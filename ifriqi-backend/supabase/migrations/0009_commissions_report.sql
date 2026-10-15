-- 0009_commissions_report.sql — fonction d'agrégation pour le nouveau module Super Admin
-- "FINANCES → RAPPORTS COMMISSIONS VENDEURS" (demande du 15/10/2026).
--
-- N'AJOUTE AUCUN COMPORTEMENT NOUVEAU sur l'existant : fonction read-only (STABLE), appelée
-- uniquement par admin-api (service_role), avec le même verrou d'exécution (revoke public/
-- authenticated, grant service_role) que create_commissions_for_order/issue_card_for_order
-- (0006_security_audit_fixes.sql) — jamais exposée directement au client.
--
-- Règles de calcul (confirmées explicitement avec l'utilisateur le 15/10/2026, car le code
-- existant ne fait JAMAIS passer une commission de PENDING à VALIDATED — aucune fonction ne le
-- fait nulle part dans la base) :
--   - Comptabilise par défaut tout sauf 'CANCELLED' (donc PENDING + VALIDATED), pour refléter
--     l'argent réellement gagné dès aujourd'hui, sans attendre un mécanisme de validation qui
--     n'existe pas encore.
--   - p_validated_only=true restreint strictement à 'VALIDATED', pour quand ce mécanisme
--     existera (filtre de statut optionnel, prévu par le cahier des charges section 5.B).
--   - Le retrait (withdrawals/ledger) n'est jamais regardé ici : une commission retirée reste
--     comptée (règle explicite du cahier des charges, section 5.B).
-- Période : sur commissions.created_at (date comptable de la commission elle-même, pas celle
-- de la commande), bornes inclusives — à l'appelant (admin-api) de calculer p_start/p_end en
-- tenant compte du fuseau horaire du pays choisi.
-- Multi-devises : amount_fcfa est TOUJOURS exprimé en FCFA (c'est l'unité réelle du grand
-- livre — voir commissions.amount_fcfa, settings.comm_l1_fcfa/comm_l2_fcfa) ; additionner ces
-- valeurs est donc toujours valide (même unité). currency_code renvoyé ici sert uniquement à
-- l'appelant pour la CONVERSION D'AFFICHAGE (via exchange_rates), jamais pour additionner des
-- montants déjà convertis dans des devises différentes.
create or replace function public.get_commissions_report(
  p_country_code text,              -- code pays ISO2, ou null/'ALL' pour tous les pays
  p_start timestamptz,
  p_end timestamptz,
  p_validated_only boolean default false
)
returns table (
  dist_id uuid,
  dist_code text,
  first_name text,
  last_name text,
  phone text,
  country_code text,
  country_name text,
  currency_code text,
  direct_fcfa bigint,
  referral_fcfa bigint,
  total_fcfa bigint
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    d.id as dist_id,
    d.code as dist_code,
    u.first_name,
    u.last_name,
    u.phone,
    u.country_code,
    cc.country_name,
    coalesce(cc.currency_code, 'XAF') as currency_code,
    coalesce(sum(c.amount_fcfa) filter (where c.level = 1), 0)::bigint as direct_fcfa,
    coalesce(sum(c.amount_fcfa) filter (where c.level = 2), 0)::bigint as referral_fcfa,
    coalesce(sum(c.amount_fcfa), 0)::bigint as total_fcfa
  from commissions c
  join distributors d on d.id = c.dist_id
  join app_users u on u.id = d.user_id
  left join country_currency cc on cc.country_code = u.country_code
  where c.created_at >= p_start
    and c.created_at <= p_end
    and c.status <> 'CANCELLED'
    and (not p_validated_only or c.status = 'VALIDATED')
    and (p_country_code is null or p_country_code = 'ALL' or u.country_code = p_country_code)
  group by d.id, d.code, u.first_name, u.last_name, u.phone, u.country_code, cc.country_name, cc.currency_code
  having coalesce(sum(c.amount_fcfa), 0) <> 0
  order by total_fcfa desc;
$$;

revoke execute on function public.get_commissions_report(text, timestamptz, timestamptz, boolean) from anon, authenticated, public;
grant execute on function public.get_commissions_report(text, timestamptz, timestamptz, boolean) to service_role;
