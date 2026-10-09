// F-11 (audit pré-prod) : Access-Control-Allow-Origin était figé sur "*", ce qui autorise
// n'importe quel site web à appeler ces fonctions depuis le navigateur d'un visiteur. On lit
// désormais le domaine officiel depuis la variable d'environnement PUBLIC_APP_URL (déclarée dans
// .env.example et à définir dans Project Settings → Edge Functions → Secrets). Tant qu'elle
// n'est pas définie (phase de développement), on retombe sur "*" pour ne rien bloquer en local —
// mais ne déployez jamais en production sans avoir renseigné PUBLIC_APP_URL.
const allowedOrigin = Deno.env.get("PUBLIC_APP_URL") || "*";

export const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cinetpay-token",
  "Vary": "Origin",
};
