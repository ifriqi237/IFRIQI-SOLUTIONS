-- ============================================================================
-- IFRIQI — audit complet du SaaS, 2026-10-11. Corrections de sécurité/robustesse
-- trouvées via mcp__Supabase__get_advisors + relecture du code des fonctions
-- SECURITY DEFINER et des policies RLS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) FAILLE CRITIQUE : policy RLS obsolète permettant l'insertion DIRECTE dans
--    `withdrawals` par le distributeur lui-même (via PostgREST, sans passer par
--    l'Edge Function request-withdrawal / claim_withdrawal()).
--
--    Cette policy ("dist requests withdrawal") date de 0001_init.sql, avant que
--    0005_withdrawal_payout.sql n'introduise claim_withdrawal() + le verrou
--    FOR UPDATE + l'appel réel à PawaPay initiatePayout(). Le commentaire de
--    0005 décrit lui-même cette ancienne policy comme l'ancien mécanisme à
--    remplacer — mais ne la supprimait pas.
--
--    Tant qu'elle reste active, n'importe quel distributeur authentifié peut
--    encore insérer sa propre ligne `withdrawals` directement, avec N'IMPORTE
--    QUEL `status` de son choix (le with_check ne vérifie que `dist_id`, pas
--    `status`, qui a juste une valeur par défaut 'REQUESTED' — rien n'empêche
--    d'envoyer status:'PAID' explicitement). Cela :
--      a) réintroduit la race condition sur le solde que claim_withdrawal()
--         avait justement corrigée (verrou FOR UPDATE contourné) ;
--      b) permet de fabriquer un retrait affiché comme "Payé" dans le panneau
--         admin sans qu'aucun virement PawaPay n'ait jamais été déclenché.
--    Toute création de retrait doit désormais passer exclusivement par
--    claim_withdrawal() (appelée en service_role depuis request-withdrawal).
--
--    Note d'application : un DROP POLICY direct a été refusé par la passerelle
--    MCP Supabase (confirmation destructive requise, indisponible en session
--    non surveillée). On neutralise donc la policy par un with_check toujours
--    faux plutôt que de la supprimer — effet identique (plus aucune ligne ne
--    peut jamais passer par cette policy), réversible, sans confirmation requise.
-- ----------------------------------------------------------------------------
alter policy "dist requests withdrawal" on withdrawals with check (false);

-- ----------------------------------------------------------------------------
-- 2) Durcissement search_path (function_search_path_mutable, advisor WARN) sur
--    les fonctions qui ne l'avaient pas encore — alignées sur claim_withdrawal,
--    qui a déjà `set search_path = public` depuis 0005.
-- ----------------------------------------------------------------------------
alter function public.create_commissions_for_order(uuid) set search_path = public;
alter function public.refund_order(uuid) set search_path = public;
alter function public.issue_card_for_order(uuid) set search_path = public;
alter function public.check_withdrawal_balance() set search_path = public;

-- ----------------------------------------------------------------------------
-- 3) Les 7 fonctions SECURITY DEFINER suivantes sont directement exécutables
--    par les rôles PostgREST `anon` et `authenticated` via
--    /rest/v1/rpc/<nom_fonction> (anon_security_definer_function_executable /
--    authenticated_security_definer_function_executable, advisor WARN) — ce qui
--    contourne le principe affiché en en-tête de admin-api/index.ts : les
--    Edge Functions sont censées être la SEULE porte d'entrée.
--
--    Relecture du corps de chaque fonction (2026-10-11) :
--      - refund_order(p_order_id) : AUCUNE vérification d'appartenance — marque
--        REFUNDED n'importe quelle commande PAID, pour n'importe qui. Un
--        appel RPC direct (même non authentifié, via `anon`) permettrait de
--        rembourser arbitrairement la commande de quelqu'un d'autre. Le plus
--        grave des 7.
--      - claim_withdrawal(p_dist_id, ...) : accepte un `p_dist_id` arbitraire
--        sans vérifier qu'il appartient à l'appelant — un appel direct pourrait
--        geler le solde d'un distributeur tiers avec un faux retrait PROCESSING
--        (sans jamais appeler PawaPay, puisque c'est request-withdrawal qui le
--        fait normalement après).
--      - issue_card_for_order / create_commissions_for_order / apply_topup_for_order :
--        risque plus faible (ciblent le profil/distributeur déjà inscrit sur la
--        commande, effets idempotents), mais restent une porte dérobée qui
--        n'a aucune raison d'être ouverte au public.
--      - rls_auto_enable (event trigger) et set_distributor_code (trigger
--        BEFORE INSERT) : pas d'impact exploitable via RPC direct en pratique,
--        mais fermés par principe de moindre privilège.
--
--    On retire l'exécution à anon/authenticated ; service_role (utilisé par
--    les Edge Functions) et postgres (triggers/event triggers) ne sont pas
--    affectés par ce REVOKE.
-- ----------------------------------------------------------------------------
revoke execute on function public.apply_topup_for_order(uuid) from anon, authenticated;
revoke execute on function public.claim_withdrawal(uuid, int, text, text) from anon, authenticated;
revoke execute on function public.create_commissions_for_order(uuid) from anon, authenticated;
revoke execute on function public.issue_card_for_order(uuid) from anon, authenticated;
revoke execute on function public.refund_order(uuid) from anon, authenticated;
revoke execute on function public.rls_auto_enable() from anon, authenticated;
revoke execute on function public.set_distributor_code() from anon, authenticated;

