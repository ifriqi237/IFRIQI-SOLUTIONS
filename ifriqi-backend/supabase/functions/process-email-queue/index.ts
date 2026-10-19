// POST /process-email-queue — maintenance de la boîte d'envoi e-mail. Protégée par EMAIL_QUEUE_SECRET
// (en-tête x-email-queue-secret) ; verify_jwt=false car appelée par un planificateur, pas par un utilisateur.
//   { action: "drain" }                  -> reprend les e-mails en attente / en échec échus
//   { action: "status" }                 -> état de configuration (booléens) + compteurs par statut
//   { action: "test", to: "a@b.c" }      -> envoie un e-mail de test (clé idempotente unique)
// Ne renvoie jamais de valeur de secret.
import { serviceClient } from "../_shared/supabase.ts";
import { drainOutbox, emailConfig, queueEmail } from "../_shared/email.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  const secret = Deno.env.get("EMAIL_QUEUE_SECRET") || "";
  const given = req.headers.get("x-email-queue-secret") || "";
  if (!secret || !safeEqual(secret, given)) return json({ error: "Non autorisé." }, 401);
  try {
    const { action, to } = await req.json().catch(() => ({}));
    const cfg = emailConfig();
    if (action === "status") {
      const { data } = await serviceClient().from("email_outbox").select("status");
      const counts: Record<string, number> = {};
      for (const r of data ?? []) counts[r.status] = (counts[r.status] ?? 0) + 1;
      return json({ resend_key_configured: !!cfg.apiKey, email_from: cfg.from, app_url: cfg.appUrl, support_email: cfg.supportEmail, outbox: counts });
    }
    if (action === "test") {
      if (typeof to !== "string") return json({ error: "to requis." }, 400);
      await queueEmail("test", to, {}, `test:${crypto.randomUUID()}`);
      const { data } = await serviceClient().from("email_outbox").select("status,attempts,last_error,provider_id").eq("kind", "test").eq("to_email", to.toLowerCase()).order("created_at", { ascending: false }).limit(1).maybeSingle();
      return json({ queued: true, last: data ?? null });
    }
    const r = await drainOutbox(20);
    return json({ drained: r });
  } catch (e) {
    console.error("process-email-queue", String((e as Error)?.message ?? e));
    return json({ error: "Erreur interne." }, 500);
  }
});
