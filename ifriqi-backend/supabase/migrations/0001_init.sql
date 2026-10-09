-- ============================================================================
-- IFRIQI — schéma backend réel (Supabase / Postgres)
-- ============================================================================
-- Remplace le "db" localStorage du prototype par de vraies tables, avec :
--   - auth gérée par Supabase Auth (auth.users)
--   - RLS strict : un client authentifié ne peut jamais créer/modifier une
--     commission, un paiement ou un order lui-même — seules les Edge Functions
--     (clé service_role) le font, après vérification du paiement.
--   - contraintes d'unicité qui REMPLACENT la logique d'idempotence côté JS
--     par une garantie au niveau base de données (impossible à contourner
--     même par un webhook dupliqué ou un appel concurrent).
-- ============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Comptes applicatifs (étend auth.users)
-- ---------------------------------------------------------------------------
create table app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  phone text,
  email text,
  country text,
  country_code text, -- ISO2, ex. 'CM'
  role text not null default 'user' check (role in ('user','admin')),
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now()
);
create unique index app_users_phone_idx on app_users(phone) where phone is not null;
create unique index app_users_email_idx on app_users(lower(email)) where email is not null;

-- ---------------------------------------------------------------------------
-- Devises / pays — table de référence, pas codée en dur dans l'application
-- ---------------------------------------------------------------------------
create table currencies (
  code text primary key,             -- XAF, XOF, GHS, NGN, KES...
  symbol text not null,
  name text not null,
  decimals int not null default 0
);

create table country_currency (
  country_code text primary key,     -- ISO2
  country_name text not null,
  currency_code text not null references currencies(code)
);

-- Taux de change : XAF = devise de référence (rate = unités de currency_code pour 1 XAF).
-- On garde tout l'historique (jamais de DELETE/UPDATE sur une ligne déjà utilisée par
-- une commande/commission : on insère une nouvelle ligne à chaque mise à jour).
create table exchange_rates (
  id uuid primary key default gen_random_uuid(),
  base_currency text not null default 'XAF',
  target_currency text not null references currencies(code),
  rate numeric(18,8) not null,
  source text not null default 'static', -- 'static' | 'api:<provider>' | 'manual'
  effective_at timestamptz not null default now()
);
create index exchange_rates_lookup on exchange_rates(target_currency, effective_at desc);

-- ---------------------------------------------------------------------------
-- Paramètres globaux (une seule ligne, modifiable par un admin)
-- ---------------------------------------------------------------------------
create table settings (
  id int primary key default 1 check (id = 1),
  price_fcfa int not null default 1000,
  comm_l1_fcfa int not null default 250,   -- commission niveau 1 (vente directe)
  comm_l2_fcfa int not null default 100,   -- commission niveau 2 (vente du filleul), jamais de niveau 3
  min_withdraw_fcfa int not null default 5000,
  validation_days int not null default 7,
  edits_included int not null default 4,
  updated_at timestamptz not null default now()
);
insert into settings (id) values (1);

-- ---------------------------------------------------------------------------
-- Profils (titulaires de carte) + cartes
-- ---------------------------------------------------------------------------
create table profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  type text not null check (type in ('adult','child')),
  first_name text not null default '',
  last_name text not null default '',
  dob date,
  sex text,
  address text,
  photo_url text,
  print_contact boolean not null default true,
  print_health boolean not null default false,
  contacts jsonb not null default '[]'::jsonb,   -- [{first,last,rel,phone}, ...]
  health jsonb not null default '{}'::jsonb,      -- {blood,allergies,...,vis:{...}}
  created_at timestamptz not null default now()
);
create index profiles_user_idx on profiles(user_id);

