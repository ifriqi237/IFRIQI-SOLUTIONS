# Backend IFRIQI — guide de déploiement

Ce dossier contient le **vrai backend** d'IFRIQI : base de données Postgres, authentification,
règles de sécurité (RLS), et les API serveur (Supabase Edge Functions) qui gèrent les paiements
et le calcul des commissions à 2 niveaux. Il remplace le `db` en `localStorage` du prototype
`ifriqi.html` par une vraie base partagée, avec de vraies garanties :

- **Impossible de tricher côté client.** Le prix, les commissions et le calcul des 2 niveaux de
  parrainage sont calculés et imposés côté serveur (fonction SQL `create_commissions_for_order`
  + Edge Functions), jamais par le JavaScript du navigateur.
- **Idempotence garantie par la base de données**, pas seulement par du code applicatif : la
  contrainte `UNIQUE(order_id, level)` sur `commissions` rend une double commission
  *structurellement impossible*, même si un webhook de paiement est livré en double par le
  prestataire (CinetPay et PayPal font parfois des retries).
- **Niveau 3 techniquement impossible** : la fonction `create_commissions_for_order` ne regarde
  jamais plus d'un cran dans la chaîne de parrainage (`distributors.referred_by`), et la colonne
  `commissions.level` a une contrainte `CHECK (level in (1,2))`.
- **Paiement vérifié, jamais seulement reçu.** Le webhook ne fait jamais confiance au contenu
  brut qu'il reçoit : il revérifie toujours le statut réel auprès du prestataire (CinetPay
  `/v2/payment/check`, PayPal `GET /v2/checkout/orders/:id`) avant de valider quoi que ce soit.

Tout a été testé directement contre un vrai Postgres (migration appliquée sans erreur, 5
scénarios de commission exécutés et vérifiés) avant livraison — voir `test_scenarios.sql`.

## 1. Créer le projet Supabase (10 minutes)

1. Allez sur [supabase.com](https://supabase.com) → **New project** (le plan gratuit suffit pour démarrer).
2. Notez l'**URL du projet** et la **clé `anon`** (Project Settings → API) — elles vont dans le
   front. Notez aussi la clé **`service_role`** — elle ne doit **jamais** quitter le serveur.
3. Installez la CLI Supabase sur votre machine : `npm install -g supabase`
4. Depuis ce dossier :
   ```bash
   supabase login
   supabase link --project-ref VOTRE_REF_PROJET
   supabase db push          # applique supabase/migrations/0001_init.sql
   ```
5. Vérifiez dans l'onglet **Table Editor** de Supabase que les tables (app_users, profiles,
   cards, distributors, orders, payments, commissions, ledger, withdrawals, settings,
   currencies, exchange_rates, country_currency) sont bien créées.

## 2. Déployer les Edge Functions

```bash
supabase functions deploy create-order
supabase functions deploy payment-webhook --no-verify-jwt   # doit rester accessible publiquement (webhook)
supabase functions deploy activate-distributor
supabase functions deploy claim-card
```

Puis, dans **Project Settings → Edge Functions → Secrets**, ajoutez les variables listées dans
`.env.example` (au minimum `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` sont
déjà injectées automatiquement par Supabase — pas besoin de les ressaisir).

## 3. Brancher les prestataires de paiement

