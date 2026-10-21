// POST /create-order
// Body: { profileId: string, product: 'card'|'topup', refCode?: string, method: 'momo'|'card'|'paypal', phone?: string }
//
// Appelé par le front, authentifié (JWT Supabase dans Authorization). Ne fait JAMAIS confiance
// à un montant envoyé par le client : le prix vient de la table `settings`, côté serveur.
// Crée la commande + initie le paiement chez le prestataire choisi, renvoie l'URL/les
// instructions à suivre pour payer.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";
import { initiateDeposit, getActiveConfiguration } from "../_shared/pawapay.ts";
import { paylivConfigured, PAYLIV_COUNTRIES, PAYLIV_MIN, normalizePhone, createMobileMoney, createCard, extractRedirect } from "../_shared/payliv.ts";
import { initiatePayin as ikeepayInitiatePayin, ikeepayConfigured, ikeepayPublicKey, ikeepayCheckoutUrl, ikeepayInlineConfigured } from "../_shared/ikeepay.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    const uc = userClient(authHeader);
    const { data: { user }, error: authErr } = await uc.auth.getUser();
    if (authErr || !user) {
      return json({ error: "Non authentifié." }, 401);
    }

    const body = await req.json();
    const { profileId, product, refCode, method, phone, pawapayProvider, ikeepayOperator, ikeepayCountry, paylivProvider } = body as {
      profileId: string; product: "card" | "topup"; refCode?: string; method: string; phone?: string;
      pawapayProvider?: string; // requis si method === 'pawapay' — code fournisseur PawaPay, ex. "MTN_MOMO_BEN"
      ikeepayOperator?: string; // requis si method === 'ikeepay' (Direct Charge/H2H) — ex. "ORANGE", "MTN", "WAVE"...
      ikeepayCountry?: string;  // requis si method === 'ikeepay' (Direct Charge/H2H) — code pays ISO2, ex. "CI"
      paylivProvider?: string;  // requis si method === 'payliv_momo' — ex. "mtn", "orange", "wave"
    };
    if (!profileId || !["card", "topup"].includes(product)) {
      return json({ error: "profileId et product ('card'|'topup') sont requis." }, 400);
    }
    if (method === "pawapay" && (!phone || !pawapayProvider)) {
      return json({ error: "phone et pawapayProvider sont requis pour un paiement PawaPay." }, 400);
    }
    // 'ikeepay' = Direct Charge / H2H (bloqué pour l'instant, palier PRO non débloqué sur le
    // compte — voir _shared/ikeepay.ts). 'ikeepay_inline' = Inline Checkout (modale pop-up),
    // mode actif choisi par l'utilisateur le 2026-10-13 en attendant ce déblocage. Les deux
    // cohabitent dans le code ; seul 'ikeepay_inline' est branché côté front pour l'instant.
    if (method === "ikeepay" && (!phone || !ikeepayOperator || !ikeepayCountry)) {
      return json({ error: "phone, ikeepayOperator et ikeepayCountry sont requis pour un paiement iKeePay (Direct Charge)." }, 400);
    }

    const svc = serviceClient();

    // vérifie que le profil appartient bien à l'appelant (defense in depth, en plus de RLS)
    const { data: profile } = await svc.from("profiles").select("id,user_id").eq("id", profileId).single();
    if (!profile || profile.user_id !== user.id) {
      return json({ error: "Profil introuvable ou non autorisé." }, 403);
    }

    const { data: settings } = await svc.from("settings").select("*").eq("id", 1).single();
    const priceFcfa = settings!.price_fcfa;

    // Attribution du distributeur : refCode vient du lien que l'acheteur a visité (équivalent
    // de db.ref côté prototype). On ne verse jamais de commission sur un refCode invalide/inactif.
    let distId: string | null = null;
    if (refCode) {
      const { data: dist } = await svc.from("distributors").select("id,status").eq("code", refCode.toUpperCase()).single();
      if (dist && dist.status === "ACTIVE") distId = dist.id;
    }

    // devise d'affichage = celle de l'ACHETEUR (pas du distributeur), figée à la commande
    const { data: buyer } = await svc.from("app_users").select("country_code").eq("id", user.id).single();
    const { data: cc } = await svc.from("country_currency").select("currency_code").eq("country_code", buyer?.country_code ?? "").single();
    const currency = cc?.currency_code ?? "XAF";
    const { data: rateRow } = await svc.from("exchange_rates").select("rate").eq("target_currency", currency).order("effective_at", { ascending: false }).limit(1).single();
    const rate = rateRow?.rate ?? 1;
    const displayAmount = Math.round(priceFcfa * rate * 100) / 100;

    // ---- PAYLIV Mobile Money : validations AVANT de créer la commande (aucune commande orpheline) ----
    // Le pays de l'acheteur (profil serveur, pas le navigateur) fixe le pays/la devise PAYLIV.
    let paylivCountry = "";
    let paylivPhone = "";
    if (method === "payliv_momo") {
      const pm = (settings!.payment_methods ?? {}) as Record<string, unknown>;
      if (pm.payliv_momo !== true) return json({ error: "Ce moyen de paiement n'est pas encore disponible." }, 403);
      if (!paylivConfigured()) return json({ error: "Ce moyen de paiement n'est pas encore disponible." }, 503);
      paylivCountry = String(buyer?.country_code ?? "").toUpperCase();
      const pc = PAYLIV_COUNTRIES[paylivCountry];
      if (!pc) return json({ error: "Le Mobile Money PAYLIV n'est pas disponible dans votre pays." }, 422);
      if (pc.currency !== currency) return json({ error: "Devise non prise en charge pour ce pays." }, 422);
      if (!paylivProvider || !pc.providers.includes(paylivProvider)) return json({ error: "Opérateur Mobile Money invalide pour votre pays." }, 422);
      const np = normalizePhone(phone ?? "", paylivCountry);
      if (!np) return json({ error: "Numéro de téléphone invalide pour votre pays." }, 422);
      paylivPhone = np;
      if (displayAmount < (PAYLIV_MIN[currency] ?? 0)) return json({ error: "Montant inférieur au minimum de l'opérateur." }, 422);
    }

    // ---- PAYLIV carte bancaire (Visa/Mastercard, page hébergée + 3DS) : mêmes principes ----
    let cardCountry = "";
    if (method === "payliv_card") {
      const pm = (settings!.payment_methods ?? {}) as Record<string, unknown>;
      if (pm.payliv_card !== true || !paylivConfigured()) return json({ error: "Ce moyen de paiement n'est pas encore disponible." }, 403);
      cardCountry = String(buyer?.country_code ?? "").toUpperCase();
      if (!cc || !cardCountry) return json({ error: "Votre pays n'est pas pris en charge pour le paiement par carte." }, 422);
      if (!user.email) return json({ error: "Une adresse e-mail est requise pour le paiement par carte." }, 422);
      if (displayAmount < (PAYLIV_MIN[currency] ?? 0)) return json({ error: "Montant inférieur au minimum accepté." }, 422);
    }

    const { data: order, error: orderErr } = await svc.from("orders").insert({
      customer_id: user.id,
      profile_id: profileId,
      product,
      amount_fcfa: priceFcfa,
      dist_id: distId,
      payment_status: "PENDING",
      display_currency: currency,
      display_rate: rate,
      display_amount: displayAmount,
    }).select().single();
    if (orderErr) { console.error("create-order insert error", orderErr); return json({ error: "Impossible de créer la commande pour le moment." }, 500); }

    // ---- Initiation du paiement chez le prestataire ----
    const provider = (method === "payliv_momo" || method === "payliv_card") ? "payliv" : method === "paypal" ? "paypal" : method === "pawapay" ? "pawapay" : (method === "ikeepay" || method === "ikeepay_inline") ? "ikeepay" : "cinetpay";
    const init = provider === "payliv"
      ? (method === "payliv_card"
          ? await initPaylivCard(order.id, displayAmount, currency, cardCountry, user.email ?? "")
          : await initPayliv(order.id, displayAmount, currency, paylivCountry, paylivPhone, paylivProvider!))
      : provider === "paypal"
      ? await initPaypal(order.id, priceFcfa)
      : provider === "pawapay"
      ? await initPawapay(order.id, displayAmount, currency, phone!, pawapayProvider!)
      : provider === "ikeepay"
      ? (method === "ikeepay_inline"
          ? initIkeepayInline(displayAmount, currency, user.email ?? "")
          : await initIkeepay(order.id, displayAmount, currency, phone!, ikeepayOperator!, ikeepayCountry!))
      : await initCinetpay(order.id, priceFcfa, method, phone);

    // Si l'initiation a été rejetée immédiatement par le prestataire (ex. opérateur PawaPay
    // inconnu, devise non supportée, token manquant), on le trace comme un paiement FAILED
    // plutôt que PENDING — jamais de ligne "en attente" pour un paiement qui n'a en réalité
    // jamais pu démarrer, et on renvoie l'erreur réelle au client au lieu de faire comme si
    // tout allait bien.
    const skipPayment = (init as { skipPayment?: boolean }).skipPayment === true;
    await svc.from("payments").insert({
      order_id: order.id,
      provider,
      provider_ref: init.reference ?? null,
      method,
      amount_fcfa: priceFcfa,
      status: skipPayment ? "FAILED" : "PENDING",
      raw_payload: init.raw ?? null,
    });
    if (skipPayment) {
      await svc.from("orders").update({ payment_status: "FAILED" }).eq("id", order.id);
      return json({ orderId: order.id, provider, ...init.client }, 422);
    }

    return json({ orderId: order.id, provider, ...init.client });
  } catch (e) {
    // F-08 (audit pré-prod) : ne jamais renvoyer le détail technique brut au navigateur du
    // client (pile d'erreur, message SQL...) — journalisé côté serveur, message générique renvoyé.
    console.error("create-order error", e);
    return json({ error: "Impossible de créer la commande pour le moment. Réessayez plus tard." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------------------
// CinetPay (Mobile Money MTN/Orange + carte, zone CEMAC/UEMOA). Doc : https://docs.cinetpay.com
// Nécessite CINETPAY_APIKEY et CINETPAY_SITE_ID dans les variables d'environnement du projet
// Supabase (Project Settings → Edge Functions → Secrets). Sans ces clés, la fonction répond
// en mode "sandbox" explicite : rien n'est jamais débité, et le front doit l'afficher comme tel.
// ---------------------------------------------------------------------------
async function initCinetpay(orderId: string, amountFcfa: number, method: string, phone?: string) {
  const apikey = Deno.env.get("CINETPAY_APIKEY");
  const siteId = Deno.env.get("CINETPAY_SITE_ID");
  const notifyUrl = Deno.env.get("PUBLIC_FUNCTIONS_URL") + "/payment-webhook";
  if (!apikey || !siteId) {
    return { reference: "SANDBOX-" + orderId, raw: { sandbox: true }, client: { sandbox: true, message: "CINETPAY_APIKEY / CINETPAY_SITE_ID non configurées : paiement simulé, aucun débit réel." } };
  }
  const transactionId = orderId.replace(/-/g, "").slice(0, 24);
  const res = await fetch("https://api-checkout.cinetpay.com/v2/payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apikey, site_id: siteId,
      transaction_id: transactionId,
      amount: amountFcfa, currency: "XAF",
      description: "Carte IFRIQI",
      notify_url: notifyUrl,
      return_url: Deno.env.get("PUBLIC_APP_URL") ?? "https://www.ifriqi.com/#/app",
      channels: method === "momo" ? "MOBILE_MONEY" : method === "card" ? "CREDIT_CARD" : "ALL",
      customer_phone_number: phone ?? undefined,
    }),
  });
  const data = await res.json();
  return { reference: transactionId, raw: data, client: { paymentUrl: data?.data?.payment_url ?? null, cinetpayResponse: data } };
}

