// POST /scan-card — endpoint PUBLIC (sans JWT, verify_jwt=false) : appelé depuis la page de
// scan (#/i/<token>), accessible à n'importe quel inconnu qui scanne une carte IFRIQI physique
// — par construction, cette personne n'a pas de compte et ne peut donc pas être authentifiée.
//
// F-19 (2026-10-11) : avant cette fonction, scanView() (public/ifriqi.html) cherchait la carte
// UNIQUEMENT dans db.profiles du navigateur qui scanne (localStorage) — jamais côté serveur.
// Résultat concret : scanner une carte IFRIQI sur un téléphone qui n'avait jamais synchronisé ce
// profil localement tombait systématiquement sur "Carte introuvable", sauf coïncidence. La
// fonctionnalité centrale du produit (retrouver les informations d'urgence via le QR) ne
// marchait donc en réalité que depuis l'appareil du titulaire lui-même — jamais depuis le
// téléphone d'un tiers qui porte secours, ce qui est pourtant LE scénario que ce produit sert.
//
// Body: { action?: 'lookup'|'call_click', token?: string, public_id?: string }
//   lookup (par défaut)  { token }      -> vérifie le jeton QR contre cards.token_hash
//   call_click            { public_id }  -> journalise un clic "Appeler" (déjà affiché, pas de
//                                           nouvelle donnée à renvoyer)
//
// Sécurité :
//   - Le token n'est JAMAIS stocké en clair côté serveur (cards.token_hash = SHA-256 du jeton,
//     exactement comme calculé côté client par sha() dans ifriqi.html) : on rehache le jeton
//     reçu et on compare les empreintes, jamais de recherche par jeton en clair.
//   - Chaque appel (trouvé, non trouvé, carte désactivée, clic appel) est journalisé dans
//     `scans`, lu ensuite par admin-api (onglet "Scans").
//   - Le profil n'est renvoyé QUE si la carte existe et est ACTIVE ; aucune autre donnée
//     (adresse, date de naissance, identité du compte...) que celle déjà affichée aujourd'hui
//     par scanBody() côté client n'est exposée.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  try {
    const svc = serviceClient();
    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === "string" ? body.action : "lookup";

    if (action === "call_click") {
      const publicId = typeof body.public_id === "string" && body.public_id ? body.public_id : null;
      if (!publicId) return json({ error: "public_id est requis." }, 400);
      const { data: card } = await svc.from("cards").select("id").eq("public_id", publicId).maybeSingle();
      await svc.from("scans").insert({ card_id: card?.id ?? null, public_id: publicId, result: "CALL_CLICK" });
      return json({ ok: true });
    }

    if (action !== "lookup") return json({ error: `Action inconnue : '${action}'.` }, 400);

    const token = typeof body.token === "string" ? body.token : "";
    if (!token) return json({ error: "token est requis." }, 400);
    const hash = await sha256Hex(token);

    const { data: card, error } = await svc
      .from("cards")
      .select("*, profiles(*)")
      .eq("token_hash", hash)
      .maybeSingle();
    if (error) return dbError("scan_lookup", error);

    if (!card) {
      await svc.from("scans").insert({ card_id: null, public_id: null, result: "NOT_FOUND" });
      return json({ found: false });
    }

    await svc.from("scans").insert({ card_id: card.id, public_id: card.public_id, result: card.status });

    if (card.status !== "ACTIVE") {
      return json({ found: true, status: card.status, public_id: card.public_id });
    }

    const profile = Array.isArray(card.profiles) ? card.profiles[0] : card.profiles;
    return json({
      found: true,
      status: "ACTIVE",
      profile: {
        first_name: profile?.first_name ?? "",
        last_name: profile?.last_name ?? "",
        photo_url: profile?.photo_url ?? null,
        public_id: card.public_id,
        health: profile?.health ?? {},
        contacts: profile?.contacts ?? [],
      },
    });
  } catch (e) {
    console.error("scan-card error", e);
    return json({ error: "Une erreur est survenue." }, 500);
  }
});

function dbError(action: string, error: unknown): Response {
  console.error(`scan-card: ${action} a échoué`, error);
  return json({ error: "Une erreur est survenue lors de la vérification." }, 500);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
