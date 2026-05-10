/*
  AWFLMETA Backend Server
  ========================
  Stack : Node.js + Express
  Deploy: Render / Railway / Replit / any Node host
  Port  : process.env.PORT (default 3000)

  GitHub API is used as the storage layer:
    - accounts  → github.com/aedtpworldawfl/wiki/accounts/
    - images    → github.com/aedtpworldawfl/wiki/images/
    - wiki html → github.com/aedtpworldawfl/wiki/awfl/wiki/

  .env required vars:
    GITHUB_TOKEN   = your GitHub personal access token (repo scope)
    GITHUB_OWNER   = aedtpworldawfl
    GITHUB_REPO    = wiki
    JWT_SECRET     = any long random string
    PORT           = 3000  (optional)
    FRONTEND_ORIGIN= https://aedtpworldawfl.github.io  (CORS)
*/

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const { Octokit } = require('@octokit/rest');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── GitHub client ─────────────────────────────────────────────── */
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GH = {
  owner : process.env.GITHUB_OWNER || 'aedtpworldawfl',
  repo  : process.env.GITHUB_REPO  || 'wiki',
};

/* ── Middleware ─────────────────────────────────────────────────── */
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 8 * 1024 * 1024 }, // 8 MB max
  fileFilter(_req, file, cb) {
    const ok = /^image\/(jpeg|png)$/.test(file.mimetype);
    cb(ok ? null : new Error('Only JPEG and PNG files are allowed'), ok);
  },
});

/* ── Helpers ────────────────────────────────────────────────────── */
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET || 'awflmeta_secret', { expiresIn: '7d' });
}

function verifyToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'awflmeta_secret');
    next();
  } catch {
    res.status(401).json({ error: 'Token invalid or expired' });
  }
}

