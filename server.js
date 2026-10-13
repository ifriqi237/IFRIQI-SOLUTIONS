// Minimal static file server for Hostinger Node.js hosting.
//
// IMPORTANT (audit finding G-01, 9 oct. 2026) : ce serveur ne doit JAMAIS
// servir la racine du dépôt. ifriqi-backend/ contient le schéma SQL, les
// migrations, les scripts de test et le README de déploiement — rien de
// secret en soi, mais rien de destiné à être téléchargeable publiquement
// non plus. Seul le contenu de public/ est exposé.
//
// Ce serveur n'est PAS le vrai backend d'IFRIQI : c'est juste ce qui rend
// le prototype ifriqi.html accessible en HTTP. Le vrai backend vit dans
// ifriqi-backend/ (Supabase) et se déploie séparément — voir son README.
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// En-têtes de sécurité HTTP (audit sécurité, 2026-10-13 — section 9 du cahier des charges).
// Pas de dépendance ajoutée (pas de helmet) : quelques en-têtes statiques suffisent pour ce
// site mono-page, sans risquer de casser un build Hostinger qui ne réinstallerait pas les
// dépendances. La CSP liste explicitement les seuls hôtes externes réellement utilisés par
// ifriqi.html (polices Google Fonts, qrcode-generator et supabase-js via CDN, API Supabase,
// et l'iframe de paiement iKeePay Inline Checkout) — tout le reste (scripts/styles inline) est
// nécessaire au fonctionnement actuel de la page (une seule page HTML/JS sans build), donc
// 'unsafe-inline' reste autorisé pour script-src/style-src ; ceci bloque malgré tout le
// chargement de script depuis un domaine tiers non listé, ce qui couvre l'essentiel du risque
// d'exfiltration en cas d'injection HTML/JS.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      // 13/10/2026 : l'URL Inline Checkout par défaut est passée de "https://www.ikeepay.com/..."
      // à "https://ikeepay.com/..." (sans "www.", confirmée par le support) — les deux domaines
      // sont autorisés ici pour ne pas casser le flux selon la valeur réellement utilisée
      // (IKEEPAY_CHECKOUT_URL peut encore pointer vers l'une ou l'autre).
      "connect-src 'self' https://opkdvhvnzqzawccrzhxg.supabase.co https://ikeepay.com https://www.ikeepay.com",
      "frame-src https://ikeepay.com https://www.ikeepay.com",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
  next();
});

// POST /api/webhook — relais vers la vraie fonction serveur (Supabase Edge Function
// ikeepay-webhook). Ajouté le 13/10/2026 : le support iKeePay a confirmé que l'URL de webhook
// qu'ils attendent de notre côté est "https://ifriqi.com/api/webhook" (une URL sur notre propre
// domaine, pas directement l'URL *.supabase.co) — et que c'est précisément l'élément manquant
// côté configuration, expliquant pourquoi aucun webhook n'était jamais reçu pour les paiements
// Inline Checkout comme H2H.
//
// Ce relais ne fait AUCUNE logique métier : il transmet tel quel (corps brut + en-têtes utiles,
// notamment X-ikeepay-signature) à la fonction Supabase ikeepay-webhook, qui contient déjà toute
// la vérification de sécurité (signature HMAC, revérification serveur-à-serveur via
// GET /h2h-verify avant toute écriture en base — voir ikeepay-webhook/index.ts). On ne duplique
// jamais cette logique ici : ce serveur Node n'a pas accès aux secrets Supabase/iKeePay.
//
// express.raw() est utilisé (pas express.json()) pour transmettre le corps EXACTEMENT comme reçu
// — une sérialisation JSON intermédiaire casserait une éventuelle vérification de signature
// calculée sur le corps brut.
const IKEEPAY_WEBHOOK_TARGET = 'https://opkdvhvnzqzawccrzhxg.supabase.co/functions/v1/ikeepay-webhook';
app.post('/api/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  try {
    const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
    if (req.headers['x-ikeepay-signature']) headers['x-ikeepay-signature'] = req.headers['x-ikeepay-signature'];

    const upstream = await fetch(IKEEPAY_WEBHOOK_TARGET, {
      method: 'POST',
      headers,
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {})),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (e) {
    console.error('Relais /api/webhook -> ikeepay-webhook a échoué', e);
    res.status(502).json({ error: 'Relais webhook indisponible.' });
  }
});

app.use(express.static(PUBLIC_DIR));

// Default route: the app is a single page.
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'ifriqi.html'));
});

app.listen(PORT, () => {
  console.log(`IFRIQI listening on port ${PORT}`);
});