**Vous n'avez pas encore d'identifiants réels** (c'est ce que vous avez indiqué) : c'est prévu.
Tant que `CINETPAY_APIKEY` et `PAYPAL_CLIENT_ID` ne sont pas renseignées dans les secrets du
projet, `create-order` et `payment-webhook` tournent en **mode sandbox explicite** — tout le
flux fonctionne (commande créée, paiement simulé, commissions à 2 niveaux calculées) mais
aucun argent réel ne bouge. Le front doit afficher clairement `sandbox: true` quand ce champ
revient dans la réponse.

Quand vous aurez vos comptes :
- **CinetPay** (Mobile Money MTN/Orange + carte, zone CEMAC/UEMOA) : créez un compte marchand
  sur [cinetpay.com](https://cinetpay.com), récupérez `apikey` et `site_id`, configurez l'URL de
  notification sur `https://VOTRE-PROJET.functions.supabase.co/payment-webhook?provider=cinetpay`.
- **PayPal** : créez une app sur [developer.paypal.com](https://developer.paypal.com), démarrez
  en mode Sandbox pour tester avec de faux comptes PayPal avant de passer en Live. **Étape
  manuelle obligatoire (corrige F-04 de l'audit) :** dans le dashboard PayPal de votre app, section
  *Webhooks*, créez un abonnement webhook pointant vers
  `https://VOTRE-PROJET.functions.supabase.co/payment-webhook?provider=paypal`, cochez au moins
  les événements `CHECKOUT.ORDER.APPROVED` et `PAYMENT.CAPTURE.COMPLETED`, puis copiez le
  **Webhook ID** généré dans le secret `PAYPAL_WEBHOOK_ID` du projet Supabase. Sans ce `?provider=`
  explicite dans l'URL ni ce `PAYPAL_WEBHOOK_ID`, le webhook ne vérifie plus rien et répond
  `ok:false` (voir `payment-webhook/index.ts`, correction F-03/F-04) — c'est volontaire : mieux
  vaut un paiement qui n'est pas validé automatiquement (traitable à la main) qu'un paiement
  validé sans vérification réelle.

Ajoutez ensuite ces clés dans les secrets Supabase — **aucun changement de code requis**, les
fonctions basculent automatiquement du mode sandbox au mode réel.

## 4. Brancher le front (`ifriqi.html`)

C'est l'étape qui reste à faire pour que le prototype devienne un vrai SaaS multi-utilisateurs :
remplacer les lectures/écritures dans l'objet `db` (localStorage) par des appels à ce backend.
C'est un chantier à part entière (chaque écran du prototype lit/écrit `db` directement), donc je
ne l'ai pas fait dans la foulée pour ne rien casser du fonctionnement actuel — dites-moi si vous
voulez que je l'enchaîne maintenant.

Le point de départ est fourni dans `frontend-integration/supabase-client.js` : un client Supabase
prêt à l'emploi avec les fonctions `signUp`, `signIn`, `createOrder`, `activateDistributor`, qui
correspondent chacune à une Edge Function ci-dessus. Pour les lectures (mes profils, mes cartes,
mes commissions...), le front peut interroger Supabase directement via le SDK JS (RLS garantit
que chaque utilisateur ne voit que ses propres données) — pas besoin d'une Edge Function pour ça.

Depuis l'audit, une fonction `claim-card` complète le flux : une fois la commande passée à
`PAID` (après le webhook de paiement), le front doit l'appeler avec `{ orderId }`. Elle renvoie
`{ publicId, token }` — `token` est le jeton QR en clair, renvoyé **une seule fois** (il est
ensuite effacé côté serveur). C'est à cet instant précis que le front doit générer et afficher le
QR code, puis ne plus jamais redemander ce jeton pour cette carte (un second appel renverra
`token: null`).

## 5. Tester sans rien payer

`test_scenarios.sql` reproduit exactement les 8 scénarios du cahier des charges contre la vraie
fonction SQL (A→B direct, A→B→C niveau 2, A→B→C→D niveau 3 bloqué, paiement échoué, webhook
dupliqué, remboursement). `test_audit_fixes.sql` vérifie en plus les correctifs de l'audit
(RLS sur settings/devises, montants négatifs refusés, solde de retrait vérifié, émission de
carte idempotente). Pour les relancer vous-même contre votre projet Supabase :

```bash
psql "$(supabase db url)" -f test_scenarios.sql
psql "$(supabase db url)" -f test_audit_fixes.sql
```
(remplacez `supabase db url` par la chaîne de connexion de votre projet si la commande n'existe pas dans votre version de la CLI)

**Pour tester en local sans aucun projet Supabase** (ce qui a été fait pour valider ces
correctifs) : `dev-only/local_test_stub.sql` simule juste assez du schéma `auth.*` de Supabase
pour faire tourner `0001_init.sql`/`0002_audit_fixes.sql` sur un Postgres nu.
**⚠️ Ne déployez jamais ce fichier sur un vrai projet Supabase** — il redéfinirait
`auth.uid()` et casserait l'authentification réelle. Il n'est d'ailleurs pas dans
`supabase/migrations/` pour qu'une commande `supabase db push` ne puisse pas l'y trouver par erreur.

## Ce qui est réel vs ce qui reste à faire

| Élément | État |
|---|---|
| Schéma de base de données (13 tables, contraintes, index) | ✅ Testé contre un vrai Postgres |
| RLS (chacun ne voit que ses données) | ✅ Écrit et activé sur toutes les tables sensibles |
| Calcul des commissions à 2 niveaux, idempotent, niveau 3 bloqué | ✅ Testé avec 5 scénarios réels |
| Vérification serveur-à-serveur des paiements (anti-falsification) | ✅ Implémentée pour CinetPay + PayPal |
| Connexion à de vrais comptes marchands CinetPay/PayPal | ⏳ Nécessite vos identifiants réels + l'abonnement webhook PayPal (section 3) |
| Émission réelle de la carte (QR + numéro) après paiement | ✅ Corrigé (audit F-05) : `issue_card_for_order` + `claim-card` |
| RLS sur les tables settings/devises | ✅ Corrigé (audit F-02) |
| Routage du webhook CinetPay/PayPal | ✅ Corrigé (audit F-03), vérification officielle PayPal (F-04) |
| Garde-fous montants négatifs/nuls, solde de retrait | ✅ Corrigés (audit F-06, F-07) |
| Branchement du front `ifriqi.html` sur ce backend (au lieu de localStorage) | ⏳ Non fait — gros chantier séparé, à planifier |
| Authentification réelle (OTP SMS, etc.) | ⏳ Supabase Auth le permet, à configurer (actuellement email/mot de passe) |
| Rôle admin vérifié côté serveur (remplace le code démo du prototype) | ⏳ À faire au moment du branchement (audit F-01) |

Le détail complet de ces corrections (quoi, pourquoi, fichiers concernés) vit dans le rapport
d'audit remis séparément — ce tableau n'en est qu'un résumé.
