-- ============================================================================
-- IFRIQI — correctifs issus de l'audit pré-production du 2026-10-04
-- ============================================================================
-- Chaque section référence l'identifiant du constat (F-xx) corrigé.
-- Rien n'est supprimé ni désactivé : toutes les protections existantes
-- (RLS, contraintes UNIQUE, SECURITY DEFINER) restent en place à l'identique.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- F-02 (CRITICAL) — RLS absente sur settings / currencies / exchange_rates /
-- country_currency. Ces tables doivent rester lisibles publiquement (le site
-- affiche le prix et les devises avant toute connexion) mais jamais
-- modifiables par un client : seules les Edge Functions (service_role, qui
-- contourne RLS) peuvent y écrire.
-- ---------------------------------------------------------------------------
alter table settings enable row level security;
alter table currencies enable row level security;
alter table exchange_rates enable row level security;
alter table country_currency enable row level security;

create policy "public read settings" on settings for select using (true);
create policy "public read currencies" on currencies for select using (true);
create policy "public read exchange_rates" on exchange_rates for select using (true);
create policy "public read country_currency" on country_currency for select using (true);
-- Volontairement aucune policy insert/update/delete : avec RLS activé et
-- aucune policy d'écriture, Postgres refuse toute écriture venant d'un rôle
-- "authenticated" ou "anon". Seul service_role (utilisé uniquement dans les
-- Edge Functions) continue de pouvoir écrire, car il contourne RLS par nature.

-- ---------------------------------------------------------------------------
-- F-06 (MEDIUM) — aucun garde-fou contre un montant négatif ou nul.
-- ---------------------------------------------------------------------------
alter table orders       add constraint orders_amount_positive       check (amount_fcfa > 0);
alter table payments     add constraint payments_amount_positive     check (amount_fcfa > 0);
alter table commissions  add constraint commissions_amount_positive  check (amount_fcfa > 0);
alter table withdrawals  add constraint withdrawals_amount_positive  check (amount_fcfa > 0);
-- Le ledger accepte des montants négatifs (type REVERSAL = annulation d'une
-- commission), mais jamais zéro (une ligne de ledger à 0 FCFA n'a pas de sens).
alter table ledger       add constraint ledger_amount_nonzero        check (amount_fcfa <> 0);

-- ---------------------------------------------------------------------------
-- F-07 (MEDIUM) — une demande de retrait n'était pas vérifiée par rapport au
-- solde réel du distributeur au moment de l'enregistrement. On ajoute un
-- contrôle au niveau base de données (pas seulement applicatif) : impossible
-- d'insérer une ligne withdrawals dont le montant dépasse le solde disponible
-- (somme du ledger moins les retraits déjà demandés/en cours/payés).
-- ---------------------------------------------------------------------------
create or replace function check_withdrawal_balance()
returns trigger language plpgsql as $$
declare
  v_ledger_total numeric;
  v_already_withdrawn numeric;
  v_available numeric;
begin
  select coalesce(sum(amount_fcfa),0) into v_ledger_total from ledger where dist_id = new.dist_id;
  select coalesce(sum(amount_fcfa),0) into v_already_withdrawn from withdrawals
    where dist_id = new.dist_id and status in ('REQUESTED','PROCESSING','PAID');
  v_available := v_ledger_total - v_already_withdrawn;
  if new.amount_fcfa > v_available then
    raise exception 'Solde insuffisant pour ce retrait (solde disponible : % FCFA, demandé : % FCFA)', v_available, new.amount_fcfa;
  end if;
  return new;
end $$;

create trigger withdrawals_balance_check
  before insert on withdrawals
  for each row execute function check_withdrawal_balance();

-- ---------------------------------------------------------------------------
-- F-09 (MEDIUM) — la policy "dist sees own payments" sur la table payments
-- concerne en réalité le CLIENT (customer_id de la commande liée), pas le
-- distributeur. On la renomme pour refléter ce qu'elle fait réellement, sans
-- changer son comportement.
-- ---------------------------------------------------------------------------
alter policy "dist sees own payments" on payments rename to "customer sees own payments";

-- ---------------------------------------------------------------------------
-- F-05 (HIGH) — rien ne générait réellement la carte (QR + numéro public)
-- après un paiement confirmé. Fonction serveur dédiée, idempotente : si la
-- carte existe déjà pour ce profil, elle ne fait rien. Le jeton QR brut n'est
-- jamais stocké définitivement : il est posé dans `pending_token` juste le
-- temps que le client authentifié vienne le récupérer une seule fois (voir
-- l'Edge Function claim-card), puis effacé.
-- ---------------------------------------------------------------------------
alter table cards add column if not exists pending_token text;

create or replace function issue_card_for_order(p_order_id uuid)
returns table(public_id text, already_existed boolean)
language plpgsql security definer as $$
declare
  v_order orders%rowtype;
  v_card cards%rowtype;
  v_token text;
  v_hash text;
  v_public_id text;
  v_tries int := 0;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found or v_order.payment_status <> 'PAID' or v_order.product <> 'card' or v_order.profile_id is null then
    raise exception 'Commande introuvable, non payée, ou sans profil : impossible d''émettre une carte.';
  end if;

  select * into v_card from cards where profile_id = v_order.profile_id;
  if found then
    -- Idempotence : un webhook rejoué ne régénère jamais une seconde carte.
    return query select v_card.public_id, true;
    return;
  end if;

  v_token := encode(gen_random_bytes(24), 'base64');
  v_hash := encode(digest(v_token, 'sha256'), 'hex');

  loop
    v_public_id := 'IFR-' || to_char(now(), 'YYMM') || '-' || lpad((floor(random()*1000000))::int::text, 6, '0');
    exit when not exists (select 1 from cards where cards.public_id = v_public_id);
    v_tries := v_tries + 1;
    if v_tries > 10 then raise exception 'Impossible de générer un numéro de carte unique.'; end if;
  end loop;

  insert into cards (profile_id, public_id, token_hash, pending_token, country_code)
  select v_order.profile_id, v_public_id, v_hash, v_token,
         (select country_code from app_users where id = v_order.customer_id);

  return query select v_public_id, false;
end $$;

-- ---------------------------------------------------------------------------
-- F-13 (MEDIUM, partiel) — trace la version exacte de @supabase/supabase-js
-- pour laquelle ce schéma a été validé (le pin de version lui-même se fait
-- côté front, voir frontend-integration/supabase-client.js et le README).
-- ---------------------------------------------------------------------------
comment on table app_users is 'Schéma validé avec @supabase/supabase-js@2.45.4 — voir frontend-integration/supabase-client.js pour la version figée côté client.';