// ---------------------------------------------------------------------------
// PawaPay (Mobile Money — Afrique de l'Est/Ouest/Centrale). Nécessite PAWAPAY_API_TOKEN.
// PAWAPAY_ENV = 'sandbox' (par défaut) ou 'production'. Contrairement à CinetPay/PayPal, PawaPay
// n'a pas de mode "sandbox implicite sans clés" ici : sans PAWAPAY_API_TOKEN, on refuse plutôt
// que de simuler, car un depositId mal formé ou un appel sans token produirait une erreur HTTP
// confuse plutôt qu'un vrai comportement sandbox — mieux vaut un message clair.
//
// Le statut renvoyé ici (ACCEPTED) ne signifie PAS que le paiement est confirmé : seul le
// callback pawapay-deposit-callback (déjà déployé), qui revérifie le statut réel auprès de
// PawaPay avant d'écrire quoi que ce soit, fait passer orders.payment_status à 'PAID'. Tant que
// le callback n'est pas reçu, orders.payment_status reste 'PENDING' — c'est voulu.
// ---------------------------------------------------------------------------
async function initPawapay(orderId: string, displayAmount: number, currency: string, phone: string, pawapayProvider: string) {
  const token = Deno.env.get("PAWAPAY_API_TOKEN");
  if (!token) {
    return { reference: null, raw: { sandbox: true }, client: { sandbox: true, message: "PAWAPAY_API_TOKEN non configurée : paiement PawaPay indisponible pour le moment." }, skipPayment: true };
  }

  // Ne fait jamais confiance au code fournisseur envoyé par le front sans le vérifier contre la
  // configuration réelle de PawaPay (pays/opérateurs/devises actuellement actifs).
  const activeConf = await getActiveConfiguration().catch((e) => {
    console.error("create-order: getActiveConfiguration a échoué", e);
    return null;
  });
  const providerKnown = Array.isArray((activeConf as { countries?: unknown[] })?.countries)
    ? (activeConf as { countries: Array<{ providers?: Array<{ provider: string; currencies?: Array<{ currency: string }> }> }> }).countries
        .flatMap((c) => c.providers ?? [])
        .find((p) => p.provider === pawapayProvider)
    : undefined;
  if (!providerKnown) {
    return { reference: null, raw: { error: "unknown_provider" }, client: { error: `Opérateur PawaPay '${pawapayProvider}' inconnu ou indisponible actuellement.` }, skipPayment: true };
  }
  const supportsCurrency = (providerKnown.currencies ?? []).some((c) => c.currency === currency);
  if (!supportsCurrency) {
    return { reference: null, raw: { error: "unsupported_currency" }, client: { error: `L'opérateur '${pawapayProvider}' ne prend pas en charge la devise ${currency}.` }, skipPayment: true };
  }

  const depositId = crypto.randomUUID();
  const amountStr = (Math.round(displayAmount * 100) / 100).toString(); // pas de zéros non significatifs, pas de notation flottante bizarre
  const phoneDigits = phone.replace(/[^0-9]/g, "").replace(/^0+/, "");

  const result = await initiateDeposit({
    depositId,
    amount: amountStr,
    currency,
    phoneNumber: phoneDigits,
    provider: pawapayProvider,
    clientReferenceId: orderId,
    customerMessage: "IFRIQI",
  });

  if (!result.ok) {
    console.error("create-order: initiateDeposit PawaPay rejetée", result);
    return { reference: depositId, raw: result.raw, client: { error: result.failureMessage ?? "Paiement PawaPay refusé.", failureCode: result.failureCode }, skipPayment: true };
  }

  return { reference: depositId, raw: result.raw, client: { depositId, status: result.status, message: "Paiement PawaPay initié. Validez la demande sur votre téléphone." } };
}

