// Règlement d'un paiement PAYLIV (utilisé par payliv-webhook ET payliv-status).
//
// Règle d'or : on ne confirme JAMAIS sur la foi d'un corps de webhook ou d'un retour navigateur.
// On relit le statut chez PAYLIV avec la clé secrète (getStatus) puis on contrôle référence,
// devise et montant avant d'écrire quoi que ce soit.
//
// Idempotence : la bascule payments -> SUCCESS est une « prise de verrou » atomique
// (UPDATE ... WHERE status <> 'SUCCESS' RETURNING) ; seule l'instance qui l'obtient crée
// commissions / carte / e-mail. L'index unique payments_provider_ref_success_idx protège en plus.
import { getStatus, classifyStatus } from "./payliv.ts";
import { notifyPaymentConfirmed } from "./email.ts";

// deno-lint-ignore no-explicit-any
type Svc = any;
export type SettleResult = {
  status: "PAID" | "FAILED" | "CANCELLED" | "PENDING";
  already?: boolean;
  reason?: string;
  failureClass?: string | null;
};

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN);
const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.011;

export async function settlePayliv(svc: Svc, payment: Record<string, any>): Promise<SettleResult> {
  if (payment.status === "SUCCESS") return { status: "PAID", already: true };

  const { data: order } = await svc.from("orders").select("id,product,payment_status,display_amount,display_currency").eq("id", payment.order_id).single();
  if (!order) return { status: "PENDING", reason: "order_not_found" };

  const paymentId: string | null = payment.provider_ref;
  if (!paymentId) return { status: "PENDING", reason: "no_provider_ref" };

  const remote = await getStatus(paymentId);
  if (!remote.ok) return { status: "PENDING", reason: "status_unavailable" };
  const r = remote.data;
  const verdict = classifyStatus(r);
  const failureClass = (r.failure_class as string) ?? ((r.latest_attempt as Record<string, unknown> | undefined)?.failure_class as string) ?? null;

  // Le statut distant doit concerner CE paiement.
  const remoteId = String(r.id ?? r.payment_id ?? paymentId);
  if (remoteId !== paymentId) { console.error("payliv-settle: identifiant de paiement incohérent", paymentId, remoteId); return { status: "PENDING", reason: "id_mismatch" }; }

  if (verdict === "paid") {
    // Devise et montant : le montant doit être le prix de la commande (ou le total facturé avec frais
    // renvoyé à la création, fee_bearer=client). Tout autre montant est refusé et journalisé.
    const rawCreate = (payment.raw_payload ?? {}) as Record<string, unknown>;
    const created = (rawCreate.created ?? rawCreate) as Record<string, unknown>;
    const allowed = [num(order.display_amount), num(created.charged_amount)].filter(Number.isFinite);
    const remoteAmount = num(r.amount);
    const remoteCurrency = String(r.currency ?? "").toUpperCase();
    if (remoteCurrency && remoteCurrency !== String(order.display_currency).toUpperCase()) {
      console.error("payliv-settle: devise différente", order.id, remoteCurrency, order.display_currency);
      return { status: "PENDING", reason: "currency_mismatch" };
    }
    if (!allowed.some((a) => close(a, remoteAmount))) {
      console.error("payliv-settle: montant différent", order.id, remoteAmount, allowed);
      return { status: "PENDING", reason: "amount_mismatch" };
    }

    // Prise de verrou atomique : une seule exécution continue.
    const { data: claimed } = await svc.from("payments")
      .update({ status: "SUCCESS", paid_at: new Date().toISOString(), raw_payload: { created, confirmed: r } })
      .eq("id", payment.id).neq("status", "SUCCESS").select("id");
    if (!claimed || claimed.length === 0) return { status: "PAID", already: true };

    await svc.from("orders").update({ payment_status: "PAID" }).eq("id", order.id);
    await svc.rpc("create_commissions_for_order", { p_order_id: order.id });
    if (order.product === "card") {
      const { error } = await svc.rpc("issue_card_for_order", { p_order_id: order.id });
      if (error) console.error("issue_card_for_order failed from payliv", error);
    } else if (order.product === "topup") {
      const { error } = await svc.rpc("apply_topup_for_order", { p_order_id: order.id });
      if (error) console.error("apply_topup_for_order failed from payliv", error);
    }
    await notifyPaymentConfirmed(order.id); // ne lève jamais
    return { status: "PAID" };
  }

  if (verdict === "failed" || verdict === "cancelled") {
    const pay = verdict === "failed" ? "FAILED" : "CANCELLED";
    // N'écrase jamais un paiement déjà confirmé ni une commande déjà payée.
    await svc.from("payments").update({ status: pay, raw_payload: { ...(payment.raw_payload ?? {}), last: r } }).eq("id", payment.id).eq("status", "PENDING");
    await svc.from("orders").update({ payment_status: pay }).eq("id", order.id).eq("payment_status", "PENDING");
    return { status: pay as "FAILED" | "CANCELLED", failureClass };
  }
  return { status: "PENDING" };
}
