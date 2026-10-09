-- Reproduit les scénarios A/B/C/D du cahier des charges directement contre la vraie fonction SQL.
begin;

-- comptes auth stubés
insert into auth.users (id) values
 ('00000000-0000-0000-0000-00000000000a'),
 ('00000000-0000-0000-0000-00000000000b'),
 ('00000000-0000-0000-0000-00000000000c'),
 ('00000000-0000-0000-0000-00000000000d'),
 ('00000000-0000-0000-0000-00000000000e');

insert into app_users (id,first_name,last_name,phone,email,country,country_code) values
 ('00000000-0000-0000-0000-00000000000a','User','A','+2370001','a@test.com','Cameroun','CM'),
 ('00000000-0000-0000-0000-00000000000b','User','B','+2370002','b@test.com','Côte d''Ivoire','CI'),
 ('00000000-0000-0000-0000-00000000000c','User','C','+2370003','c@test.com','Ghana','GH'),
 ('00000000-0000-0000-0000-00000000000d','User','D','+2370004','d@test.com','Kenya','KE'),
 ('00000000-0000-0000-0000-00000000000e','User','E','+2370005','e@test.com','Sénégal','SN');

insert into profiles (id,user_id,type) values
 ('10000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a','adult'),
 ('10000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-00000000000b','adult'),
 ('10000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-00000000000c','adult'),
 ('10000000-0000-0000-0000-00000000000d','00000000-0000-0000-0000-00000000000d','adult'),
 ('10000000-0000-0000-0000-00000000000e','00000000-0000-0000-0000-00000000000e','adult');

insert into distributors (id,user_id,code,status,referred_by) values
 ('20000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a','IFR-AAAAA','ACTIVE',null);
insert into distributors (id,user_id,code,status,referred_by) values
 ('20000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-00000000000b','IFR-BBBBB','ACTIVE','20000000-0000-0000-0000-00000000000a');
insert into distributors (id,user_id,code,status,referred_by) values
 ('20000000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-00000000000c','IFR-CCCCC','ACTIVE','20000000-0000-0000-0000-00000000000b');

-- Scénario 1 : B achète via le lien de A -> A touche 250 FCFA (niveau 1)
insert into orders (id,customer_id,profile_id,product,amount_fcfa,dist_id,payment_status)
values ('30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000b','10000000-0000-0000-0000-00000000000b','card',1000,'20000000-0000-0000-0000-00000000000a','PAID');
select create_commissions_for_order('30000000-0000-0000-0000-000000000001');

-- Scénario 2 : C achète via le lien de B (B parrainé par A) -> B +250 (N1), A +100 (N2)
insert into orders (id,customer_id,profile_id,product,amount_fcfa,dist_id,payment_status)
values ('30000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000c','10000000-0000-0000-0000-00000000000c','card',1000,'20000000-0000-0000-0000-00000000000b','PAID');
select create_commissions_for_order('30000000-0000-0000-0000-000000000002');

-- Scénario 3 : D achète via le lien de C (C parrainé par B, B parrainé par A) -> C +250, B +100, A +0
insert into orders (id,customer_id,profile_id,product,amount_fcfa,dist_id,payment_status)
values ('30000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-00000000000d','10000000-0000-0000-0000-00000000000d','card',1000,'20000000-0000-0000-0000-00000000000c','PAID');
select create_commissions_for_order('30000000-0000-0000-0000-000000000003');

-- Scénario 4 : paiement échoué -> zéro commission
insert into orders (id,customer_id,profile_id,product,amount_fcfa,dist_id,payment_status)
values ('30000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-00000000000e','10000000-0000-0000-0000-00000000000e','card',1000,'20000000-0000-0000-0000-00000000000c','FAILED');
select create_commissions_for_order('30000000-0000-0000-0000-000000000004'); -- payment_status != PAID -> no-op

-- Scénario 5 : webhook livré 3 fois sur la même commande -> toujours une seule commission par niveau
select create_commissions_for_order('30000000-0000-0000-0000-000000000001');
select create_commissions_for_order('30000000-0000-0000-0000-000000000001');

\echo '--- Résultats ---'
select o.id as order_id, c.level, d.code as beneficiaire, c.amount_fcfa, c.currency, c.status
from commissions c join orders o on o.id=c.order_id join distributors d on d.id=c.dist_id
order by o.id, c.level;

\echo '--- Comptage par commande (doit être <=2 lignes, jamais de doublon niveau) ---'
select order_id, count(*) from commissions group by order_id order by order_id;

\echo '--- A a-t-il touché quoi que ce soit sur la commande de D (doit être: aucune ligne) ---'
select * from commissions where order_id='30000000-0000-0000-0000-000000000003' and dist_id='20000000-0000-0000-0000-00000000000a';

-- Remboursement de la commande 1 -> la commission de A doit passer CANCELLED
select refund_order('30000000-0000-0000-0000-000000000001');
\echo '--- Après remboursement de la commande 1 ---'
select order_id, level, status from commissions where order_id='30000000-0000-0000-0000-000000000001';

rollback;
