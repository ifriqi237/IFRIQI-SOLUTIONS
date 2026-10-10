// GET /pawapay-providers?op=DEPOSIT|PAYOUT — liste simplifiée des opérateurs Mobile Money
// réellement actifs chez PawaPay pour ce compte, utilisée par le frontend pour remplacer la
// saisie libre du code opérateur par un menu déroulant (plus aucun risque de faute de frappe
// ou de code inventé par l'utilisateur, ce qui déclenchait "opérateur inconnu" à chaque essai —
// PawaPay n'accepte que des codes exacts du type "MTN_MOMO_CMR", jamais un nom libre comme
// "orange" ou "mtn").
//
// Ne fait que relayer GET /v2/active-conf (déjà utilisé côté serveur par create-order pour
// valider le code fourni) sous une forme réduite : uniquement les champs d'affichage (pays,
// opérateur) + le code à renvoyer tel quel à create-order/request-withdrawal. Authentification
// requise (JWT Supabase), comme le reste de l'API — cette liste ne contient rien de sensible
// mais reste cohérente avec le principe "aucun accès anonyme" déjà appliqué partout ailleurs.
import { corsHeaders } from "../_shared/cors.ts";
import { getActiveConfiguration } from "../_shared/pawapay.ts";
import { userClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Méthode non autorisée." }, 405);
  try {
    const uc = userClient(req.headers.get("Authorization"));
    const { data: { user }, error: authErr } = await uc.auth.getUser();
    if (authErr || !user) return json({ error: "Non authentifié." }, 401);

    const url = new URL(req.url);
    const op = (url.searchParams.get("op") || "DEPOSIT").toUpperCase();
    if (!["DEPOSIT", "PAYOUT"].includes(op)) return json({ error: "op doit être DEPOSIT ou PAYOUT." }, 400);

    const conf = await getActiveConfiguration(undefined, op) as any;
    const countries = (conf?.countries ?? []).map((c: any) => {
      const providers = (c.providers ?? [])
        .filter((p: any) => (p.currencies ?? []).some((cur: any) => cur.operationTypes?.[op]?.status === "OPERATIONAL"))
        .map((p: any) => ({ code: p.provider, label: p.displayName || p.nameDisplayedToCustomer || p.provider }));
      return providers.length ? { country: c.country, nameFr: c.displayName?.fr || c.country, nameEn: c.displayName?.en || c.country, providers } : null;
    }).filter(Boolean);

    return json({ countries });
  } catch (e) {
    console.error("pawapay-providers error", e);
    return json({ error: "Impossible de récupérer la liste des opérateurs PawaPay pour le moment." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