/* ── GitHub file helpers ────────────────────────────────────────── */
async function ghGet(path) {
  try {
    const { data } = await octokit.repos.getContent({ ...GH, path });
    return {
      content: Buffer.from(data.content, 'base64').toString('utf8'),
      sha    : data.sha,
    };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function ghPut(path, contentStr, message, sha) {
  const params = {
    ...GH, path, message,
    content: Buffer.from(contentStr, 'utf8').toString('base64'),
  };
  if (sha) params.sha = sha;
  await octokit.repos.createOrUpdateFileContents(params);
}

async function ghPutBinary(path, buffer, message, sha) {
  const params = {
    ...GH, path, message,
    content: buffer.toString('base64'),
  };
  if (sha) params.sha = sha;
  await octokit.repos.createOrUpdateFileContents(params);
}

/* ── Accounts helpers ───────────────────────────────────────────── */
const ACCOUNTS_PATH = 'accounts/accounts.json';

async function loadAccounts() {
  const file = await ghGet(ACCOUNTS_PATH);
  if (!file) return { users: [], _sha: null };
  const parsed = JSON.parse(file.content);
  return { ...parsed, _sha: file.sha };
}

async function saveAccounts(data) {
  const { _sha, ...payload } = data;
  await ghPut(
    ACCOUNTS_PATH,
    JSON.stringify(payload, null, 2),
    'Update accounts',
    _sha,
  );
}

/* ══════════════════════════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════════════════════════ */

/* ── Health ─────────────────────────────────────────────────────── */
app.get('/', (_req, res) => res.json({ status: 'AWFLMETA API running' }));

/* ────────────────────────────────────────────────────────────────
   AUTH : Create Account
   POST /api/auth/create
   body: { username, password }
──────────────────────────────────────────────────────────────── */
app.post('/api/auth/create', async (req, res) => {
  try {
    const { username = '', password = '' } = req.body;

    // Validate username (no spaces)
    if (!username || /\s/.test(username)) {
      return res.status(400).json({ error: 'Username must not contain spaces.' });
    }

    // Validate password (no spaces, min 8 chars)
    if (!password || /\s/.test(password)) {
      return res.status(400).json({ error: 'Password must not contain spaces.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const accounts = await loadAccounts();
    if (!accounts.users) accounts.users = [];

    // Check username exists
    const exists = accounts.users.find(
      u => u.username.toLowerCase() === username.toLowerCase(),
    );
    if (exists) {
      return res.status(409).json({ error: 'Username already exists. Please choose another.' });
    }

    // Store hashed password
    accounts.users.push({
      username,
      passwordHash: sha256(password),
      createdAt   : new Date().toISOString(),
    });

    await saveAccounts(accounts);
    const token = signToken({ username });
    res.json({ token, username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

/* ────────────────────────────────────────────────────────────────
   AUTH : Sign In
   POST /api/auth/signin
   body: { username, password }
──────────────────────────────────────────────────────────────── */
app.post('/api/auth/signin', async (req, res) => {
  try {
    const { username = '', password = '' } = req.body;

    if (!username || /\s/.test(username)) {
      return res.status(400).json({ error: 'Username must not contain spaces.' });
    }
    if (!password || /\s/.test(password) || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters and contain no spaces.' });
    }

    const accounts = await loadAccounts();
    const user = (accounts.users || []).find(
      u => u.username.toLowerCase() === username.toLowerCase(),
    );

    if (!user || user.passwordHash !== sha256(password)) {
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }

    const token = signToken({ username: user.username });
    res.json({ token, username: user.username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

/* ────────────────────────────────────────────────────────────────
   AUTH : Verify Token (for page-load session restore)
   GET /api/auth/verify
──────────────────────────────────────────────────────────────── */
app.get('/api/auth/verify', verifyToken, (req, res) => {
  res.json({ username: req.user.username });
});

/* ────────────────────────────────────────────────────────────────
   UPLOAD : Image
   POST /api/upload/image  (multipart/form-data, field: "image")
   Auth required
──────────────────────────────────────────────────────────────── */
app.post('/api/upload/image', verifyToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided.' });

    const ext      = req.file.mimetype === 'image/png' ? '.png' : '.jpg';
    const baseName = req.file.originalname.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const fileName = baseName.endsWith(ext) ? baseName : baseName.replace(/\.[^.]+$/, '') + ext;
    const ghPath   = `images/${fileName}`;

    // Check if file already exists (to get SHA for update)
    const existing = await ghGet(ghPath);
    await ghPutBinary(ghPath, req.file.buffer, `Upload image: ${fileName}`, existing?.sha);

    const url = `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/main/${ghPath}`;
    res.json({ url, fileName, path: ghPath });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Upload failed.' });
  }
});

/* ────────────────────────────────────────────────────────────────
   WIKI : Publish Page
   POST /api/wiki/publish
   body: { slug, title, htmlContent }
   Auth required
──────────────────────────────────────────────────────────────── */
app.post('/api/wiki/publish', verifyToken, async (req, res) => {
  try {
    const { slug, title, htmlContent } = req.body;

    if (!slug || !title || !htmlContent) {
      return res.status(400).json({ error: 'slug, title and htmlContent are required.' });
    }

    // Sanitise slug: spaces→underscore, only word chars
    const safeSlug = slug.replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
    const ghPath   = `awfl/wiki/${safeSlug}.html`;

    // Full stand-alone HTML page
    const fileContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — AWFLMETA</title>
<meta name="description" content="AWFLMETA Wiki page: ${escapeHtml(title)}">
<style>
  body{font-family:Georgia,serif;max-width:900px;margin:0 auto;padding:24px;background:#0a0c10;color:#e8edf5;line-height:1.75}
  h1,h2,h3{font-weight:400;border-bottom:1px solid #2a3450;padding-bottom:6px}
  a{color:#4a9eff}
  table{width:100%;border-collapse:collapse;margin:16px 0}
  th{background:#1e2535;padding:8px 12px;text-align:left;border:1px solid #3a4870}
  td{padding:7px 12px;border:1px solid #2a3450}
  img{max-width:100%;border-radius:6px}
  .back{display:inline-block;margin-bottom:20px;color:#4a9eff;text-decoration:none;font-family:sans-serif;font-size:14px}
</style>
</head>
<body>
<a class="back" href="https://${GH.owner}.github.io/${GH.repo}/#${safeSlug}">← Back to AWFLMETA</a>
<h1>${escapeHtml(title)}</h1>
${htmlContent}
<hr style="margin-top:40px;border-color:#2a3450">
<p style="font-size:12px;color:#6b7a95;font-family:sans-serif">Published on AWFLMETA · © AEDTP WORLD</p>
</body>
</html>`;

    const existing = await ghGet(ghPath);
    await ghPut(ghPath, fileContent, `Publish wiki: ${safeSlug}`, existing?.sha);

    const pageUrl = `https://${GH.owner}.github.io/${GH.repo}/awfl/wiki/${safeSlug}.html`;
    res.json({ url: pageUrl, slug: safeSlug, path: ghPath });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Publish failed.' });
  }
});

/* ────────────────────────────────────────────────────────────────
   WIKI : List Published Pages
   GET /api/wiki/list
   Public
──────────────────────────────────────────────────────────────── */
app.get('/api/wiki/list', async (_req, res) => {
  try {
    const { data } = await octokit.repos.getContent({ ...GH, path: 'awfl/wiki' });
    const pages = Array.isArray(data)
      ? data
          .filter(f => f.name.endsWith('.html'))
          .map(f => ({
            slug: f.name.replace('.html', ''),
            url : `https://${GH.owner}.github.io/${GH.repo}/awfl/wiki/${f.name}`,
            sha : f.sha,
          }))
      : [];
    res.json({ pages });
  } catch (e) {
    if (e.status === 404) return res.json({ pages: [] });
    res.status(500).json({ error: e.message });
  }
});

/* ── Escape helper for HTML output ──────────────────────────────── */
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Start ──────────────────────────────────────────────────────── */
app.listen(PORT, () => console.log(`AWFLMETA API listening on port ${PORT}`));
