-- 0010 : activation AUTOMATIQUE d'un distributeur dès que sa carte IFRIQI existe.
-- L'activation manuelle (admin-api approve_distributor) reste disponible mais n'est plus nécessaire.
--  * Cas 1 : le client a déjà un compte distributeur (VERIFICATION) et sa carte est émise -> trigger sur cards.
--  * Cas 2 : le client a déjà sa carte et crée ensuite son compte distributeur -> trigger sur distributors.
-- Seul le statut VERIFICATION est modifié : SUSPENDED / DEACTIVATED ne sont jamais réactivés automatiquement.
-- La policy d'insertion (status = 'VERIFICATION' obligatoire) n'est pas touchée : l'activation se fait
-- APRÈS l'insertion, dans une fonction SECURITY DEFINER, donc un utilisateur ne peut pas s'auto-approuver
-- sans carte réellement émise (une carte n'est émise que pour une commande PAID).

create or replace function public.activate_distributor_for_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_user_id is null then return; end if;
  if not exists (select 1 from cards c join profiles p on p.id = c.profile_id where p.user_id = p_user_id) then
    return;
  end if;
  update distributors set status = 'ACTIVE', activated_at = coalesce(activated_at, now())
   where user_id = p_user_id and status = 'VERIFICATION'
   returning id into v_id;
  if v_id is not null then
    insert into audit_log (actor_id, action, resource) values (null, 'distributor_auto_activated', v_id::text);
  end if;
end $$;

create or replace function public.trg_cards_activate_distributor() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform activate_distributor_for_user((select user_id from profiles where id = new.profile_id));
  return new;
end $$;

create or replace function public.trg_distributors_activate_if_card() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'VERIFICATION' then perform activate_distributor_for_user(new.user_id); end if;
  return new;
end $$;

drop trigger if exists trg_cards_activate_distributor on cards;
create trigger trg_cards_activate_distributor after insert on cards
  for each row execute function trg_cards_activate_distributor();

drop trigger if exists trg_distributors_activate_if_card on distributors;
create trigger trg_distributors_activate_if_card after insert on distributors
  for each row execute function trg_distributors_activate_if_card();

revoke execute on function public.activate_distributor_for_user(uuid), public.trg_cards_activate_distributor(),
  public.trg_distributors_activate_if_card() from anon, authenticated, public;
grant execute on function public.activate_distributor_for_user(uuid) to service_role;

-- Rattrapage : distributeurs en VERIFICATION qui ont déjà une carte.
select activate_distributor_for_user(user_id) from distributors where status = 'VERIFICATION';
