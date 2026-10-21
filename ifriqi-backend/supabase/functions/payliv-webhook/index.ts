// POST /payliv-webhook — endpoint PUBLIC (verify_jwt=false) à renseigner comme webhook_url PAYLIV
// (create-order l'envoie automatiquement à chaque paiement : <SUPABASE_URL>/functions/v1/payliv-webhook).
//
//   1. Signature X-Webhook-Signature = HMAC-SHA256 hex du CORPS BRUT avec PAYLIV_WEBHOOK_SECRET,
//      comparaison en temps constant (voir _shared/payliv.ts). Invalide/absente -> 401, rien d'écrit.
//   2. Le corps n'est qu'une NOTIFICATION : le statut est relu chez PAYLIV avec la clé secrète et le
//      montant / la devise / l'identifiant sont contrôlés (voir _shared/payliv-settle.ts).
//   3. Idempotent : un même paiement notifié 3 fois ne crée qu'une carte et qu'une série de commissions.
//   4. PAYLIV attend un 200 en moins de 10 s et réessaie 3 fois en cas d'échec : on répond 200 dès que
//      la notification est traitée (y compris « en attente »), 5xx seulement si une relecture est utile.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { verifyWebhookSignature } from "../_shared/payliv.ts";
import { settlePayliv } from "../_shared/payliv-settle.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  const rawBody = new Uint8Array(await req.arrayBuffer());
  try {
    if (!(await verifyWebhookSignature(rawBody, req.headers.get("X-Webhook-Signature")))) {
      console.error("payliv-webhook: signature invalide ou absente");
      return json({ error: "Signature invalide." }, 401);
    }
    let payload: Record<string, any> = {};
    try { payload = JSON.parse(new TextDecoder().decode(rawBody)); } catch { return json({ error: "Corps illisible." }, 400); }
    // Tolère le corps plat (doc Mobile Money) et la forme { data: { id, status, ... } } (exemple Node).
    const evt: Record<string, any> = payload.data && typeof payload.data === "object" ? { ...payload, ...payload.data } : payload;
    const paymentId = String(evt.payment_id ?? evt.id ?? "");
    const metaOrder = evt.metadata && typeof evt.metadata === "object" ? String(evt.metadata.orderId ?? "") : "";
    if (!paymentId && !metaOrder) return json({ error: "Identifiant de paiement manquant." }, 400);

    const svc = serviceClient();
    let payment: Record<string, any> | null = null;
    if (paymentId) {
      const { data } = await svc.from("payments").select("*").eq("provider", "payliv").eq("provider_ref", paymentId).maybeSingle();
      payment = data;
    }
    // Repli : le paiement PAYLIV a été créé mais notre ligne payments n'a pas pu être écrite (coupure) ->
    // on la retrouve par notre numéro de commande placé dans metadata, puis on lui rattache l'identifiant.
    if (!payment && metaOrder && /^[0-9a-f-]{36}$/i.test(metaOrder)) {
      const { data } = await svc.from("payments").select("*").eq("provider", "payliv").eq("order_id", metaOrder).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (data && (!data.provider_ref || data.provider_ref === paymentId)) {
        payment = data;
        if (!data.provider_ref && paymentId) {
          await svc.from("payments").update({ provider_ref: paymentId }).eq("id", data.id);
          payment = { ...data, provider_ref: paymentId };
        }
      }
    }
    if (!payment) {
      console.error("payliv-webhook: paiement introuvable", paymentId, metaOrder);
      return json({ error: "Paiement introuvable." }, 404);
    }

    const res = await settlePayliv(svc, payment);
    if (res.status === "PENDING" && (res.reason === "status_unavailable")) {
      return json({ status: "PENDING", retry: true }, 503); // PAYLIV réessaiera
    }
    return json(res);
  } catch (e) {
    console.error("payliv-webhook error", e);
    return json({ error: "Une erreur est survenue lors du traitement de la notification." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
