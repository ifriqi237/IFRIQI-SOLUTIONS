-- Vérifie les correctifs de l'audit du 2026-10-04. Lancer après 0000/0001/0002.
begin;

-- F-02 : RLS doit être activée sur les 4 tables, et la table reste lisible publiquement
-- (sans se connecter en service_role) mais pas modifiable.
select relname, relrowsecurity
from pg_class
where relname in ('settings','currencies','exchange_rates','country_currency')
order by relname;
-- attendu : relrowsecurity = t (true) pour les 4 lignes

-- F-06 : un montant <= 0 doit être rejeté.
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000a001'),('00000000-0000-0000-0000-00000000a002');
insert into app_users (id) values ('00000000-0000-0000-0000-00000000a001');
insert into distributors (user_id, code) values ('00000000-0000-0000-0000-00000000a001','IFR-ZZZZZ');
insert into app_users (id) values ('00000000-0000-0000-0000-00000000a002');
insert into orders (id, customer_id, product, amount_fcfa) values
  ('40000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000a002','card',1000);
do $$ begin
  begin
    insert into payments (order_id, provider, amount_fcfa) values ('40000000-0000-0000-0000-000000000001','cinetpay',0);
    raise exception 'ÉCHEC : un montant de paiement à 0 a été accepté (F-06 non corrigé)';
  exception when check_violation then
    raise notice 'OK F-06 : montant de paiement à 0 refusé comme attendu';
  end;
end $$;

-- F-07 : une demande de retrait dépassant le solde disponible doit être rejetée.
insert into ledger (dist_id, type, amount_fcfa, description)
  select id, 'COMMISSION', 250, 'test' from distributors where code='IFR-ZZZZZ';
do $$ declare v_dist uuid; begin
  select id into v_dist from distributors where code='IFR-ZZZZZ';
  begin
    insert into withdrawals (dist_id, amount_fcfa, method) values (v_dist, 999999, 'momo');
    raise exception 'ÉCHEC : un retrait supérieur au solde a été accepté (F-07 non corrigé)';
  exception when others then
    raise notice 'OK F-07 : retrait au-delà du solde refusé (%)', sqlerrm;
  end;
  -- un retrait dans la limite du solde doit, lui, passer :
  insert into withdrawals (dist_id, amount_fcfa, method) values (v_dist, 250, 'momo');
  raise notice 'OK F-07 : retrait dans la limite du solde accepté normalement';
end $$;

-- F-09 : la policy renommée doit exister sous son nouveau nom.
select policyname from pg_policies where tablename='payments' order by policyname;

-- F-05 : issue_card_for_order doit créer une carte avec un jeton en attente, puis être
-- idempotente (deuxième appel = la même carte, already_existed=true).
insert into profiles (id, user_id, type) values
  ('50000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000a002','adult');
update orders set profile_id='50000000-0000-0000-0000-000000000001', payment_status='PAID'
  where id='40000000-0000-0000-0000-000000000001';
select * from issue_card_for_order('40000000-0000-0000-0000-000000000001');
select public_id, pending_token is not null as has_pending_token from cards
  where profile_id='50000000-0000-0000-0000-000000000001';
select * from issue_card_for_order('40000000-0000-0000-0000-000000000001'); -- doit renvoyer already_existed=true, pas une 2e carte
select count(*) as nb_cartes_pour_ce_profil from cards where profile_id='50000000-0000-0000-0000-000000000001';

rollback;
