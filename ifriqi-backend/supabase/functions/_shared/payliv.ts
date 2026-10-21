// PAYLIV (https://payliv.shop) — encaissement Mobile Money, ajouté le 2026-10-21.
//
// Source : documentation officielle PAYLIV fournie par l'utilisateur (page « API Mobile Money »).
// Secrets (variables d'environnement Supabase Edge Functions — JAMAIS dans le code/le front) :
//   PAYLIV_API_KEY         clé secrète serveur (sk_live_…), envoyée dans l'en-tête X-API-Key
//   PAYLIV_WEBHOOK_SECRET  secret de signature des webhooks (whsec_…), HMAC-SHA256 hex du CORPS BRUT
//
// Points de la doc qui se contredisent et la façon dont ce module les tolère :
//   * statut payé : « PAID » + is_paid:true (endpoint statut) vs « completed » (webhook/exemples)
//     -> classifyStatus() accepte les deux ;
//   * forme du webhook : corps plat (texte) vs { data: { id, status } } (exemple Node)
//     -> le webhook fusionne les deux formes.
// Le webhook ne fait JAMAIS confiance au corps reçu : après contrôle de signature il relit le
// statut chez PAYLIV (GET /api-payments-status) avec la clé secrète avant de confirmer.

const BASE = "https://ivnvckgzkxxhowusxczt.supabase.co/functions/v1";
const TIMEOUT_MS = 28000;

export const paylivConfigured = () => !!Deno.env.get("PAYLIV_API_KEY");

/** Pays pris en charge pour le Mobile Money à l'encaissement (doc : « Opérateurs supportés par pays »).
 *  dial = indicatif ; currency = devise OBLIGATOIRE chez PAYLIV ; providers = codes `provider` PAYLIV.
 *  TD (Tchad) n'a aucun Mobile Money à l'encaissement (carte seulement) : volontairement absent. */
export const PAYLIV_COUNTRIES: Record<string, { dial: string; currency: string; providers: string[] }> = {
  CI: { dial: "225", currency: "XOF", providers: ["orange", "mtn", "moov", "wave"] },
  SN: { dial: "221", currency: "XOF", providers: ["orange", "wave", "free"] },
  BJ: { dial: "229", currency: "XOF", providers: ["mtn", "moov"] },
  BF: { dial: "226", currency: "XOF", providers: ["orange", "moov"] },
  TG: { dial: "228", currency: "XOF", providers: ["tmoney", "flooz"] },
  ML: { dial: "223", currency: "XOF", providers: ["orange", "moov", "wave"] },
  NE: { dial: "227", currency: "XOF", providers: ["amanata", "mynita"] },
  GW: { dial: "245", currency: "XOF", providers: ["orange", "mtn"] },
  GH: { dial: "233", currency: "GHS", providers: ["mtn", "telecel", "airteltigo"] },
  NG: { dial: "234", currency: "NGN", providers: ["mtn"] },
  CM: { dial: "237", currency: "XAF", providers: ["mtn", "orange"] },
  GA: { dial: "241", currency: "XAF", providers: ["airtel", "moov"] },
  CG: { dial: "242", currency: "XAF", providers: ["mtn", "airtel"] },
  CF: { dial: "236", currency: "XAF", providers: ["orange", "moov"] },
  GQ: { dial: "240", currency: "XAF", providers: ["mtn"] },
  KE: { dial: "254", currency: "KES", providers: ["mpesa", "airtel"] },
  ZA: { dial: "27", currency: "ZAR", providers: ["vodacom"] },
};

/** Montants minimums par devise (doc : « Montants minimums par devise »). */
export const PAYLIV_MIN: Record<string, number> = { XOF: 100, XAF: 100, NGN: 100, GHS: 1, KES: 10, ZAR: 5 };

/** Normalise un numéro en +<indicatif><chiffres>. Retourne null s'il est manifestement invalide. */
export function normalizePhone(raw: string, country: string): string | null {
  const cfg = PAYLIV_COUNTRIES[country];
  if (!cfg) return null;
  let s = String(raw ?? "").trim().replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(s)) return null;
  let digits: string;
  if (s.startsWith("+")) digits = s.slice(1);
  else if (s.startsWith("00")) digits = s.slice(2);
  else if (s.startsWith(cfg.dial) && s.length >= cfg.dial.length + 8) digits = s;
  else digits = cfg.dial + s.replace(/^0+/, "");
  if (!digits.startsWith(cfg.dial)) return null; // numéro d'un autre pays
  const national = digits.length - cfg.dial.length;
  if (national < 8 || national > 11) return null;
  return "+" + digits;
}

export type PaylivResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string; http: number };

const FRIENDLY: Record<string, string> = {
  AMOUNT_TOO_LOW: "Montant inférieur au minimum accepté pour cette devise.",
  INVALID_CURRENCY: "Cette devise n'est pas acceptée par ce moyen de paiement.",
  MISSING_PHONE: "Numéro de téléphone manquant.",
  GATEWAY_FAILED: "Impossible d'envoyer la demande à votre opérateur. Vérifiez le numéro et l'opérateur choisi, puis réessayez.",
  GATEWAY_TIMEOUT: "L'opérateur ne répond pas pour le moment. Réessayez dans quelques minutes.",
};

