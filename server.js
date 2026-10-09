// Minimal static file server for Hostinger Node.js hosting.
// Serves ifriqi.html (and any other static assets in this repo) with no build step.
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// Default route: the app is a single page.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ifriqi.html'));
});

app.listen(PORT, () => {
  console.log(`IFRIQI listening on port ${PORT}`);
});