// ---------------------------------------------------------------------------
// iKeePay (mode H2H, Mobile Money), ajouté le 2026-10-12 EN PLUS de PawaPay (ne remplace rien).
// Nécessite IKEEPAY_SECRET_KEY. Comme pour PawaPay, pas de mode "sandbox implicite" ici : sans
// la clé, on refuse plutôt que de simuler un appel qui produirait une erreur HTTP confuse.
//
// Le statut renvoyé ici (succès de l'appel HTTP /h2h-payin) ne signifie PAS que le paiement est
// confirmé : seul ikeepay-webhook/index.ts, après revérification serveur-à-serveur via
// GET /h2h-verify/:reference, fait passer orders.payment_status à 'PAID'. Tant que le webhook
// n'est pas reçu ET que la vérification de signature n'est pas finalisée (voir _shared/ikeepay.ts),
// orders.payment_status reste 'PENDING' — c'est voulu, et ça restera le cas en production tant
// que le support iKeePay n'a pas confirmé le schéma exact de signature des webhooks.
// ---------------------------------------------------------------------------
async function initIkeepay(orderId: string, displayAmount: number, currency: string, phone: string, operator: string, country: string) {
  if (!ikeepayConfigured()) {
    return { reference: null, raw: { sandbox: true }, client: { sandbox: true, message: "IKEEPAY_SECRET_KEY non configurée : paiement iKeePay indisponible pour le moment." }, skipPayment: true };
  }
  const externalReference = crypto.randomUUID();
  const phoneDigits = phone.replace(/[^0-9]/g, "").replace(/^0+/, "");

  const result = await ikeepayInitiatePayin({
    amount: Math.round(displayAmount * 100) / 100,
    currency,
    country,
    phoneNumber: phoneDigits,
    operator,
    externalReference,
  });

  if (!result.ok) {
    console.error("create-order: initiatePayin iKeePay rejetée", result);
    return { reference: externalReference, raw: result.raw, client: { error: result.message ?? "Paiement iKeePay refusé." }, skipPayment: true };
  }

  return {
    reference: externalReference,
    raw: result.raw,
    client: {
      externalReference,
      paymentLink: result.paymentLink ?? null,
      message: "Paiement iKeePay initié. Validez la demande sur votre téléphone (ou suivez le lien fourni selon l'opérateur).",
    },
  };
}

