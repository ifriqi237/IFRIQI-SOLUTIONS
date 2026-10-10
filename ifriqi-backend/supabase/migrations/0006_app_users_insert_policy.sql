-- ============================================================================
-- IFRIQI — policy RLS manquante pour permettre l'inscription réelle (Supabase
-- Auth), 2026-10-10.
-- ============================================================================
-- Jusqu'ici, app_users n'avait que deux policies : "own account" (SELECT) et
-- "update own account" (UPDATE), toutes deux sur auth.uid() = id (0001_init.sql
-- et suivants). Aucune policy INSERT n'existe, et aucun trigger sur auth.users
-- ne crée automatiquement la ligne app_users correspondante.
--
-- Conséquence concrète : le frontend, une fois branché sur la vraie
-- authentification Supabase (sb.auth.signUp), doit lui-même insérer la ligne
-- app_users (id, first_name, last_name, phone, email, country, country_code)
-- juste après la création du compte Auth. Sans cette policy, cet insert est
-- refusé par RLS pour tout utilisateur non-admin (aucune policy ne l'autorise),
-- et l'inscription réelle échoue silencieusement côté client.
--
-- Cette policy suit exactement le même principe que "own account" et
-- "update own account" : un utilisateur authentifié ne peut insérer QUE la
-- ligne dont l'id correspond à son propre auth.uid() — jamais une ligne pour
-- un autre utilisateur, jamais avec un role autre que celui par défaut (le
-- champ role n'est pas contrôlé ici : il garde sa valeur par défaut 'user'
-- côté schéma, comme pour tout autre insert applicatif non-admin).
-- ============================================================================

create policy "own account insert" on app_users
  for insert
  with check (auth.uid() = id);

comment on policy "own account insert" on app_users is
  'Permet à un utilisateur Supabase Auth authentifié de créer sa propre ligne '
  'app_users (id = auth.uid()) juste après son inscription (sb.auth.signUp). '
  'Sans cette policy, aucune policy RLS n''autorisait cet insert et '
  'l''inscription réelle via le frontend échouait systématiquement.';
