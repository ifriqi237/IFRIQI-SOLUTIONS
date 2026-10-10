-- ============================================================================
-- IFRIQI — inscription distributeur en self-service + application réelle des
-- recharges de crédits (topup), 2026-10-10.
-- ============================================================================
-- 1) Devenir distributeur : jusqu'ici, aucune policy RLS n'autorisait un utilisateur
-- à créer sa propre ligne `distributors` — la seule voie existante était un insert
-- manuel en base. On ajoute une policy self-service, mais elle ne permet JAMAIS de
-- s'auto-approuver : le statut inséré doit toujours être 'VERIFICATION' (jamais
-- 'ACTIVE' directement), exactement comme le check constraint existant le permet
-- déjà. Seul un administrateur (admin-api, migration suivante) peut faire passer
-- un distributeur de VERIFICATION à ACTIVE.
--
-- Le code distributeur (`code`, unique, utilisé dans les liens de parrainage) est
-- désormais TOUJOURS généré côté serveur par un trigger, jamais fourni par le
-- client — même principe que `issue_card_for_order()` pour `cards.public_id`
-- (0003/0004_pawapay... non, voir définition initiale dans ce dépôt) : on ne laisse
-- jamais un client choisir un identifiant public qui doit être unique et non
-- deviné à l'avance.
-- ============================================================================

create or replace function set_distributor_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_tries int := 0;
begin
  if new.code is not null and new.code <> '' then
    return new;
  end if;
  loop
    v_code := 'IFD-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6));
    exit when not exists (select 1 from distributors where code = v_code);
    v_tries := v_tries + 1;
    if v_tries > 10 then
      raise exception 'Impossible de générer un code distributeur unique.';
    end if;
  end loop;
  new.code := v_code;
  return new;
end;
$$;

drop trigger if exists trg_set_distributor_code on distributors;
create trigger trg_set_distributor_code
  before insert on distributors
  for each row execute function set_distributor_code();

create policy "own distributor insert" on distributors
  for insert
  with check (auth.uid() = user_id and status = 'VERIFICATION');

comment on policy "own distributor insert" on distributors is
  'Permet à un utilisateur authentifié de demander à devenir distributeur '
  '(auto-inscription), toujours avec status=''VERIFICATION''. L''activation '
  '(passage à ACTIVE) n''est possible que via admin-api (service_role), jamais '
  'par le client lui-même.';

-- ============================================================================
-- 2) Recharge de crédits (topup) : jusqu'ici, pawapay-deposit-callback appelait
-- issue_card_for_order() uniquement pour product='card'. Pour product='topup',
-- rien n'incrémentait réellement cards.credits — la commande passait PAID mais
-- le crédit n'était jamais livré. Ajoute apply_topup_for_order(), appelée depuis
-- le callback (voir modification de pawapay-deposit-callback/index.ts dans le
-- même commit), avec la même marque d'idempotence que pour l'émission de carte
-- (rejouer ce callback plusieurs fois ne doit jamais créditer plusieurs fois).
-- ============================================================================

alter table orders add column if not exists credited boolean not null default false;

comment on column orders.credited is
  'Marque d''idempotence pour apply_topup_for_order() : empêche un callback '
  'rejoué (PawaPay réessaie jusqu''à 15 min) de créditer plusieurs fois le même '
  'achat de recharge. Sans effet sur product=''card'' (idempotent nativement via '
  'la contrainte unique cards.profile_id).';

create or replace function apply_topup_for_order(p_order_id uuid)
returns table(profile_id uuid, credits int, already_applied boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
  v_settings settings%rowtype;
  v_new_credits int;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found or v_order.payment_status <> 'PAID' or v_order.product <> 'topup' or v_order.profile_id is null then
    raise exception 'Commande introuvable, non payée, ou sans profil : impossible d''appliquer la recharge.';
  end if;

  if v_order.credited then
    select c.credits into v_new_credits from cards c where c.profile_id = v_order.profile_id;
    return query select v_order.profile_id, v_new_credits, true;
    return;
  end if;

  select * into v_settings from settings where id = 1;

  update cards set credits = cards.credits + v_settings.edits_included
    where cards.profile_id = v_order.profile_id
    returning cards.credits into v_new_credits;

  if v_new_credits is null then
    raise exception 'Aucune carte existante pour ce profil : impossible de recharger des crédits.';
  end if;

  update orders set credited = true where id = p_order_id;

  return query select v_order.profile_id, v_new_credits, false;
end;
$$;

comment on function apply_topup_for_order is
  'Incrémente cards.credits de settings.edits_included pour la carte du profil '
  'de la commande, une seule fois par commande (voir orders.credited). Appelée '
  'uniquement depuis pawapay-deposit-callback (service_role) après confirmation '
  'réelle du paiement — jamais par le client.';
