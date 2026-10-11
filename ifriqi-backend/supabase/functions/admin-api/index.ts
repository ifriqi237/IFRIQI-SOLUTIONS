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
//   list_withdrawals       { status? }                        -> retraits + distributeur
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
