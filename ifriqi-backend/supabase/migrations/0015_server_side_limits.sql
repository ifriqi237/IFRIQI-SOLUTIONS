-- 0015 (applique en base le 2026-10-19) : limites cote serveur.
--  1) retrait minimum (settings.min_withdraw_fcfa) applique dans check_withdrawal_balance()
--  2) formulaire de contact public : 5 messages/heure par contact, 100/heure au total
--  3) scans de cartes inconnues : plus de journal au-dela de 300/minute (reponse inchangee)
create or replace function public.check_withdrawal_balance() returns trigger
language plpgsql set search_path = public as $$
declare v_ledger_total numeric; v_already_withdrawn numeric; v_available numeric; v_min numeric;
begin
  select min_withdraw_fcfa into v_min from settings where id = 1;
  if v_min is not null and new.amount_fcfa < v_min then
    raise exception 'Retrait minimum : % FCFA (demandé : % FCFA)', v_min, new.amount_fcfa;
  end if;
  select coalesce(sum(amount_fcfa),0) into v_ledger_total from ledger where dist_id = new.dist_id;
  select coalesce(sum(amount_fcfa),0) into v_already_withdrawn from withdrawals
    where dist_id = new.dist_id and status in ('REQUESTED','PROCESSING','PAID');
  v_available := v_ledger_total - v_already_withdrawn;
  if new.amount_fcfa > v_available then
    raise exception 'Solde insuffisant pour ce retrait (solde disponible : % FCFA, demandé : % FCFA)', v_available, new.amount_fcfa;
  end if;
  return new;
end $$;

create or replace function public.trg_support_rate_limit() returns trigger
language plpgsql set search_path = public as $$
begin
  if (select count(*) from support_messages where contact = new.contact and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from support_messages where created_at > now() - interval '1 hour') >= 100 then
    raise exception 'Trop de messages envoyés. Réessayez plus tard.';
  end if;
  return new;
end $$;
revoke all on function public.trg_support_rate_limit() from public, anon, authenticated;
create trigger support_rate_limit before insert on public.support_messages
  for each row execute function public.trg_support_rate_limit();

create or replace function public.trg_scans_notfound_limit() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.result = 'NOT_FOUND'
     and (select count(*) from scans where result = 'NOT_FOUND' and created_at > now() - interval '1 minute') >= 300 then
    return null;
  end if;
  return new;
end $$;
revoke all on function public.trg_scans_notfound_limit() from public, anon, authenticated;
create trigger scans_notfound_limit before insert on public.scans
  for each row execute function public.trg_scans_notfound_limit();
