// POST /pawapay-payout-callback — endpoint PUBLIC à renseigner dans le Dashboard PawaPay,
// champ "Callback URL" pour les PAIEMENTS SORTANTS (payouts), c'est-à-dire les retraits des
// distributeurs (table `withdrawals`).
//
// IMPORTANT — ce que cet endpoint fait et ne fait PAS :
//   Il REÇOIT et traite les notifications de statut final d'un payout PawaPay. Il ne DÉCLENCHE
//   pas lui-même de payout : aucun code de ce dépôt n'appelle encore l'API "Initiate Payout" de
//   PawaPay pour générer un payoutId à partir d'une demande de retrait (`withdrawals`). Tant que
//   cette initiation n'est pas branchée (et que `withdrawals.provider`/`provider_ref` ne sont pas
//   renseignés à la création du payout), ce callback répondra 404 "introuvable" pour tout
//   payoutId réel envoyé par PawaPay — ce qui est le comportement correct et attendu en attendant
//   que ce branchement soit fait.
//
// Sécurité : même principe que pawapay-deposit-callback (signature RFC 9421 + revérification
// serveur-à-serveur du statut, jamais confiance au corps du callback seul).
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { verifyPawaPayCallback, checkPayoutStatus } from "../_shared/pawapay.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  const rawBody = new Uint8Array(await req.arrayBuffer());

  try {
    const requireSignature = Deno.env.get("PAWAPAY_REQUIRE_SIGNATURE") !== "false";
    if (requireSignature) {
      const verif = await verifyPawaPayCallback(req, rawBody);
      if (!verif.ok) {
        console.error("pawapay-payout-callback: signature invalide", verif.reason);
        return json({ error: "Signature invalide." }, 401);
      }
    } else {
      console.warn("pawapay-payout-callback: vérification de signature DÉSACTIVÉE (PAWAPAY_REQUIRE_SIGNATURE=false) — à ne jamais faire en production.");
    }

    const payload = safeJsonParse(rawBody);
    const payoutId: string | undefined = payload?.payoutId;
    if (!payoutId) return json({ error: "payoutId manquant." }, 400);

    const checked = await checkPayoutStatus(payoutId);

    const svc = serviceClient();
    const { data: withdrawal } = await svc.from("withdrawals").select("*").eq("provider", "pawapay").eq("provider_ref", payoutId).single();
    if (!withdrawal) {
      console.error("pawapay-payout-callback: aucun retrait pawapay avec provider_ref=", payoutId);
      return json({ error: "Retrait introuvable pour ce payoutId." }, 404);
    }

    if (checked.status === "COMPLETED") {
      // Idempotent par nature : si déjà PAID, cette écriture ne fait que réaffirmer le même état.
      await svc.from("withdrawals").update({ status: "PAID", paid_at: new Date().toISOString() }).eq("id", withdrawal.id);
      return json({ status: "PAID" });
    }

    if (checked.status === "FAILED" || checked.status === "REJECTED") {
      // Le statut `withdrawals.status` le plus proche d'un payout qui a échoué chez le
      // prestataire est 'REJECTED'. Remarque : si le montant avait déjà été débité du solde
      // disponible du distributeur (selon la logique métier qui crée la ligne `withdrawals`),
      // une éventuelle contre-écriture au ledger (type REVERSAL) pour restituer ce solde n'est
      // PAS faite ici — elle dépend de la façon dont l'initiation du payout gère ce débit, qui
      // n'existe pas encore dans ce dépôt (voir note en tête de fichier). À traiter au moment où
      // l'initiation des payouts PawaPay sera ajoutée à `create-order`/un nouvel endpoint dédié.
      await svc.from("withdrawals").update({ status: "REJECTED" }).eq("id", withdrawal.id);
      return json({ status: "REJECTED" });
    }

    return json({ status: checked.status });
  } catch (e) {
    console.error("pawapay-payout-callback error", e);
    return json({ error: "Une erreur est survenue lors du traitement du paiement sortant." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function safeJsonParse(bytes: Uint8Array): any {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; }
}
