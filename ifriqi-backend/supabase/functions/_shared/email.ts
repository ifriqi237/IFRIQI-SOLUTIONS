// Service e-mail centralisé IFRIQI (Resend). Utilisé UNIQUEMENT côté serveur (Edge Functions).
//
// Principes :
//  * Jamais bloquant : queueEmail()/notify*() ne lèvent JAMAIS d'exception. Un échec d'e-mail
//    ne change donc jamais l'état d'un paiement ou d'une commande.
//  * Anti-doublon : chaque e-mail a une idempotency_key unique (ex. "payment:<order_id>") ;
//    l'insertion est ignorée si la clé existe déjà. L'id de l'outbox sert aussi d'Idempotency-Key
//    chez Resend (dédoublonnage côté fournisseur en cas de réponse perdue).
//  * Nouvelles tentatives : backoff 1 min, 5 min, 30 min, 2 h, 6 h puis statut "dead" (max 5).
//    Pas de pg_cron sur ce projet : les envois en attente sont repris à chaque nouvel envoi et
//    par la fonction process-email-queue (appel planifié/manuel protégé par EMAIL_QUEUE_SECRET).
//  * Secrets : RESEND_API_KEY n'est lue que dans l'environnement serveur ; jamais journalisée,
//    jamais renvoyée. Les erreurs stockées sont tronquées et ne contiennent pas l'en-tête d'auth.
import { serviceClient } from "./supabase.ts";
import { render, type EmailKind } from "./email-templates.ts";

const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 5, 30, 120, 360];
const SEND_TIMEOUT_MS = 8000;

export const emailConfig = () => ({
  apiKey: Deno.env.get("RESEND_API_KEY") || "",
  from: Deno.env.get("EMAIL_FROM") || "IFRIQI <notifications@ifriqi.com>",
  appUrl: (Deno.env.get("APP_URL") || "https://www.ifriqi.com").replace(/\/+$/, ""),
  supportEmail: Deno.env.get("SUPPORT_EMAIL") || "support@ifriqi.com",
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type Row = { id: string; kind: EmailKind; to_email: string; data: Record<string, unknown>; attempts: number };

/** Met un e-mail en file (idempotent) puis tente l'envoi en arrière-plan. Ne lève jamais. */
export async function queueEmail(kind: EmailKind, to: string | null | undefined, data: Record<string, unknown>, idempotencyKey: string): Promise<void> {
  try {
    if (!to || !EMAIL_RE.test(to) || to.length > 254) { console.warn("email: destinataire invalide, ignoré", kind); return; }
    const svc = serviceClient();
    const { error } = await svc.from("email_outbox").upsert(
      { idempotency_key: idempotencyKey, kind, to_email: to.toLowerCase(), data },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );
    if (error) { console.error("email: mise en file impossible", error.message); return; }
    // Envoi en arrière-plan : n'allonge pas la réponse du webhook.
    const job = drainOutbox(5).catch((e) => console.error("email: drain", String(e?.message ?? e)));
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(job);
  } catch (e) {
    console.error("email: queueEmail", String((e as Error)?.message ?? e));
  }
}

/** Reprend les e-mails dus (pending/failed échus, ou 'sending' bloqués > 5 min). */
export async function drainOutbox(limit = 10): Promise<{ sent: number; failed: number; skipped: number }> {
  const out = { sent: 0, failed: 0, skipped: 0 };
  const cfg = emailConfig();
  const svc = serviceClient();
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: due } = await svc.from("email_outbox").select("id")
    .or(`and(status.in.(pending,failed),next_attempt_at.lte.${nowIso}),and(status.eq.sending,locked_at.lt.${staleIso})`)
    .order("created_at", { ascending: true }).limit(limit);
  for (const { id } of due ?? []) {
    // Verrou atomique : une seule instance traite une ligne donnée.
    const { data: claimed } = await svc.from("email_outbox")
      .update({ status: "sending", locked_at: new Date().toISOString() })
      .eq("id", id)
      .or(`status.in.(pending,failed),and(status.eq.sending,locked_at.lt.${staleIso})`)
      .select("id,kind,to_email,data,attempts").maybeSingle();
    if (!claimed) { out.skipped++; continue; }
    const r = await sendRow(claimed as unknown as Row, cfg);
    out[r === "sent" ? "sent" : r === "skipped" ? "skipped" : "failed"]++;
  }
  return out;
}

async function sendRow(row: Row, cfg: ReturnType<typeof emailConfig>): Promise<"sent" | "failed" | "skipped"> {
  const svc = serviceClient();
  if (!cfg.apiKey) {
    // Clé absente : on remet en attente SANS consommer de tentative (l'e-mail partira dès que la clé sera posée).
    await svc.from("email_outbox").update({ status: "pending", locked_at: null, last_error: "RESEND_API_KEY non configurée", next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString() }).eq("id", row.id);
    console.warn("email: RESEND_API_KEY non configurée — e-mail laissé en attente");
    return "skipped";
  }
  const attempts = row.attempts + 1;
  try {
    const { subject, html, text } = render(row.kind, row.data ?? {}, { appUrl: cfg.appUrl, supportEmail: cfg.supportEmail });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": row.id },
        body: JSON.stringify({ from: cfg.from, to: [row.to_email], subject, html, text, reply_to: cfg.supportEmail, tags: [{ name: "kind", value: row.kind }] }),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.id) {
      await svc.from("email_outbox").update({ status: "sent", attempts, provider_id: body.id, sent_at: new Date().toISOString(), locked_at: null, last_error: null }).eq("id", row.id);
      return "sent";
    }
    const msg = `HTTP ${res.status} ${String(body?.name ?? "")} ${String(body?.message ?? "")}`.trim().slice(0, 300);
    // 4xx hors 429 = erreur définitive (domaine, adresse, clé invalide...) : inutile de réessayer 5 fois.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
    await fail(row.id, attempts, msg, permanent);
    return "failed";
  } catch (e) {
    await fail(row.id, attempts, `réseau/timeout: ${String((e as Error)?.name ?? "erreur")}`, false);
    return "failed";
  }
}