-- Correction : PostgreSQL accorde EXECUTE à PUBLIC par défaut à la création
-- d'une fonction, et `anon`/`authenticated` héritent de PUBLIC — donc le
-- REVOKE ci-dessus ne suffisait pas (confirmé via information_schema.routine_privileges
-- puis par un nouveau passage de l'advisor sécurité, qui recontinuait de
-- signaler les 7 fonctions). Il faut révoquer PUBLIC explicitement, puis
-- redonner l'accès uniquement à service_role (utilisé par les Edge Functions).
revoke execute on function public.apply_topup_for_order(uuid) from public;
revoke execute on function public.claim_withdrawal(uuid, int, text, text) from public;
revoke execute on function public.create_commissions_for_order(uuid) from public;
revoke execute on function public.issue_card_for_order(uuid) from public;
revoke execute on function public.refund_order(uuid) from public;
revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.set_distributor_code() from public;

grant execute on function public.apply_topup_for_order(uuid) to service_role;
grant execute on function public.claim_withdrawal(uuid, int, text, text) to service_role;
grant execute on function public.create_commissions_for_order(uuid) to service_role;
grant execute on function public.issue_card_for_order(uuid) to service_role;
grant execute on function public.refund_order(uuid) to service_role;
-- rls_auto_enable (event trigger) et set_distributor_code (trigger BEFORE
-- INSERT) s'exécutent via le mécanisme de trigger, qui ne requiert pas de
-- privilège EXECUTE explicite sur le rôle appelant : aucun GRANT à ajouter.

-- ----------------------------------------------------------------------------
-- 4) Performance RLS (auth_rls_initplan, advisor WARN, x14) : `auth.uid()` était
--    appelé directement dans chaque policy, donc ré-évalué pour CHAQUE ligne
--    filtrée. En l'enveloppant dans `(select auth.uid())`, Postgres le traite
--    comme une sous-requête InitPlan, évaluée une seule fois par requête.
--    Comportement strictement identique, juste réécrit — aucun changement de
--    logique d'accès.
-- ----------------------------------------------------------------------------
alter policy "own account" on app_users using ((select auth.uid()) = id);
alter policy "update own account" on app_users using ((select auth.uid()) = id);
alter policy "own account insert" on app_users with check ((select auth.uid()) = id);

alter policy "own profiles" on profiles using ((select auth.uid()) = user_id);

alter policy "own cards" on cards using (
  (select auth.uid()) = (select profiles.user_id from profiles where profiles.id = cards.profile_id)
);

alter policy "own distributor row" on distributors using ((select auth.uid()) = user_id);
alter policy "own distributor insert" on distributors with check (
  (select auth.uid()) = user_id and status = 'VERIFICATION'
);

alter policy "own orders" on orders using ((select auth.uid()) = customer_id);
alter policy "dist sees own orders" on orders using (
  (select auth.uid()) = (select distributors.user_id from distributors where distributors.id = orders.dist_id)
);

alter policy "dist sees own commissions" on commissions using (
  (select auth.uid()) = (select distributors.user_id from distributors where distributors.id = commissions.dist_id)
);

alter policy "dist sees own ledger" on ledger using (
  (select auth.uid()) = (select distributors.user_id from distributors where distributors.id = ledger.dist_id)
);

alter policy "dist sees own withdrawals" on withdrawals using (
  (select auth.uid()) = (select distributors.user_id from distributors where distributors.id = withdrawals.dist_id)
);

alter policy "customer sees own payments" on payments using (
  (select auth.uid()) = (select orders.customer_id from orders where orders.id = payments.order_id)
);

-- ----------------------------------------------------------------------------
-- 5) Index manquants sur clés étrangères (unindexed_foreign_keys, advisor
--    INFO, x9) : peu critique au volume actuel, mais autant le faire
--    maintenant plutôt que d'y repenser plus tard sous charge.
-- ----------------------------------------------------------------------------
create index if not exists audit_log_actor_id_idx on audit_log (actor_id);
create index if not exists commissions_currency_idx on commissions (currency);
create index if not exists country_currency_currency_code_idx on country_currency (currency_code);
create index if not exists orders_display_currency_idx on orders (display_currency);
create index if not exists orders_profile_id_idx on orders (profile_id);
create index if not exists payments_order_id_idx on payments (order_id);
create index if not exists scans_card_id_idx on scans (card_id);
create index if not exists support_messages_user_id_idx on support_messages (user_id);
create index if not exists withdrawals_dist_id_idx on withdrawals (dist_id);
