-- ============================================================================
-- IFRIQI — intégration des callbacks PawaPay (dépôts, paiements sortants,
-- remboursements), 2026-10-09.
-- ============================================================================
-- `payments.provider` est une colonne texte libre sans contrainte CHECK (voir
-- 0001_init.sql, commentaire "'cinetpay' | 'paypal' | 'manual' ..."), donc la valeur
-- 'pawapay' peut déjà y être écrite sans migration. Seuls les PAYOUTS (retraits
-- distributeur) et les REFUNDS nécessitent un nouveau moyen de faire le lien entre
-- l'identifiant PawaPay (payoutId / refundId) et la ligne correspondante en base,
-- pour la même raison d'idempotence que payments.provider_ref.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Payouts : withdrawals n'avait aucune colonne pour savoir QUEL prestataire traite
-- un retrait, ni sous quelle référence. On ajoute les deux, sur le même modèle que
-- payments(provider, provider_ref).
-- ---------------------------------------------------------------------------
alter table withdrawals add column if not exists provider text;
alter table withdrawals add column if not exists provider_ref text;

-- Idempotence : un callback payout rejoué 10 fois ne doit jamais faire basculer deux
-- fois le même retrait, ni créer d'ambiguïté entre deux retraits PawaPay différents.
create unique index if not exists withdrawals_provider_ref_idx
  on withdrawals(provider, provider_ref)
  where provider_ref is not null;

-- ---------------------------------------------------------------------------
-- Refunds : un remboursement PawaPay porte son propre identifiant (refundId),
-- distinct du depositId remboursé. On le trace sur la ligne `payments` concernée
-- (le paiement qui a été remboursé), pour pouvoir retrouver la commande et garantir
-- qu'un même refundId n'est traité qu'une seule fois.
-- ---------------------------------------------------------------------------
alter table payments add column if not exists refund_provider text;
alter table payments add column if not exists refund_ref text;
alter table payments add column if not exists refunded_at timestamptz;

create unique index if not exists payments_refund_ref_idx
  on payments(refund_provider, refund_ref)
  where refund_ref is not null;

comment on column withdrawals.provider is 'Prestataire de paiement sortant ayant traité ce retrait, ex. ''pawapay''. NULL = retrait traité manuellement (hors API).';
comment on column withdrawals.provider_ref is 'Référence du paiement sortant chez le prestataire (ex. payoutId PawaPay). Utilisée pour l''idempotence des callbacks.';
comment on column payments.refund_ref is 'Référence du remboursement chez le prestataire (ex. refundId PawaPay), si ce paiement a été remboursé via l''API.';
