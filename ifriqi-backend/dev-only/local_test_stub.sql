-- NE PAS DÉPLOYER SUR SUPABASE : ce fichier stub uniquement le schéma auth.* de Supabase pour
-- pouvoir tester 0001_init.sql / 0002_audit_fixes.sql contre un Postgres local nu. Sur un vrai
-- projet Supabase, auth.users et auth.uid() existent déjà nativement.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
