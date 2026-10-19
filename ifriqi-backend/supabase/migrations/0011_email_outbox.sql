-- 0011 : boîte d'envoi (outbox) des e-mails transactionnels (Resend).
-- Rôle : (1) anti-doublon (idempotency_key unique : un même événement ne produit jamais 2 e-mails),
--        (2) nouvelles tentatives avec temporisation si Resend est indisponible,
--        (3) journal technique SANS secret ni contenu sensible (le contenu est re-généré à l'envoi
--            à partir de `data`, qui ne contient que : prénom, montant, référence, n° public de carte).
-- Accès : service_role uniquement (RLS activée, aucune policy, droits retirés à anon/authenticated).
create table if not exists public.email_outbox (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  kind            text not null check (kind in ('welcome','payment_confirmed','test')),
  to_email        text not null,
  data            jsonb not null default '{}'::jsonb,
  status          text not null default 'pending' check (status in ('pending','sending','sent','failed','dead')),
  attempts        int  not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at       timestamptz,
  last_error      text,
  provider_id     text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index if not exists email_outbox_due_idx on public.email_outbox (status, next_attempt_at);
alter table public.email_outbox enable row level security;
revoke all on public.email_outbox from anon, authenticated, public;
grant all on public.email_outbox to service_role;
