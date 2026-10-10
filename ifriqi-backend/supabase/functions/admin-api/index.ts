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
//   list_commissions       { limit? }                         -> commissions + distributeur
//   list_withdrawals       { status? }                        -> retraits + distributeur
//   list_users             { limit? }                         -> comptes
//   approve_distributor    { dist_id }                        -> VERIFICATION -> ACTIVE
//   suspend_distributor    { dist_id }                        -> * -> SUSPENDED
//   reactivate_distributor { dist_id }                        -> SUSPENDED -> ACTIVE
//   suspend_user           { user_id }                        -> active -> suspended
//   reactivate_user        { user_id }                        -> suspended -> active
//   update_settings        { price_fcfa?, comm_l1_fcfa?, ... } -> met à jour settings (id=1)
//
// Principes de sécurité (mêmes que refund-order/request-withdrawal) :
//   1. Le rôle admin est revérifié ici à chaque appel via le JWT (jamais un champ envoyé par le
//      client, jamais un état local comme l'ancien "adminOK" du prototype).
//   2. Les transitions de statut sont toujours conditionnées sur l'état de départ attendu
//      (ex. approve_distributor n'agit que si status='VERIFICATION') : un double-clic ou deux
//      admins concurrents ne peuvent pas produire un état incohérent silencieux.
//   3. Un admin ne peut jamais se suspendre lui-même (verrou trivial pour éviter de se
//      retrouver bloqué hors du panneau par erreur).
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
        const { data: users } = userIds.length
          ? await svc.from("app_users").select("id,first_name,last_name,email,phone,country").in("id", userIds)
          : { data: [] };
        return json({
          distributors: (dists ?? []).map((d) => ({
            ...d,
            holder: (users ?? []).find((u) => u.id === d.user_id) ?? null,
          })),
        });
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
        return json({ user: data });
      }

      case "update_settings": {
        const fields = ["price_fcfa", "comm_l1_fcfa", "comm_l2_fcfa", "min_withdraw_fcfa", "validation_days", "edits_included"] as const;
        const update: Record<string, number> = {};
        for (const f of fields) {
          if (body[f] !== undefined) {
            const v = body[f];
            if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || Math.floor(v) !== v) {
              return json({ error: `${f} doit être un entier strictement positif.` }, 400);
            }
            update[f] = v;
          }
        }
        if (Object.keys(update).length === 0) return json({ error: "Aucun champ à mettre à jour." }, 400);
        const { data, error } = await svc.from("settings").update(update).eq("id", 1).select().single();
        if (error) return dbError("update_settings", error);
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
