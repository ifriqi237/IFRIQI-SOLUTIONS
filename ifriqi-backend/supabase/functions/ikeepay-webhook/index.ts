// POST /ikeepay-webhook — endpoint PUBLIC à renseigner dans le tableau de bord iKeePay comme
// URL de notification pour les transactions H2H (payin).
//
// Même architecture que pawapay-deposit-callback/index.ts, avec les mêmes principes de
// sécurité :
//   1. Vérifie X-ikeepay-signature (HMAC-SHA256) — voir _shared/ikeepay.ts. ⚠️ À ce jour, cette
//      vérification est TOUJOURS REFUSÉE (fail-safe) car le secret exact / les champs signés /
//      l'encodage n'ont pas encore été confirmés par le support iKeePay (voir le commentaire
//      détaillé dans ikeepay.ts). Autrement dit : ce webhook ne validera AUCUN paiement réel en
//      production tant que ce point n'est pas résolu — c'est volontaire, pas un oubli.
//      IKEEPAY_REQUIRE_SIGNATURE=false permet de désactiver temporairement cette vérification,
//      UNIQUEMENT pour tester le reste du flux en sandbox, jamais en production.
//   2. Ne fait jamais confiance au `status` porté par le corps du webhook : revérifie toujours
//      via GET /h2h-verify/:reference (verifyTransaction()) avant d'écrire en base.
//   3. Idempotence : même index unique payments(provider, provider_ref) où status='SUCCESS'
//      que pour PawaPay/CinetPay/PayPal (0001_init.sql) — rejouer ce webhook plusieurs fois ne
//      crée jamais plusieurs cartes/commissions pour la même transaction.
//   4. Ne rétrograde jamais un paiement déjà PAID (webhook en retard ou désordonné).
//
// Forme du webhook attendue, d'après la doc (section "Intégration H2H" → "4. Webhooks") :
//   { event: "transaction.updated"|"transaction.created",
//     data: { type: "payin"|"payout", external_reference, provider_reference, amount, currency,
//             country, phone_number, operator, status: "completed"|"pending"|"failed", ... } }
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { verifyIkeepayWebhookSignature, verifyTransaction } from "../_shared/ikeepay.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  const rawBody = new Uint8Array(await req.arrayBuffer());

  try {
    const requireSignature = Deno.env.get("IKEEPAY_REQUIRE_SIGNATURE") !== "false";
    if (requireSignature) {
      const verif = await verifyIkeepayWebhookSignature(req, rawBody);
      if (!verif.ok) {
        console.error("ikeepay-webhook: signature invalide/non vérifiable", verif.reason);
        return json({ error: "Signature invalide." }, 401);
      }
    } else {
      console.warn("ikeepay-webhook: vérification de signature DÉSACTIVÉE (IKEEPAY_REQUIRE_SIGNATURE=false) — à ne jamais faire en production.");
    }

    const payload = safeJsonParse(rawBody);
    const data = payload?.data ?? payload; // tolère aussi un corps plat (variante "inline checkout" de la doc)
    const externalReference: string | undefined = data?.external_reference ?? payload?.order_id;
    const providerReference: string | undefined = data?.provider_reference ?? payload?.ikeepay_ref;
    if (!externalReference) return json({ error: "external_reference manquant." }, 400);

    const svc = serviceClient();
    const { data: payment } = await svc.from("payments").select("*").eq("provider", "ikeepay").eq("provider_ref", externalReference).single();
    if (!payment) {
      console.error("ikeepay-webhook: aucun paiement ikeepay avec provider_ref=", externalReference);
      return json({ error: "Paiement introuvable pour cette référence." }, 404);
    }

    // Ne traite jamais deux fois un paiement déjà confirmé (idempotence applicative, en plus
    // de l'index unique en base) et ne rétrograde jamais un SUCCESS déjà écrit.
    if (payment.status === "SUCCESS") {
      return json({ status: "PAID", already: true });
    }

    // Revérification serveur-à-serveur obligatoire : seule cette valeur fait foi, jamais le
    // `status` du corps du webhook.
    const checked = await verifyTransaction(providerReference ?? externalReference);

    if (checked.status === "completed") {
      await svc.from("payments").update({ status: "SUCCESS", paid_at: new Date().toISOString(), raw_payload: payload }).eq("id", payment.id);
      await svc.from("orders").update({ payment_status: "PAID" }).eq("id", payment.order_id);
      await svc.rpc("create_commissions_for_order", { p_order_id: payment.order_id });

      const { data: order } = await svc.from("orders").select("product").eq("id", payment.order_id).single();
      if (order?.product === "card") {
        const { error: issueErr } = await svc.rpc("issue_card_for_order", { p_order_id: payment.order_id });
        if (issueErr) console.error("issue_card_for_order failed from ikeepay-webhook", issueErr);
      } else if (order?.product === "topup") {
        const { error: topupErr } = await svc.rpc("apply_topup_for_order", { p_order_id: payment.order_id });
        if (topupErr) console.error("apply_topup_for_order failed from ikeepay-webhook", topupErr);
      }
      return json({ status: "PAID" });
    }

    if (checked.status === "failed") {
      await svc.from("payments").update({ status: "FAILED", raw_payload: payload }).eq("id", payment.id);
      await svc.from("orders").update({ payment_status: "FAILED" }).eq("id", payment.order_id);
      return json({ status: "FAILED" });
    }

    if (checked.status === "cancelled") {
      await svc.from("payments").update({ status: "CANCELLED", raw_payload: payload }).eq("id", payment.id);
      await svc.from("orders").update({ payment_status: "CANCELLED" }).eq("id", payment.order_id);
      return json({ status: "CANCELLED" });
    }

    // "pending" ou statut non reconnu : on accuse réception sans modifier la base — un webhook
    // ultérieur (ou une vérification manuelle via /h2h-verify) apportera le statut final.
    return json({ status: checked.status });
  } catch (e) {
    console.error("ikeepay-webhook error", e);
    return json({ error: "Une erreur est survenue lors du traitement de la notification." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function safeJsonParse(bytes: Uint8Array): any {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; }
}