// ---------------------------------------------------------------------------
// PAYLIV carte bancaire : le serveur crée le paiement, le navigateur est redirigé vers checkout_url (page PAYLIV 3DS).
// Les adresses de retour contiennent notre numéro de commande ; elles ne prouvent JAMAIS le paiement (le webhook signé + la
// relecture du statut chez PAYLIV font foi, voir payliv-settle.ts).
async function initPaylivCard(orderId: string, displayAmount: number, currency: string, country: string, email: string) {
  const base = (Deno.env.get("PUBLIC_APP_URL") || "https://ifriqi.com").replace(/\/+$/, "");
  const r = await createCard({
    amount: displayAmount, currency, country, title: "Carte de secours IFRIQI", email,
    successUrl: `${base}/#/payreturn/${orderId}`,
    cancelUrl: `${base}/#/paycancel/${orderId}`,
    webhookUrl: (Deno.env.get("SUPABASE_URL") ?? "") + "/functions/v1/payliv-webhook",
    metadata: { orderId },
  });
  if (!r.ok) return { reference: null, raw: { error: r.code }, client: { error: r.message }, skipPayment: true };
  const d = r.data;
  const paymentId = String(d.payment_id ?? d.id ?? "");
  const url = extractRedirect(d);
  if (!paymentId || !url) return { reference: null, raw: { error: "NO_CHECKOUT" }, client: { error: "Réponse inattendue du prestataire de paiement." }, skipPayment: true };
  return { reference: paymentId, raw: { created: d }, client: { paylivPaymentId: paymentId, paylivCheckoutUrl: url } };
}

