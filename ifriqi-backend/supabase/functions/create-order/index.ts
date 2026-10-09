// POST /create-order
// Body: { profileId: string, product: 'card'|'topup', refCode?: string, method: 'momo'|'card'|'paypal', phone?: string }
//
// Appelé par le front, authentifié (JWT Supabase dans Authorization). Ne fait JAMAIS confiance
// à un montant envoyé par le client : le prix vient de la table `settings`, côté serveur.
// Crée la commande + initie le paiement chez le prestataire choisi, renvoie l'URL/les
// instructions à suivre pour payer.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";

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
    const { profileId, product, refCode, method, phone } = body as {
      profileId: string; product: "card" | "topup"; refCode?: string; method: string; phone?: string;
    };
    if (!profileId || !["card", "topup"].includes(product)) {
      return json({ error: "profileId et product ('card'|'topup') sont requis." }, 400);
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
    const provider = method === "paypal" ? "paypal" : "cinetpay"; // momo/card/other -> CinetPay (agrégateur Mobile Money + carte en zone CEMAC/UEMOA)
    const init = provider === "paypal"
      ? await initPaypal(order.id, priceFcfa)
      : await initCinetpay(order.id, priceFcfa, method, phone);

    await svc.from("payments").insert({
      order_id: order.id,
      provider,
      provider_ref: init.reference ?? null,
      method,
      amount_fcfa: priceFcfa,
      status: "PENDING",
      raw_payload: init.raw ?? null,
    });

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
