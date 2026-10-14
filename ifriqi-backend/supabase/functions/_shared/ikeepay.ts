// Helpers partagés pour l'intégration iKeePay (mode H2H — Mobile Money), 2026-10-12.
//
// Ce module suit EXACTEMENT ce que la documentation iKeePay fournie par l'utilisateur décrit,
// et rien de plus : aucun endpoint, paramètre ou comportement n'est deviné. Chaque fonction
// cite la section de la doc dont elle vient. Là où la doc est silencieuse ou ambiguë, c'est
// noté explicitement en commentaire — voir en particulier verifyIkeepayWebhookSignature()
// ci-dessous, qui N'EST PAS complète (point bloquant signalé, pas contourné).
//
// Variables d'environnement attendues (Project Settings → Edge Functions → Secrets) :
//   IKEEPAY_API_BASE_URL     — défaut "https://api.ikeepay.com" (doc : "Endpoint Live")
//   IKEEPAY_SECRET_KEY        — clé secrète H2H (en-tête x-api-key sur /h2h-payin, /h2h-payout,
//                                /h2h-verify). Indépendante de PAWAPAY_API_TOKEN.
//   IKEEPAY_WEBHOOK_SECRET    — secret utilisé pour calculer X-ikeepay-signature (HMAC-SHA256,
//                                confirmé par le support iKeePay). ⚠️ NON CONFIRMÉ à ce jour :
//                                ni la valeur exacte de ce secret (= IKEEPAY_SECRET_KEY ou un
//                                secret distinct ?), ni ce qui est signé (corps brut vs champs
//                                concaténés), ni l'encodage (hex vs base64). Tant que ce n'est
//                                pas confirmé par le support, verifyIkeepayWebhookSignature()
//                                refuse TOUJOURS le callback (fail-safe : on ne traite jamais
//                                une notification qu'on ne peut pas authentifier).
//   IKEEPAY_REQUIRE_SIGNATURE — "false" pour désactiver la vérification PENDANT LES TESTS
//                                SANDBOX UNIQUEMENT (même principe que PAWAPAY_REQUIRE_SIGNATURE
//                                dans pawapay.ts). Ne jamais mettre à "false" en production.

export function ikeepayApiBase(): string {
  return Deno.env.get("IKEEPAY_API_BASE_URL") || "https://api.ikeepay.com";
}

function ikeepayAuthHeaders(): Record<string, string> {
  const key = Deno.env.get("IKEEPAY_SECRET_KEY");
  return key ? { "x-api-key": key } : {};
}

export function ikeepayConfigured(): boolean {
  return !!Deno.env.get("IKEEPAY_SECRET_KEY");
}

