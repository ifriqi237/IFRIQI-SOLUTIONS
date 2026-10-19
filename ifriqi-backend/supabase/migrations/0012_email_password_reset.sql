-- 0012 : autorise le type d'e-mail 'password_reset' dans la boîte d'envoi.
-- Le jeton de réinitialisation est effacé de `data` dès l'envoi réussi (ou échec définitif).
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('welcome','payment_confirmed','password_reset','test'));
