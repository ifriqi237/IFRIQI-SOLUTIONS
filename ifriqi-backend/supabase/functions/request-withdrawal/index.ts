// POST /request-withdrawal — appelé par un DISTRIBUTEUR authentifié depuis son propre
// tableau de bord ("encaisser mes commissions") : chaque distributeur ne peut retirer QUE
// ses propres commissions, jamais celles d'un autre (vérifié via son JWT, jamais via un id
// envoyé par le client).
//
// Corrige le même manque que refund-order (tour précédent) mais pour les PAIEMENTS
// SORTANTS : avant cette fonction, aucun code de ce dépôt n'appelait jamais l'API
// "Initiate Payout" de PawaPay. Un distributeur pouvait seulement insérer une ligne
// `withdrawals` "REQUESTED" (policy RLS existante, 0001_init.sql), mais rien ne la
// transformait en paiement réel — pawapay-payout-callback restait condamné à répondre 404
// à tout payoutId reçu.
//
// Sécurité :
//   1. Authentification + propriété : le distributeur est retrouvé via son propre user_id
//      (JWT), jamais via un dist_id fourni par le client.
//   2. `payoutId` est TOUJOURS généré côté serveur (jamais par le client), et la réservation
//      du solde + l'insertion de la ligne `withdrawals` se font dans UNE SEULE transaction
//      verrouillée côté base (claim_withdrawal(), 0005_withdrawal_payout.sql) — deux demandes
//      concurrentes du même distributeur ne peuvent jamais faire passer deux fois la même
//      vérification de solde.
//   3. Le code fournisseur Mobile Money (`provider`) envoyé par le client est revérifié
//      contre la configuration PAYOUT réellement active chez PawaPay (jamais de confiance
//      aveugle), exactement comme pour les dépôts dans create-order.
//   4. Si PawaPay rejette l'appel, la ligne passe à REJECTED (jamais supprimée, jamais laissée
//      bloquée en PROCESSING) et le solde du distributeur redevient immédiatement disponible.
//   5. Cette fonction ne marque JAMAIS la ligne PAID elle-même : un retour "ACCEPTED" signifie
//      seulement que PawaPay a accepté de traiter le payout. Seul
//      pawapay-payout-callback/index.ts, après revérification serveur-à-serveur du statut réel
//      (COMPLETED), fait passer `withdrawals.status` à 'PAID'.
//
// Limite connue (assumée, pas corrigée ici) : la devise du virement est déduite du pays
// enregistré sur le compte du distributeur (app_users.country_code → country_currency),
// exactement comme pour les dépôts clients dans create-order. Un distributeur qui voudrait
// être payé dans un pays différent de celui déclaré sur son compte n'est pas pris en charge.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";
import { initiatePayout, getActiveConfiguration } from "../_shared/pawapay.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  try {
    // 1) Authentification + retrouve le distributeur du JWT (jamais un id fourni par le client).
    const uc = userClient(req.headers.get("Authorization"));
    const { data: { user }, error: authErr } = await uc.auth.getUser();
    if (authErr || !user) return json({ error: "Non authentifié." }, 401);

    const svc = serviceClient();
    const { data: dist } = await svc.from("distributors").select("*").eq("user_id", user.id).single();
    if (!dist) return json({ error: "Vous n'avez pas de compte distributeur." }, 403);
    if (dist.status !== "ACTIVE") {
      return json({ error: `Votre compte distributeur est au statut ${dist.status} ; retrait impossible.` }, 403);
    }

    const { amount_fcfa, phoneNumber, provider } = await req.json().catch(() => ({}));
    if (!provider) return json({ error: "provider est requis (code opérateur Mobile Money PawaPay, ex. MTN_MOMO_CMR)." }, 400);
    if (amount_fcfa !== undefined && (typeof amount_fcfa !== "number" || !(amount_fcfa > 0))) {
      return json({ error: "amount_fcfa, si fourni, doit être un nombre strictement positif." }, 400);
    }

    const { data: distUser } = await svc.from("app_users").select("*").eq("id", user.id).single();
    const phone: string | undefined = phoneNumber ?? distUser?.phone ?? undefined;
    if (!phone) return json({ error: "phoneNumber est requis (aucun numéro enregistré sur votre compte)." }, 400);

    const { data: cc } = await svc.from("country_currency").select("currency_code").eq("country_code", distUser?.country_code ?? "").single();
    const currency = cc?.currency_code ?? "XAF";

    // 2) Revérifie le fournisseur et la devise contre la configuration PAYOUT réellement
    // active chez PawaPay — jamais de confiance aveugle dans ce qu'envoie le client.
    const activeConf = await getActiveConfiguration(undefined, "PAYOUT").catch((e) => {
      console.error("request-withdrawal: getActiveConfiguration a échoué", e);
      return null;
    });
    if (!activeConf) return json({ error: "Impossible de vérifier la configuration PawaPay pour le moment. Réessayez plus tard." }, 503);

    const countries = (activeConf as { countries?: Array<{ providers?: Array<{ provider: string; currencies?: Array<{ currency: string }> }> }> }).countries ?? [];
    const providerKnown = countries.flatMap((c) => c.providers ?? []).find((p) => p.provider === provider);
    if (!providerKnown) {
      return json({ error: `Opérateur '${provider}' inconnu ou indisponible actuellement pour les paiements sortants.` }, 400);
    }
    const supportsCurrency = (providerKnown.currencies ?? []).some((c) => c.currency === currency);
    if (!supportsCurrency) {
      return json({ error: `L'opérateur '${provider}' ne prend pas en charge la devise ${currency}.` }, 400);
    }

    // 3) Solde disponible (même formule que claim_withdrawal(), pour un message d'erreur
    // clair avant même de verrouiller ; claim_withdrawal() reste la seule source de vérité
    // réellement sûre contre les accès concurrents).
    const { data: ledgerRows } = await svc.from("ledger").select("amount_fcfa").eq("dist_id", dist.id);
    const ledgerTotal = (ledgerRows ?? []).reduce((s, r) => s + r.amount_fcfa, 0);
    const { data: pendingWithdrawals } = await svc.from("withdrawals").select("amount_fcfa").eq("dist_id", dist.id).in("status", ["REQUESTED", "PROCESSING", "PAID"]);
    const alreadyWithdrawn = (pendingWithdrawals ?? []).reduce((s, r) => s + r.amount_fcfa, 0);
    const available = ledgerTotal - alreadyWithdrawn;

    const requestedFcfa = amount_fcfa ?? available;
    if (requestedFcfa <= 0) return json({ error: "Aucune commission disponible à retirer." }, 409);
    if (requestedFcfa > available) {
      return json({ error: `Solde insuffisant (solde disponible : ${available} FCFA, demandé : ${requestedFcfa} FCFA).` }, 409);
    }

    const { data: rateRow } = await svc.from("exchange_rates").select("rate").eq("target_currency", currency).order("effective_at", { ascending: false }).limit(1).single();
    const rate = rateRow?.rate ?? 1;
    const amountInCurrency = Math.round(requestedFcfa * rate * 100) / 100;

    // 4) Réservation atomique du solde + insertion de la ligne withdrawals (transaction
    // verrouillée côté base — voir claim_withdrawal()).
    const payoutId = crypto.randomUUID();
    const phoneDigits = phone.replace(/[^0-9]/g, "").replace(/^0+/, "");
    const { data: withdrawal, error: claimErr } = await svc.rpc("claim_withdrawal", {
      p_dist_id: dist.id,
      p_amount_fcfa: requestedFcfa,
      p_account_ref: phoneDigits,
      p_provider_ref: payoutId,
    });
    if (claimErr || !withdrawal) {
      console.error("request-withdrawal: claim_withdrawal a échoué", claimErr);
      return json({ error: claimErr?.message ?? "Impossible de réserver ce retrait pour le moment." }, 409);
    }

    const amountStr = (Math.round(amountInCurrency * 100) / 100).toString();

    const result = await initiatePayout({
      payoutId,
      phoneNumber: phoneDigits,
      provider,
      amount: amountStr,
      currency,
      clientReferenceId: withdrawal.id,
      customerMessage: "IFRIQI",
    });

    if (!result.ok) {
      // Le solde redevient immédiatement disponible : la formule de claim_withdrawal()
      // exclut REJECTED/CANCELLED. On ne supprime jamais la ligne (trace d'audit).
      await svc.from("withdrawals").update({ status: "REJECTED" }).eq("id", withdrawal.id).eq("provider_ref", payoutId);
      console.error("request-withdrawal: initiatePayout a échoué", { dist_id: dist.id, payoutId, status: result.status, failureCode: result.failureCode });
      return json({
        error: result.failureMessage ?? `Retrait refusé par PawaPay (${result.status}).`,
        failureCode: result.failureCode,
        status: result.status,
      }, 422);
    }

    return json({
      payoutId,
      withdrawalId: withdrawal.id,
      status: result.status,
      amount: amountStr,
      currency,
      amount_fcfa: requestedFcfa,
      message: "Retrait PawaPay initié. Il ne sera marqué PAID qu'après confirmation réelle via le callback pawapay-payout-callback.",
    });
  } catch (e) {
    console.error("request-withdrawal error", e);
    return json({ error: "Une erreur est survenue lors de la demande de retrait." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
