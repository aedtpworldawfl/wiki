/*
  AWFLMETA Backend Server
  ========================
  Stack : Node.js + Express
  Deploy: Render / Railway / Replit / any Node host
  Port  : process.env.PORT (default 3000)

  FIXES (2025):
  - Image URLs: fixImageUrl() ensures all image srcs are absolute,
    resolving the /awfl/wiki/images/... broken path bug.
  - Upload response now returns both `url` (raw) and `pagesUrl` (GitHub Pages).
  - buildInfoboxHTML() handles image, audio, video, link, plain text, AND table fields.
  - buildPageHTML() wraps everything in a fully styled, self-contained HTML page.
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

function isAbsoluteUrl(v) { return /^https?:\/\//.test(v); }
function isImageUrl(v)    { return /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(v); }

/* ── fixImageUrl ────────────────────────────────────────────────────
   Uploaded images live at:
     https://aedtpworldawfl.github.io/wiki/images/file.jpg  (Pages URL)
     https://raw.githubusercontent.com/.../main/images/file.jpg (raw URL)
   Both are valid. But if the editor stored a relative path like
   "images/buddydml.jpg" the browser resolves it against the published
   page location (/awfl/wiki/) giving a 404. This makes every src absolute.
─────────────────────────────────────────────────────────────────── */
function fixImageUrl(url) {
  if (!url) return url;
  if (isAbsoluteUrl(url)) return url;
  const clean = url.replace(/^\//, '');
  return `https://${GH.owner}.github.io/${GH.repo}/${clean}`;
}

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

  if (xml.includes(`/awfl/wiki/${slug}.html`)) return;

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

   Accepts:
     infoboxData = {
       template : "Artist" | "Person" | "Business" | "Custom" | …
       fields   : [
         { key: "Image",        value: "https://…/photo.jpg" },
         { key: "Name",         value: "Buddy DML" },
         { key: "Genre",        value: "Afrobeats\nHiplife" },
         { key: "Website",      value: "https://buddydml.com" },
         { key: "Promo",        value: "https://…/promo.mp4" },
         { key: "Audio Sample", value: "https://…/track.mp3" },
         { key: "Discography",  value: "table:Album|Year|Label\nOne More|2021|AEDTP\nReflect|2023|AEDTP" },
       ]
     }

   Special value formats:
     "table:Col1|Col2\nRow1Val1|Row1Val2"  →  nested HTML table inside the cell
     https://….mp4 / key contains "video"  →  <video> player
     https://….mp3 / key contains "audio"  →  <audio> player
     https://….jpg|png|gif|webp|svg        →  inline <img>
     https://… (any other)                 →  hyperlink ↗
     plain text                             →  text (newlines → <br>)

   All image srcs pass through fixImageUrl() to guarantee absolute paths.

═══════════════════════════════════════════════════════════════════════ */

function buildInfoboxHTML(infoboxData) {
  if (!infoboxData || !Array.isArray(infoboxData.fields) || !infoboxData.fields.length) {
    return '';
  }

  const { template, fields } = infoboxData;

  const imgF  = fields.find(f => f.key && f.key.toLowerCase() === 'image');
  const nameF = fields.find(f => f.key && f.key.toLowerCase() === 'name');
  const rows  = fields.filter(f => f.key && f.value && f.key.toLowerCase() !== 'image');

  /* ── Inline style constants ── */
  const S = {
    wrap     : 'float:right;clear:right;margin:0 0 20px 28px;background:#141820;border:1px solid #3a4870;border-radius:8px;width:280px;font-size:13px;overflow:hidden;font-family:"IBM Plex Sans",Arial,sans-serif;line-height:1.5;box-shadow:0 4px 18px rgba(0,0,0,.45)',
    titleBar : 'background:#252d40;padding:9px 13px;font-weight:700;font-size:14px;border-bottom:1px solid #3a4870;text-align:center;color:#e8edf5;letter-spacing:.02em',
    imgWrap  : 'border-bottom:1px solid #2a3450;text-align:center;overflow:hidden;background:#1a2030',
    imgTag   : 'width:100%;height:auto;max-height:220px;object-fit:cover;display:block',
    caption  : 'font-size:11px;color:#6b7a95;padding:5px 10px;text-align:center;background:#1a2030;border-bottom:1px solid #2a3450',
    table    : 'width:100%;border-collapse:collapse',
    trEven   : 'border-bottom:1px solid rgba(42,52,80,.5);background:#141820',
    trOdd    : 'border-bottom:1px solid rgba(42,52,80,.5);background:#101318',
    th       : 'background:#1a2030;padding:6px 10px;font-size:12px;font-weight:600;color:#6b7a95;text-align:left;width:42%;vertical-align:top;border-right:1px solid #2a3450',
    td       : 'padding:6px 10px;font-size:12px;color:#e8edf5;vertical-align:top',
    link     : 'color:#4a9eff;text-decoration:none;font-size:12px;word-break:break-all',
    thumbImg : 'max-width:100%;max-height:80px;border-radius:4px;display:block',
    video    : 'width:100%;max-height:130px;border-radius:4px;display:block;margin:2px 0',
    audio    : 'width:100%;display:block;margin:2px 0',
    /* nested table styles */
    nTable   : 'width:100%;border-collapse:collapse;margin:2px 0;font-size:11px',
    nTh      : 'background:#0f131a;padding:3px 6px;color:#a0aec0;font-weight:600;border:1px solid #2a3450;text-align:left',
    nTd      : 'padding:3px 6px;color:#e8edf5;border:1px solid #1e2535;vertical-align:top',
    nTrEven  : 'background:#141820',
    nTrOdd   : 'background:#101318',
  };

  /* ── Render a nested table from "table:Col1|Col2\nVal1|Val2" ── */
  function renderNestedTable(raw) {
    const lines = raw.replace(/^table:/i, '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return escapeHtml(raw);
    const headers  = lines[0].split('|');
    const dataRows = lines.slice(1);
    let t = `<table style="${S.nTable}"><thead><tr>`;
    headers.forEach(h => { t += `<th style="${S.nTh}">${escapeHtml(h.trim())}</th>`; });
    t += `</tr></thead><tbody>`;
    dataRows.forEach((row, ri) => {
      const cells    = row.split('|');
      const rowStyle = ri % 2 === 0 ? S.nTrEven : S.nTrOdd;
      t += `<tr style="${rowStyle}">`;
      cells.forEach(c => { t += `<td style="${S.nTd}">${escapeHtml(c.trim())}</td>`; });
      t += `</tr>`;
    });
    t += `</tbody></table>`;
    return t;
  }

  /* ── Render a single field value into cell HTML ── */
  function renderCell(f) {
    const kl  = f.key.toLowerCase();
    const val = f.value;

    if (/^table:/i.test(val)) {
      return renderNestedTable(val);
    }
    if (kl.includes('video') || /\.(mp4|webm|ogg|mov)(\?|$)/i.test(val)) {
      return `<video src="${escapeHtml(fixImageUrl(val))}" controls style="${S.video}"></video>`;
    }
    if (kl.includes('audio') || kl.includes('music') || kl.includes('sound') ||
        /\.(mp3|wav|ogg|flac|aac|m4a)(\?|$)/i.test(val)) {
      return `<audio src="${escapeHtml(fixImageUrl(val))}" controls style="${S.audio}"></audio>`;
    }
    if (isImageUrl(val)) {
      return `<img src="${escapeHtml(fixImageUrl(val))}" alt="${escapeHtml(f.key)}" loading="lazy" style="${S.thumbImg}">`;
    }
    if (isAbsoluteUrl(val)) {
      const label = val.replace(/^https?:\/\//, '').replace(/\/$/, '').substring(0, 34);
      return `<a href="${escapeHtml(val)}" target="_blank" rel="noopener" style="${S.link}">${escapeHtml(label)} ↗</a>`;
    }
    return escapeHtml(val).replace(/\n/g, '<br>');
  }

  /* ── Assemble ── */
  let html = `<div style="${S.wrap}">`;

  html += `<div style="${S.titleBar}">${escapeHtml(template)}</div>`;

  if (imgF && imgF.value) {
    const src = fixImageUrl(imgF.value);
    html += `<div style="${S.imgWrap}">`;
    html += `<img src="${escapeHtml(src)}" alt="${escapeHtml(nameF ? nameF.value : template)}" loading="lazy" style="${S.imgTag}">`;
    html += `</div>`;
    if (nameF && nameF.value) {
      html += `<div style="${S.caption}">${escapeHtml(nameF.value)}</div>`;
    }
  }

  if (rows.length) {
    html += `<table style="${S.table}">`;
    rows.forEach((f, idx) => {
      if (!f.key || !f.value) return;
      const trStyle = idx % 2 === 0 ? S.trEven : S.trOdd;
      html += `
        <tr style="${trStyle}">
          <th style="${S.th}">${escapeHtml(f.key)}</th>
          <td style="${S.td}">${renderCell(f)}</td>
        </tr>`;
    });
    html += `</table>`;
  }

  html += `</div>`;
  return html;
}

/* ══ PAGE HTML BUILDER ═══════════════════════════════════════════════ */

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
<meta name="application-name"    content="AEDTP WORLD FREE LICENSE (AWFL) WIKI META">
<meta name="application-alias"   content="AWFLMETA">
<meta name="generator"           content="AEDTP WORLD">
<meta name="email"               content="aedtpworld@gmail.com">
<meta name="short-name"          content="AWFLMETA">
<meta name="alias"               content="AWFLMETA">
<meta name="AEDTP-WORLD-version" content="1.0.0.0">
<meta name="apple-mobile-web-app-capable"          content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="mobile-web-app-capable"                content="yes">
<!-- Open Graph -->
<meta property="og:title"       content="${escapeHtml(title)} — AWFLMETA AEDTP WORLD FREE LICENSE (AWFL) WIKI META">
<meta property="og:description" content="${escapeHtml(title)} Official WIKI | AWFLMETA — The most advanced WIKI system by AEDTP WORLD.">
<meta property="og:type"        content="website">
<meta property="og:image"       content="https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/main/icons/awflmetaawfl.jpg">
<link rel="icon" href="https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/main/icons/awflmeta.jpg" type="image/jpeg">
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,400&family=IBM+Plex+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{background:#0a0c10;color:#e8edf5;font-family:'IBM Plex Sans',Arial,sans-serif;font-size:15px;line-height:1.65;padding:0;margin:0}

  /* Top bar */
  .page-topbar{background:rgba(10,12,16,.97);border-bottom:1px solid #2a3450;padding:10px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(10px)}
  .page-topbar-brand{font-family:'IBM Plex Mono',monospace;font-size:12px;color:#d4a843;font-weight:600;letter-spacing:.08em;text-decoration:none}
  .page-topbar-brand:hover{color:#f0c060}
  .page-topbar-back{font-size:12px;color:#4a9eff;text-decoration:none;display:inline-flex;align-items:center;gap:5px}
  .page-topbar-back:hover{text-decoration:underline}

  /* Layout */
  .page-wrap{max-width:960px;margin:0 auto;padding:32px 28px 60px}
  .page-title{font-family:'Crimson Pro',Georgia,serif;font-size:36px;font-weight:300;color:#e8edf5;border-bottom:2px solid #2a3450;padding-bottom:12px;margin-bottom:22px;line-height:1.2}

  /* Clearfix so body text wraps around floated infobox */
  .wiki-body::after{content:'';display:table;clear:both}

  /* Typography */
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

  /* Media */
  .wiki-body img{max-width:100%;border-radius:6px;margin:10px 0;height:auto}
  .wiki-body video{max-width:100%;border-radius:6px;margin:10px 0}
  .wiki-body audio{width:100%;margin:10px 0}

  /* Content tables */
  .wiki-body table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;font-family:'IBM Plex Sans',Arial,sans-serif}
  .wiki-body table th{background:#1e2535;padding:8px 12px;text-align:left;font-weight:600;border:1px solid #3a4870;font-size:13px;color:#e8edf5}
  .wiki-body table td{padding:7px 12px;border:1px solid #2a3450;vertical-align:top;color:#e8edf5}
  .wiki-body table tr:nth-child(even) td{background:rgba(255,255,255,.025)}

  /* TOC */
  #toc,.toc{background:#141820;border:1px solid #2a3450;border-radius:6px;padding:12px 16px;margin-bottom:22px;display:inline-block;min-width:200px;max-width:340px}
  #toc .toc-title,.toc .toc-title{font-size:13px;font-weight:600;color:#e8edf5;margin-bottom:8px}
  #toc a,.toc a{display:block;font-size:13px;color:#4a9eff;margin:3px 0;text-decoration:none}
  #toc a:hover,.toc a:hover{text-decoration:underline}
  #toc .toc-sub,.toc .toc-sub{padding-left:14px;font-size:12px}

  /* Footer */
  .page-footer{margin-top:50px;padding-top:18px;border-top:1px solid #2a3450;font-size:12px;color:#6b7a95;font-family:'IBM Plex Mono',monospace;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
  .page-footer a{color:#4a9eff;text-decoration:none}
  .page-footer a:hover{text-decoration:underline}

  /* Mobile */
  @media(max-width:680px){
    .page-wrap{padding:20px 14px 40px}
    .page-title{font-size:26px}
    div[style*="float:right"]{float:none!important;width:100%!important;margin:0 0 20px 0!important}
  }
</style>
</head>
<body>

<div class="page-topbar">
  <a class="page-topbar-brand" href="https://${GH.owner}.github.io/${GH.repo}/">AWFLMETA</a>
  <a class="page-topbar-back" href="https://${GH.owner}.github.io/${GH.repo}/#${slug}">← Back to Wiki</a>
</div>

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

/* ── Upload Image ─────────────────────────────────────────────────
   Returns both `url` (raw.githubusercontent.com) and `pagesUrl`
   (GitHub Pages). Paste pagesUrl into the infobox Image field so
   the browser resolves it correctly from the published page.
─────────────────────────────────────────────────────────────────── */
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

    const rawUrl   = `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/main/${ghPath}`;
    const pagesUrl = `https://${GH.owner}.github.io/${GH.repo}/${ghPath}`;

    res.json({
      url     : rawUrl,   // always works immediately after push
      pagesUrl,           // use this in infobox Image field
      fileName,
      path    : ghPath,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Upload failed.' });
  }
});

/* ── Wiki: Publish Page ──────────────────────────────────────────────
   POST /api/wiki/publish
   Body (JSON):
   {
     slug        : string  — page slug / URL key
     title       : string  — page display title
     htmlContent : string  — innerHTML of the wiki-content editor div
     infoboxData : {       — OPTIONAL; omit or send null if no infobox
       template  : string  — "Artist" | "Person" | "Business" | "Custom" | …
       fields    : [{ key: string, value: string }, …]
         Special value formats:
           "table:Col1|Col2\nVal1|Val2"        → nested HTML table
           .mp4/.webm / key contains "video"   → <video> player
           .mp3/.wav  / key contains "audio"   → <audio> player
           image URL (.jpg/.png/etc)            → inline <img>
           other https:// URL                  → hyperlink ↗
           plain text                           → text
     }
   }
──────────────────────────────────────────────────────────────────── */
app.post('/api/wiki/publish', verifyToken, async (req, res) => {
  try {
    const { slug, title, htmlContent, infoboxData } = req.body;

    if (!slug || !title || !htmlContent)
      return res.status(400).json({ error: 'slug, title and htmlContent are required.' });

    const safeSlug = slug.replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
    const ghPath   = `awfl/wiki/${safeSlug}.html`;

    const infoboxHTML = buildInfoboxHTML(
      infoboxData && typeof infoboxData === 'object' ? infoboxData : null
    );

    const fileContent = buildPageHTML({ slug: safeSlug, title, htmlContent, infoboxHTML });

    const existing = await ghGet(ghPath);
    await ghPut(ghPath, fileContent, `Publish wiki: ${safeSlug}`, existing?.sha);

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
   GET /api/wiki/list — reads index.json (fast) or falls back to dir listing
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
