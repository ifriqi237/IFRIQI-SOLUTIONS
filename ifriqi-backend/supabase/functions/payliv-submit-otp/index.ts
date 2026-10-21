// POST /payliv-submit-otp — { orderId, otp } — authentifié (verify_jwt=true).
// Certains opérateurs (ex. Orange Burkina Faso / Côte d'Ivoire en USSD manuel) renvoient requires_otp:true :
// le client compose un code USSD, reçoit un OTP, et le saisit sur le site. On le relaie à PAYLIV
// (POST /api-payments-submit-otp). L'OTP n'est jamais journalisé ni stocké.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";
import { submitOtp } from "../_shared/payliv.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { data: { user } } = await userClient(req.headers.get("Authorization")).auth.getUser();
    if (!user) return json({ error: "Non authentifié." }, 401);
    const { orderId, otp } = await req.json();
    if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId)) return json({ error: "orderId invalide." }, 400);
    if (typeof otp !== "string" || !/^\d{3,8}$/.test(otp.trim())) return json({ error: "Code invalide." }, 400);

    const svc = serviceClient();
    const { data: order } = await svc.from("orders").select("id,customer_id,payment_status").eq("id", orderId).single();
    if (!order || order.customer_id !== user.id) return json({ error: "Commande introuvable." }, 404);
    if (order.payment_status !== "PENDING") return json({ error: "Cette commande n'attend plus de code." }, 409);
    const { data: payment } = await svc.from("payments").select("provider_ref,status").eq("order_id", orderId).eq("provider", "payliv").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!payment?.provider_ref || payment.status !== "PENDING") return json({ error: "Paiement introuvable." }, 404);

    const r = await submitOtp(payment.provider_ref, otp.trim());
    if (!r.ok) return json({ error: "Code refusé ou expiré. Vérifiez-le et réessayez." }, 422);
    return json({ ok: true });
  } catch (e) {
    console.error("payliv-submit-otp error", e instanceof Error ? e.name : e);
    return json({ error: "Erreur lors de l'envoi du code." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
