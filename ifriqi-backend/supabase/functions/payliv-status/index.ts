// POST /payliv-status — { orderId } — authentifié (verify_jwt=true).
// Permet au site de forcer une relecture serveur-à-serveur du statut PAYLIV d'une commande de
// l'acheteur connecté (filet de sécurité si le webhook tarde). La clé PAYLIV reste côté serveur ;
// la confirmation passe par le même règlement que le webhook (montant/devise/identifiant contrôlés).
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";
import { settlePayliv } from "../_shared/payliv-settle.ts";

const last = new Map<string, number>(); // limitation douce par commande (meilleur effort, par instance)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { data: { user } } = await userClient(req.headers.get("Authorization")).auth.getUser();
    if (!user) return json({ error: "Non authentifié." }, 401);
    const { orderId } = await req.json();
    if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId)) return json({ error: "orderId invalide." }, 400);

    const svc = serviceClient();
    const { data: order } = await svc.from("orders").select("id,customer_id,payment_status").eq("id", orderId).single();
    if (!order || order.customer_id !== user.id) return json({ error: "Commande introuvable." }, 404);
    if (order.payment_status !== "PENDING") return json({ status: order.payment_status });

    const now = Date.now();
    if (now - (last.get(orderId) ?? 0) < 4000) return json({ status: "PENDING", throttled: true });
    last.set(orderId, now);
    if (last.size > 500) last.clear();

    const { data: payment } = await svc.from("payments").select("*").eq("order_id", orderId).eq("provider", "payliv").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!payment) return json({ status: order.payment_status });
    const res = await settlePayliv(svc, payment);
    return json({ status: res.status, failureClass: res.failureClass ?? null });
  } catch (e) {
    console.error("payliv-status error", e);
    return json({ error: "Erreur de vérification." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