// iKeePay — Inline Checkout (modale pop-up), ajouté le 2026-10-13. Mode ACTIF côté front en
// attendant le déblocage du palier Direct Charge/PRO (voir commentaire détaillé dans
// _shared/ikeepay.ts : ikeepayPublicKey()/ikeepayCheckoutUrl()).
//
// Contrairement à initIkeepay() (H2H) ci-dessus, cette fonction ne fait AUCUN appel HTTP vers
// iKeePay : c'est le NAVIGATEUR du client qui charge l'iframe de paiement directement avec la
// clé publique. On se contente ici de générer la référence et de renvoyer au front ce qu'il lui
// faut pour ouvrir cette iframe. Nécessite IKEEPAY_PUBLIC_KEY (distincte de IKEEPAY_SECRET_KEY,
// qui ne doit jamais quitter le serveur).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PAYLIV Mobile Money (ajouté le 2026-10-21) — voir _shared/payliv.ts.
// Le montant vient de settings.price_fcfa converti côté serveur (displayAmount). fee_bearer=client :
// l'acheteur paie les frais PAYLIV EN PLUS (le prix enregistré de la commande ne change pas).
// payments.provider_ref = payment_id PAYLIV ; notre numéro de commande part dans metadata.orderId.
// ---------------------------------------------------------------------------
async function initPayliv(orderId: string, displayAmount: number, currency: string, country: string, phone: string, provider: string) {
  const r = await createMobileMoney({
    amount: displayAmount, currency, phone, country, provider,
    title: "Carte de secours IFRIQI",
    webhookUrl: (Deno.env.get("SUPABASE_URL") ?? "") + "/functions/v1/payliv-webhook",
    metadata: { orderId },
  });
  if (!r.ok) {
    return { reference: null, raw: { error: r.code }, client: { error: r.message }, skipPayment: true };
  }
  const d = r.data;
  const paymentId = String(d.payment_id ?? d.id ?? "");
  if (!paymentId) return { reference: null, raw: { error: "NO_PAYMENT_ID" }, client: { error: "Réponse inattendue du prestataire de paiement." }, skipPayment: true };
  const na = d.next_action;
  const instructions = (d.confirmation_instructions ?? d.otp_instructions ?? d.instructions ?? null) as string | null;
  const exp = (d.confirmation_expires_at as string | undefined) ??
    new Date(Date.now() + ((typeof d.expires_in === "number" ? d.expires_in : 1800) * 1000)).toISOString();
  return {
    reference: paymentId,
    raw: { created: d },
    client: {
      paylivPaymentId: paymentId,
      paylivInstructions: instructions,
      paylivRequiresOtp: d.requires_otp === true || na === "submit_otp" || d.status === "awaiting_otp",
      paylivRedirectUrl: extractRedirect(d),
      paylivExpiresAt: exp,
      paylivChargedAmount: typeof d.charged_amount === "number" ? d.charged_amount : null,
      paylivFees: typeof d.fees === "number" ? d.fees : null,
      paylivCurrency: currency,
    },
  };
}

