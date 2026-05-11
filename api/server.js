/*
  AWFLMETA Backend Server
  ========================
  Stack : Node.js + Express
  Deploy: Render / Railway / Replit / any Node host
  Port  : process.env.PORT (default 3000)

  INFOBOX FIX (2025):
  - /api/wiki/publish now accepts optional `infoboxData` JSON alongside htmlContent
  - buildInfoboxHTML() renders it server-side with full inline styles
  - Published .html files always contain the infobox — no localStorage needed
  - Frontend must send: { slug, title, htmlContent, infoboxData: { template, fields:[{key,value}] } }
*/

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const multer      = require('multer');
const jwt         = require('jsonwebtoken');
const crypto      = require('crypto');
const { Octokit } = require('@octokit/rest');

const app  = express();
const PORT = process.env.PORT || 3000;

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GH = {
  owner : process.env.GITHUB_OWNER || 'aedtpworldawfl',
  repo  : process.env.GITHUB_REPO  || 'wiki',
};

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 8 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = /^image\/(jpeg|png)$/.test(file.mimetype);
    cb(ok ? null : new Error('Only JPEG and PNG files are allowed'), ok);
  },
});

/* ══ HELPERS ════════════════════════════════════════════════════════ */

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET || 'awflmeta_secret', { expiresIn: '7d' });
}
function verifyToken(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'awflmeta_secret');
    next();
  } catch {
    res.status(401).json({ error: 'Token invalid or expired' });
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

function isUrl(v)      { return /^https?:\/\//.test(v); }
function isImageUrl(v) { return /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(v); }

/* ══ GITHUB I/O ═════════════════════════════════════════════════════ */

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
  const params = { ...GH, path, message, content: buffer.toString('base64') };
  if (sha) params.sha = sha;
  await octokit.repos.createOrUpdateFileContents(params);
}

/* ══ ACCOUNTS ════════════════════════════════════════════════════════ */

const ACCOUNTS_PATH = 'accounts/accounts.json';

async function loadAccounts() {
  const file = await ghGet(ACCOUNTS_PATH);
  if (!file) return { users: [], _sha: null };
  return { ...JSON.parse(file.content), _sha: file.sha };
}

async function saveAccounts(data) {
  const { _sha, ...payload } = data;
  await ghPut(ACCOUNTS_PATH, JSON.stringify(payload, null, 2), 'Update accounts', _sha);
}

/* ══ SITEMAP ════════════════════════════════════════════════════════ */

const SITEMAP_PATH = 'sitemap.xml';
const BASE_URL     = `https://${GH.owner}.github.io/${GH.repo}`;

async function updateSitemap(slug) {
  const file = await ghGet(SITEMAP_PATH);
  let xml = file
    ? file.content
    : `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/1.0">\n</urlset>`;
  const sha = file?.sha;

  if (xml.includes(`/awfl/wiki/${slug}.html`)) return; // no duplicates

  const entry = `
  <url>
    <loc>${BASE_URL}/awfl/wiki/${slug}.html</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>`;

  xml = xml.replace('</urlset>', `${entry}\n\n</urlset>`);
  await ghPut(SITEMAP_PATH, xml, `Sitemap: add ${slug}`, sha);
}

/* ══ INDEX.JSON ══════════════════════════════════════════════════════ */

const INDEX_PATH = 'awfl/wiki/index.json';

async function updateIndex(slug, title) {
  let index = [];
  let sha   = null;
  const file = await ghGet(INDEX_PATH);
  if (file) {
    try { index = JSON.parse(file.content); } catch { index = []; }
    sha = file.sha;
  }

  const i     = index.findIndex(p => p.slug === slug);
  const entry = { slug, title, updated: Date.now() };
  if (i >= 0) index[i] = entry;
  else         index.push(entry);

  index.sort((a, b) => b.updated - a.updated);
  await ghPut(INDEX_PATH, JSON.stringify(index, null, 2), `Index: update ${slug}`, sha);
}

/* ══ INFOBOX HTML BUILDER ════════════════════════════════════════════
   Converts { template: "Artist", fields: [{key,value}, ...] }
   into a self-contained HTML block with full inline styles.
   Works for ALL infobox types (image, audio, video, link, text, table).
   Output is embedded directly into the published .html file body.
═══════════════════════════════════════════════════════════════════════ */

function buildInfoboxHTML(infoboxData) {
  if (!infoboxData || !Array.isArray(infoboxData.fields) || !infoboxData.fields.length) {
    return '';
  }

  const { template, fields } = infoboxData;

  const imgF  = fields.find(f => f.key && f.key.toLowerCase() === 'image');
  const nameF = fields.find(f => f.key && f.key.toLowerCase() === 'name');
  const rows  = fields.filter(f => f.key && f.value && f.key.toLowerCase() !== 'image');

  /* ── Styles (all inline so they work in standalone .html files) ── */
  const S = {
    wrap      : 'float:right;clear:right;margin:0 0 20px 28px;background:#141820;border:1px solid #3a4870;border-radius:8px;width:268px;font-size:13px;overflow:hidden;font-family:"IBM Plex Sans",Arial,sans-serif;line-height:1.5;box-shadow:0 4px 18px rgba(0,0,0,.45)',
    titleBar  : 'background:#252d40;padding:9px 13px;font-weight:700;font-size:14px;border-bottom:1px solid #3a4870;text-align:center;color:#e8edf5;letter-spacing:.02em',
    imgWrap   : 'border-bottom:1px solid #2a3450;text-align:center;overflow:hidden;background:#1a2030',
    img       : 'width:100%;height:auto;max-height:210px;object-fit:cover;display:block',
    caption   : 'font-size:11px;color:#6b7a95;padding:5px 10px;text-align:center;background:#1a2030;border-bottom:1px solid #2a3450',
    table     : 'width:100%;border-collapse:collapse',
    trEven    : 'border-bottom:1px solid rgba(42,52,80,.5);background:#141820',
    trOdd     : 'border-bottom:1px solid rgba(42,52,80,.5);background:#101318',
    th        : 'background:#1a2030;padding:6px 10px;font-size:12px;font-weight:600;color:#6b7a95;text-align:left;width:42%;vertical-align:top;border-right:1px solid #2a3450',
    td        : 'padding:6px 10px;font-size:12px;color:#e8edf5;vertical-align:top',
    link      : 'color:#4a9eff;text-decoration:none;font-size:12px;word-break:break-all',
    thumbImg  : 'max-width:100%;max-height:80px;border-radius:4px;display:block',
    video     : 'width:100%;max-height:130px;border-radius:4px;display:block;margin:2px 0',
    audio     : 'width:100%;display:block;margin:2px 0',
  };

  let html = `<div style="${S.wrap}">`;

  /* Title bar */
  html += `<div style="${S.titleBar}">${escapeHtml(template)}</div>`;

  /* Image row */
  if (imgF && imgF.value) {
    html += `<div style="${S.imgWrap}">`;
    html += `<img src="${escapeHtml(imgF.value)}" alt="${escapeHtml(nameF ? nameF.value : template)}" loading="lazy" style="${S.img}">`;
    html += `</div>`;
    if (nameF && nameF.value) {
      html += `<div style="${S.caption}">${escapeHtml(nameF.value)}</div>`;
    }
  }

  /* Field rows table */
  if (rows.length) {
    html += `<table style="${S.table}">`;
    rows.forEach((f, idx) => {
      if (!f.key || !f.value) return;

      const kl  = f.key.toLowerCase();
      const trS = idx % 2 === 0 ? S.trEven : S.trOdd;
      let cell  = '';

      if (kl.includes('video')) {
        /* Video field */
        cell = `<video src="${escapeHtml(f.value)}" controls style="${S.video}"></video>`;
      } else if (kl.includes('audio')) {
        /* Audio field */
        cell = `<audio src="${escapeHtml(f.value)}" controls style="${S.audio}"></audio>`;
      } else if (isImageUrl(f.value)) {
        /* Inline image (not the main image) */
        cell = `<img src="${escapeHtml(f.value)}" alt="${escapeHtml(f.key)}" loading="lazy" style="${S.thumbImg}">`;
      } else if (isUrl(f.value)) {
        /* Hyperlink */
        const label = f.value.replace(/^https?:\/\//, '').replace(/\/$/, '').substring(0, 32);
        cell = `<a href="${escapeHtml(f.value)}" target="_blank" rel="noopener" style="${S.link}">${escapeHtml(label)} ↗</a>`;
      } else {
        /* Plain text — preserve line breaks */
        cell = escapeHtml(f.value).replace(/\n/g, '<br>');
      }

      html += `
      <tr style="${trS}">
        <th style="${S.th}">${escapeHtml(f.key)}</th>
        <td style="${S.td}">${cell}</td>
      </tr>`;
    });
    html += `</table>`;
  }

  html += `</div>`;
  return html;
}

/* ══ PAGE HTML BUILDER ═══════════════════════════════════════════════
   Wraps the editor content + infobox in a complete, styled HTML page.
   The infobox is floated right so body text flows around it naturally.
═══════════════════════════════════════════════════════════════════════ */

function buildPageHTML({ slug, title, htmlContent, infoboxHTML }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — AWFLMETA AEDTP WORLD FREE LICENSE (AWFL) WIKI META</title>
<meta name="description" content="${escapeHtml(title)} Official WIKI | AEDTP WORLD FREE LICENSE (AWFL) WIKI META — The most advanced WIKI system by AEDTP WORLD.">
<meta name="type"        content="application, website, wiki, AEDTP WORLD">
<meta name="author"      content="AEDTP WORLD">
<meta name="copyright"   content="© AEDTP WORLD">
<meta name="keywords"    content="${escapeHtml(title)}, AEDTP WORLD FREE LICENSE (AWFL) WIKI META, AWFLMETA, AEDTP WORLD">
<meta name="license"     content="AEDTP WORLD FREE LICENSE (AWFL)">
<meta name="robots"      content="index, follow">
<meta name="application-name"  content="AEDTP WORLD FREE LICENSE (AWFL) WIKI META">
<meta name="application-alias" content="AWFLMETA">
<meta name="generator"         content="AEDTP WORLD">
<meta name="email"             content="aedtpworld@gmail.com">
<meta name="short-name"        content="AWFLMETA">
<meta name="alias"             content="AWFLMETA">
<meta name="AEDTP-WORLD-version" content="1.0.0.0">
<meta name="apple-mobile-web-app-capable"       content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="mobile-web-app-capable" content="yes">
<!-- Open Graph -->
<meta property="og:title"       content="${escapeHtml(title)} — AWFLMETA AEDTP WORLD FREE LICENSE (AWFL) WIKI META">
<meta property="og:description" content="${escapeHtml(title)} Official WIKI | AWFLMETA — The most advanced WIKI system by AEDTP WORLD.">
<meta property="og:type"        content="website">
<meta property="og:image"       content="https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/main/icons/awflmetaawfl.jpg">
<link rel="icon" href="https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/main/icons/awflmeta.jpg" type="image/jpeg">
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,400&family=IBM+Plex+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  /* ── Reset ── */
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}

  /* ── Page ── */
  body{
    background:#0a0c10;
    color:#e8edf5;
    font-family:'IBM Plex Sans',Arial,sans-serif;
    font-size:15px;
    line-height:1.65;
    padding:0;
    margin:0;
  }

  /* ── Top bar ── */
  .page-topbar{
    background:rgba(10,12,16,.97);
    border-bottom:1px solid #2a3450;
    padding:10px 28px;
    display:flex;
    align-items:center;
    justify-content:space-between;
    position:sticky;
    top:0;
    z-index:100;
    backdrop-filter:blur(10px);
  }
  .page-topbar-brand{
    font-family:'IBM Plex Mono',monospace;
    font-size:12px;
    color:#d4a843;
    font-weight:600;
    letter-spacing:.08em;
    text-decoration:none;
  }
  .page-topbar-brand:hover{color:#f0c060}
  .page-topbar-back{
    font-size:12px;
    color:#4a9eff;
    text-decoration:none;
    display:inline-flex;
    align-items:center;
    gap:5px;
  }
  .page-topbar-back:hover{text-decoration:underline}

  /* ── Content wrapper ── */
  .page-wrap{
    max-width:960px;
    margin:0 auto;
    padding:32px 28px 60px;
  }

  /* ── Page title ── */
  .page-title{
    font-family:'Crimson Pro',Georgia,serif;
    font-size:36px;
    font-weight:300;
    color:#e8edf5;
    border-bottom:2px solid #2a3450;
    padding-bottom:12px;
    margin-bottom:22px;
    line-height:1.2;
  }

  /* ── Clearfix for floated infobox ── */
  .wiki-body::after{content:'';display:table;clear:both}

  /* ── Body content typography ── */
  .wiki-body h1{font-family:'Crimson Pro',serif;font-size:28px;font-weight:400;color:#e8edf5;margin:28px 0 12px;border-bottom:1px solid #2a3450;padding-bottom:6px}
  .wiki-body h2{font-family:'Crimson Pro',serif;font-size:23px;font-weight:400;color:#e8edf5;margin:24px 0 10px;border-bottom:1px solid #2a3450;padding-bottom:5px}
  .wiki-body h3{font-family:'Crimson Pro',serif;font-size:19px;font-weight:600;color:#e8edf5;margin:20px 0 8px}
  .wiki-body p{font-family:'Crimson Pro',Georgia,serif;font-size:17px;line-height:1.78;margin:0 0 14px;color:#e8edf5}
  .wiki-body b,.wiki-body strong{font-weight:700;color:#fff}
  .wiki-body u{text-decoration:underline;text-decoration-color:#d4a843}
  .wiki-body em,.wiki-body i{font-style:italic}
  .wiki-body ul,.wiki-body ol{margin:10px 0 14px 28px}
  .wiki-body li{margin-bottom:5px;font-family:'Crimson Pro',serif;font-size:16px}
  .wiki-body a{color:#4a9eff;text-decoration:none}
  .wiki-body a:hover{text-decoration:underline}

  /* ── Content images ── */
  .wiki-body img{max-width:100%;border-radius:6px;margin:10px 0;height:auto}
  .wiki-body video{max-width:100%;border-radius:6px;margin:10px 0}
  .wiki-body audio{width:100%;margin:10px 0}

  /* ── Content tables ── */
  .wiki-body table{
    width:100%;
    border-collapse:collapse;
    margin:16px 0;
    font-size:14px;
    font-family:'IBM Plex Sans',Arial,sans-serif;
  }
  .wiki-body table th{
    background:#1e2535;
    padding:8px 12px;
    text-align:left;
    font-weight:600;
    border:1px solid #3a4870;
    font-size:13px;
    color:#e8edf5;
  }
  .wiki-body table td{
    padding:7px 12px;
    border:1px solid #2a3450;
    vertical-align:top;
    color:#e8edf5;
  }
  .wiki-body table tr:nth-child(even) td{background:rgba(255,255,255,.025)}

  /* ── TOC ── */
  #toc,.toc{
    background:#141820;
    border:1px solid #2a3450;
    border-radius:6px;
    padding:12px 16px;
    margin-bottom:22px;
    display:inline-block;
    min-width:200px;
    max-width:340px;
  }
  #toc .toc-title,.toc .toc-title{font-size:13px;font-weight:600;color:#e8edf5;margin-bottom:8px}
  #toc a,.toc a{display:block;font-size:13px;color:#4a9eff;margin:3px 0;text-decoration:none}
  #toc a:hover,.toc a:hover{text-decoration:underline}
  #toc .toc-sub,.toc .toc-sub{padding-left:14px;font-size:12px}

  /* ── Footer ── */
  .page-footer{
    margin-top:50px;
    padding-top:18px;
    border-top:1px solid #2a3450;
    font-size:12px;
    color:#6b7a95;
    font-family:'IBM Plex Mono',monospace;
    display:flex;
    align-items:center;
    justify-content:space-between;
    flex-wrap:wrap;
    gap:8px;
  }
  .page-footer a{color:#4a9eff;text-decoration:none}
  .page-footer a:hover{text-decoration:underline}

  /* ── Responsive ── */
  @media(max-width:680px){
    .page-wrap{padding:20px 14px 40px}
    .page-title{font-size:26px}
    /* stack infobox on mobile */
    div[style*="float:right"]{float:none!important;width:100%!important;margin:0 0 20px 0!important}
  }
</style>
</head>
<body>

<!-- Top Navigation Bar -->
<div class="page-topbar">
  <a class="page-topbar-brand" href="https://${GH.owner}.github.io/${GH.repo}/">AWFLMETA</a>
  <a class="page-topbar-back" href="https://${GH.owner}.github.io/${GH.repo}/#${slug}">← Back to Wiki</a>
</div>

<!-- Page Content -->
<div class="page-wrap">

  <h1 class="page-title">${escapeHtml(title)}</h1>

  <div class="wiki-body">
    ${infoboxHTML}
    ${htmlContent}
  </div>

  <div class="page-footer">
    <span>Published on <a href="https://${GH.owner}.github.io/${GH.repo}/">AWFLMETA</a> · AEDTP WORLD FREE LICENSE (AWFL)</span>
    <span>© AEDTP WORLD · <a href="mailto:aedtpworld@gmail.com">aedtpworld@gmail.com</a></span>
  </div>

</div>

</body>
</html>`;
}

/* ══ ROUTES ════════════════════════════════════════════════════════ */

app.get('/', (_req, res) => res.json({ status: 'AWFLMETA API running' }));

/* ── Auth: Create Account ── */
app.post('/api/auth/create', async (req, res) => {
  try {
    const { username = '', password = '' } = req.body;
    if (!username || /\s/.test(username))
      return res.status(400).json({ error: 'Username must not contain spaces.' });
    if (!password || /\s/.test(password))
      return res.status(400).json({ error: 'Password must not contain spaces.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const accounts = await loadAccounts();
    if (!accounts.users) accounts.users = [];
    if (accounts.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
      return res.status(409).json({ error: 'Username already exists. Please choose another.' });

    accounts.users.push({
      username,
      passwordHash: sha256(password),
      createdAt   : new Date().toISOString(),
    });
    await saveAccounts(accounts);
    res.json({ token: signToken({ username }), username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

/* ── Auth: Sign In ── */
app.post('/api/auth/signin', async (req, res) => {
  try {
    const { username = '', password = '' } = req.body;
    if (!username || /\s/.test(username))
      return res.status(400).json({ error: 'Username must not contain spaces.' });
    if (!password || /\s/.test(password) || password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters and contain no spaces.' });

    const accounts = await loadAccounts();
    const user = (accounts.users || []).find(
      u => u.username.toLowerCase() === username.toLowerCase()
    );
    if (!user || user.passwordHash !== sha256(password))
      return res.status(401).json({ error: 'Incorrect username or password.' });

    res.json({ token: signToken({ username: user.username }), username: user.username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

/* ── Auth: Verify Token ── */
app.get('/api/auth/verify', verifyToken, (req, res) => {
  res.json({ username: req.user.username });
});

/* ── Upload Image ── */
app.post('/api/upload/image', verifyToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided.' });

    const ext      = req.file.mimetype === 'image/png' ? '.png' : '.jpg';
    const baseName = req.file.originalname.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const fileName = baseName.endsWith(ext)
      ? baseName
      : baseName.replace(/\.[^.]+$/, '') + ext;
    const ghPath   = `images/${fileName}`;
    const existing = await ghGet(ghPath);
    await ghPutBinary(ghPath, req.file.buffer, `Upload image: ${fileName}`, existing?.sha);

    res.json({
      url     : `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/main/${ghPath}`,
      fileName,
      path    : ghPath,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Upload failed.' });
  }
});

/* ── Wiki: Publish Page ──────────────────────────────────────────────
   Body (JSON):
   {
     slug        : string   — page slug / URL key
     title       : string   — page display title
     htmlContent : string   — innerHTML of the editor (wiki-content div)
     infoboxData : {        — OPTIONAL; send {} or omit if no infobox
       template  : string   — e.g. "Artist", "Person", "Business" …
       fields    : [{ key: string, value: string }, …]
     }
   }

   The server renders the infobox server-side so the published .html
   file is completely self-contained — no JavaScript, no localStorage.
──────────────────────────────────────────────────────────────────── */
app.post('/api/wiki/publish', verifyToken, async (req, res) => {
  try {
    const { slug, title, htmlContent, infoboxData } = req.body;

    if (!slug || !title || !htmlContent)
      return res.status(400).json({ error: 'slug, title and htmlContent are required.' });

    const safeSlug = slug.replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
    const ghPath   = `awfl/wiki/${safeSlug}.html`;

    /* Build infobox HTML (empty string if none provided) */
    const infoboxHTML = buildInfoboxHTML(
      infoboxData && typeof infoboxData === 'object' ? infoboxData : null
    );

    /* Assemble the full page */
    const fileContent = buildPageHTML({
      slug     : safeSlug,
      title,
      htmlContent,
      infoboxHTML,
    });

    /* Write to GitHub */
    const existing = await ghGet(ghPath);
    await ghPut(ghPath, fileContent, `Publish wiki: ${safeSlug}`, existing?.sha);

    /* Non-blocking: update index.json + sitemap.xml */
    updateIndex(safeSlug, title).catch(e => console.error('Index update failed:', e.message));
    updateSitemap(safeSlug).catch(e => console.error('Sitemap update failed:', e.message));

    const pageUrl = `https://${GH.owner}.github.io/${GH.repo}/awfl/wiki/${safeSlug}.html`;
    res.json({ url: pageUrl, slug: safeSlug, path: ghPath });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Publish failed.' });
  }
});

/* ── Wiki: List Published Pages ─────────────────────────────────────
   GET /api/wiki/list
   Reads index.json first (fast). Falls back to directory listing.
──────────────────────────────────────────────────────────────────── */
app.get('/api/wiki/list', async (_req, res) => {
  try {
    const indexFile = await ghGet(INDEX_PATH);
    if (indexFile) {
      const index = JSON.parse(indexFile.content);
      return res.json({
        pages: index.map(p => ({
          slug   : p.slug,
          title  : p.title,
          updated: p.updated,
          url    : `https://${GH.owner}.github.io/${GH.repo}/awfl/wiki/${p.slug}.html`,
        })),
      });
    }
    /* Fallback: directory listing (no titles) */
    const { data } = await octokit.repos.getContent({ ...GH, path: 'awfl/wiki' });
    const pages = Array.isArray(data)
      ? data
          .filter(f => f.name.endsWith('.html') && f.name !== 'index.html')
          .map(f => ({
            slug: f.name.replace('.html', ''),
            url : `https://${GH.owner}.github.io/${GH.repo}/awfl/wiki/${f.name}`,
          }))
      : [];
    res.json({ pages });
  } catch (e) {
    if (e.status === 404) return res.json({ pages: [] });
    res.status(500).json({ error: e.message });
  }
});

/* ══ START ══════════════════════════════════════════════════════════ */

app.listen(PORT, () => console.log(`AWFLMETA API listening on port ${PORT}`));
