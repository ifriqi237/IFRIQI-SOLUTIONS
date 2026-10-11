// POST /submit-support — endpoint PUBLIC (sans JWT, verify_jwt=false) : appelé depuis la page
// Contact. Doit rester accessible sans compte — un visiteur qui n'a pas encore créé de carte
// doit pouvoir écrire au support.
//
// F-20 (2026-10-11) : avant cette fonction, sendSupport() (public/ifriqi.html) faisait
// db.support.push({...}) puis save() — c'est-à-dire qu'elle stockait le message UNIQUEMENT
// dans le localStorage du navigateur de l'expéditeur. Aucun message envoyé via le formulaire
// de contact n'a donc jamais été réellement reçu par qui que ce soit : la personne voyait un
// toast de confirmation ("Message envoyé"), mais le message ne quittait jamais son propre
// appareil. Corrigé en écrivant réellement en base (table support_messages), lue ensuite par
// admin-api (onglet "Support").
//
// Si l'appelant est authentifié (en-tête Authorization présent et valide), user_id est rempli ;
// sinon le message reste anonyme (contact = le champ saisi dans le formulaire, obligatoire).
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const category = typeof body.category === "string" ? body.category.slice(0, 100) : null;
    const contact = typeof body.contact === "string" ? body.contact.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!contact || !message) return json({ error: "contact et message sont requis." }, 400);
    if (contact.length > 300) return json({ error: "contact trop long." }, 400);
    if (message.length > 5000) return json({ error: "message trop long." }, 400);

    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      try {
        const uc = userClient(authHeader);
        const { data: { user } } = await uc.auth.getUser();
        userId = user?.id ?? null;
      } catch {
        userId = null;
      }
    }

    const svc = serviceClient();
    const { data, error } = await svc
      .from("support_messages")
      .insert({ user_id: userId, category, contact, message })
      .select()
      .single();
    if (error) {
      console.error("submit-support: insert a échoué", error);
      return json({ error: "Une erreur est survenue lors de l'envoi du message." }, 500);
    }
    return json({ message: data });
  } catch (e) {
    console.error("submit-support error", e);
    return json({ error: "Une erreur est survenue." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
