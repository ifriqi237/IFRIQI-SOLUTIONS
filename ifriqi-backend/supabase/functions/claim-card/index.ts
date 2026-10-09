// POST /claim-card
// Body: { orderId: string }
//
// Appelé par le front, authentifié, juste après qu'une commande est passée au statut PAID
// (soit en réponse immédiate à un retour de paiement, soit après un rafraîchissement : le
// client peut rappeler cette fonction sans risque, elle est idempotente).
//
// F-05 (audit pré-prod) : avant cette fonction, rien ne créait réellement la carte (QR + numéro
// public) côté serveur. Elle appelle issue_card_for_order() (SECURITY DEFINER, voir la migration
// 0002) qui génère la carte si besoin, puis renvoie le jeton QR en clair UNE SEULE FOIS : il est
// ensuite effacé de la base (colonne pending_token remise à NULL). Si le jeton a déjà été
// récupéré précédemment, cette fonction ne renvoie plus que le numéro public de la carte, jamais
// un nouveau jeton — pour obtenir un nouveau jeton il faut explicitly régénérer le QR (fonctionnalité
// "renouveler mon QR" du prototype, pas encore branchée ici).
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const uc = userClient(req.headers.get("Authorization"));
    const { data: { user }, error: authErr } = await uc.auth.getUser();
    if (authErr || !user) return json({ error: "Non authentifié." }, 401);

    const { orderId } = await req.json().catch(() => ({ orderId: undefined }));
    if (!orderId) return json({ error: "orderId requis." }, 400);

    const svc = serviceClient();

    // Defense in depth : même si RLS protège déjà la lecture, on revérifie explicitement que
    // la commande appartient bien à l'appelant avant d'émettre quoi que ce soit pour elle.
    const { data: order } = await svc.from("orders").select("id,customer_id,profile_id,payment_status,product").eq("id", orderId).single();
    if (!order || order.customer_id !== user.id) {
      return json({ error: "Commande introuvable ou non autorisée." }, 403);
    }
    if (order.payment_status !== "PAID" || order.product !== "card") {
      return json({ error: "Cette commande n'est pas une carte payée." }, 409);
    }

    const { data: issued, error: issueErr } = await svc.rpc("issue_card_for_order", { p_order_id: orderId }).single();
    if (issueErr) {
      console.error("issue_card_for_order failed", issueErr);
      return json({ error: "Impossible d'émettre la carte pour le moment. Réessayez plus tard." }, 500);
    }

    const { data: card } = await svc.from("cards").select("public_id,pending_token,status").eq("profile_id", order.profile_id).single();
    const token = card?.pending_token ?? null;
    if (token) {
      // Remise à zéro immédiate : ce jeton ne sera plus jamais renvoyé en clair par cette route.
      await svc.from("cards").update({ pending_token: null }).eq("profile_id", order.profile_id);
    }

    return json({
      publicId: card?.public_id ?? (issued as { public_id: string } | null)?.public_id,
      status: card?.status ?? "ACTIVE",
      token, // null si déjà récupéré précédemment — le front doit le gérer (carte déjà générée).
    });
  } catch (e) {
    console.error("claim-card error", e);
    return json({ error: "Une erreur est survenue. Réessayez plus tard." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
