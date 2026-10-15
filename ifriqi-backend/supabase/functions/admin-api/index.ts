// POST /admin-api — endpoint RÉSERVÉ AUX ADMINS (JWT Supabase requis, role='admin' dans
// app_users), appelé depuis le panneau d'administration. Regroupe en un seul endpoint les
// actions d'administration qui n'ont aucune autre voie d'accès aujourd'hui : aucune policy RLS
// ne donne à un admin un accès large aux tables (orders, distributors, app_users...), et c'était
// volontaire — cette fonction, en service_role, est la SEULE porte d'entrée pour ces lectures/
// écritures larges, avec la vérification de rôle refaite à chaque appel (jamais confiance dans
// un état côté client, même "adminOK" côté frontend).
//
// Body: { action: string, ...params }
// Actions :
//   list_orders            { limit? }                         -> commandes récentes + paiement
//   list_distributors      { status? }                        -> distributeurs + titulaire
//   list_cards              { limit? }                         -> profils + cartes (tous les comptes)
//   set_card_status        { profile_id, status }             -> ACTIVE <-> DEACTIVATED
//   grant_card_edits       { profile_id, amount }              -> crédite N éditions sur la carte
//   list_commissions       { limit? }                         -> commissions + distributeur
//   list_payments          { limit? }                         -> paiements réels (table payments) + commande/client
//   list_withdrawals       { status? }                        -> retraits + distributeur
//   cancel_withdrawal      { withdrawal_id }                   -> REQUESTED/PROCESSING -> CANCELLED (secours, jamais -> PAID)
//   list_users             { limit? }                         -> comptes
//   list_scans             { limit? }                         -> journal des scans QR (table scans)
//   list_audit_log         { limit? }                         -> journal des actions admin
//   list_support           { limit? }                         -> messages du formulaire de contact
//   list_settings          {}                                 -> paramètres courants (settings, id=1)
//   approve_distributor    { dist_id }                        -> VERIFICATION -> ACTIVE
//   suspend_distributor    { dist_id }                        -> * -> SUSPENDED
//   reactivate_distributor { dist_id }                        -> SUSPENDED -> ACTIVE
//   suspend_user           { user_id }                        -> active -> suspended
//   reactivate_user        { user_id }                        -> suspended -> active
//   update_settings        { price_fcfa?, ..., payment_methods?, payout_methods? } -> settings (id=1)
//   recheck_ikeepay_payment { payment_id }                      -> revérifie un paiement iKeePay
//                                                                   PENDING via GET /h2h-verify
//                                                                   (audit 2026-10-13, voir plus bas)
//   commissions_report    { country_code?, start_date, end_date, validated_only? }
//                                                                -> rapport agrégé des commissions
//                                                                   vendeurs (module Finances →
//                                                                   Rapports, 2026-10-15, voir plus
//                                                                   bas)
//   commissions_report_export_log { country_code?, start_date?, end_date? }
//                                                                -> journalise un export PDF du
//                                                                   rapport (aucune donnée lue,
//                                                                   voir plus bas)
//   list_countries         {}                                  -> pays configurés (country_currency)
//
// Principes de sécurité (mêmes que refund-order/request-withdrawal) :
//   1. Le rôle admin est revérifié ici à chaque appel via le JWT (jamais un champ envoyé par le
//      client, jamais un état local comme l'ancien "adminOK" du prototype).
//   2. Les transitions de statut sont toujours conditionnées sur l'état de départ attendu
//      (ex. approve_distributor n'agit que si status='VERIFICATION') : un double-clic ou deux
//      admins concurrents ne peuvent pas produire un état incohérent silencieux.
//   3. Un admin ne peut jamais se suspendre lui-même (verrou trivial pour éviter de se
//      retrouver bloqué hors du panneau par erreur).
//   4. F-19/F-20 (2026-10-11) : chaque mutation réussie de cette fonction écrit une ligne dans
//      audit_log (logAudit() plus bas) — c'est ce qui alimente réellement l'onglet "Journal" du
//      panneau admin, au lieu du tableau purement local d'avant.
import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";
import { verifyTransaction } from "../_shared/ikeepay.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  try {
    const uc = userClient(req.headers.get("Authorization"));
    const { data: { user }, error: authErr } = await uc.auth.getUser();
    if (authErr || !user) return json({ error: "Non authentifié." }, 401);

    const svc = serviceClient();
    const { data: caller } = await svc.from("app_users").select("role").eq("id", user.id).single();
    if (caller?.role !== "admin") {
      return json({ error: "Accès réservé aux administrateurs." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    switch (action) {
      case "list_orders": {
        const limit = clampLimit(body.limit, 100, 300);
        const { data: orders, error } = await svc
          .from("orders")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return dbError("list_orders", error);
        const orderIds = (orders ?? []).map((o) => o.id);
        const customerIds = [...new Set((orders ?? []).map((o) => o.customer_id))];
        const { data: payments } = orderIds.length
          ? await svc.from("payments").select("*").in("order_id", orderIds)
          : { data: [] };
        const { data: customers } = customerIds.length
          ? await svc.from("app_users").select("id,first_name,last_name,email,phone").in("id", customerIds)
          : { data: [] };
        return json({
          orders: (orders ?? []).map((o) => ({
            ...o,
            payment: (payments ?? []).find((p) => p.order_id === o.id) ?? null,
            customer: (customers ?? []).find((c) => c.id === o.customer_id) ?? null,
          })),
        });
      }

      case "list_distributors": {
        const status = typeof body.status === "string" ? body.status : undefined;
        let q = svc.from("distributors").select("*").order("activated_at", { ascending: false });
        if (status) q = q.eq("status", status);
        const { data: dists, error } = await q;
        if (error) return dbError("list_distributors", error);
        const userIds = [...new Set((dists ?? []).map((d) => d.user_id))];
        // F-17 (2026-10-11) : ce select omettait role/status. Le frontend fusionne pourtant ce
        // "holder" directement dans db.users (syncAdminDistributors -> mapAdminUser()), qui
        // retombe sur role:'user'/status:'active' par défaut quand le champ est absent — ce qui
        // écrasait silencieusement le rôle 'admin' réel de l'utilisateur connecté dès qu'il
        // apparaissait aussi comme titulaire d'une fiche distributeur (cas vécu : un admin qui
        // est aussi distributeur voyait son propre accès admin rétrogradé en cliquant sur
        // n'importe quel onglet du panneau admin, syncAdminDistributors() étant appelée à chaque
        // changement d'onglet). Inclure role/status élimine ce faux-positif à la source.
        const { data: users } = userIds.length
          ? await svc.from("app_users").select("id,first_name,last_name,email,phone,country,role,status").in("id", userIds)
          : { data: [] };
        return json({
          distributors: (dists ?? []).map((d) => ({
            ...d,
            holder: (users ?? []).find((u) => u.id === d.user_id) ?? null,
          })),
        });
      }

      case "list_cards": {
        // F-18 (2026-10-11) : l'onglet "Cartes" du panneau admin affichait jusqu'ici uniquement
        // les profils déjà connus en local (db.profiles, peuplé seulement par la propre carte
        // de l'admin connecté) — jamais les profils des AUTRES utilisateurs, et le bandeau
        // "prototype local, non connecté à la base" le signalait explicitement. Ajoute la
        // lecture réelle de tous les profils + cartes. Pas de jointure app_users ici : la
        // colonne "titulaire" affichée vient de profiles.first_name/last_name (le nom imprimé
        // sur la carte), jamais du compte — donc aucun risque de répéter le bug F-17
        // (role/status) puisqu'app_users n'est pas touché par cette action.
        const limit = clampLimit(body.limit, 300, 1000);
        const { data: profiles, error } = await svc
          .from("profiles")
          .select("*, cards(*)")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return dbError("list_cards", error);
        const withCard = (profiles ?? [])
          .map((p) => ({ ...p, card: Array.isArray(p.cards) ? p.cards[0] : p.cards }))
          .filter((p) => p.card);
        return json({ profiles: withCard });
      }

      case "set_card_status": {
        const profileId = requireString(body.profile_id, "profile_id");
        if (typeof profileId !== "string") return profileId;
        const status = body.status;
        if (status !== "ACTIVE" && status !== "DEACTIVATED") {
          return json({ error: "status doit être 'ACTIVE' ou 'DEACTIVATED'." }, 400);
        }
        const { data, error } = await svc
          .from("cards")
          .update({ status })
          .eq("profile_id", profileId)
          .select()
          .maybeSingle();
        if (error) return dbError("set_card_status", error);
        if (!data) return json({ error: "Aucune carte pour ce profil." }, 404);
        await logAudit(svc, user.id, "set_card_status_" + status.toLowerCase(), profileId);
        return json({ card: data });
      }

      case "grant_card_edits": {
        const profileId = requireString(body.profile_id, "profile_id");
        if (typeof profileId !== "string") return profileId;
        const amount = typeof body.amount === "number" && Number.isFinite(body.amount) && body.amount > 0
          ? Math.floor(body.amount)
          : null;
        if (amount === null) return json({ error: "amount doit être un entier strictement positif." }, 400);
        const { data: card, error: fetchErr } = await svc
          .from("cards")
          .select("id,credits")
          .eq("profile_id", profileId)
          .maybeSingle();
        if (fetchErr) return dbError("grant_card_edits", fetchErr);
        if (!card) return json({ error: "Aucune carte pour ce profil." }, 404);
        const { data, error } = await svc
          .from("cards")
          .update({ credits: card.credits + amount })
          .eq("id", card.id)
          .select()
          .single();
        if (error) return dbError("grant_card_edits", error);
        await logAudit(svc, user.id, "grant_card_edits_" + amount, profileId);
        return json({ card: data });
      }

      case "list_commissions": {
        const limit = clampLimit(body.limit, 200, 500);
        const { data: comms, error } = await svc
          .from("commissions")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return dbError("list_commissions", error);
        const distIds = [...new Set((comms ?? []).map((c) => c.dist_id))];
        const { data: dists } = distIds.length
          ? await svc.from("distributors").select("id,code,user_id").in("id", distIds)
          : { data: [] };
        return json({ commissions: (comms ?? []).map((c) => ({ ...c, distributor: (dists ?? []).find((d) => d.id === c.dist_id) ?? null })) });
      }

      // commissions_report — nouveau module Finances → Rapports commissions vendeurs
      // (demande du 15/10/2026). Agrège via get_commissions_report() (0009_commissions_report.sql,
      // lecture seule, service_role uniquement) : jamais de calcul de commission ici, uniquement
      // de la lecture/agrégation de ce qui existe déjà en base. country_code accepte un code pays
      // ISO2 (ex. 'CM') ou 'ALL'/absent pour tous les pays. start_date/end_date au format
      // AAAA-MM-JJ, bornes incluses, interprétées dans le fuseau horaire du pays choisi (table
      // statique ci-dessous — l'Afrique n'a pas d'heure d'été, donc un décalage fixe suffit) ;
      // pour 'ALL', on retombe sur UTC (aucun fuseau unique ne serait correct pour tous les pays
      // à la fois — limite documentée, pas un oubli). validated_only=true restreint aux
      // commissions déjà au statut 'VALIDATED' (voir commentaire de la fonction SQL : ce statut
      // n'est atteint par aucun mécanisme actuel de la plateforme, donc ce filtre ne renverra
      // rien tant qu'une validation manuelle/automatique n'existera pas — fourni par anticipation,
      // comme demandé). Chaque appel écrit une ligne dans audit_log (consultation d'un rapport
      // financier sensible), que la recherche aboutisse à un export PDF ou non.
      case "commissions_report": {
        const countryCode = typeof body.country_code === "string" && body.country_code && body.country_code !== "ALL"
          ? body.country_code
          : null;
        const startDate = typeof body.start_date === "string" ? body.start_date : null;
        const endDate = typeof body.end_date === "string" ? body.end_date : null;
        if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
          return json({ error: "start_date et end_date sont requis au format AAAA-MM-JJ." }, 400);
        }
        const validatedOnly = body.validated_only === true;

        const offsetHours = countryCode ? (COUNTRY_UTC_OFFSET[countryCode] ?? 0) : 0;
        // Jour civil [00:00:00, 23:59:59.999] dans le fuseau du pays, converti en UTC pour la requête.
        const startUtc = new Date(`${startDate}T00:00:00.000${formatOffset(offsetHours)}`);
        const endUtc = new Date(`${endDate}T23:59:59.999${formatOffset(offsetHours)}`);
        if (isNaN(startUtc.getTime()) || isNaN(endUtc.getTime()) || startUtc > endUtc) {
          return json({ error: "Période invalide (date de fin avant la date de début ?)." }, 400);
        }

        const { data: rows, error } = await svc.rpc("get_commissions_report", {
          p_country_code: countryCode,
          p_start: startUtc.toISOString(),
          p_end: endUtc.toISOString(),
          p_validated_only: validatedOnly,
        });
        if (error) return dbError("commissions_report", error);

        const { data: rates } = await svc.from("exchange_rates").select("target_currency,rate,effective_at").order("effective_at", { ascending: false });
        const rateFor = (cur: string) => (rates ?? []).find((r) => r.target_currency === cur) ?? null;

        const byCurrency = new Map<string, { currency_code: string; total_fcfa: number; converted: number | null; rate: number | null; rate_date: string | null }>();
        let totalDirect = 0, totalReferral = 0, totalAll = 0;
        for (const r of (rows ?? [])) {
          totalDirect += Number(r.direct_fcfa) || 0;
          totalReferral += Number(r.referral_fcfa) || 0;
          totalAll += Number(r.total_fcfa) || 0;
          const cur = r.currency_code || "XAF";
          const entry = byCurrency.get(cur) ?? { currency_code: cur, total_fcfa: 0, converted: null, rate: null, rate_date: null };
          entry.total_fcfa += Number(r.total_fcfa) || 0;
          byCurrency.set(cur, entry);
        }
        for (const entry of byCurrency.values()) {
          const rt = rateFor(entry.currency_code);
          entry.rate = rt ? Number(rt.rate) : (entry.currency_code === "XAF" ? 1 : null);
          entry.rate_date = rt?.effective_at ?? null;
          entry.converted = entry.rate !== null ? Math.round(entry.total_fcfa * entry.rate) : null;
        }

        await logAudit(
          svc,
          user.id,
          "commissions_report_view",
          `${countryCode ?? "ALL"}:${startDate}:${endDate}:${validatedOnly ? "validated_only" : "default"}`,
        );

        return json({
          rows: rows ?? [],
          totals: {
            distributor_count: (rows ?? []).length,
            direct_fcfa: totalDirect,
            referral_fcfa: totalReferral,
            total_fcfa: totalAll,
            by_currency: [...byCurrency.values()],
          },
          meta: {
            country_code: countryCode ?? "ALL",
            start_date: startDate,
            end_date: endDate,
            validated_only: validatedOnly,
            generated_at: new Date().toISOString(),
          },
        });
      }

      // commissions_report_export_log — le PDF (§7 du cahier des charges) est généré entièrement
      // côté client (jsPDF) à partir des données déjà renvoyées par un appel 'commissions_report'
      // précédent : aucune donnée supplémentaire n'est lue ici. Son seul rôle est d'écrire dans
      // audit_log que ce rapport a été EXPORTÉ (pas seulement consulté) — exigence explicite du
      // §10 ("journal d'audit [des] consultations/exports"), distincte de la ligne déjà écrite par
      // 'commissions_report' à chaque recherche.
      case "commissions_report_export_log": {
        const countryCode = typeof body.country_code === "string" && body.country_code ? body.country_code : "ALL";
        const startDate = typeof body.start_date === "string" ? body.start_date : "";
        const endDate = typeof body.end_date === "string" ? body.end_date : "";
        await logAudit(svc, user.id, "commissions_report_export", `${countryCode}:${startDate}:${endDate}`);
        return json({ ok: true });
      }

      // F-21 (2026-10-11) : l'onglet "Paiements" du panneau admin (distinct de "Ventes", qui lit
      // `orders`) lisait db.payments côté frontend — un tableau jamais alimenté par aucune
      // synchronisation ni aucune écriture locale, donc vide depuis toujours. Les KPIs "Paiements
      // réussis"/"Revenus" de l'Aperçu lisaient ce même tableau vide. Résultat concret signalé par
      // l'utilisateur : un paiement réellement réussi (table `payments`, status='SUCCESS') ce
      // matin n'apparaissait nulle part dans cet onglet, ni dans les KPIs. Corrigé en lisant
      // réellement la table `payments`.
      case "list_payments": {
        const limit = clampLimit(body.limit, 200, 500);
        const { data: pays, error } = await svc
          .from("payments")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return dbError("list_payments", error);
        const orderIds = [...new Set((pays ?? []).map((p) => p.order_id).filter(Boolean))];
        const { data: orders } = orderIds.length
          ? await svc.from("orders").select("id,product,customer_id").in("id", orderIds)
          : { data: [] };
        const customerIds = [...new Set((orders ?? []).map((o) => o.customer_id).filter(Boolean))];
        const { data: customers } = customerIds.length
          ? await svc.from("app_users").select("id,first_name,last_name,email,phone").in("id", customerIds)
          : { data: [] };
        return json({
          payments: (pays ?? []).map((p) => {
            const o = (orders ?? []).find((x) => x.id === p.order_id) ?? null;
            const c = o ? (customers ?? []).find((x) => x.id === o.customer_id) ?? null : null;
            const label = c
              ? (((c.first_name || "") + " " + (c.last_name || "")).trim() || c.email || c.phone || "")
              : "";
            return { ...p, product: o?.product ?? null, customer_label: label };
          }),
        });
      }

      case "list_withdrawals": {
        const status = typeof body.status === "string" ? body.status : undefined;
        let q = svc.from("withdrawals").select("*").order("requested_at", { ascending: false });
        if (status) q = q.eq("status", status);
        const { data: wds, error } = await q;
        if (error) return dbError("list_withdrawals", error);
        const distIds = [...new Set((wds ?? []).map((w) => w.dist_id))];
        const { data: dists } = distIds.length
          ? await svc.from("distributors").select("id,code,user_id").in("id", distIds)
          : { data: [] };
        return json({ withdrawals: (wds ?? []).map((w) => ({ ...w, distributor: (dists ?? []).find((d) => d.id === w.dist_id) ?? null })) });
      }

      // cancel_withdrawal : intervention de SECOURS uniquement, pour un retrait resté bloqué
      // en PROCESSING sans jamais recevoir de callback PawaPay (incident réseau, panne, compte
      // PawaPay mal configuré...). N'agit que sur REQUESTED/PROCESSING -> CANCELLED. Ne passe
      // JAMAIS à PAID depuis cette fonction : seul pawapay-payout-callback, après confirmation
      // serveur-à-serveur réelle de PawaPay, peut marquer un retrait payé. Le solde du
      // distributeur redevient disponible automatiquement (la formule de claim_withdrawal()
      // exclut CANCELLED/REJECTED), sans écriture ledger supplémentaire nécessaire.
      case "cancel_withdrawal": {
        const wdId = requireString(body.withdrawal_id, "withdrawal_id");
        if (typeof wdId !== "string") return wdId;
        const { data, error } = await svc
          .from("withdrawals")
          .update({ status: "CANCELLED" })
          .eq("id", wdId)
          .in("status", ["REQUESTED", "PROCESSING"])
          .select()
          .maybeSingle();
        if (error) return dbError("cancel_withdrawal", error);
        if (!data) return json({ error: "Ce retrait n'est plus en attente (déjà payé, rejeté ou annulé)." }, 409);
        await logAudit(svc, user.id, "cancel_withdrawal", wdId);
        return json({ withdrawal: data });
      }

      case "list_users": {
        const limit = clampLimit(body.limit, 200, 500);
        const { data: users, error } = await svc
          .from("app_users")
          .select("id,first_name,last_name,email,phone,country,role,status,created_at")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return dbError("list_users", error);
        return json({ users: users ?? [] });
      }

      case "list_scans": {
        const limit = clampLimit(body.limit, 200, 500);
        const { data, error } = await svc
          .from("scans")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return dbError("list_scans", error);
        return json({ scans: data ?? [] });
      }

      case "list_audit_log": {
        const limit = clampLimit(body.limit, 200, 500);
        const { data: rows, error } = await svc
          .from("audit_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return dbError("list_audit_log", error);
        const actorIds = [...new Set((rows ?? []).map((r) => r.actor_id).filter(Boolean))];
        // Select limité à id/first_name/last_name/email/phone (pas role/status) et jamais
        // fusionné dans db.users côté frontend : juste un libellé d'affichage pour le journal,
        // donc aucun risque de répéter le bug F-17 (role écrasé par défaut).
        const { data: actors } = actorIds.length
          ? await svc.from("app_users").select("id,first_name,last_name,email,phone").in("id", actorIds)
          : { data: [] };
        return json({
          logs: (rows ?? []).map((r) => {
            const a = (actors ?? []).find((x) => x.id === r.actor_id);
            const label = a
              ? (((a.first_name || "") + " " + (a.last_name || "")).trim() || a.email || a.phone || a.id)
              : (r.actor_id || "—");
            return { ...r, actor_label: label };
          }),
        });
      }

      case "list_support": {
        const limit = clampLimit(body.limit, 200, 500);
        const { data, error } = await svc
          .from("support_messages")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return dbError("list_support", error);
        return json({ messages: data ?? [] });
      }

      // list_countries — pays effectivement configurés dans IFRIQI (table de référence
      // country_currency, non sensible), pour alimenter dynamiquement le filtre pays du module
      // Finances → Rapports commissions vendeurs (demande explicite du cahier des charges
      // section 3.A : "La liste doit être alimentée dynamiquement à partir des pays effectivement
      // configurés dans IFRIQI").
      case "list_countries": {
        const { data, error } = await svc.from("country_currency").select("country_code,country_name,currency_code").order("country_name", { ascending: true });
        if (error) return dbError("list_countries", error);
        return json({ countries: data ?? [] });
      }

      case "list_settings": {
        const { data, error } = await svc.from("settings").select("*").eq("id", 1).single();
        if (error) return dbError("list_settings", error);
        return json({ settings: data });
      }

      case "approve_distributor": {
        const distId = requireString(body.dist_id, "dist_id");
        if (typeof distId !== "string") return distId;
        const { data, error } = await svc
          .from("distributors")
          .update({ status: "ACTIVE" })
          .eq("id", distId)
          .eq("status", "VERIFICATION")
          .select()
          .maybeSingle();
        if (error) return dbError("approve_distributor", error);
        if (!data) return json({ error: "Ce distributeur n'est pas (ou plus) en attente de vérification." }, 409);
        await logAudit(svc, user.id, "approve_distributor", distId);
        return json({ distributor: data });
      }

      case "suspend_distributor": {
        const distId = requireString(body.dist_id, "dist_id");
        if (typeof distId !== "string") return distId;
        const { data, error } = await svc
          .from("distributors")
          .update({ status: "SUSPENDED" })
          .eq("id", distId)
          .neq("status", "SUSPENDED")
          .select()
          .maybeSingle();
        if (error) return dbError("suspend_distributor", error);
        if (!data) return json({ error: "Ce distributeur est déjà suspendu ou introuvable." }, 409);
        await logAudit(svc, user.id, "suspend_distributor", distId);
        return json({ distributor: data });
      }

      case "reactivate_distributor": {
        const distId = requireString(body.dist_id, "dist_id");
        if (typeof distId !== "string") return distId;
        const { data, error } = await svc
          .from("distributors")
          .update({ status: "ACTIVE" })
          .eq("id", distId)
          .eq("status", "SUSPENDED")
          .select()
          .maybeSingle();
        if (error) return dbError("reactivate_distributor", error);
        if (!data) return json({ error: "Ce distributeur n'est pas suspendu." }, 409);
        await logAudit(svc, user.id, "reactivate_distributor", distId);
        return json({ distributor: data });
      }

      case "suspend_user": {
        const userId = requireString(body.user_id, "user_id");
        if (typeof userId !== "string") return userId;
        if (userId === user.id) return json({ error: "Vous ne pouvez pas suspendre votre propre compte." }, 400);
        const { data, error } = await svc
          .from("app_users")
          .update({ status: "suspended" })
          .eq("id", userId)
          .neq("status", "suspended")
          .select()
          .maybeSingle();
        if (error) return dbError("suspend_user", error);
        if (!data) return json({ error: "Ce compte est déjà suspendu ou introuvable." }, 409);
        await logAudit(svc, user.id, "suspend_user", userId);
        return json({ user: data });
      }

      case "reactivate_user": {
        const userId = requireString(body.user_id, "user_id");
        if (typeof userId !== "string") return userId;
        const { data, error } = await svc
          .from("app_users")
          .update({ status: "active" })
          .eq("id", userId)
          .eq("status", "suspended")
          .select()
          .maybeSingle();
        if (error) return dbError("reactivate_user", error);
        if (!data) return json({ error: "Ce compte n'est pas suspendu." }, 409);
        await logAudit(svc, user.id, "reactivate_user", userId);
        return json({ user: data });
      }

      // recheck_ikeepay_payment : audit sécurité du 2026-10-13 — confirmé en production le même
      // jour : iKeePay peut notifier un paiement réussi par email marchand sans JAMAIS appeler
      // notre webhook (ikeepay-webhook), laissant la commande bloquée à PENDING indéfiniment.
      // Cette action permet à un admin de déclencher une revérification RÉELLE serveur-à-serveur
      // (GET /h2h-verify/:reference, verifyTransaction()) — jamais une confirmation sur la seule
      // foi d'un email ou d'un clic admin. Réutilise exactement la même logique de traitement
      // (idempotente) que ikeepay-webhook en cas de succès confirmé.
      case "recheck_ikeepay_payment": {
        const paymentId = requireString(body.payment_id, "payment_id");
        if (typeof paymentId !== "string") return paymentId;
        const { data: payment, error: payErr } = await svc.from("payments").select("*").eq("id", paymentId).maybeSingle();
        if (payErr) return dbError("recheck_ikeepay_payment", payErr);
        if (!payment) return json({ error: "Paiement introuvable." }, 404);
        if (payment.provider !== "ikeepay") return json({ error: "Cette action ne concerne que les paiements iKeePay." }, 400);
        if (payment.status === "SUCCESS") return json({ status: "SUCCESS", already: true, message: "Déjà confirmé." });
        if (!payment.provider_ref) return json({ error: "Référence iKeePay manquante sur ce paiement." }, 500);

        const checked = await verifyTransaction(payment.provider_ref);

        if (checked.status === "completed") {
          await svc.from("payments").update({ status: "SUCCESS", paid_at: new Date().toISOString(), raw_payload: checked.raw }).eq("id", payment.id);
          await svc.from("orders").update({ payment_status: "PAID" }).eq("id", payment.order_id);
          await svc.rpc("create_commissions_for_order", { p_order_id: payment.order_id });
          const { data: order } = await svc.from("orders").select("product").eq("id", payment.order_id).single();
          if (order?.product === "card") {
            const { error: issueErr } = await svc.rpc("issue_card_for_order", { p_order_id: payment.order_id });
            if (issueErr) console.error("recheck_ikeepay_payment: issue_card_for_order a échoué", issueErr);
          } else if (order?.product === "topup") {
            const { error: topupErr } = await svc.rpc("apply_topup_for_order", { p_order_id: payment.order_id });
            if (topupErr) console.error("recheck_ikeepay_payment: apply_topup_for_order a échoué", topupErr);
          }
          await logAudit(svc, user.id, "recheck_ikeepay_payment_success", paymentId);
          return json({ status: "PAID", message: "Paiement confirmé réellement par iKeePay — commande marquée payée." });
        }
        if (checked.status === "failed") {
          await svc.from("payments").update({ status: "FAILED", raw_payload: checked.raw }).eq("id", payment.id);
          await svc.from("orders").update({ payment_status: "FAILED" }).eq("id", payment.order_id);
          await logAudit(svc, user.id, "recheck_ikeepay_payment_failed", paymentId);
          return json({ status: "FAILED", message: "iKeePay confirme l'échec de ce paiement." });
        }
        if (checked.status === "cancelled") {
          await svc.from("payments").update({ status: "CANCELLED", raw_payload: checked.raw }).eq("id", payment.id);
          await svc.from("orders").update({ payment_status: "CANCELLED" }).eq("id", payment.order_id);
          await logAudit(svc, user.id, "recheck_ikeepay_payment_cancelled", paymentId);
          return json({ status: "CANCELLED", message: "iKeePay confirme l'annulation de ce paiement." });
        }
        // "pending"/"unknown" : aucune écriture, on relaie simplement l'état réel actuel.
        return json({ status: checked.status, message: `iKeePay renvoie le statut '${checked.status}' pour ce paiement — pas encore de confirmation définitive.` });
      }

      case "update_settings": {
        const fields = ["price_fcfa", "comm_l1_fcfa", "comm_l2_fcfa", "min_withdraw_fcfa", "validation_days", "edits_included"] as const;
        const update: Record<string, unknown> = {};
        for (const f of fields) {
          if (body[f] !== undefined) {
            const v = body[f];
            if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || Math.floor(v) !== v) {
              return json({ error: `${f} doit être un entier strictement positif.` }, 400);
            }
            update[f] = v;
          }
        }
        // F-18bis (2026-10-11) : les bascules "Passerelle" (méthodes de paiement/retrait)
        // n'étaient jusqu'ici qu'un état local — chaque admin voyait sa propre version selon
        // son navigateur. On les persiste maintenant dans settings, comme le reste des
        // paramètres. Toujours envoyées comme objet complet (jamais un simple diff) pour
        // pouvoir vérifier ici qu'il en reste au moins une activée, même règle que côté client.
        if (body.payment_methods !== undefined) {
          const pm = body.payment_methods as Record<string, unknown>;
          const keys = ["momo", "card", "paypal", "other"];
          if (typeof pm !== "object" || pm === null || keys.some((k) => typeof pm[k] !== "boolean")) {
            return json({ error: "payment_methods doit contenir momo/card/paypal/other en booléen." }, 400);
          }
          if (!keys.some((k) => pm[k])) return json({ error: "Au moins un moyen de paiement doit rester actif." }, 400);
          update.payment_methods = pm;
        }
        if (body.payout_methods !== undefined) {
          const pm = body.payout_methods as Record<string, unknown>;
          const keys = ["momo", "bank", "paypal", "other"];
          if (typeof pm !== "object" || pm === null || keys.some((k) => typeof pm[k] !== "boolean")) {
            return json({ error: "payout_methods doit contenir momo/bank/paypal/other en booléen." }, 400);
          }
          if (!keys.some((k) => pm[k])) return json({ error: "Au moins un moyen de retrait doit rester actif." }, 400);
          update.payout_methods = pm;
        }
        if (Object.keys(update).length === 0) return json({ error: "Aucun champ à mettre à jour." }, 400);
        const { data, error } = await svc.from("settings").update(update).eq("id", 1).select().single();
        if (error) return dbError("update_settings", error);
        await logAudit(svc, user.id, "update_settings", Object.keys(update).join(","));
        return json({ settings: data });
      }

      default:
        return json({ error: `Action inconnue : '${action}'.` }, 400);
    }
  } catch (e) {
    console.error("admin-api error", e);
    return json({ error: "Une erreur est survenue." }, 500);
  }
});

