-- ============================================================================
-- IFRIQI — préparation de l'intégration iKeePay (mode H2H, Mobile Money), 2026-10-10.
-- ============================================================================
-- `payments.provider` est une colonne texte libre sans contrainte CHECK (voir
-- 0001_init.sql, commentaire "'cinetpay' | 'paypal' | 'manual' ..."), donc la valeur
-- 'ikeepay' pourra y être écrite sans migration, exactement comme 'pawapay' (0003).
--
-- En revanche, ni orders.payment_status ni payments.status ne connaissent l'état
-- ANNULÉ (CANCELLED) — seulement PENDING/PAID|SUCCESS/FAILED/REFUNDED. Le cahier des
-- charges de l'intégration iKeePay exige explicitement de prévoir "en attente, réussi,
-- échoué et annulé". On l'ajoute ici, pour tous les prestataires (pas seulement
-- iKeePay) puisque la distinction est universelle : un paiement FAILED a été tenté et
-- rejeté par le prestataire, alors qu'un paiement CANCELLED a été abandonné par le
-- client ou expiré avant toute tentative réelle de débit.
-- ============================================================================

alter table orders drop constraint orders_payment_status_check;
alter table orders add constraint orders_payment_status_check
  check (payment_status in ('PENDING','PAID','FAILED','CANCELLED','REFUNDED'));

alter table payments drop constraint payments_status_check;
alter table payments add constraint payments_status_check
  check (status in ('PENDING','SUCCESS','FAILED','CANCELLED'));

comment on column orders.payment_status is
  'PENDING = commande créée, paiement pas encore confirmé. PAID = paiement confirmé serveur-à-serveur. '
  'FAILED = paiement tenté et rejeté par le prestataire. CANCELLED = abandonné par le client ou expiré '
  'avant tout débit réel (ex. callback iKeePay status=cancelled, ou timeout). REFUNDED = remboursé après PAID.';
comment on column payments.status is
  'Même sémantique que orders.payment_status, au niveau de la tentative de paiement individuelle.';
