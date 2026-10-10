// POST /pawapay-refund-callback — endpoint PUBLIC à renseigner dans le Dashboard PawaPay,
// champ "Callback URL" pour les REMBOURSEMENTS (refunds).
//
// IMPORTANT — comme pour pawapay-payout-callback : cet endpoint REÇOIT et traite les
// notifications de statut final d'un remboursement PawaPay. Aucun code de ce dépôt n'appelle
// encore l'API "Initiate Refund" de PawaPay (aucun bouton "rembourser" côté distributeur/admin
// n'existe dans le prototype actuel). Tant que cette initiation n'est pas ajoutée (et que
// payments.refund_provider/refund_ref ne sont pas renseignés au moment où un remboursement est
// demandé), ce callback répondra 404 pour tout refundId réel reçu — comportement attendu.
//
// Sécurité : même principe que les deux autres callbacks PawaPay (signature RFC 9421 +
// revérification serveur-à-serveur du statut réel auprès de PawaPay).
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { verifyPawaPayCallback, checkRefundStatus } from "../_shared/pawapay.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  const rawBody = new Uint8Array(await req.arrayBuffer());

  try {
    const requireSignature = Deno.env.get("PAWAPAY_REQUIRE_SIGNATURE") !== "false";
    if (requireSignature) {
      const verif = await verifyPawaPayCallback(req, rawBody, "/functions/v1/pawapay-refund-callback");
      if (!verif.ok) {
        console.error("pawapay-refund-callback: signature invalide", verif.reason);
        return json({ error: "Signature invalide." }, 401);
      }
    } else {
      console.warn("pawapay-refund-callback: vérification de signature DÉSACTIVÉE (PAWAPAY_REQUIRE_SIGNATURE=false) — à ne jamais faire en production.");
    }

    const payload = safeJsonParse(rawBody);
    const refundId: string | undefined = payload?.refundId;
    if (!refundId) return json({ error: "refundId manquant." }, 400);

    const checked = await checkRefundStatus(refundId);

    const svc = serviceClient();
    const { data: payment } = await svc.from("payments").select("*").eq("refund_provider", "pawapay").eq("refund_ref", refundId).single();
    if (!payment) {
      console.error("pawapay-refund-callback: aucun paiement avec refund_ref=", refundId);
      return json({ error: "Paiement introuvable pour ce refundId." }, 404);
    }

    if (checked.status === "COMPLETED") {
      // Idempotent : index unique payments(refund_provider, refund_ref) où refund_ref non null
      // (0003_pawapay.sql) — un callback rejoué ne modifie pas deux fois le même paiement, et
      // refund_order() elle-même ne touche que les commandes encore 'PAID' (0001_init.sql).
      await svc.from("payments").update({ refunded_at: new Date().toISOString(), raw_payload: payload }).eq("id", payment.id);
      await svc.rpc("refund_order", { p_order_id: payment.order_id });
      return json({ status: "REFUNDED" });
    }

    if (checked.status === "FAILED" || checked.status === "REJECTED") {
      console.error("pawapay-refund-callback: remboursement échoué côté PawaPay", { refundId, status: checked.status });
      return json({ status: checked.status });
    }

    return json({ status: checked.status });
  } catch (e) {
    console.error("pawapay-refund-callback error", e);
    return json({ error: "Une erreur est survenue lors du traitement du remboursement." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function safeJsonParse(bytes: Uint8Array): any {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; }
}
