// POST /pawapay-deposit-callback — endpoint PUBLIC à renseigner dans le Dashboard PawaPay,
// champ "Callback URL" pour les DÉPÔTS (deposits).
//
// Sécurité (même principe que payment-webhook pour CinetPay/PayPal) :
//   1. Vérifie la signature HTTP du callback (RFC 9421, clé publique PawaPay) — voir
//      _shared/pawapay.ts. Un callback non signé ou mal signé est rejeté (401), SAUF si
//      PAWAPAY_REQUIRE_SIGNATURE=false (à n'utiliser qu'en tout début de test, avant d'avoir
//      activé "signed callbacks" dans le Dashboard PawaPay).
//   2. Ne fait jamais confiance au `status` porté par le corps du callback : revérifie le
//      statut réel auprès de l'API PawaPay (Check Deposit Status) avant d'écrire en base.
//   3. Idempotence : index unique payments(provider, provider_ref) où status='SUCCESS'
//      (0001_init.sql) — rejouer ce callback 50 fois ne crée jamais 50 cartes/commissions.
//
// Doit répondre HTTP 200 dans les 15 minutes pour que PawaPay considère le callback comme
// livré (voir https://docs.pawapay.io/v2/docs/what_to_know#callbacks).
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { verifyPawaPayCallback, checkDepositStatus } from "../_shared/pawapay.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  const rawBody = new Uint8Array(await req.arrayBuffer());

  try {
    const requireSignature = Deno.env.get("PAWAPAY_REQUIRE_SIGNATURE") !== "false";
    if (requireSignature) {
      const verif = await verifyPawaPayCallback(req, rawBody);
      if (!verif.ok) {
        console.error("pawapay-deposit-callback: signature invalide", verif.reason);
        return json({ error: "Signature invalide." }, 401);
      }
    } else {
      console.warn("pawapay-deposit-callback: vérification de signature DÉSACTIVÉE (PAWAPAY_REQUIRE_SIGNATURE=false) — à ne jamais faire en production.");
    }

    const payload = safeJsonParse(rawBody);
    const depositId: string | undefined = payload?.depositId;
    if (!depositId) return json({ error: "depositId manquant." }, 400);

    // Revérification serveur-à-serveur : seule cette valeur fait foi, jamais payload.status.
    const checked = await checkDepositStatus(depositId);

    const svc = serviceClient();
    const { data: payment } = await svc.from("payments").select("*").eq("provider", "pawapay").eq("provider_ref", depositId).single();
    if (!payment) {
      // Ce dépôt n'a pas été initié par notre create-order (ou l'initiation PawaPay n'est
      // pas encore branchée côté create-order). On journalise et on répond proprement :
      // PawaPay réessaiera pendant 15 min, ce qui laisse le temps de corriger côté intégration.
      console.error("pawapay-deposit-callback: aucun paiement pawapay avec provider_ref=", depositId);
      return json({ error: "Paiement introuvable pour ce depositId." }, 404);
    }

    if (checked.status === "COMPLETED") {
      await svc.from("payments").update({ status: "SUCCESS", paid_at: new Date().toISOString(), raw_payload: payload }).eq("id", payment.id);
      await svc.from("orders").update({ payment_status: "PAID" }).eq("id", payment.order_id);
      await svc.rpc("create_commissions_for_order", { p_order_id: payment.order_id });

      const { data: order } = await svc.from("orders").select("product").eq("id", payment.order_id).single();
      if (order?.product === "card") {
        const { error: issueErr } = await svc.rpc("issue_card_for_order", { p_order_id: payment.order_id });
        if (issueErr) console.error("issue_card_for_order failed from pawapay-deposit-callback", issueErr);
      }
      return json({ status: "PAID" });
    }

    if (checked.status === "FAILED" || checked.status === "REJECTED") {
      await svc.from("payments").update({ status: "FAILED", raw_payload: payload }).eq("id", payment.id);
      await svc.from("orders").update({ payment_status: "FAILED" }).eq("id", payment.order_id);
      return json({ status: "FAILED" });
    }

    // Statut encore non final (ex. ACCEPTED/ENQUEUED) : on accuse réception sans modifier la
    // base — un callback ultérieur apportera le statut final.
    return json({ status: checked.status });
  } catch (e) {
    console.error("pawapay-deposit-callback error", e);
    return json({ error: "Une erreur est survenue lors du traitement du dépôt." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function safeJsonParse(bytes: Uint8Array): any {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; }
}
