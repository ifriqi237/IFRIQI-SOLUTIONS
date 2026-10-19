// POST /request-password-reset { email }
// Public (verify_jwt=false) : l'utilisateur n'est pas connecté.
//
// Sécurité :
//  * Réponse TOUJOURS identique (200 {ok:true}) que le compte existe ou non → pas d'énumération
//    de comptes. Le travail réel est fait en arrière-plan (temps de réponse constant).
//  * Limites : 3 demandes / heure / adresse, 40 / heure au total (protège le quota Resend et
//    la boîte des clients contre le spam).
//  * Le lien contient le token_hash Supabase (usage unique, 1 h) ; la vérification et le
//    changement de mot de passe se font côté navigateur via verifyOtp + updateUser : le mot de
//    passe ne transite jamais par cette fonction. Le jeton est effacé de l'outbox après envoi.
//  * L'e-mail part via le service Resend centralisé (outbox idempotente).
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { emailConfig, queueEmail } from "../_shared/email.ts";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PER_EMAIL_HOUR = 3;
const GLOBAL_HOUR = 40;

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function work(email: string) {
  try {
    const svc = serviceClient();
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count: mine } = await svc.from("email_outbox").select("id", { count: "exact", head: true })
      .eq("kind", "password_reset").eq("to_email", email).gte("created_at", since);
    if ((mine ?? 0) >= PER_EMAIL_HOUR) return;
    const { count: all } = await svc.from("email_outbox").select("id", { count: "exact", head: true })
      .eq("kind", "password_reset").gte("created_at", since);
    if ((all ?? 0) >= GLOBAL_HOUR) { console.warn("password reset: plafond horaire global atteint"); return; }

    // Compte inconnu → erreur ici : on s'arrête en silence (même réponse côté client).
    const { data, error } = await svc.auth.admin.generateLink({ type: "recovery", email });
    const th = data?.properties?.hashed_token;
    if (error || !th) return;
    const cfg = emailConfig();
    const resetUrl = `${cfg.appUrl}/#/reset?th=${encodeURIComponent(th)}`;
    const { data: u } = await svc.from("app_users").select("first_name").eq("email", email).maybeSingle();
    await queueEmail("password_reset", email, { firstName: u?.first_name ?? "", resetUrl }, `pwreset:${crypto.randomUUID()}`, { direct: true });
  } catch (e) {
    console.error("password reset:", String((e as Error)?.message ?? e));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Méthode non autorisée." }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const body = await req.json().catch(() => ({}));
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return new Response(JSON.stringify({ error: "Adresse e-mail invalide." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const job = work(email);
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(job); else await job;
  return ok();
});
