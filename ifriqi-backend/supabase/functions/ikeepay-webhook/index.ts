// POST /ikeepay-webhook — endpoint PUBLIC à renseigner dans le tableau de bord iKeePay comme
// URL de notification pour les transactions H2H (payin) ET Inline Checkout (payin).
//
// Même architecture que pawapay-deposit-callback/index.ts, avec les principes de sécurité
// suivants :
//   1. Vérifie X-ikeepay-signature — voir _shared/ikeepay.ts. CONFIRMÉ le 14/10/2026 via capture
//      de diagnostic (IKEEPAY_DEBUG_CAPTURE=true, webhook réel) : ce n'est PAS un HMAC (contrairement
//      à ce que le support avait annoncé le 12/10) mais la clé secrète du marchand (IKEEPAY_SECRET_KEY)
//      envoyée en clair — vérifiée par comparaison en temps constant. IKEEPAY_REQUIRE_SIGNATURE=false
//      permet de désactiver temporairement cette vérification, UNIQUEMENT pour tester le reste du
//      flux en sandbox, jamais en production.
//   2. Revérification indépendante du `status` porté par le corps du webhook :
//        - Paiements H2H (payments.method === 'ikeepay') : toujours revérifiés via
//          GET /h2h-verify/:reference (verifyTransaction()) avant d'écrire en base — règle
//          inchangée, cet endpoint fonctionne pour ce mode.
//        - Paiements Inline Checkout (payments.method === 'ikeepay_inline') : EXCEPTION
//          confirmée explicitement par l'utilisateur le 14/10/2026, après qu'il a été
//          établi de façon reproductible (deux références différentes testées, dont la
//          référence iKeePay elle-même) que GET /h2h-verify/:reference renvoie
//          systématiquement 404 "Requested function was not found" pour ce type de
//          transaction — la revérification indépendante est donc structurellement
//          impossible pour ce mode, pas seulement non confirmée. Dans ce cas précis, une
//          fois la signature authentifiée (étape 1, secret partagé jamais exposé au
//          navigateur — voir _shared/ikeepay.ts), le `status`/`event` du corps du webhook
//          est accepté comme preuve suffisante de paiement. Ce choix a été posé explicitement
//          à l'utilisateur (compromis sécurité documenté) et confirmé par lui : "Oui,
//          authentifier via signature suffit". Si iKeePay ajoute un jour un endpoint de
//          vérification couvrant l'Inline Checkout, revenir à la double vérification ici.
//   3. Idempotence : même index unique payments(provider, provider_ref) où status='SUCCESS'
//      que pour PawaPay/CinetPay/PayPal (0001_init.sql) — rejouer ce webhook plusieurs fois ne
//      crée jamais plusieurs cartes/commissions pour la même transaction.
//   4. Ne rétrograde jamais un paiement déjà PAID (webhook en retard ou désordonné).
//
// Forme du webhook H2H attendue d'après la doc (section "Intégration H2H" → "4. Webhooks") :
//   { event: "transaction.updated"|"transaction.created",
//     data: { type: "payin"|"payout", external_reference, provider_reference, amount, currency,
//             country, phone_number, operator, status: "completed"|"pending"|"failed", ... } }
// Forme du webhook Inline Checkout CONFIRMÉE en production le 14/10/2026 (voir plus bas) :
//   { event: "payment.success", data: { order_id, amount, currency, reference,
//             customer_email, status: "completed" } }
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { verifyIkeepayWebhookSignature, verifyTransaction } from "../_shared/ikeepay.ts";
import { notifyPaymentConfirmed } from "../_shared/email.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  const rawBody = new Uint8Array(await req.arrayBuffer());

  // ---------------------------------------------------------------------------
  // CAPTURE DE DIAGNOSTIC TEMPORAIRE (2026-10-12) — à retirer une fois le schéma de signature
  // confirmé. Objectif : voir EXACTEMENT ce qu'iKeePay envoie sur un vrai webhook (tous les
  // en-têtes + le corps brut), pour pouvoir calculer plusieurs HMAC candidats (différents
  // secrets/encodages) côté serveur et les comparer à la valeur reçue, au lieu de deviner.
  // N'expose aucun secret : on ne journalise que ce qu'iKeePay nous envoie lui-même.
  // Actif uniquement si IKEEPAY_DEBUG_CAPTURE=true (pour ne pas polluer les logs en continu).
  // ---------------------------------------------------------------------------
  if (Deno.env.get("IKEEPAY_DEBUG_CAPTURE") === "true") {
    const allHeaders: Record<string, string> = {};
    for (const [k, v] of req.headers.entries()) allHeaders[k] = v;
    console.log("IKEEPAY_DEBUG_CAPTURE headers=", JSON.stringify(allHeaders));
    console.log("IKEEPAY_DEBUG_CAPTURE rawBody=", new TextDecoder().decode(rawBody));
  }

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
    // CONFIRMÉ le 14/10/2026 via capture de diagnostic (webhook réel Inline Checkout) : la forme
    // reçue en production est { event: "payment.success", data: { order_id, amount, currency,
    // reference, customer_email, status: "completed" } } — différente de la forme documentée
    // (data.external_reference / data.provider_reference). "order_id" porte en réalité notre
    // propre externalReference (celui généré côté serveur dans create-order), et "reference" porte
    // la référence CÔTÉ IKEEPAY (utile pour verifyTransaction, potentiellement différente de celle
    // qui échoue avec /h2h-verify pour les transactions Inline Checkout). On garde aussi les
    // anciens noms de champs en repli, au cas où le H2H (mode Direct Charge) utilise une forme
    // différente de celle de l'Inline Checkout.
    const externalReference: string | undefined = data?.external_reference ?? data?.order_id ?? payload?.order_id;
    const providerReference: string | undefined = data?.provider_reference ?? data?.reference ?? payload?.ikeepay_ref;
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

    // Revérification serveur-à-serveur : par défaut (H2H), seule cette valeur fait foi, jamais
    // le `status` du corps du webhook. EXCEPTION Inline Checkout (voir commentaire d'en-tête) :
    // GET /h2h-verify ne couvre pas ce mode (confirmé par deux 404 reproductibles avec des
    // références différentes) — la signature ayant déjà été authentifiée plus haut, on accepte
    // directement le statut annoncé par le webhook pour ce mode précis, décision explicitement
    // confirmée par l'utilisateur le 14/10/2026.
    const isInlineCheckout = payment.method === "ikeepay_inline";
    let checked: { status: "completed" | "pending" | "failed" | "cancelled" | "unknown" };
    if (isInlineCheckout) {
      const rawStatus = data?.status ?? payload?.status;
      const eventIsSuccess = payload?.event === "payment.success";
      const status =
        rawStatus === "completed" || (eventIsSuccess && !rawStatus)
          ? "completed"
          : rawStatus === "failed" || payload?.event === "payment.failed"
          ? "failed"
          : rawStatus === "cancelled" || payload?.event === "payment.cancelled"
          ? "cancelled"
          : rawStatus === "pending"
          ? "pending"
          : "unknown";
      console.warn(
        "ikeepay-webhook: paiement Inline Checkout — statut accepté sur la seule foi du webhook signé (h2h-verify non disponible pour ce mode) :",
        status,
      );
      checked = { status };
    } else {
      checked = await verifyTransaction(providerReference ?? externalReference);
    }

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
      // E-mail de confirmation : paiement validé côté serveur (webhook authentifié) uniquement. Ne lève jamais :
      // un échec d'e-mail n'a aucun effet sur l'état du paiement/de la commande déjà écrit ci-dessus.
      await notifyPaymentConfirmed(payment.order_id);
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