async function call(path: string, init: RequestInit): Promise<PaylivResult<Record<string, unknown>>> {
  const key = Deno.env.get("PAYLIV_API_KEY");
  if (!key) return { ok: false, code: "NOT_CONFIGURED", message: "PAYLIV n'est pas configuré.", http: 503 };
  try {
    const res = await fetch(BASE + path, {
      ...init,
      headers: { ...(init.headers ?? {}), "X-API-Key": key, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* corps non JSON */ }
    if (!res.ok || data.success === false) {
      const code = String(data.code ?? data.error_code ?? (data.error && typeof data.error === "object" ? (data.error as Record<string, unknown>).code : "") ?? "") || `HTTP_${res.status}`;
      console.error("payliv error", path, res.status, code);
      return { ok: false, code, message: FRIENDLY[code] ?? "Le paiement n'a pas pu être initié. Réessayez dans quelques instants.", http: res.status };
    }
    return { ok: true, data };
  } catch (e) {
    console.error("payliv network error", path, e instanceof Error ? e.name : e);
    return { ok: false, code: "NETWORK", message: "Le service de paiement ne répond pas. Réessayez dans quelques instants.", http: 502 };
  }
}

export function createMobileMoney(p: {
  amount: number; currency: string; phone: string; country: string; provider: string;
  title: string; webhookUrl: string; metadata: Record<string, unknown>;
}) {
  return call("/api-payments-mobile-money", {
    method: "POST",
    body: JSON.stringify({
      amount: p.amount, currency: p.currency, phone: p.phone, country: p.country, provider: p.provider,
      title: p.title,
      fee_bearer: "client", // décision utilisateur 2026-10-21 : l'acheteur paie les frais PAYLIV en plus du prix
      webhook_url: p.webhookUrl, metadata: p.metadata,
    }),
  });
}

/** Carte bancaire Visa/Mastercard (doc « API Paiement par carte ») : page hébergée PAYLIV + 3-D Secure.
 *  Réponse : { payment_id, reference, status:"pending", checkout_url, ... }. Pas de fee_bearer documenté
 *  pour la carte : le montant demandé est celui facturé, les frais éventuels restent à la charge du marchand. */
export function createCard(p: {
  amount: number; currency: string; country: string; title: string; email: string; name?: string;
  successUrl: string; cancelUrl: string; webhookUrl: string; metadata: Record<string, unknown>;
}) {
  return call("/api-payments-card", {
    method: "POST",
    body: JSON.stringify({
      amount: p.amount, currency: p.currency, country: p.country, title: p.title,
      customer_email: p.email, ...(p.name ? { customer_name: p.name } : {}),
      success_url: p.successUrl, cancel_url: p.cancelUrl, webhook_url: p.webhookUrl, metadata: p.metadata,
    }),
  });
}

export function getStatus(paymentId: string) {
  return call("/api-payments-status?payment_id=" + encodeURIComponent(paymentId), { method: "GET" });
}

export function submitOtp(paymentId: string, otp: string) {
  return call("/api-payments-submit-otp", { method: "POST", body: JSON.stringify({ payment_id: paymentId, otp }) });
}

export type Verdict = "paid" | "failed" | "cancelled" | "pending";

/** Interprète un statut PAYLIV (réponse /api-payments-status ou corps de webhook). */
export function classifyStatus(o: Record<string, unknown> | null | undefined): Verdict {
  if (!o) return "pending";
  if (o.is_paid === true) return "paid";
  const s = String(o.status ?? "").toLowerCase();
  if (["paid", "completed", "success", "succeeded"].includes(s)) return "paid";
  if (["cancelled", "canceled"].includes(s)) return "cancelled";
  if (["failed", "expired", "rejected", "error"].includes(s)) return "failed";
  return "pending";
}

function hex(buf: ArrayBuffer) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** HMAC-SHA256 (hex) du CORPS BRUT exact, comparé en temps constant à X-Webhook-Signature. */
export async function verifyWebhookSignature(rawBody: Uint8Array, header: string | null): Promise<boolean> {
  const secret = Deno.env.get("PAYLIV_WEBHOOK_SECRET");
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, rawBody));
  const received = header.trim().replace(/^sha256=/i, "").toLowerCase();
  return timingSafeEqual(expected, received);
}

/** Cherche une URL de redirection https dans une réponse de création (cas Mali/Guinée…). */
export function extractRedirect(d: Record<string, unknown>): string | null {
  const na = d.next_action;
  const cand = [
    na && typeof na === "object" ? (na as Record<string, unknown>).redirect_url : undefined,
    d.redirect_url, d.payment_url, d.checkout_url,
  ];
  for (const c of cand) {
    if (typeof c === "string" && /^https:\/\//i.test(c)) return c;
  }
  return null;
}
