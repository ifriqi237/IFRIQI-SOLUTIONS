// Point de départ pour brancher ifriqi.html sur le vrai backend.
// À inclure dans la page via :
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
//   <script src="supabase-client.js"></script>
// F-13 (audit pré-prod) : version figée explicitement (2.45.4) plutôt que "@2" (qui suit
// automatiquement toutes les mises à jour mineures/patch) — un changement de comportement
// inattendu dans une nouvelle version ne doit jamais atterrir en production sans être testé
// d'abord. Pour monter de version : changer ce numéro ici ET le revalider, jamais le laisser flottant.
//
// Remplace progressivement les fonctions du prototype qui lisaient/écrivaient `db`
// (localStorage) par des appels à ces fonctions. Ne touche à rien d'autre dans
// ifriqi.html tant que vous n'êtes pas prêt à migrer un écran à la fois.

const SUPABASE_URL = "https://VOTRE-PROJET.supabase.co";
const SUPABASE_ANON_KEY = "VOTRE_CLE_ANON";
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const IfriqiAPI = {
  // ---- Authentification ----
  async signUp({ email, password, firstName, lastName, phone, country, countryCode }) {
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    // complète la fiche app_users (le trigger côté DB peut aussi le faire automatiquement
    // si vous ajoutez un trigger on auth.users insert -> app_users ; ici on le fait depuis
    // le client juste après inscription, protégé par RLS "own account").
    await sb.from("app_users").upsert({
      id: data.user.id, first_name: firstName, last_name: lastName,
      phone, email, country, country_code: countryCode,
    });
    return data;
  },
  async signIn({ email, password }) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },
  async signOut() { await sb.auth.signOut(); },
  async currentUser() {
    const { data } = await sb.auth.getUser();
    return data.user;
  },

  // ---- Lecture (directe via RLS, pas besoin d'Edge Function) ----
  async myProfiles() {
    const user = await this.currentUser(); if (!user) return [];
    const { data } = await sb.from("profiles").select("*, cards(*)").eq("user_id", user.id);
    return data ?? [];
  },
  async myDistributor() {
    const user = await this.currentUser(); if (!user) return null;
    const { data } = await sb.from("distributors").select("*").eq("user_id", user.id).maybeSingle();
    return data;
  },
  async myCommissions(distId) {
    const { data } = await sb.from("commissions").select("*, orders(*)").eq("dist_id", distId).order("created_at", { ascending: false });
    return data ?? [];
  },
  async myLedger(distId) {
    const { data } = await sb.from("ledger").select("*").eq("dist_id", distId).order("created_at", { ascending: false });
    return data ?? [];
  },

  // ---- Écriture sensible (toujours via Edge Function, jamais en direct) ----
  async createOrder({ profileId, product, refCode, method, phone }) {
    return callFunction("create-order", { profileId, product, refCode, method, phone });
  },
  async activateDistributor({ refCode } = {}) {
    return callFunction("activate-distributor", { refCode });
  },
};

async function callFunction(name, body) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body ?? {}),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || `Erreur ${name}`);
  return out;
}

window.IfriqiAPI = IfriqiAPI;
