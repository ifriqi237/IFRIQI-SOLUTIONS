// POST /debug-ikeepay-payin — fonction de DIAGNOSTIC TEMPORAIRE (2026-10-12), à supprimer une
// fois le schéma de signature des webhooks iKeePay confirmé.
//
// Objectif unique : déclencher UNE vraie transaction H2H minimale (avec un vrai numéro de
// téléphone fourni par l'appelant, donc un vrai débit réel), pour qu'iKeePay nous envoie un
// vrai webhook — qu'on capture ensuite via IKEEPAY_DEBUG_CAPTURE=true dans ikeepay-webhook.
// N'écrit RIEN en base (pas de ligne orders/payments) : c'est volontaire, pour ne pas mélanger
// ce test avec le vrai flux commande/carte tant que la signature n'est pas fiable.
//
// Protégée par un jeton partagé (IKEEPAY_DEBUG_TOKEN), à définir dans les secrets avant usage,
// pour qu'un tiers ne puisse pas déclencher de débits à distance sur ce endpoint public.
import { corsHeaders } from "../_shared/cors.ts";
import { initiatePayin } from "../_shared/ikeepay.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const { token, amount, currency, country, phone, operator } = body as {
      token?: string; amount?: number; currency?: string; country?: string; phone?: string; operator?: string;
    };

    const expectedToken = Deno.env.get("IKEEPAY_DEBUG_TOKEN");
    if (!expectedToken || token !== expectedToken) {
      return json({ error: "Jeton de diagnostic invalide ou IKEEPAY_DEBUG_TOKEN non configuré." }, 403);
    }
    if (!amount || !currency || !country || !phone || !operator) {
      return json({ error: "amount, currency, country, phone et operator sont requis." }, 400);
    }

    const externalReference = crypto.randomUUID();
    const result = await initiatePayin({
      amount, currency, country,
      phoneNumber: phone.replace(/[^0-9]/g, ""),
      operator,
      externalReference,
    });

    return json({
      externalReference,
      note: "Surveillez les function_logs de ikeepay-webhook (IKEEPAY_DEBUG_CAPTURE=true) pour voir le webhook réel correspondant à cette externalReference.",
      result,
    });
  } catch (e) {
    console.error("debug-ikeepay-payin error", e);
    return json({ error: "Une erreur est survenue." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
