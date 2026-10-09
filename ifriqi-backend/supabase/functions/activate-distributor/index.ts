// POST /activate-distributor
// Body: { refCode?: string }  — le code du lien que l'utilisateur a visité avant de s'activer.
//
// Fait côté serveur (pas côté client) pour que la capture du parrain (referred_by) et les
// vérifications anti-fraude ne puissent pas être falsifiées par le navigateur de l'utilisateur.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "IFR-";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const uc = userClient(req.headers.get("Authorization"));
    const { data: { user }, error: authErr } = await uc.auth.getUser();
    if (authErr || !user) return json({ error: "Non authentifié." }, 401);

    const { refCode } = await req.json().catch(() => ({ refCode: undefined }));
    const svc = serviceClient();

    const { data: existing } = await svc.from("distributors").select("*").eq("user_id", user.id).single();
    if (existing) return json({ distributor: existing });

    // éligibilité : avoir au moins un profil avec une carte active
    const { count } = await svc.from("cards").select("id, profiles!inner(user_id)", { count: "exact", head: true }).eq("profiles.user_id", user.id);
    if (!count) return json({ error: "Le statut de distributeur est accessible après l'achat d'une carte." }, 403);

    const { data: me } = await svc.from("app_users").select("*").eq("id", user.id).single();

    let referredBy: string | null = null;
    if (refCode) {
      const { data: ref } = await svc.from("distributors").select("id,user_id,status").eq("code", refCode.toUpperCase()).single();
      if (ref && ref.status === "ACTIVE") {
        const { data: refUser } = await svc.from("app_users").select("*").eq("id", ref.user_id).single();
        const selfReferral = refUser?.id === me?.id ||
          (refUser?.phone && refUser.phone === me?.phone) ||
          (refUser?.email && refUser.email?.toLowerCase() === me?.email?.toLowerCase());
        if (!selfReferral) referredBy = ref.id;
      }
    }

    let code = genCode(), tries = 0;
    while (tries < 5) {
      const { data: clash } = await svc.from("distributors").select("id").eq("code", code).maybeSingle();
      if (!clash) break;
      code = genCode(); tries++;
    }

    const { data: dist, error } = await svc.from("distributors").insert({
      user_id: user.id, code, status: "ACTIVE", referred_by: referredBy,
    }).select().single();
    if (error) { console.error("activate-distributor insert error", error); return json({ error: "Impossible d'activer le statut de distributeur pour le moment." }, 500); }

    return json({ distributor: dist });
  } catch (e) {
    // F-08 (audit pré-prod) : message générique au client, détail réservé aux journaux serveur.
    console.error("activate-distributor error", e);
    return json({ error: "Une erreur est survenue. Réessayez plus tard." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
