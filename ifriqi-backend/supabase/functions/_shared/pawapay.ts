// Helpers partagés pour les callbacks (webhooks) PawaPay — dépôts, paiements sortants
// (payouts) et remboursements (refunds).
//
// Deux principes de sécurité, comme pour payment-webhook (CinetPay/PayPal) :
//
// 1. On ne fait JAMAIS confiance au contenu brut envoyé dans le callback. PawaPay signe ses
//    callbacks avec des signatures HTTP (RFC 9421, ECDSA P-256) quand l'option "signed callbacks"
//    est activée dans le Dashboard PawaPay ; on vérifie cette signature avec la clé publique de
//    PawaPay (jamais une clé/secret partagé — c'est de la cryptographie asymétrique).
//    Référence : https://docs.pawapay.io/v2/docs/signatures
// 2. Même une signature valide ne suffit pas à elle seule : on revérifie le statut final
//    directement auprès de l'API PawaPay (Check Deposit/Payout/Refund Status) avant d'écrire
//    quoi que ce soit en base — exactement le même principe que verifyCinetpay() dans
//    payment-webhook/index.ts.
//
// Variables d'environnement attendues (Project Settings → Edge Functions → Secrets) :
//   PAWAPAY_API_TOKEN     — jeton Bearer de l'API PawaPay (sandbox ou production)
//   PAWAPAY_ENV            — "production" ou "sandbox" (défaut : "sandbox")
//   PAWAPAY_REQUIRE_SIGNATURE — "false" pour désactiver la vérification de signature (NE PAS
//                               faire en production ; utile seulement si les "signed callbacks"
//                               n'ont pas encore été activés dans le Dashboard PawaPay pendant les
//                               tout premiers tests). Par défaut : exigée.

export function pawapayApiBase(): string {
  const env = (Deno.env.get("PAWAPAY_ENV") ?? "sandbox").toLowerCase();
  return env === "production" || env === "live"
    ? "https://api.pawapay.io"
    : "https://api.sandbox.pawapay.io";
}

function pawapayAuthHeaders(): Record<string, string> {
  const token = Deno.env.get("PAWAPAY_API_TOKEN");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---------------------------------------------------------------------------
// Vérification de signature RFC 9421 ("HTTP Message Signatures"), telle que documentée par
// PawaPay sur https://docs.pawapay.io/v2/docs/signatures : en-têtes Signature / Signature-Input /
// Signature-Date / Content-Digest, algorithme ecdsa-p256-sha256, clé publique récupérée via
// GET /v2/public-key/http.
// ---------------------------------------------------------------------------

type PublicKeyEntry = { id: string; key: string };

// Cache en mémoire du process (une instance Deno Deploy peut traiter plusieurs requêtes :
// on évite de re-télécharger les clés publiques à chaque callback).
let cachedKeys: { keys: PublicKeyEntry[]; fetchedAt: number } | null = null;
const KEY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

async function fetchPawaPayPublicKeys(): Promise<PublicKeyEntry[]> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < KEY_CACHE_TTL_MS) {
    return cachedKeys.keys;
  }
  const res = await fetch(`${pawapayApiBase()}/v2/public-key/http`, {
    headers: { ...pawapayAuthHeaders() },
  });
  if (!res.ok) {
    throw new Error(`Impossible de récupérer les clés publiques PawaPay (HTTP ${res.status}).`);
  }
  const keys = (await res.json()) as PublicKeyEntry[];
  cachedKeys = { keys, fetchedAt: Date.now() };
  return keys;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