create table cards (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references profiles(id) on delete cascade,
  public_id text not null unique,     -- IFR-YYMM-NNNNNN, affiché sur la carte
  token_hash text not null,           -- SHA-256 du token QR (jamais le token en clair en base)
  status text not null default 'ACTIVE' check (status in ('ACTIVE','DEACTIVATED')),
  version int not null default 1,
  credits int not null default 4,
  edits_used int not null default 0,
  country_code text,                  -- figé à la création (priorité carte > profil > compte), jamais recalculé
  revoked_tokens int not null default 0, -- compteur de régénérations QR
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Distributeurs / parrainage strictement à 2 niveaux
-- ---------------------------------------------------------------------------
create table distributors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references app_users(id) on delete cascade,
  code text not null unique,                      -- IFR-XXXXX
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','DEACTIVATED','VERIFICATION')),
  referred_by uuid references distributors(id),    -- parrain DIRECT uniquement (niveau 1 pour ce distributeur)
  activated_at timestamptz not null default now(),
  -- un distributeur ne peut pas se parrainer lui-même, et la chaîne est bornée à 2 niveaux
  -- par construction applicative (le trigger ci-dessous bloque toute tentative de créer
  -- un niveau 3 en vérifiant que le parrain n'a lui-même pas de parrain... NON : on autorise
  -- le parrain à avoir un parrain (ça fait la chaîne), mais on ne verse JAMAIS de commission
  -- au-delà du parrain direct (voir fonction create_commission_for_order plus bas).
  constraint distributors_no_self_referral check (referred_by is distinct from id)
);
create index distributors_referred_by_idx on distributors(referred_by);

-- ---------------------------------------------------------------------------
-- Commandes et paiements
-- ---------------------------------------------------------------------------
create table orders (
  id uuid primary key default gen_random_uuid(),
  seq bigserial,
  customer_id uuid not null references app_users(id),
  profile_id uuid references profiles(id),
  product text not null check (product in ('card','topup')),
  amount_fcfa int not null,                -- montant en FCFA (valeur comptable de référence)
  dist_id uuid references distributors(id),-- distributeur attribué (lien visité avant l'achat)
  payment_status text not null default 'PENDING' check (payment_status in ('PENDING','PAID','FAILED','REFUNDED')),
  display_currency text references currencies(code),  -- devise affichée à l'acheteur
  display_rate numeric(18,8),                           -- taux figé au moment de la commande (jamais recalculé)
  display_amount numeric(18,2),
  created_at timestamptz not null default now()
);
create index orders_customer_idx on orders(customer_id);
create index orders_dist_idx on orders(dist_id);

create table payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  provider text not null,                  -- 'cinetpay' | 'paypal' | 'manual' ...
  provider_ref text,                       -- référence transaction chez le prestataire
  method text,                             -- 'momo' | 'card' | 'paypal' | 'other'
  amount_fcfa int not null,
  status text not null default 'PENDING' check (status in ('PENDING','SUCCESS','FAILED')),
  raw_payload jsonb,                       -- payload brut du webhook, pour audit
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
-- Un seul paiement "SUCCESS" par provider_ref : rejoue un webhook dupliqué sans
-- jamais créer deux lignes de paiement pour la même transaction.
create unique index payments_provider_ref_success_idx on payments(provider, provider_ref)
  where status = 'SUCCESS' and provider_ref is not null;

-- ---------------------------------------------------------------------------
-- Commissions — la contrainte UNIQUE(order_id, level) est LA garantie
-- d'idempotence : impossible, même en cas de webhook livré 10 fois en
-- parallèle, de créer deux fois la commission de niveau 1 ou 2 d'une commande.
-- ---------------------------------------------------------------------------
create table commissions (
  id uuid primary key default gen_random_uuid(),
  dist_id uuid not null references distributors(id),
  order_id uuid not null references orders(id),
  level smallint not null check (level in (1,2)),   -- jamais 3 : contrainte CHECK au niveau SQL
  amount_fcfa int not null,
  currency text references currencies(code),         -- devise d'affichage du bénéficiaire, figée
  rate_used numeric(18,8),                            -- taux figé à la création, jamais recalculé
  status text not null default 'PENDING' check (status in ('PENDING','VALIDATED','CANCELLED')),
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  unique (order_id, level)
);
create index commissions_dist_idx on commissions(dist_id);

create table ledger (
  id uuid primary key default gen_random_uuid(),
  dist_id uuid not null references distributors(id),
  type text not null check (type in ('COMMISSION','REVERSAL','WITHDRAWAL','ADJUSTMENT')),
  amount_fcfa int not null,
  ref text,
  description text,
  created_at timestamptz not null default now()
);
create index ledger_dist_idx on ledger(dist_id);

create table withdrawals (
  id uuid primary key default gen_random_uuid(),
  dist_id uuid not null references distributors(id),
  amount_fcfa int not null,
  method text not null,
  account_ref text,
  status text not null default 'REQUESTED' check (status in ('REQUESTED','PROCESSING','PAID','REJECTED','CANCELLED')),
  requested_at timestamptz not null default now(),
  paid_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Fonction serveur : création des commissions à 2 niveaux, strictement.
-- Appelée UNIQUEMENT par l'Edge Function payment-webhook (via service_role),
-- jamais directement par le client. C'est ici, au niveau base de données,
-- que la règle "jamais de niveau 3" est appliquée : on ne regarde que
-- distributors.referred_by du vendeur direct, un seul niveau, point final.
-- ---------------------------------------------------------------------------
create or replace function create_commissions_for_order(p_order_id uuid)
returns void language plpgsql security definer as $$
declare
  v_order orders%rowtype;
  v_dist distributors%rowtype;
  v_parent distributors%rowtype;
  v_settings settings%rowtype;
  v_customer app_users%rowtype;
  v_dist_user app_users%rowtype;
  v_parent_user app_users%rowtype;
  v_cur text; v_rate numeric;
begin
  select * into v_order from orders where id = p_order_id for update;
  if v_order.payment_status <> 'PAID' or v_order.dist_id is null or v_order.product <> 'card' then
    return; -- règle absolue : paiement confirmé + carte neuve uniquement
  end if;
  select * into v_settings from settings where id = 1;
  select * into v_dist from distributors where id = v_order.dist_id;
  if not found or v_dist.status in ('SUSPENDED','DEACTIVATED') then return; end if;

  select * into v_customer from app_users where id = v_order.customer_id;
  select * into v_dist_user from app_users where id = v_dist.user_id;
  -- anti auto-achat : même identité (compte, téléphone ou email)
  if v_dist_user.id = v_customer.id
     or (v_dist_user.phone is not null and v_dist_user.phone = v_customer.phone)
     or (v_dist_user.email is not null and lower(v_dist_user.email) = lower(v_customer.email)) then
    return;
  end if;

  -- Niveau 1 : vendeur direct. ON CONFLICT DO NOTHING = idempotence garantie par la base.
  select currency_code into v_cur from country_currency where country_code = v_dist_user.country_code;
  v_cur := coalesce(v_cur, 'XAF');
  select rate into v_rate from exchange_rates where target_currency = v_cur order by effective_at desc limit 1;
  insert into commissions (dist_id, order_id, level, amount_fcfa, currency, rate_used)
  values (v_dist.id, p_order_id, 1, v_settings.comm_l1_fcfa, v_cur, coalesce(v_rate,1))
  on conflict (order_id, level) do nothing;

  if v_dist.id is not null then
    insert into ledger (dist_id, type, amount_fcfa, ref, description)
    select v_dist.id, 'COMMISSION', v_settings.comm_l1_fcfa, p_order_id::text, 'Niveau 1 — vente directe'
    where exists (select 1 from commissions where order_id = p_order_id and level = 1 and dist_id = v_dist.id);
  end if;

  -- Niveau 2 : UNIQUEMENT le parrain DIRECT de v_dist (jamais plus haut -> pas de niveau 3).
  if v_dist.referred_by is not null then
    select * into v_parent from distributors where id = v_dist.referred_by;
    if found and v_parent.status = 'ACTIVE' then
      select * into v_parent_user from app_users where id = v_parent.user_id;
      if v_parent_user.id <> v_customer.id
         and not (v_parent_user.phone is not null and v_parent_user.phone = v_customer.phone)
         and not (v_parent_user.email is not null and lower(v_parent_user.email) = lower(v_customer.email)) then
        select currency_code into v_cur from country_currency where country_code = v_parent_user.country_code;
        v_cur := coalesce(v_cur, 'XAF');
        select rate into v_rate from exchange_rates where target_currency = v_cur order by effective_at desc limit 1;
        insert into commissions (dist_id, order_id, level, amount_fcfa, currency, rate_used)
        values (v_parent.id, p_order_id, 2, v_settings.comm_l2_fcfa, v_cur, coalesce(v_rate,1))
        on conflict (order_id, level) do nothing;

        insert into ledger (dist_id, type, amount_fcfa, ref, description)
        select v_parent.id, 'COMMISSION', v_settings.comm_l2_fcfa, p_order_id::text, 'Niveau 2 — vente du filleul'
        where exists (select 1 from commissions where order_id = p_order_id and level = 2 and dist_id = v_parent.id);
      end if;
    end if;
  end if;
end $$;

-- Remboursement : annule les commissions liées (jamais de suppression, on garde la trace).
create or replace function refund_order(p_order_id uuid)
returns void language plpgsql security definer as $$
begin
  update orders set payment_status = 'REFUNDED' where id = p_order_id and payment_status = 'PAID';
  update commissions set status = 'CANCELLED' where order_id = p_order_id and status <> 'CANCELLED';
  insert into ledger (dist_id, type, amount_fcfa, ref, description)
  select dist_id, 'REVERSAL', -amount_fcfa, p_order_id::text, 'Annulation suite remboursement'
  from commissions where order_id = p_order_id and status = 'CANCELLED';
end $$;

-- ---------------------------------------------------------------------------
-- RLS — un utilisateur ne voit/modifie que ses propres données. Les tables
-- sensibles à l'argent (orders, payments, commissions, ledger, withdrawals)
-- sont en lecture seule pour le client ; toute écriture passe par une Edge
-- Function avec la clé service_role (qui contourne RLS par conception).
-- ---------------------------------------------------------------------------
alter table app_users enable row level security;
alter table profiles enable row level security;
alter table cards enable row level security;
alter table distributors enable row level security;
alter table orders enable row level security;
alter table payments enable row level security;
alter table commissions enable row level security;
alter table ledger enable row level security;
alter table withdrawals enable row level security;

create policy "own account" on app_users for select using (auth.uid() = id);
create policy "update own account" on app_users for update using (auth.uid() = id);

create policy "own profiles" on profiles for all using (auth.uid() = user_id);

create policy "own cards" on cards for select using (
  auth.uid() = (select user_id from profiles where profiles.id = cards.profile_id)
);

create policy "own distributor row" on distributors for select using (auth.uid() = user_id);
-- lecture publique minimale pour valider un code de parrainage (page d'atterrissage /d/:code)
create policy "public code lookup" on distributors for select using (status = 'ACTIVE');

create policy "own orders" on orders for select using (auth.uid() = customer_id);
create policy "dist sees own orders" on orders for select using (
  auth.uid() = (select user_id from distributors where distributors.id = orders.dist_id)
);

create policy "dist sees own payments" on payments for select using (
  auth.uid() = (select customer_id from orders where orders.id = payments.order_id)
);

create policy "dist sees own commissions" on commissions for select using (
  auth.uid() = (select user_id from distributors where distributors.id = commissions.dist_id)
);
create policy "dist sees own ledger" on ledger for select using (
  auth.uid() = (select user_id from distributors where distributors.id = ledger.dist_id)
);
create policy "dist sees own withdrawals" on withdrawals for select using (
  auth.uid() = (select user_id from distributors where distributors.id = withdrawals.dist_id)
);
-- Les demandes de retrait, elles, PEUVENT être créées par le client (ce n'est pas un
-- mouvement d'argent en soi, juste une demande) :
create policy "dist requests withdrawal" on withdrawals for insert with check (
  auth.uid() = (select user_id from distributors where distributors.id = withdrawals.dist_id)
);

-- ---------------------------------------------------------------------------
-- Données de référence initiales (devises + pays, exemples du cahier des charges)
-- ---------------------------------------------------------------------------
insert into currencies (code,symbol,name,decimals) values
 ('XAF','FCFA','Franc CFA (CEMAC)',0),
 ('XOF','FCFA','Franc CFA (UEMOA)',0),
 ('GHS','GH₵','Cedi ghanéen',2),
 ('NGN','₦','Naira nigérian',0),
 ('KES','KES','Shilling kényan',0),
 ('ZAR','R','Rand sud-africain',2);

insert into exchange_rates (target_currency, rate, source) values
 ('XAF',1,'static'),('XOF',1,'static'),('GHS',0.0074,'static'),
 ('NGN',0.79,'static'),('KES',2.11,'static'),('ZAR',0.03,'static');

insert into country_currency (country_code,country_name,currency_code) values
 ('CM','Cameroun','XAF'),('GA','Gabon','XAF'),('TD','Tchad','XAF'),('CF','Centrafrique','XAF'),('CG','Congo (Brazzaville)','XAF'),('GQ','Guinée équatoriale','XAF'),
 ('CI','Côte d''Ivoire','XOF'),('SN','Sénégal','XOF'),('BJ','Bénin','XOF'),('BF','Burkina Faso','XOF'),('ML','Mali','XOF'),('NE','Niger','XOF'),('TG','Togo','XOF'),('GW','Guinée-Bissau','XOF'),
 ('GH','Ghana','GHS'),('NG','Nigéria','NGN'),('KE','Kenya','KES'),('ZA','Afrique du Sud','ZAR');
