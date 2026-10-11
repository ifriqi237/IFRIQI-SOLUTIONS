-- ============================================================================
-- IFRIQI — tables réelles pour Scans, Journal d'audit, Support, et persistance
-- des méthodes de paiement/retrait affichées dans le panneau admin, 2026-10-11.
-- ============================================================================
-- Contexte : "Onglet prototype local, non connecté à la base de données réelle"
-- n'était pas qu'un message cosmétique sur ces 4 onglets du panneau admin :
--
--   - scanView() (la vérification QR PUBLIQUE, route #/i/<token>, celle que
--     n'importe quel inconnu utilise en scannant une carte physique) ne lisait
--     QUE db.profiles du navigateur courant. Un téléphone qui n'avait jamais
--     synchronisé ce profil localement tombait donc systématiquement sur
--     "Carte introuvable", sauf coïncidence — la fonctionnalité centrale du
--     produit (retrouver les informations d'urgence via le QR) ne marchait
--     en réalité que depuis l'appareil du titulaire lui-même. Corrigé par la
--     nouvelle fonction scan-card (service_role, publique, sans JWT), qui
--     interroge `cards` directement et journalise chaque scan dans `scans`.
--   - sendSupport() stockait le message de contact dans db.support, c'est-à-dire
--     UNIQUEMENT dans le navigateur de l'expéditeur : aucun message envoyé via
--     la page Contact n'a jamais réellement été reçu par qui que ce soit.
--     Corrigé par submit-support (service_role, publique).
--
-- Le Journal (audit_log) et la persistance des bascules Paiement/Retrait
-- (settings.payment_methods / payout_methods) sont des corrections plus
-- mineures dans le même lot.
-- ============================================================================

create table scans (
  id uuid primary key default gen_random_uuid(),
  card_id uuid references cards(id) on delete set null,
  public_id text,              -- figé au moment du scan : reste lisible même si la carte est supprimée
  result text not null,        -- 'ACTIVE' | 'DEACTIVATED' | 'NOT_FOUND' | 'CALL_CLICK'
  created_at timestamptz not null default now()
);
create index scans_created_idx on scans(created_at desc);
alter table scans enable row level security;
comment on table scans is
  'Journal réel des scans QR (#/i/<token>) et des clics "Appeler". Écrit
  uniquement par scan-card (service_role, fonction publique sans JWT — un
  inconnu sans compte doit pouvoir scanner une carte). Aucune policy RLS :
  lecture réservée à admin-api, jamais d''accès direct client.';

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references app_users(id) on delete set null,
  action text not null,
  resource text,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on audit_log(created_at desc);
alter table audit_log enable row level security;
comment on table audit_log is
  'Journal réel des actions admin (approve/suspend/reactivate distributeur et
  compte, update_settings, set_card_status, grant_card_edits...), écrit
  uniquement par admin-api (service_role) après exécution réussie de l''action.
  Portée volontairement limitée aux actions passant par admin-api : les
  actions self-service (ex. qr_regenerated par le titulaire lui-même) n''y
  figurent pas pour l''instant.';

create table support_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app_users(id) on delete set null,
  category text,
  contact text not null,
  message text not null,
  created_at timestamptz not null default now()
);
create index support_messages_created_idx on support_messages(created_at desc);
alter table support_messages enable row level security;
comment on table support_messages is
  'Messages réels du formulaire de contact. Écrits uniquement par
  submit-support (service_role, fonction publique sans JWT), avec user_id
  rempli seulement si l''expéditeur était connecté. Lecture réservée à
  admin-api.';

alter table settings add column if not exists payment_methods jsonb not null default '{"momo":true,"card":true,"paypal":true,"other":false}'::jsonb;
alter table settings add column if not exists payout_methods jsonb not null default '{"momo":true,"bank":false,"paypal":false,"other":false}'::jsonb;
comment on column settings.payment_methods is
  'Bascules affichées dans l''onglet "Passerelle" du panneau admin, désormais
  persistées (avant, elles ne vivaient que dans le navigateur de chaque admin).
  Reste déclaratif : seul "momo" (PawaPay Mobile Money) est un moyen de
  paiement réellement implémenté côté serveur (create-order) ; carte/PayPal/
  autre restent non fonctionnels quel que soit l''état de cette bascule.';
comment on column settings.payout_methods is
  'Même principe pour les retraits distributeur : seul "momo" (PawaPay Payout)
  est implémenté côté serveur (request-withdrawal).';