// Un en-tête "Signature" PawaPay encode la signature ECDSA au format ASN.1 DER
// (SEQUENCE de deux INTEGER r,s), alors que Web Crypto (algorithme "ECDSA") exige le format
// "raw" IEEE P1363 (r concaténé à s, chacun sur 32 octets pour P-256). On convertit l'un vers
// l'autre nous-mêmes : aucune lib tierce n'est nécessaire pour ça.
function derToRawEcdsaSignature(der: Uint8Array): Uint8Array {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("Signature DER invalide (SEQUENCE attendue).");
  // longueur de la séquence (court ou long format) — on l'ignore, on avance juste correctement
  let seqLen = der[offset++];
  if (seqLen & 0x80) offset += seqLen & 0x7f;

  function readInt(): Uint8Array {
    if (der[offset++] !== 0x02) throw new Error("Signature DER invalide (INTEGER attendu).");
    let len = der[offset++];
    let bytes = der.slice(offset, offset + len);
    offset += len;
    // retire un éventuel octet de padding 0x00 ajouté pour signaler un entier positif
    while (bytes.length > 32 && bytes[0] === 0x00) bytes = bytes.slice(1);
    // pad à gauche jusqu'à 32 octets si l'entier était plus court
    if (bytes.length < 32) {
      const padded = new Uint8Array(32);
      padded.set(bytes, 32 - bytes.length);
      bytes = padded;
    }
    return bytes;
  }

  const r = readInt();
  const s = readInt();
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(s, 32);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

async function sha256Base64(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
async function sha512Base64(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

// Parse l'en-tête Signature-Input, ex. :
//   sig-pp=("@method" "@authority" "@path" "signature-date" "content-digest" "content-type");alg="ecdsa-p256-sha256";keyid="HTTP_EC_P256_KEY:1";created=...;expires=...
function parseSignatureInput(header: string): { label: string; components: string[]; params: string; keyid: string | null } {
  const eq = header.indexOf("=");
  if (eq === -1) throw new Error("Signature-Input invalide.");
  const label = header.slice(0, eq).trim();
  const rest = header.slice(eq + 1).trim();
  const close = rest.indexOf(")");
  if (!rest.startsWith("(") || close === -1) throw new Error("Signature-Input invalide (liste de composants).");
  const compList = rest.slice(1, close);
  const components = compList.split(/\s+/).filter(Boolean).map((c) => c.replace(/^"|"$/g, ""));
  const params = rest.slice(close + 1).replace(/^;/, "");
  const keyidMatch = params.match(/keyid="([^"]+)"/);
  return { label, components, params, keyid: keyidMatch ? keyidMatch[1] : null };
}

// Parse l'en-tête Signature, ex. : sig-pp=:MEQCIH...==:
function parseSignatureHeader(header: string, label: string): Uint8Array {
  const prefix = `${label}=:`;
  const idx = header.indexOf(prefix);
  if (idx === -1) throw new Error("En-tête Signature introuvable pour ce label.");
  const rest = header.slice(idx + prefix.length);
  const end = rest.indexOf(":");
  if (end === -1) throw new Error("En-tête Signature mal formé.");
  return base64ToBytes(rest.slice(0, end));
}

export type SignatureVerification = { ok: boolean; reason?: string };

// Vérifie l'intégrité (Content-Digest) ET l'authenticité (Signature) d'un callback PawaPay.
// `rawBody` doit être le corps BRUT de la requête, exactement comme reçu (avant tout
// JSON.parse), car le digest et la signature portent sur ces octets précis.
export async function verifyPawaPayCallback(req: Request, rawBody: Uint8Array): Promise<SignatureVerification> {
  const sigHeader = req.headers.get("signature");
  const sigInputHeader = req.headers.get("signature-input");
  const digestHeader = req.headers.get("content-digest");
  const dateHeader = req.headers.get("signature-date");
  const contentType = req.headers.get("content-type") ?? "";

  if (!sigHeader || !sigInputHeader || !digestHeader) {
    return { ok: false, reason: "En-têtes de signature PawaPay absents (Signature / Signature-Input / Content-Digest)." };
  }

  // 1) Intégrité du corps : le Content-Digest doit correspondre au corps réellement reçu.
  const digestMatch = digestHeader.match(/^(sha-256|sha-512)=:([^:]+):$/i);
  if (!digestMatch) return { ok: false, reason: "Content-Digest mal formé." };
  const algo = digestMatch[1].toLowerCase();
  const expectedDigest = algo === "sha-512" ? await sha512Base64(rawBody) : await sha256Base64(rawBody);
  if (expectedDigest !== digestMatch[2]) {
    return { ok: false, reason: "Content-Digest ne correspond pas au corps reçu (intégrité compromise)." };
  }

  // 2) Authenticité : reconstruit la "signature base" RFC 9421 et vérifie la signature ECDSA
  //    avec la clé publique PawaPay correspondant au keyid annoncé.
  const parsed = parseSignatureInput(sigInputHeader);
  const lines: string[] = [];
  for (const comp of parsed.components) {
    let value: string | null;
    switch (comp) {
      case "@method": value = req.method.toUpperCase(); break;
      case "@authority": value = new URL(req.url).host.toLowerCase(); break;
      case "@path": value = new URL(req.url).pathname; break;
      case "signature-date": value = dateHeader; break;
      case "content-digest": value = digestHeader; break;
      case "content-type": value = contentType; break;
      default: value = req.headers.get(comp);
    }
    if (value === null || value === undefined) {
      return { ok: false, reason: `Composant de signature manquant : ${comp}.` };
    }
    lines.push(`"${comp}": ${value}`);
  }
  // Dernière ligne de la base de signature (RFC 9421 §2.5) : "@signature-params" suivi de la
  // liste de composants ET des paramètres (alg, keyid, created, expires), repris tels quels
  // depuis l'en-tête Signature-Input reçu (on réutilise les octets reçus plutôt que de les
  // resérialiser nous-mêmes, pour éviter tout écart de formatage).
  const afterLabel = sigInputHeader.slice(sigInputHeader.indexOf("=") + 1);
  lines.push(`"@signature-params": ${afterLabel}`);
  const signatureBase = lines.join("\n");

  if (!parsed.keyid) return { ok: false, reason: "keyid absent de Signature-Input." };
  const keys = await fetchPawaPayPublicKeys();
  const keyEntry = keys.find((k) => k.id === parsed.keyid);
  if (!keyEntry) return { ok: false, reason: `Clé publique PawaPay inconnue pour keyid=${parsed.keyid}.` };

  const publicKey = await crypto.subtle.importKey(
    "spki",
    pemToArrayBuffer(keyEntry.key),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  const derSignature = parseSignatureHeader(sigHeader, parsed.label);
  const rawSignature = derToRawEcdsaSignature(derSignature);

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    rawSignature,
    new TextEncoder().encode(signatureBase),
  );
  return valid ? { ok: true } : { ok: false, reason: "Signature ECDSA invalide." };
}

// ---------------------------------------------------------------------------
// Revérification serveur-à-serveur du statut réel (jamais confiance au corps du callback seul).
// ---------------------------------------------------------------------------

// Forme de réponse de l'API "Check Status" PawaPay (GET /v2/{deposits|payouts|refunds}/{id}) :
// l'enveloppe racine ne porte que FOUND/NOT_FOUND, le statut métier réel (COMPLETED/FAILED/...)
// est dans `data.status`. On gère aussi une forme en tableau par prudence (observée sur
// d'anciennes versions de l'API), sans jamais deviner un statut par défaut autre que "UNKNOWN".
function extractStatus(payload: any): string {
  if (!payload) return "UNKNOWN";
  if (Array.isArray(payload)) return payload[0]?.status ?? "UNKNOWN";
  if (payload.status === "NOT_FOUND") return "NOT_FOUND";
  return payload.data?.status ?? payload.status ?? "UNKNOWN";
}

async function checkStatus(kind: "deposits" | "payouts" | "refunds", id: string): Promise<{ status: string; raw: unknown }> {
  const res = await fetch(`${pawapayApiBase()}/v2/${kind}/${id}`, { headers: pawapayAuthHeaders() });
  const data = await res.json();
  if (!res.ok) {
    console.error(`PawaPay check-status ${kind}/${id} -> HTTP ${res.status}`, data);
    return { status: "UNKNOWN", raw: data };
  }
  return { status: extractStatus(data), raw: data };
}

export function checkDepositStatus(depositId: string) { return checkStatus("deposits", depositId); }
export function checkPayoutStatus(payoutId: string) { return checkStatus("payouts", payoutId); }
export function checkRefundStatus(refundId: string) { return checkStatus("refunds", refundId); }
