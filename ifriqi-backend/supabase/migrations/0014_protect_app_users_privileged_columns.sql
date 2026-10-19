-- 0014 (CRITIQUE, applique en base le 2026-10-19) : un utilisateur connecte pouvait modifier sa propre
-- ligne app_users via l'API publique (policy "update own account" sans restriction de colonnes) et
-- se passer role='admin'. admin-api se fiant a app_users.role, cela donnait un acces administrateur
-- complet (remboursements, parametres, distributeurs). Les clients (anon/authenticated) ne peuvent
-- plus choisir leur role ni leur statut ; service_role / proprietaire SQL restent libres.
create or replace function public.trg_app_users_protect_privileged() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.role := 'user';
      new.status := 'active';
    else
      new.role := old.role;
      new.status := old.status;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.trg_app_users_protect_privileged() from public, anon, authenticated;
create trigger app_users_protect_privileged before insert or update on public.app_users
  for each row execute function public.trg_app_users_protect_privileged();

create index if not exists app_users_referred_by_dist_idx on public.app_users (referred_by_dist);