// ---------------------------------------------------------------------------
// Inline Checkout (modale pop-up unifiée), ajouté le 2026-10-13 — mode alternatif au H2H
// ci-dessus, utilisé EN ATTENDANT que le palier "Direct Charge (Server-to-Server) / PRO" du
// compte iKeePay soit débloqué (H2H renvoie 403 "Accès refusé" tant que ce palier n'est pas
// activé — voir l'échange avec l'utilisateur, 2026-10-12/13).
//
// Principe (doc utilisateur + fichier de démo officiel `Demo.html` fourni, et plugin WooCommerce
// officiel iKeePay inspecté pour référence) : le NAVIGATEUR charge directement
// `${IKEEPAY_CHECKOUT_URL}?pk=...&amount=...&currency=...&order_id=...&email=...` dans une
// iframe. L'utilisateur y choisit lui-même son moyen de paiement (carte, Mobile Money, virement,
// USDT) ; iKeePay poste ensuite un message `window.postMessage` ('ikeepay-ready' | 'ikeepay-close'
// | 'ikeepay-success' | 'ikeepay-error') à la page parente.
//
// ⚠️ ÉCART VOLONTAIRE PAR RAPPORT AU PLUGIN WOOCOMMERCE OFFICIEL D'IKEEPAY : ce plugin transmet
// AUSSI la clé SECRÈTE au navigateur (`sk=...` dans l'URL de l'iframe) et valide la commande
// uniquement sur la réception du message client `ikeepay-success` — sans aucune revérification
// serveur-à-serveur. C'est un anti-pattern de sécurité (clé secrète exposée côté client +
// confirmation de paiement qui ne tient qu'à un `postMessage`, qu'un attrapeur de console peut
// envoyer lui-même). On ne le reproduit PAS ici :
//   1. Seule la clé PUBLIQUE (`IKEEPAY_PUBLIC_KEY`, pk_live_...) part vers le navigateur.
//   2. `ikeepay-success` ne fait JAMAIS passer une commande à PAID côté serveur — ce n'est qu'un
//      signal UI (fermer la modale, démarrer le sondage normal de orders.payment_status, déjà en
//      place pour PawaPay/H2H). La confirmation réelle doit toujours venir d'un canal
//      serveur-à-serveur (webhook, ou vérification), exactement comme pour le H2H ci-dessus.
//
// ⚠️ GAP DE DOCUMENTATION (signalé, non deviné) : ni la doc utilisateur ni le `Demo.html` fourni
// ne précisent SI iKeePay envoie un webhook pour les transactions Inline Checkout (et avec quel
// format), ni si GET /h2h-verify/:reference couvre aussi ce type de transaction. Tant que ce
// point n'est pas confirmé par le support iKeePay, une commande payée via Inline Checkout peut
// rester bloquée à PENDING côté IFRIQI même si le client a réellement payé — c'est un risque
// connu et accepté par l'utilisateur (2026-10-13), pas un bug caché.
export function ikeepayPublicKey(): string | undefined {
  return Deno.env.get("IKEEPAY_PUBLIC_KEY") || undefined;
}

export function ikeepayCheckoutUrl(): string {
  // CORRIGÉ le 13/10/2026 : la valeur par défaut était "https://www.ikeepay.com/checkout/v1/inline"
  // (celle du fichier `Demo.html` fourni initialement), mais un extrait de code iKeePay transmis
  // par le support/l'utilisateur le même jour utilise explicitement "https://ikeepay.com/..." SANS
  // "www.". C'est une piste sérieuse pour expliquer le silence des webhooks Inline Checkout
  // constaté en production (4 paiements confirmés par email mais jamais notifiés) : si "www." et
  // le domaine nu ne pointent pas vers la même infrastructure côté iKeePay, l'iframe chargeait
  // potentiellement un point d'entrée différent du vrai backend qui émet les webhooks.
  // IKEEPAY_CHECKOUT_URL reste disponible pour basculer sans redéploiement si besoin.
  return Deno.env.get("IKEEPAY_CHECKOUT_URL") || "https://ikeepay.com/checkout/v1/inline";
}

export function ikeepayInlineConfigured(): boolean {
  return !!ikeepayPublicKey();
}

// ---------------------------------------------------------------------------
// 1. Encaissement (Payin) — POST /h2h-payin.
// Doc : section "Intégration H2H (Payin, Payout & Webhooks)" → "1. Encaissement (Payin)".
//
// ⚠️ GAP DE DOCUMENTATION (signalé, non deviné) : la doc montre le payload envoyé et le webhook
// reçu PLUS TARD, mais ne montre PAS la forme de la réponse HTTP synchrone de cet endpoint (ni
// en succès, ni en erreur). On lit donc la réponse de façon défensive (plusieurs noms de champs
// plausibles) et on conserve `raw` intégralement pour diagnostic — mais tant que le support n'a
// pas confirmé le format exact, ce parsing peut être incomplet. Ne JAMAIS considérer cet appel
// seul comme une preuve de paiement : voir verifyTransaction() plus bas, appelée par le webhook
// avant toute écriture en base.
// ---------------------------------------------------------------------------

