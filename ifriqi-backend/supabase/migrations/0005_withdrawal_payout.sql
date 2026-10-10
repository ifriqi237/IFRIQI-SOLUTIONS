-- ============================================================================
-- IFRIQI — retrait self-service des commissions via PawaPay (payouts), 2026-10-10.
-- ============================================================================
-- Jusqu'ici, un distributeur pouvait seulement DEMANDER un retrait (insertion directe
-- dans `withdrawals`, policy RLS "dist requests withdrawal", 0001_init.sql), mais rien
-- dans ce dépôt n'appelait jamais l'API "Initiate Payout" de PawaPay : le commentaire
-- d'en-tête de pawapay-payout-callback/index.ts le disait explicitement — cette fonction
-- ne pouvait que RECEVOIR une confirmation de payout, jamais le déclencher.
--
-- Cette migration ajoute claim_withdrawal(), appelée exclusivement par la nouvelle Edge
-- Function request-withdrawal/index.ts (service_role), qui réserve le solde ET insère la
-- ligne `withdrawals` dans la MÊME transaction, verrouillée sur le distributeur concerné
-- (SELECT ... FOR UPDATE). Cela corrige une race condition possible dans la vérification
-- check_withdrawal_balance() (0002_audit_fixes.sql) : son contrôle, exécuté juste avant
-- l'INSERT mais sans verrou explicite, n'empêchait pas deux requêtes concurrentes de lire
-- le même solde disponible et de passer toutes les deux la vérification avant qu'aucune
-- des deux lignes ne soit encore visible de l'autre. Le trigger existant reste en place
-- (défense en profondeur, inchangé) ; cette fonction ajoute le verrou qui lui manquait.
-- ============================================================================

create or replace function claim_withdrawal(
  p_dist_id uuid,
  p_amount_fcfa int,
  p_account_ref text,
  p_provider_ref text
)
returns withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_total numeric;
  v_already_withdrawn numeric;
  v_available numeric;
  v_row withdrawals;
begin
  -- Verrou : sérialise les demandes concurrentes du même distributeur. Une seconde
  -- transaction attend que la première se termine (commit ou rollback) avant de
  -- recalculer le solde disponible, qui tiendra alors compte de la ligne déjà insérée.
  perform 1 from distributors where id = p_dist_id for update;

  if p_amount_fcfa <= 0 then
    raise exception 'Le montant du retrait doit être strictement positif.';
  end if;

  select coalesce(sum(amount_fcfa), 0) into v_ledger_total from ledger where dist_id = p_dist_id;
  select coalesce(sum(amount_fcfa), 0) into v_already_withdrawn from withdrawals
    where dist_id = p_dist_id and status in ('REQUESTED', 'PROCESSING', 'PAID');
  v_available := v_ledger_total - v_already_withdrawn;

  if p_amount_fcfa > v_available then
    raise exception 'Solde insuffisant pour ce retrait (solde disponible : % FCFA, demandé : % FCFA)', v_available, p_amount_fcfa;
  end if;

  insert into withdrawals (dist_id, amount_fcfa, method, account_ref, status, provider, provider_ref)
  values (p_dist_id, p_amount_fcfa, 'pawapay', p_account_ref, 'PROCESSING', 'pawapay', p_provider_ref)
  returning * into v_row;

  return v_row;
end;
$$;

comment on function claim_withdrawal is
  'Réserve atomiquement le solde d''un distributeur (verrou FOR UPDATE sur distributors) '
  'et insère la ligne withdrawals correspondante, status=PROCESSING. Appelée uniquement '
  'par request-withdrawal/index.ts (service_role) avant d''appeler initiatePayout() ; '
  'si PawaPay rejette l''appel, la ligne passe à REJECTED (jamais supprimée) et le solde '
  'redevient disponible, puisque le calcul ci-dessus exclut REJECTED/CANCELLED.';