async function fail(id: string, attempts: number, msg: string, permanent: boolean) {
  const dead = permanent || attempts >= MAX_ATTEMPTS;
  const next = new Date(Date.now() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000).toISOString();
  await serviceClient().from("email_outbox").update({ status: dead ? "dead" : "failed", attempts, last_error: msg, locked_at: null, next_attempt_at: next }).eq("id", id);
  console.error(`email: échec ${dead ? "définitif" : "temporaire"} (tentative ${attempts}) — ${msg}`);
}

// ---------- Événements métier ----------

/** Confirmation de paiement. À appeler UNIQUEMENT après validation serveur (webhook authentifié). */
export async function notifyPaymentConfirmed(orderId: string): Promise<void> {
  try {
    const svc = serviceClient();
    const { data: o } = await svc.from("orders").select("id,seq,customer_id,profile_id,product,amount_fcfa,display_currency,display_amount,payment_status").eq("id", orderId).maybeSingle();
    if (!o || o.payment_status !== "PAID") return; // jamais de confirmation si la commande n'est pas réellement PAID
    const { data: u } = await svc.from("app_users").select("email,first_name").eq("id", o.customer_id).maybeSingle();
    let cardPublicId = "";
    if (o.product === "card" && o.profile_id) {
      const { data: c } = await svc.from("cards").select("public_id").eq("profile_id", o.profile_id).maybeSingle();
      cardPublicId = c?.public_id ?? "";
    }
    const fcfa = `${Number(o.amount_fcfa).toLocaleString("fr-FR").replace(/ | /g, " ")} FCFA`;
    const amountLabel = o.display_currency && o.display_currency !== "XAF" && o.display_amount
      ? `${fcfa} (≈ ${Number(o.display_amount).toLocaleString("fr-FR")} ${o.display_currency})` : fcfa;
    await queueEmail("payment_confirmed", u?.email, {
      firstName: u?.first_name ?? "", product: o.product, amountLabel, orderRef: `#${String(o.id).slice(0, 8).toUpperCase()}`, cardPublicId,
    }, `payment:${o.id}`);
  } catch (e) {
    console.error("email: notifyPaymentConfirmed", String((e as Error)?.message ?? e));
  }
}

/** Bienvenue : un seul envoi par compte (clé welcome:<user_id>). */
export async function notifyWelcome(userId: string): Promise<void> {
  try {
    const svc = serviceClient();
    const { data } = await svc.auth.admin.getUserById(userId);
    const email = data?.user?.email;
    await queueEmail("welcome", email, {}, `welcome:${userId}`);
  } catch (e) {
    console.error("email: notifyWelcome", String((e as Error)?.message ?? e));
  }
}