export type IkeepayPayinParams = {
  amount: number;                 // montant — la doc donne des entiers (500, 5000) selon la devise
  currency: string;                // ex. "XOF"
  country: string;                 // code pays ISO2, ex. "CI"
  phoneNumber: string;              // ex. "2250700000000" (indicatif inclus, sans "+")
  operator: string;                 // "ORANGE" | "MTN" | "WAVE" | "MOOV" | "MOBICASH" | "AIRTEL" | "VODACOM" | ...
  externalReference: string;        // généré côté serveur, jamais par le client
  customerEmail?: string;
  otp?: string;                     // requis pour certains opérateurs (ex. Orange BF) — flux de soumission du
                                     // second facteur non détaillé par la doc ; voir gap signalé au rapport final.
};

export type IkeepayPayinResult =
  | { ok: true; raw: unknown; paymentLink?: string | null }
  | { ok: false; raw: unknown; httpStatus?: number; message?: string };

export async function initiatePayin(params: IkeepayPayinParams): Promise<IkeepayPayinResult> {
  const body = {
    amount: params.amount,
    currency: params.currency,
    country: params.country,
    phoneNumber: params.phoneNumber,
    operator: params.operator,
    external_reference: params.externalReference,
    ...(params.customerEmail ? { customer_email: params.customerEmail } : {}),
    ...(params.otp ? { otp: params.otp } : {}),
  };
  const res = await fetch(`${ikeepayApiBase()}/h2h-payin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ikeepayAuthHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("iKeePay initiatePayin HTTP error", res.status, data);
    return { ok: false, raw: data, httpStatus: res.status, message: data?.message ?? data?.error ?? undefined };
  }
  // La doc mentionne : "Vous recevrez un lien de redirection payment_link en réponse pour le cas
  // de Wave et Orange si nécessaire" — on l'extrait si présent, sans supposer sa présence.
  const paymentLink = data?.payment_link ?? data?.data?.payment_link ?? null;
  return { ok: true, raw: data, paymentLink };
}

// ---------------------------------------------------------------------------
// 2. Retrait (Payout) — POST /h2h-payout. Fourni pour complétude (doc "2. Retrait (Payout)"),
// mais PAS branché sur request-withdrawal/index.ts dans cette intervention : le cahier des
// charges porte sur l'intégration du paiement (encaissement), et toucher le flux de retrait
// distributeur (déjà opérationnel avec PawaPay) serait hors du périmètre demandé. À brancher
// séparément si un jour IFRIQI veut proposer iKeePay comme option de retrait aussi.
// ---------------------------------------------------------------------------

export type IkeepayPayoutParams = {
  amount: number;
  currency: string;
  country: string;
  phoneNumber: string;
  operator: string;
  externalReference: string;
};

export async function initiatePayout(params: IkeepayPayoutParams): Promise<IkeepayPayinResult> {
  const body = {
    amount: params.amount,
    currency: params.currency,
    country: params.country,
    phoneNumber: params.phoneNumber,
    operator: params.operator,
    external_reference: params.externalReference,
  };
  const res = await fetch(`${ikeepayApiBase()}/h2h-payout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ikeepayAuthHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("iKeePay initiatePayout HTTP error", res.status, data);
    return { ok: false, raw: data, httpStatus: res.status, message: data?.message ?? data?.error ?? undefined };
  }
  return { ok: true, raw: data };
}

// ---------------------------------------------------------------------------
// 3. Vérification de transaction — GET /h2h-verify/:reference.
// Doc : "3. Vérification de transaction". Réponse confirmée par la doc :
//   { status: "success", data: { external_reference, provider_reference, amount, currency,
//     status: "completed"|"pending"|"failed", type: "payin"|"payout", operator, created_at } }
//
// Appelée par ikeepay-webhook AVANT d'écrire quoi que ce soit en base — on ne fait jamais
// confiance au `status` porté par le webhook seul, exactement le même principe que
// checkDepositStatus() dans pawapay.ts.
// ---------------------------------------------------------------------------

