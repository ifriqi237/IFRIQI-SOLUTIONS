// POST /payment-webhook — endpoint PUBLIC appelé par CinetPay / PayPal après un paiement.
//
// Règle de sécurité n°1 : on ne fait JAMAIS confiance au contenu brut envoyé par le webhook
// (un attaquant peut rejouer/forger une requête HTTP). On revérifie toujours le statut
// directement auprès du prestataire via son API serveur-à-serveur avant de marquer un
// paiement SUCCESS.
//
// Règle de sécurité n°2 (idempotence) : que ce webhook soit livré 1 fois ou 50 fois pour la
// même transaction, le résultat en base doit être identique. Ceci est garanti à deux niveaux :
//   - payments : index unique (provider, provider_ref) où status='SUCCESS'
//   - commissions : contrainte UNIQUE(order_id, level) + ON CONFLICT DO NOTHING
// donc même si ce code s'exécute deux fois en parallèle, aucune double écriture n'est possible.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const svc = serviceClient();
  try {
    const url = new URL(req.url);
    const payload = await safeParseBody(req);

    // F-03 (audit pré-prod) : l'ancienne logique retombait TOUJOURS sur "cinetpay" par défaut
    // (un ternaire dont les deux branches valaient "cinetpay"), donc un webhook PayPal mal
    // configuré était silencieusement traité comme du CinetPay — un client payant par PayPal
    // pouvait ne jamais recevoir sa carte, sans erreur visible. Désormais : le prestataire doit
    // être explicite dans l'URL de notification (?provider=cinetpay ou ?provider=paypal, voir
    // le README section 3) ; à défaut, on tente une détection par en-tête propre à chaque
    // prestataire, et si c'est toujours ambigu on REFUSE plutôt que de deviner.
    const qp = url.searchParams.get("provider");
    const provider = qp
      ?? (req.headers.get("paypal-transmission-id") ? "paypal" : null)
      ?? (req.headers.get("x-cinetpay-token") ? "cinetpay" : null);

    if (!provider) {
      console.error("payment-webhook: provider indéterminé", { headers: [...req.headers.keys()] });
      return json({ error: "provider manquant : configurez l'URL de notification avec ?provider=cinetpay ou ?provider=paypal." }, 400);
    }

    let transactionRef: string | null = null;
    let verified: { ok: boolean } = { ok: false };

    if (provider === "cinetpay") {
      transactionRef = payload.cpm_trans_id ?? payload.transaction_id ?? null;
      if (!transactionRef) return json({ error: "transaction_id manquant" }, 400);
      verified = await verifyCinetpay(transactionRef);
    } else if (provider === "paypal") {
      transactionRef = payload.resource?.id ?? payload.id ?? null;
      if (!transactionRef) return json({ error: "order id manquant" }, 400);
      verified = await verifyPaypal(req, payload, transactionRef);
    } else {
      return json({ error: "provider inconnu" }, 400);
    }

    // Retrouve le paiement correspondant (créé par create-order) via sa référence.
    const { data: payment } = await svc.from("payments").select("*").eq("provider", provider).eq("provider_ref", transactionRef).single();
    if (!payment) return json({ error: "Paiement introuvable pour cette référence." }, 404);

    if (!verified.ok) {
      await svc.from("payments").update({ status: "FAILED" }).eq("id", payment.id);
      await svc.from("orders").update({ payment_status: "FAILED" }).eq("id", payment.order_id);
      return json({ status: "FAILED" });
    }

    // Idempotence niveau DB : si ce paiement est déjà SUCCESS, l'UPDATE ci-dessous est un no-op
    // logique (on ne fait que réécrire le même état), et create_commissions_for_order() est
    // lui-même protégé par la contrainte UNIQUE(order_id, level) — donc rejouer ce webhook
    // 10 fois ne crée jamais 10 commissions.
    await svc.from("payments").update({ status: "SUCCESS", paid_at: new Date().toISOString(), raw_payload: payload }).eq("id", payment.id);
    await svc.from("orders").update({ payment_status: "PAID" }).eq("id", payment.order_id);
    await svc.rpc("create_commissions_for_order", { p_order_id: payment.order_id });

    // F-05 (audit pré-prod) : émet réellement la carte dès que le paiement est confirmé, plutôt
    // que de laisser cette étape manquante. issue_card_for_order() est idempotente (ON CONFLICT
    // n'est pas nécessaire : elle vérifie elle-même si une carte existe déjà pour ce profil).
    // Le jeton QR en clair n'est pas renvoyé ici (ce endpoint répond au prestataire de paiement,
    // pas au navigateur du client) : le front le récupère ensuite via /claim-card, une seule fois.
    const { data: order } = await svc.from("orders").select("product").eq("id", payment.order_id).single();
    if (order?.product === "card") {
      const { error: issueErr } = await svc.rpc("issue_card_for_order", { p_order_id: payment.order_id });
      if (issueErr) console.error("issue_card_for_order failed from webhook", issueErr);
    }

    return json({ status: "PAID" });
  } catch (e) {
    // F-08 (audit pré-prod) : ne jamais renvoyer le détail technique brut (String(e)) au webhook
    // appelant — on le journalise côté serveur (visible dans les logs Supabase) et on renvoie un
    // message générique.
    console.error("payment-webhook error", e);
    return json({ error: "Une erreur est survenue lors du traitement du paiement." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function safeParseBody(req: Request): Promise<Record<string, any>> {
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return await req.json();
    const form = await req.formData();
    const obj: Record<string, any> = {};
    for (const [k, v] of form.entries()) obj[k] = v;
    return obj;
  } catch { return {}; }
}

// Revérifie le statut réel auprès de CinetPay (endpoint "check") plutôt que de faire confiance
// au contenu du POST reçu, conformément à leur documentation.
async function verifyCinetpay(transactionId: string): Promise<{ ok: boolean }> {
  const apikey = Deno.env.get("CINETPAY_APIKEY");
  const siteId = Deno.env.get("CINETPAY_SITE_ID");
  if (!apikey || !siteId) return { ok: transactionId.startsWith("SANDBOX-") }; // mode démo sans clés réelles
  const res = await fetch("https://api-checkout.cinetpay.com/v2/payment/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey, site_id: siteId, transaction_id: transactionId }),
  });
  const data = await res.json();
  return { ok: data?.data?.status === "ACCEPTED" };
}

// F-04 (audit pré-prod) : auparavant, ce webhook ne faisait qu'une capture directe de la
// commande PayPal, sans jamais vérifier une signature de webhook officielle — ce qui marche pour
// le flux "retour du client après approbation", mais n'est pas une vérification de webhook au
// sens de PayPal (aucun abonnement webhook n'était créé côté PayPal non plus). On distingue
// maintenant deux cas :
//   1. Vrai webhook PayPal (en-têtes paypal-transmission-* présents) : on vérifie la signature
//      officielle via /v1/notifications/verify-webhook-signature, comme documenté par PayPal.
//      Nécessite PAYPAL_WEBHOOK_ID (créé en configurant un abonnement webhook dans le dashboard
//      PayPal — ÉTAPE MANUELLE qui reste à faire, voir README section 3).
//   2. Retour direct du client après approbation (pas d'en-têtes webhook) : on capture la
//      commande serveur-à-serveur, ce qui est la vérification elle-même (si la capture réussit,
//      le paiement est réel).
async function verifyPaypal(req: Request, payload: Record<string, any>, orderId: string): Promise<{ ok: boolean }> {
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const secret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  if (!clientId || !secret) return { ok: orderId.startsWith("SANDBOX-") };
  const base = (Deno.env.get("PAYPAL_ENV") ?? "sandbox") === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

  const tokRes = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Authorization": "Basic " + btoa(`${clientId}:${secret}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const tok = await tokRes.json();

  const isOfficialWebhook = !!req.headers.get("paypal-transmission-id");
  if (isOfficialWebhook) {
    const webhookId = Deno.env.get("PAYPAL_WEBHOOK_ID");
    if (!webhookId) {
      console.error("PAYPAL_WEBHOOK_ID absent : impossible de vérifier la signature du webhook PayPal.");
      return { ok: false };
    }
    const verifyRes = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: req.headers.get("paypal-auth-algo"),
        cert_url: req.headers.get("paypal-cert-url"),
        transmission_id: req.headers.get("paypal-transmission-id"),
        transmission_sig: req.headers.get("paypal-transmission-sig"),
        transmission_time: req.headers.get("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: payload,
      }),
    });
    const verify = await verifyRes.json();
    if (verify.verification_status !== "SUCCESS") return { ok: false };
    // Signature confirmée authentique PayPal : on peut faire confiance au statut porté par
    // l'événement lui-même (pas besoin d'une capture supplémentaire pour un événement
    // PAYMENT.CAPTURE.COMPLETED / CHECKOUT.ORDER.APPROVED déjà signé par PayPal).
    const eventType = payload.event_type ?? "";
    return { ok: eventType.includes("COMPLETED") || eventType.includes("APPROVED") };
  }

  // Retour direct du client (pas d'en-têtes de webhook officiel) : la capture serveur-à-serveur
  // EST la vérification — si PayPal répond COMPLETED, l'argent a réellement été débité.
  const capRes = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
  });
  const cap = await capRes.json();
  return { ok: cap.status === "COMPLETED" };
}
