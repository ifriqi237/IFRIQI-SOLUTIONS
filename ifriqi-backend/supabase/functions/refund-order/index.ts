// POST /refund-order — endpoint RÉSERVÉ AUX ADMINS (JWT Supabase requis, role='admin' dans
// app_users), appelé depuis le panneau d'administration quand le SaaS doit rembourser une
// commande payée via PawaPay.
//
// Avant cette fonction, aucun code de ce dépôt n'appelait l'API "Initiate Refund" de PawaPay :
// pawapay-refund-callback/index.ts ne pouvait que RECEVOIR la confirmation d'un remboursement,
// jamais le déclencher — tout refundId reçu répondait 404. Cette fonction corrige ce manque.
//
// Principes de sécurité (mêmes que create-order pour les dépôts) :
//   1. Authentification + autorisation serveur : seul un compte avec app_users.role='admin'
//      peut appeler cet endpoint (vérifié via le JWT, jamais via un champ envoyé par le client).
//   2. Le serveur choisit toujours `refundId` (UUID), jamais le client/l'admin — il sert de clé
//      d'idempotence côté PawaPay ET est protégé par l'index unique
//      payments(refund_provider, refund_ref) où refund_ref is not null (0003_pawapay.sql).
//   3. Réservation atomique en base (UPDATE ... WHERE refund_ref IS NULL) avant d'appeler
//      PawaPay : si deux requêtes admin concurrentes visent le même paiement, une seule gagne
//      la réservation et appelle réellement l'API — l'autre reçoit 409 sans jamais déclencher
//      un second remboursement.
//   4. Le montant et la devise remboursés sont ceux réellement débités par PawaPay au moment du
//      dépôt (orders.display_amount / orders.display_currency), jamais recalculés à partir
//      d'amount_fcfa (valeur comptable de référence, pas la devise facturée au client).
//   5. Cette fonction ne marque JAMAIS la commande REFUNDED elle-même : un retour
//      status="ACCEPTED" signifie seulement que PawaPay a accepté de traiter le remboursement.
//      Seul pawapay-refund-callback/index.ts, après revérification serveur-à-serveur du statut
//      réel (COMPLETED), appelle refund_order() et fait passer orders.payment_status à
//      'REFUNDED'. Tant que ce callback n'est pas arrivé, la commande reste 'PAID'.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";
import { initiateRefund } from "../_shared/pawapay.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  try {
    // 1) Authentification + autorisation admin.
    const uc = userClient(req.headers.get("Authorization"));
    const { data: { user }, error: authErr } = await uc.auth.getUser();
    if (authErr || !user) return json({ error: "Non authentifié." }, 401);

    const svc = serviceClient();
    const { data: caller } = await svc.from("app_users").select("role").eq("id", user.id).single();
    if (caller?.role !== "admin") {
      return json({ error: "Seul un administrateur peut initier un remboursement." }, 403);
    }

    const { order_id, amount } = await req.json().catch(() => ({}));
    if (!order_id) return json({ error: "order_id est requis." }, 400);
    if (amount !== undefined && (typeof amount !== "number" || !(amount > 0))) {
      return json({ error: "amount, si fourni, doit être un nombre strictement positif." }, 400);
    }

    const { data: order } = await svc.from("orders").select("*").eq("id", order_id).single();
    if (!order) return json({ error: "Commande introuvable." }, 404);
    if (order.payment_status !== "PAID") {
      return json({ error: `La commande n'est pas au statut PAID (statut actuel : ${order.payment_status}) ; elle ne peut pas être remboursée.` }, 409);
    }

    // 2) Retrouve le paiement PawaPay confirmé de cette commande.
    const { data: payment } = await svc.from("payments").select("*").eq("order_id", order_id).eq("status", "SUCCESS").single();
    if (!payment) return json({ error: "Aucun paiement confirmé trouvé pour cette commande." }, 404);
    if (payment.provider !== "pawapay") {
      return json({ error: `Cette commande a été payée via '${payment.provider}', pas PawaPay. Ce endpoint ne gère que les remboursements PawaPay.` }, 400);
    }
    if (!payment.provider_ref) {
      return json({ error: "Le paiement PawaPay n'a pas de depositId enregistré (provider_ref manquant) ; remboursement impossible." }, 500);
    }
    if (payment.refund_ref) {
      return json({ error: "Un remboursement a déjà été initié ou effectué pour ce paiement." }, 409);
    }

    if (!order.display_currency || order.display_amount == null) {
      return json({ error: "La commande n'a pas de montant/devise affichés enregistrés (display_amount/display_currency) ; remboursement impossible." }, 500);
    }
    const requestedAmount = amount ?? Number(order.display_amount);
    if (requestedAmount > Number(order.display_amount) + 0.001) {
      return json({ error: `Le montant demandé (${requestedAmount}) dépasse le montant réellement payé (${order.display_amount} ${order.display_currency}).` }, 400);
    }

    // 3) Réservation atomique de la ligne de paiement : seule la requête qui gagne cette
    // écriture conditionnelle (refund_ref IS NULL) appelle réellement PawaPay.
    const refundId = crypto.randomUUID();
    const { data: claimed, error: claimErr } = await svc
      .from("payments")
      .update({ refund_provider: "pawapay", refund_ref: refundId })
      .eq("id", payment.id)
      .is("refund_ref", null)
      .select()
      .single();
    if (claimErr || !claimed) {
      return json({ error: "Un remboursement vient d'être initié pour ce paiement par une autre requête." }, 409);
    }

    const amountStr = (Math.round(requestedAmount * 100) / 100).toString();

    const result = await initiateRefund({
      refundId,
      depositId: payment.provider_ref,
      amount: amountStr,
      currency: order.display_currency,
      clientReferenceId: order.id,
    });

    if (!result.ok) {
      // L'appel a échoué ou a été rejeté : aucun remboursement n'a réellement été engagé côté
      // PawaPay, donc on libère la réservation pour permettre une nouvelle tentative — sauf si
      // un autre appel a déjà repris cette ligne entre-temps (refund_ref a changé).
      await svc.from("payments").update({ refund_provider: null, refund_ref: null }).eq("id", payment.id).eq("refund_ref", refundId);
      console.error("refund-order: initiateRefund a échoué", { order_id, refundId, status: result.status, failureCode: result.failureCode });
      return json({
        error: result.failureMessage ?? `Remboursement refusé par PawaPay (${result.status}).`,
        failureCode: result.failureCode,
        status: result.status,
      }, 422);
    }

    return json({
      refundId,
      status: result.status,
      amount: amountStr,
      currency: order.display_currency,
      message: "Remboursement PawaPay initié. Il ne sera marqué REFUNDED qu'après confirmation réelle via le callback pawapay-refund-callback.",
    });
  } catch (e) {
    console.error("refund-order error", e);
    return json({ error: "Une erreur est survenue lors de l'initiation du remboursement." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