export type IkeepayVerifyResult = {
  found: boolean;
  status: "completed" | "pending" | "failed" | "cancelled" | "unknown";
  raw: unknown;
  data?: {
    external_reference: string;
    provider_reference: string;
    amount: number;
    currency: string;
    type: "payin" | "payout";
    operator: string;
    created_at: string;
  };
};

export async function verifyTransaction(reference: string): Promise<IkeepayVerifyResult> {
  const res = await fetch(`${ikeepayApiBase()}/h2h-verify/${encodeURIComponent(reference)}`, {
    headers: ikeepayAuthHeaders(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("iKeePay verifyTransaction HTTP error", res.status, data);
    return { found: false, status: "unknown", raw: data };
  }
  const status = data?.data?.status;
  if (status === "completed" || status === "pending" || status === "failed" || status === "cancelled") {
    return { found: true, status, raw: data, data: data.data };
  }
  return { found: false, status: "unknown", raw: data };
}

// ---------------------------------------------------------------------------
// Vérification de signature des webhooks — X-ikeepay-signature, HMAC-SHA256 (confirmé par le
// support iKeePay, 2026-10-12).
//
// ⚠️ POINT BLOQUANT (signalé explicitement, conformément au cahier des charges — "n'invente
// aucun format de signature") : le support a confirmé l'ALGORITHME (HMAC-SHA256) et l'EN-TÊTE
// (X-ikeepay-signature), mais PAS encore :
//   1. quel secret alimente le HMAC (IKEEPAY_SECRET_KEY, ou un IKEEPAY_WEBHOOK_SECRET distinct) ;
//   2. ce qui est exactement signé (le corps brut de la requête, ou des champs concaténés dans
//      un ordre précis) ;
//   3. l'encodage du résultat (hex ou base64).
//
// Tant que ces 3 points ne sont pas confirmés, cette fonction refuse TOUJOURS le webhook
// (fail-safe) plutôt que de deviner un schéma qui pourrait soit (a) rejeter de vrais paiements,
// soit pire (b) laisser passer une notification falsifiée si la supposition était la bonne par
// coïncidence mais le reste du calcul faux. Dès que le support confirme les 3 points, remplacer
// le corps de cette fonction par le calcul réel — la structure (lire l'en-tête, recalculer,
// comparer en temps constant) est déjà prête ci-dessous en commentaire.
// ---------------------------------------------------------------------------

export type IkeepaySignatureVerification = { ok: boolean; reason?: string };

// CONFIRMÉ le 14/10/2026 via capture de diagnostic (IKEEPAY_DEBUG_CAPTURE=true, webhook réel
// reçu sur un paiement Inline Checkout) : contrairement à ce que le support avait annoncé le
// 12/10 ("HMAC-SHA256"), l'en-tête X-ikeepay-signature ne contient PAS un HMAC calculé sur le
// corps de la requête. Il contient directement, en clair, la clé secrète du marchand telle que
// fournie dans IKEEPAY_SECRET_KEY (format "sk_live_..."). Ce n'est donc pas une signature
// cryptographique du message, mais une authentification par secret partagé statique — on
// compare simplement l'en-tête reçu à notre propre IKEEPAY_SECRET_KEY, en temps constant pour
// ne pas exposer d'information via le temps de réponse.
export async function verifyIkeepayWebhookSignature(req: Request, _rawBody: Uint8Array): Promise<IkeepaySignatureVerification> {
  const sig = req.headers.get("x-ikeepay-signature");
  if (!sig) return { ok: false, reason: "En-tête X-ikeepay-signature absent." };

  const secret = Deno.env.get("IKEEPAY_SECRET_KEY");
  if (!secret) return { ok: false, reason: "IKEEPAY_SECRET_KEY non configurée côté serveur." };

  return timingSafeEqualStr(sig, secret)
    ? { ok: true }
    : { ok: false, reason: "X-ikeepay-signature ne correspond pas à la clé secrète attendue." };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}
