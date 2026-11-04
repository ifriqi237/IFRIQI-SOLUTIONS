// POST /email-my-card { profileId, pdfBase64 } — JWT requis.
// Envoie le PDF de SA carte à SA propre adresse e-mail (celle du compte) : c'est le moyen le plus simple de
// retrouver la carte sur un téléphone ancien (l'application e-mail est toujours là, contrairement au dossier
// « Téléchargements »). Le destinataire n'est JAMAIS lu dans la requête.
// Garde-fous : profil appartenant à l'appelant et carte existante ; fichier %PDF de 3 Mo maximum ;
// 5 envois / heure / utilisateur (compté dans email_outbox, kind='test', purpose='card_pdf', jamais le PDF) ;
// aucune copie du PDF conservée.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";

const MAX_B64 = 4_200_000; // ~3 Mo de PDF
const PER_HOUR = 5;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
  try {
    const uc = userClient(req.headers.get("Authorization"));
    const { data: { user }, error: authErr } = await uc.auth.getUser();
    if (authErr || !user) return json({ error: "Non authentifié." }, 401);

    const body = await req.json().catch(() => ({}));
    const profileId = typeof body?.profileId === "string" ? body.profileId : "";
    const b64 = typeof body?.pdfBase64 === "string" ? body.pdfBase64 : "";
    if (!/^[0-9a-f-]{36}$/i.test(profileId)) return json({ error: "Carte introuvable." }, 400);
    if (!b64 || b64.length > MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return json({ error: "Fichier invalide." }, 400);
    // doit commencer par %PDF- (JVBERi0 en base64)
    if (!b64.startsWith("JVBERi0")) return json({ error: "Fichier invalide." }, 400);

    const svc = serviceClient();
    const { data: profile } = await svc.from("profiles").select("id,user_id").eq("id", profileId).maybeSingle();
    if (!profile || profile.user_id !== user.id) return json({ error: "Carte introuvable." }, 403);
    const { data: card } = await svc.from("cards").select("id").eq("profile_id", profileId).maybeSingle();
    if (!card) return json({ error: "Carte introuvable." }, 404);

    const { data: u } = await svc.from("app_users").select("email,first_name").eq("id", user.id).maybeSingle();
    const to = (u?.email ?? user.email ?? "").toLowerCase();
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ error: "Aucune adresse e-mail sur votre compte." }, 400);

    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await svc.from("email_outbox").select("id", { count: "exact", head: true })
      .eq("kind", "test").eq("to_email", to).gte("created_at", since).contains("data", { purpose: "card_pdf" });
    if ((count ?? 0) >= PER_HOUR) return json({ error: "Trop d'envois pour le moment. Réessayez dans une heure." }, 429);

    const apiKey = Deno.env.get("RESEND_API_KEY") || "";
    if (!apiKey) return json({ error: "L'envoi par e-mail n'est pas disponible pour le moment." }, 503);
    const from = Deno.env.get("EMAIL_FROM") || "IFRIQI <notifications@ifriqi.com>";
    const appUrl = (Deno.env.get("APP_URL") || "https://www.ifriqi.com").replace(/\/+$/, "");
    const support = Deno.env.get("SUPPORT_EMAIL") || "support@ifriqi.com";
    const hello = u?.first_name ? `Bonjour ${esc(u.first_name)},` : "Bonjour,";
    const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#EFF3F9;font-family:Arial,Helvetica,sans-serif;color:#1b2a4a"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table width="100%" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden"><tr><td style="background:#012768;padding:22px 32px"><span style="font-size:26px;font-weight:800;color:#fff">IFRI<span style="color:#FE4E9A">QI</span></span></td></tr><tr><td style="padding:28px 32px;font-size:15px;line-height:1.6"><h1 style="margin:0 0 12px;font-size:22px;color:#012768">Votre carte IFRIQI est jointe</h1><p>${hello}</p><p>Vous trouverez votre carte de secours en <b>pièce jointe (PDF)</b> de ce message. Ouvrez la pièce jointe pour la voir, l'imprimer ou la transférer à un proche. Vous pourrez aussi la retrouver à tout moment dans cet e-mail.</p><p style="color:#5b6b8c;font-size:12px">Conservez votre carte pour pouvoir la présenter en cas d'urgence. Une question ? <a href="mailto:${esc(support)}">${esc(support)}</a> — <a href="${esc(appUrl)}">${esc(appUrl.replace(/^https?:\/\//, ""))}</a></p></td></tr></table></td></tr></table></body></html>`;
    const text = `${u?.first_name ? "Bonjour " + u.first_name + "," : "Bonjour,"}\n\nVotre carte de secours IFRIQI est en pièce jointe (PDF) de ce message. Ouvrez la pièce jointe pour la voir, l'imprimer ou la transférer à un proche.\n\nUne question ? ${support}\nIFRIQI — ${appUrl}`;

    const logId = crypto.randomUUID();
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": logId },
      body: JSON.stringify({
        from, to: [to], subject: "Votre carte IFRIQI (PDF en pièce jointe)", html, text, reply_to: support,
        attachments: [{ filename: "IFRIQI_Carte_Secours.pdf", content: b64 }],
        tags: [{ name: "kind", value: "card_pdf" }],
      }),
    });
    const rb = await res.json().catch(() => ({}));
    if (!res.ok || !rb?.id) {
      console.error("email-my-card: Resend", res.status, String(rb?.name ?? ""), String(rb?.message ?? "").slice(0, 200));
      return json({ error: "L'e-mail n'a pas pu être envoyé. Réessayez dans un instant." }, 502);
    }
    // Trace pour la limite horaire (jamais le PDF).
    await svc.from("email_outbox").insert({ idempotency_key: `cardpdf:${logId}`, kind: "test", to_email: to, data: { purpose: "card_pdf" }, status: "sent", attempts: 1, provider_id: rb.id, sent_at: new Date().toISOString() });
    return json({ ok: true, to: to.replace(/^(.).*(@.*)$/, "$1***$2") });
  } catch (e) {
    console.error("email-my-card:", String((e as Error)?.message ?? e));
    return json({ error: "Une erreur est survenue." }, 500);
  }
});
