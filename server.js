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
      "connect-src 'self' https://opkdvhvnzqzawccrzhxg.supabase.co https://www.ikeepay.com",
      "frame-src https://www.ikeepay.com",
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

app.use(express.static(PUBLIC_DIR));

// Default route: the app is a single page.
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'ifriqi.html'));
});

app.listen(PORT, () => {
  console.log(`IFRIQI listening on port ${PORT}`);
});
