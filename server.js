require('dotenv').config();
const express = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');

const app         = express();
const PORT        = process.env.PORT || 3456;
const N8N_URL     = process.env.N8N_URL || 'https://n8n.effipm.cloud';
const N8N_KEY     = process.env.N8N_KEY || '';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'TCTwgK1Apdy4oULj';
const USERS_FILE    = path.join(__dirname, 'users.json');
const CACHE_FILE    = path.join(__dirname, 'last_result.json');
const TRIGGER_FILE  = path.join(__dirname, 'last_trigger.json');

// Startup config check
if (!N8N_KEY) console.warn('[warn] N8N_KEY is not set — n8n API calls will fail with 401');
else          console.log(`[init] N8N_KEY loaded (${N8N_KEY.slice(0, 12)}...)`);
console.log(`[init] N8N_URL=${N8N_URL}  WORKFLOW_ID=${WORKFLOW_ID}`);

// ─── Bootstrap admin on first run ────────────────────────────────────────────
function initUsers() {
  if (fs.existsSync(USERS_FILE)) return;
  const email = process.env.ADMIN_EMAIL || 'admin@briefing.local';
  const pass  = process.env.ADMIN_PASS  || 'changeme123';
  const hash  = bcrypt.hashSync(pass, 10);
  fs.writeFileSync(USERS_FILE, JSON.stringify([{ email, passwordHash: hash, isAdmin: true }], null, 2));
  console.log(`[init] Created admin user: ${email}`);
}
initUsers();

const readUsers  = ()      => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const writeUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

// ─── Result cache ─────────────────────────────────────────────────────────────
function saveCache(result) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2)); } catch {}
}
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}

// ─── Trigger timestamp ────────────────────────────────────────────────────────
function saveTrigger() {
  try { fs.writeFileSync(TRIGGER_FILE, JSON.stringify({ triggeredAt: new Date().toISOString() })); } catch {}
}
function loadTrigger() {
  try { return JSON.parse(fs.readFileSync(TRIGGER_FILE, 'utf8')); } catch { return null; }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mb-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const requireAuth  = (req, res, next) => next(); // auth disabled
const requireAdmin = (req, res, next) => next(); // auth disabled

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  const user = readUsers().find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.passwordHash))
    return res.status(401).json({ error: 'Invalid email or password' });
  req.session.userId = user.email;
  res.json({ ok: true, email: user.email, isAdmin: !!user.isAdmin });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth/me', (req, res) => {
  res.json({ email: 'user@local', isAdmin: true });
});

// ─── Admin: User management ───────────────────────────────────────────────────
app.get('/admin/users', requireAdmin, (req, res) => {
  const users = readUsers().map(({ email, isAdmin }) => ({ email, isAdmin: !!isAdmin }));
  res.json(users);
});

app.post('/admin/users', requireAdmin, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be ≥ 8 characters' });
  const users = readUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'User already exists' });
  users.push({ email, passwordHash: bcrypt.hashSync(password, 10), isAdmin: false });
  writeUsers(users);
  res.json({ ok: true });
});

app.delete('/admin/users/:email', requireAdmin, (req, res) => {
  const target = decodeURIComponent(req.params.email);
  if (target === req.session.userId) return res.status(400).json({ error: 'Cannot remove yourself' });
  const users = readUsers();
  const idx = users.findIndex(u => u.email === target);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  users.splice(idx, 1);
  writeUsers(users);
  res.json({ ok: true });
});

// ─── n8n helper ───────────────────────────────────────────────────────────────
async function n8nFetch(endpoint, opts = {}) {
  const resp = await fetch(`${N8N_URL}/api/v1${endpoint}`, {
    ...opts,
    headers: { 'X-N8N-API-KEY': N8N_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`n8n ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp.json();
}

// ─── Data extraction ──────────────────────────────────────────────────────────
function nodeOutput(runData, name) {
  return runData[name]?.[0]?.data?.main?.[0]?.[0]?.json || {};
}

function extractBias(md) {
  if (!md) return '';
  const m = md.match(/###\s*Section\s*4[\s\S]*/i) || md.match(/###\s*Bias\s*Summary[\s\S]*/i);
  return m ? m[0].trim() : '';
}

function extractPriceNumbers(html) {
  const m = html.match(/Key Levels Reference<\/h3><pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!m) return [];
  return m[1].trim().split('\n').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
}

function extractResult(exec) {
  const runData = exec.data?.resultData?.runData || {};
  const js  = nodeOutput(runData, 'Code in JavaScript');
  const htm = nodeOutput(runData, 'Code (Build Email HTML)');
  const prices = extractPriceNumbers(htm.email_html || '');
  const result = {
    symbol:         js.symbol || 'NQ=F',
    chartSummary:   js.chartSummary || '',
    mainZonesMd:    js.mainZonesMd  || js.scalpingZonesMd || '',
    scalpZonesMd:   js.scalpZonesMd || '',
    keyLevelsMd:    js.keyLevelsMd  || '',
    dataSnapshotMd: js.data?.dataSnapshotMd || '',
    biasMd:         extractBias(js.chartCombined || ''),
    prices,
    pp:             prices.length > 0 ? prices[0] : null,
    sentiment:      js.news?.newsSentiment ?? null,
    themes:         Array.isArray(js.news?.newsThemes) ? js.news.newsThemes : [],
    subject:        htm.email_subject || '',
    ranAt:          exec.startedAt || exec.createdAt || null,
  };
  saveCache(result);
  return result;
}

// ─── API routes ───────────────────────────────────────────────────────────────
app.post('/api/trigger', requireAuth, async (req, res) => {
  try {
    const resp = await fetch(`${N8N_URL}/webhook/market-briefing-trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Webhook ${resp.status}: ${txt.slice(0, 200)}`);
    }
    // Record when we triggered so /api/latest can detect a fresh run
    saveTrigger();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/execution/:id', requireAuth, async (req, res) => {
  try {
    const data = await n8nFetch(`/executions/${req.params.id}?includeData=true`);
    const out = { status: data.status, id: data.id };
    if (data.status === 'success') out.result = extractResult(data);
    if (data.status === 'error')   out.error  = data.data?.resultData?.error?.message || 'Execution failed';
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/latest', requireAuth, async (req, res) => {
  const cached    = loadCache();
  const triggered = loadTrigger();

  // Helper: is the cached result newer than the last trigger?
  function isFresh() {
    if (!triggered || !cached?.ranAt) return false;
    return new Date(cached.ranAt) >= new Date(triggered.triggeredAt);
  }

  try {
    // Try to get live data from n8n
    const data = await n8nFetch(`/executions?workflowId=${WORKFLOW_ID}&limit=1&includeData=true`);
    const exec = data?.data?.[0];

    if (exec?.status === 'success') {
      const result = extractResult(exec);   // also saves to cache
      return res.json({ status: 'success', result });
    }

    if (exec?.status === 'running' || exec?.status === 'new') {
      return res.json({ status: 'running' });
    }

    // n8n gave us an exec but it wasn't success — fall back to cache
    if (cached) return res.json({ status: 'success', result: cached });
    res.json({ status: 'none' });

  } catch (e) {
    // n8n API unreachable — use local trigger timestamp + cache to infer state
    if (triggered && !isFresh()) {
      // We triggered but cache hasn't updated yet → still running
      return res.json({ status: 'running' });
    }
    if (cached) return res.json({ status: 'success', result: cached });
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Market Briefing UI  →  http://localhost:${PORT}\n`);
});
