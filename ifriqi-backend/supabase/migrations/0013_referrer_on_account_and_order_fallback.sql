-- 0013 : parrain memorise sur le compte de l'acheteur + rattachement serveur des commandes de carte
-- sans distributeur (filet de securite si le navigateur n'envoie pas le code de parrainage).
-- Applique en base (sans les 'drop trigger', signales destructifs ; creation seule).
alter table public.app_users add column if not exists referred_by_dist uuid references public.distributors(id) on delete set null;

create or replace function public.trg_app_users_keep_referrer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.referred_by_dist is not null then
    new.referred_by_dist := old.referred_by_dist;
  end if;
  if new.referred_by_dist is not null and not exists (
       select 1 from public.distributors d where d.id = new.referred_by_dist and d.status = 'ACTIVE' and d.user_id <> new.id) then
    new.referred_by_dist := null;
  end if;
  return new;
end $$;
revoke all on function public.trg_app_users_keep_referrer() from public, anon, authenticated;
create trigger app_users_keep_referrer before insert or update on public.app_users
  for each row execute function public.trg_app_users_keep_referrer();

create or replace function public.trg_orders_default_dist() returns trigger
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if new.dist_id is null and new.product = 'card' then
    select a.referred_by_dist into v from public.app_users a where a.id = new.customer_id;
    if v is null then
      select d.referred_by into v from public.distributors d where d.user_id = new.customer_id;
    end if;
    if v is not null and exists (select 1 from public.distributors d where d.id = v and d.status = 'ACTIVE' and d.user_id <> new.customer_id) then
      new.dist_id := v;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.trg_orders_default_dist() from public, anon, authenticated;
create trigger orders_default_dist before insert on public.orders
  for each row execute function public.trg_orders_default_dist();
