// POST /auth-auto-confirm — mesure TEMPORAIRE.
//
// Ce projet Supabase a "Confirm email" activé côté Auth, mais aucun fournisseur SMTP réel
// n'est pour l'instant configuré (Authentication → Settings → SMTP Settings) : l'email de
// confirmation n'est donc jamais réellement envoyé à personne. Résultat : toute inscription
// restait bloquée pour toujours, avec "Email not confirmed" au moment de se connecter.
//
// En attendant qu'un SMTP réel soit branché et testé, cette fonction confirme IMMÉDIATEMENT
// le compte concerné, via l'API admin (service_role). Deux points d'appel côté frontend
// (AuthBridge) :
//   - signUp() : juste après sb.auth.signUp(), avec { user_id } (le compte vient de se
//     créer, son UUID n'est connu de personne d'autre que lui — pas de preuve supplémentaire
//     nécessaire ici).
//   - signIn() : en repli, UNIQUEMENT si signInWithPassword() a d'abord échoué avec
//     "Email not confirmed", avec { email, password }.
//
// AUDIT DE SÉCURITÉ (2026-10-13) — faille corrigée ici :
//   Avant cette version, le chemin { email } ne revérifiait RIEN côté serveur : il se
//   contentait de faire confiance au fait que le FRONTEND avait déjà appelé
//   signInWithPassword() avant d'arriver ici. Or rien n'empêche un appel direct à cet
//   endpoint public (verify_jwt=false) avec n'importe quel email, sans jamais fournir de mot
//   de passe — ce qui permettait (a) de confirmer de force n'importe quel compte tiers non
//   confirmé, et (b) d'énumérer les comptes existants via la différence 404/200. Conformément
//   à la règle "ne jamais considérer une vérification faite uniquement côté frontend comme
//   suffisante", le mot de passe est désormais EXIGÉ et REVÉRIFIÉ ici même (via un client
//   anon, exactement comme le ferait le frontend) avant toute confirmation. La réponse
//   d'échec est volontairement générique (ne distingue pas "compte inconnu" de "mot de passe
//   incorrect") pour ne pas rouvrir la même fuite d'énumération sous une autre forme.
//
// À RETIRER (et à retirer des deux appels correspondants dans AuthBridge) une fois un
// fournisseur SMTP réel configuré et le flux de confirmation par email testé en conditions
// réelles.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  try {
    const { user_id, email, password } = await req.json().catch(() => ({}));
    const svc = serviceClient();
    let uid: string | undefined = typeof user_id === "string" ? user_id : undefined;

    if (!uid) {
      // Chemin par email : exige désormais le mot de passe et le revérifie ici même, plutôt
      // que de faire confiance à une vérification supposée déjà faite côté frontend.
      if (typeof email !== "string" || !email || typeof password !== "string" || !password) {
        return json({ error: "user_id, ou email et password, sont requis." }, 400);
      }
      const anon = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { auth: { persistSession: false } },
      );
      const { error: signInErr } = await anon.auth.signInWithPassword({ email, password });
      // Supabase Auth valide le mot de passe AVANT de bloquer sur la confirmation d'email :
      // un échec "Email not confirmed" signifie donc que le mot de passe fourni est correct.
      // Tout autre résultat (mot de passe incorrect, compte inconnu, ou succès direct — rien
      // à confirmer dans ce dernier cas) reçoit la même réponse générique, pour ne jamais
      // révéler si le compte existe.
      if (!signInErr || !/email not confirmed/i.test(signInErr.message || "")) {
        return json({ error: "Identifiants invalides ou confirmation non nécessaire." }, 401);
      }
      const { data: row, error: lookupErr } = await svc
        .schema("auth")
        .from("users")
        .select("id")
        .ilike("email", email)
        .maybeSingle();
      if (lookupErr || !row) {
        // Ne devrait normalement pas arriver si signInWithPassword a renvoyé "email not
        // confirmed" juste au-dessus, mais on garde la même réponse générique par prudence.
        return json({ error: "Identifiants invalides ou confirmation non nécessaire." }, 401);
      }
      uid = row.id as string;
    }

    const { error } = await svc.auth.admin.updateUserById(uid, { email_confirm: true });
    if (error) {
      console.error("auth-auto-confirm: updateUserById a échoué", error);
      return json({ error: "Impossible de confirmer ce compte pour le moment." }, 500);
    }
    return json({ confirmed: true });
  } catch (e) {
    console.error("auth-auto-confirm error", e);
    return json({ error: "Une erreur est survenue." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
