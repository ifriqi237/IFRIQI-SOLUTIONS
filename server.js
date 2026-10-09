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

app.use(express.static(PUBLIC_DIR));

// Default route: the app is a single page.
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'ifriqi.html'));
});

app.listen(PORT, () => {
  console.log(`IFRIQI listening on port ${PORT}`);
});