function initIkeepayInline(displayAmount: number, currency: string, email: string) {
  if (!ikeepayInlineConfigured()) {
    return { reference: null, raw: { sandbox: true }, client: { sandbox: true, message: "IKEEPAY_PUBLIC_KEY non configurée : paiement iKeePay (Inline Checkout) indisponible pour le moment." }, skipPayment: true };
  }
  // 2026-10-15 : remplace crypto.randomUUID() (36 caractères) par un identifiant court, sur le
  // modèle du plugin WooCommerce OFFICIEL d'iKeePay fourni par l'utilisateur, qui utilise
  // 'ORDER_' + Date.now() (~19 caractères) — voir assets/js/ikeepay-checkout.js de ce plugin.
  // Signalé le 15/10/2026 : "Metadata field value length must not exceed 64 symbols", renvoyée
  // par le widget iKeePay LUI-MÊME (jamais par notre serveur — rien ne transite par nos logs)
  // une fois le formulaire Mobile Money soumis DANS leur iframe, donc visiblement un champ
  // combiné construit côté iKeePay à partir de ce que l'iframe reçoit en paramètres d'URL
  // (pk/amount/currency/order_id/email). order_id (notre reference) était de très loin le plus
  // long de ces champs (UUID v4 = 36 caractères) : le raccourcir est le seul changement sous
  // notre contrôle qui corresponde à une différence concrète et vérifiable avec l'implémentation
  // de référence d'iKeePay. Reste unique (horodatage ms + 4 caractères aléatoires en base36) —
  // aucun contrôle de collision ici, comme pour l'ancien crypto.randomUUID() (risque inchangé,
  // juste rendu plus court). Cette valeur reste celle stockée dans payments.provider_ref et celle
  // que le webhook iKeePay renvoie dans data.order_id pour le rapprochement (ikeepay-webhook/index.ts).
  const reference = "IFR" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  return {
    reference,
    raw: { mode: "inline_checkout" },
    client: {
      ikeepayReference: reference,
      ikeepayPublicKey: ikeepayPublicKey(),
      ikeepayCheckoutUrl: ikeepayCheckoutUrl(),
      ikeepayAmount: Math.round(displayAmount * 100) / 100,
      ikeepayCurrency: currency,
      ikeepayEmail: email,
      message: "Une fenêtre sécurisée iKeePay va s'ouvrir pour finaliser le paiement.",
    },
  };
}

// ---------------------------------------------------------------------------
// PayPal Orders API v2. Nécessite PAYPAL_CLIENT_ID et PAYPAL_CLIENT_SECRET.
// PAYPAL_ENV = 'sandbox' (par défaut) ou 'live'.
// ---------------------------------------------------------------------------
async function initPaypal(orderId: string, amountFcfa: number) {
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const secret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  if (!clientId || !secret) {
    return { reference: "SANDBOX-" + orderId, raw: { sandbox: true }, client: { sandbox: true, message: "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET non configurées : paiement simulé, aucun débit réel." } };
  }
  const base = (Deno.env.get("PAYPAL_ENV") ?? "sandbox") === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const amountUsd = (amountFcfa / 610).toFixed(2); // conversion grossière FCFA->USD pour l'exemple ; brancher CurrencyService en vrai
  const tokRes = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Authorization": "Basic " + btoa(`${clientId}:${secret}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const tok = await tokRes.json();
  const ordRes = await fetch(`${base}/v2/checkout/orders`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ reference_id: orderId, amount: { currency_code: "USD", value: amountUsd } }],
    }),
  });
  const ord = await ordRes.json();
  const approve = (ord.links ?? []).find((l: { rel: string; href: string }) => l.rel === "approve")?.href ?? null;
  return { reference: ord.id, raw: ord, client: { approveUrl: approve, paypalOrderId: ord.id } };
}