// Décalage UTC fixe par pays (Afrique : aucun pays couvert ici n'observe l'heure d'été, un
// décalage statique est donc fiable) — utilisé uniquement par commissions_report pour borner
// correctement le "jour civil" d'une période dans le fuseau du pays choisi.
const COUNTRY_UTC_OFFSET: Record<string, number> = {
  ZA: 2, BJ: 1, BF: 0, CM: 1, CF: 1, CG: 1, CI: 0, GA: 1, GH: 0,
  GQ: 1, GW: 0, KE: 3, ML: 0, NE: 1, NG: 1, SN: 0, TD: 1, TG: 0,
};
function formatOffset(hours: number): string {
  const sign = hours >= 0 ? "+" : "-";
  const h = String(Math.abs(hours)).padStart(2, "0");
  return `${sign}${h}:00`;
}

function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, 1), max);
}

function requireString(v: unknown, field: string): string | Response {
  if (typeof v !== "string" || !v) return json({ error: `${field} est requis.` }, 400);
  return v;
}

function dbError(action: string, error: unknown): Response {
  console.error(`admin-api: ${action} a échoué`, error);
  return json({ error: "Une erreur est survenue lors de l'opération." }, 500);
}

// F-19/F-20 (2026-10-11) : journal réel des actions admin (table audit_log), alimentant
// l'onglet "Journal" du panneau admin. Volontairement best-effort : un échec d'écriture du
// journal ne doit jamais faire échouer l'action elle-même (déjà appliquée en base à ce stade).
async function logAudit(
  svc: ReturnType<typeof serviceClient>,
  actorId: string,
  action: string,
  resource?: string | null,
) {
  try {
    await svc.from("audit_log").insert({ actor_id: actorId, action, resource: resource ?? null });
  } catch (e) {
    console.error("admin-api: logAudit a échoué", e);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
