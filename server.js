// ============================================================
//  mybot — Real Sports Automation Server
//  Run: node server.js
//  Then open: http://localhost:3000
// ============================================================

const express  = require('express');
const cors     = require('cors');
const http     = require('http');
const WebSocket = require('ws');
const fetch    = require('node-fetch');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT   = process.env.PORT || 3000;
const RS_BASE = 'https://web.realapp.com';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  SESSION STORE  (in-memory; one per token)
// ============================================================
const sessions = {}; // sessionId -> Session

function makeId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ============================================================
//  REAL SPORTS API WRAPPER
//  All RS calls go through here so you only need to update
//  headers/auth in one place.
// ============================================================
async function rsCall(session, method, path, body) {
  const url = RS_BASE + path;
  // Real Sports uses custom auth headers (not Authorization: Bearer)
  // Format: real-auth-info = userId!deviceId!token
  const authInfo = `${session.userId}!${session.deviceId}!${session.token}`;
  const opts = {
    method,
    headers: {
      'real-auth-info':    authInfo,
      'real-request-token': session.requestToken || '',
      'real-device-uuid':  session.deviceUuid || '',
      'real-device-type':  'desktop_web',
      'real-device-name':  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'real-version':      '30',
      'Content-Type':      'application/json',
      'Accept':            'application/json',
      'Origin':            'https://www.realapp.com',
      'Referer':           'https://www.realapp.com/',
      'User-Agent':        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { data = text; }

  sessionLog(session, `RS ${method} ${path} → ${res.status}`);
  return { status: res.status, ok: res.status >= 200 && res.status < 300, data };
}

// ============================================================
//  WEBSOCKET — broadcast updates to all connected browsers
// ============================================================
function broadcast(eventType, payload) {
  const msg = JSON.stringify({ event: eventType, ...payload });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function sessionLog(session, msg) {
  if (!session) return;
  const entry = { t: new Date().toISOString(), msg };
  session.logs = session.logs || [];
  session.logs.push(entry);
  if (session.logs.length > 500) session.logs.shift();
  broadcast('log', { sessionId: session.id, entry, jobType: null });
}

// ============================================================
//  AUTH
// ============================================================
app.post('/api/auth', async (req, res) => {
  const { token, deviceId, userId, requestToken, deviceUuid, username } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  // Build a test session with all auth fields
  const testSession = {
    token,
    deviceId:     deviceId || '',
    userId:       userId || '',
    requestToken: requestToken || '',
    deviceUuid:   deviceUuid || '',
    logs: [],
    id: 'test',
  };

  // Validate connectivity using /squads (confirmed working with correct headers)
  // Also try user-specific endpoints that return profile data
  let connected = false;
  let userInfo = null;
  let workingPath = null;

  // First confirm API access works at all
  try {
    const probe = await rsCall(testSession, 'GET', '/squads?sport=nba', null);
    connected = probe.ok;
    if (connected) workingPath = '/squads?sport=nba';
  } catch(e) {}

  // Try to get user profile data
  const userEndpoints = ['/users/me', `/users/${userId}`, '/user', '/profile'];
  for (const ep of userEndpoints) {
    try {
      const r = await rsCall(testSession, 'GET', ep, null);
      if (r.ok && r.data && (r.data.id || r.data.userId || r.data.username || r.data.userName)) {
        userInfo = r.data;
        break;
      }
    } catch(e) {}
  }

  const sessionId = makeId();
  const session = {
    id:           sessionId,
    token,
    deviceId:     deviceId || '',
    userId:       userInfo?.userId || userInfo?.id || userId || '',
    requestToken: requestToken || '',
    deviceUuid:   deviceUuid || '',
    username:     userInfo?.username || userInfo?.userName || userInfo?.name || username || 'Player',
    balance:      userInfo?.balance || userInfo?.rax || 0,
    jobs:         {},
    history:      [],
    logs:         [],
    connected,
  };

  sessions[sessionId] = session;
  sessionLog(session, `✅ Session created — user: ${session.username}`);
  if (connected) sessionLog(session, `✅ RS API connected — authenticated successfully`);
  else sessionLog(session, `⚠ Could not connect to RS API — check credentials`);

  res.json({
    sessionId,
    username:  session.username,
    userId:    session.userId,
    balance:   session.balance,
    connected: session.connected,
  });
});

// ============================================================
//  SESSION INFO
// ============================================================
app.get('/api/session/:id', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.json({
    sessionId: s.id,
    username:  s.username,
    userId:    s.userId,
    balance:   s.balance,
    connected: s.connected,
    jobCount:  Object.values(s.jobs).filter(j => j.running).length,
  });
});

app.get('/api/session/:id/balance', async (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'session not found' });

  const userEndpoints = ['/users/me', `/users/${s.userId}`, '/user', '/profile'].filter(Boolean);
  for (const ep of userEndpoints) {
    try {
      const r = await rsCall(s, 'GET', ep, null);
      if (r.ok && r.data) {
        s.balance = r.data.balance || r.data.rax || s.balance;
        return res.json({ balance: s.balance });
      }
    } catch(e) {}
  }
  res.json({ balance: s.balance });
});

// ============================================================
//  PROXY — forward ANY RS API call
//  Use this to explore/test endpoints from the frontend
// ============================================================
app.post('/api/proxy', async (req, res) => {
  const { sessionId, method, path: apiPath, body } = req.body;
  const s = sessions[sessionId];
  if (!s) return res.status(401).json({ error: 'invalid session' });
  if (!apiPath) return res.status(400).json({ error: 'path required' });

  try {
    const result = await rsCall(s, method || 'GET', apiPath, body || null);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  AUTH FORMAT TESTER — try multiple header combos against RS API
// ============================================================
app.post('/api/test-auth', async (req, res) => {
  const { token, deviceId } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  const did = deviceId || '';
  const baseUrl = RS_BASE + '/users/me';

  // Full browser-like headers (Sec-Fetch-* etc.) to pass server-side bot detection
  const browserBase = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Origin': 'https://www.realapp.com',
    'Referer': 'https://www.realapp.com/',
  };

  const variants = [
    { name: 'Bearer+Device',   headers: { 'Authorization': `Bearer ${token}`, 'X-Device-Id': did } },
    { name: 'Token+Device',    headers: { 'Authorization': `Token ${token}`,  'X-Device-Id': did } },
    { name: 'Raw+Device',      headers: { 'Authorization': token,             'X-Device-Id': did } },
    { name: 'X-Auth-Token',    headers: { 'X-Auth-Token': token,             'X-Device-Id': did } },
    { name: 'X-Token',         headers: { 'X-Token': token,                  'X-Device-Id': did } },
    { name: 'Bearer-only',     headers: { 'Authorization': `Bearer ${token}` } },
    { name: 'NoAuth-browser',  headers: {} },
    // Also try /home/nba/next (the endpoint that returns 200 for app)
  ];

  const results = [];
  for (const v of variants) {
    try {
      const r = await fetch(baseUrl, {
        method: 'GET',
        headers: { ...browserBase, ...v.headers }
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch(e) { data = text.slice(0,200); }
      results.push({ name: v.name, status: r.status, data });
    } catch(e) {
      results.push({ name: v.name, error: e.message });
    }
  }

  // Also test the /home/nba/next endpoint which the real app accesses successfully
  try {
    const r2 = await fetch(RS_BASE + '/home/nba/next?cohort=0', {
      headers: { ...browserBase, 'Authorization': `Bearer ${token}`, 'X-Device-Id': did }
    });
    const t2 = await r2.text();
    let d2; try { d2 = JSON.parse(t2); } catch(e) { d2 = t2.slice(0,200); }
    results.push({ name: 'home-nba-next-Bearer', status: r2.status, data: d2 });
  } catch(e) { results.push({ name: 'home-nba-next-Bearer', error: e.message }); }

  try {
    const r3 = await fetch(RS_BASE + '/home/nba/next?cohort=0', { headers: { ...browserBase } });
    const t3 = await r3.text();
    let d3; try { d3 = JSON.parse(t3); } catch(e) { d3 = t3.slice(0,200); }
    results.push({ name: 'home-nba-next-NoAuth', status: r3.status, data: d3 });
  } catch(e) { results.push({ name: 'home-nba-next-NoAuth', error: e.message }); }
  res.json(results);
});

// ============================================================
//  JOB STATUS & LOGS
// ============================================================
app.get('/api/jobs/status', (req, res) => {
  const s = sessions[req.query.sessionId];
  if (!s) return res.status(401).json({ error: 'invalid session' });
  res.json({ jobs: s.jobs });
});

app.get('/api/jobs/history', (req, res) => {
  const s = sessions[req.query.sessionId];
  if (!s) return res.status(401).json({ error: 'invalid session' });
  res.json(s.history);
});

app.get('/api/jobs/logs', (req, res) => {
  const s = sessions[req.query.sessionId];
  if (!s) return res.status(401).json({ error: 'invalid session' });
  res.json({ logs: s.logs.slice(-200) });
});

// ============================================================
//  JOB CONTROL
// ============================================================
app.post('/api/jobs/start', async (req, res) => {
  const { sessionId, type, config } = req.body;
  const s = sessions[sessionId];
  if (!s) return res.status(401).json({ error: 'invalid session' });

  if (s.jobs[type]?.running) {
    return res.status(409).json({ error: `${type} already running` });
  }

  s.jobs[type] = { running: true, status: 'starting', stats: {}, config, startedAt: new Date() };
  broadcast('jobUpdate', { sessionId, jobType: type, job: s.jobs[type] });

  res.json({ ok: true, type });

  // Run job async (non-blocking)
  runJob(s, type, config).catch(err => {
    sessionLog(s, `✗ Job ${type} crashed: ${err.message}`);
    s.jobs[type] = { ...s.jobs[type], running: false, status: 'error', error: err.message };
    broadcast('jobUpdate', { sessionId, jobType: type, job: s.jobs[type] });
  });
});

app.post('/api/jobs/stop', (req, res) => {
  const { sessionId, type } = req.body;
  const s = sessions[sessionId];
  if (!s) return res.status(401).json({ error: 'invalid session' });

  if (s.jobs[type]) {
    s.jobs[type].stopRequested = true;
    sessionLog(s, `⏹ Stop requested for ${type}`);
  }
  res.json({ ok: true });
});

// ============================================================
//  JOB RUNNER
// ============================================================
async function runJob(session, type, config) {
  switch(type) {
    case 'prestige':  return runPrestige(session, config);
    case 'offer':     return runOffers(session, config);
    case 'sell':      return runQuicksell(session, config);
    case 'live':      return runPackFeed(session, config);
    case 'listings':  return runListings(session, config);
    default:
      throw new Error(`Unknown job type: ${type}`);
  }
}

function shouldStop(session, type) {
  return session.jobs[type]?.stopRequested === true;
}

function updateJob(session, type, update) {
  session.jobs[type] = { ...session.jobs[type], ...update };
  broadcast('jobUpdate', { sessionId: session.id, jobType: type, job: session.jobs[type] });
}

function finishJob(session, type, stats, status = 'done') {
  const job = session.jobs[type];
  session.history.unshift({
    type,
    status,
    stats,
    config: job.config,
    startedAt: job.startedAt,
    endedAt: new Date(),
  });
  session.jobs[type] = { ...job, running: false, status, stats };
  broadcast('jobUpdate', { sessionId: session.id, jobType: type, job: session.jobs[type] });
  sessionLog(session, `✅ ${type} finished — ${JSON.stringify(stats)}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── PRESTIGE ───────────────────────────────────────────────
async function runPrestige(session, config) {
  const { sport, season, level = 1, skipRarities = [] } = config;
  const stats = { prestiged: 0, failed: 0, skipped: 0, total: 0 };
  updateJob(session, 'prestige', { status: 'running', stats });
  sessionLog(session, `▶ Prestige: sport=${sport} season=${season} level=${level}`);

  // Fetch eligible cards — try multiple endpoint formats (confirmed: /collecting/cards works)
  const cardPaths = [
    `/collecting/cards?sport=${sport}&season=${season}&prestige_level=${level}&prestige_ready=true&limit=200`,
    `/collecting/${sport}/prestige?level=${level}&season=${season}&status=ready`,
    `/collecting/cards?sport=${sport}&season=${season}&prestige_ready=true&limit=200`,
    `/cards?sport=${sport}&season=${season}&prestige_level=${level}&prestige_ready=true&limit=200`,
  ];

  let cards = [];
  for (const p of cardPaths) {
    if (shouldStop(session, 'prestige')) break;
    try {
      const r = await rsCall(session, 'GET', p, null);
      if (r.ok) {
        cards = Array.isArray(r.data) ? r.data
              : r.data?.cards || r.data?.items || r.data?.results || [];
        if (cards.length > 0) {
          sessionLog(session, `✅ Found ${cards.length} cards via ${p}`);
          break;
        }
      }
    } catch(e) {}
  }

  stats.total = cards.length;
  sessionLog(session, `Found ${cards.length} cards eligible for prestige`);

  for (const card of cards) {
    if (shouldStop(session, 'prestige')) break;

    const rarity = (card.rarity || card.tier || '').toLowerCase();
    if (skipRarities.some(r => rarity.includes(r.toLowerCase()))) {
      stats.skipped++;
      sessionLog(session, `⏭ Skipped ${card.playerName || card.name || card.id} (${rarity})`);
      continue;
    }

    const cardId = card.id || card.cardId;

    // Try multiple prestige endpoint formats
    const prestigePaths = [
      { path: `/collecting/${sport}/prestige`, body: { cardId, level, season } },
      { path: `/collecting/prestige`,          body: { cardId, level, sport, season } },
      { path: `/cards/${cardId}/prestige`,     body: { level, sport, season } },
      { path: `/collecting/cards/${cardId}/prestige`, body: { level } },
    ];

    let done = false;
    for (const { path, body } of prestigePaths) {
      try {
        const r = await rsCall(session, 'POST', path, body);
        if (r.ok) {
          stats.prestiged++;
          sessionLog(session, `⭐ Prestiged ${card.playerName || card.id}`);
          done = true;
          break;
        }
        if (r.status === 404) continue; // try next path
        sessionLog(session, `✗ Prestige error ${r.status}: ${JSON.stringify(r.data).slice(0,80)}`);
        break;
      } catch(e) {}
    }
    if (!done) stats.failed++;

    updateJob(session, 'prestige', { stats });
    await sleep(800);
  }

  finishJob(session, 'prestige', stats, shouldStop(session, 'prestige') ? 'stopped' : 'done');
}

// ─── GLOBAL OFFERS ─────────────────────────────────────────
async function runOffers(session, config) {
  const { sport, season, duration = 3600, target = 100, minOwners, maxOwners, fighter } = config;
  const stats = { offered: 0, skipped: 0, failed: 0, target };
  updateJob(session, 'offer', { status: 'running', stats });
  sessionLog(session, `▶ Offers: sport=${sport} duration=${duration}s target=${target}`);

  // Step 1: get marketplace listings to offer on
  let listings = [];
  // confirmed: /marketplace/listings works
  const listingPaths = [
    `/marketplace/listings?sport=${sport}${season ? `&season=${season}` : ''}${minOwners ? `&min_owners=${minOwners}` : ''}${maxOwners ? `&max_owners=${maxOwners}` : ''}&limit=200`,
    `/marketplace/listings?limit=200`,
    `/marketplace?sport=${sport}${season ? `&season=${season}` : ''}&limit=200`,
    `/listings?sport=${sport}&limit=200`,
  ];

  for (const p of listingPaths) {
    try {
      const r = await rsCall(session, 'GET', p, null);
      if (r.ok) {
        listings = Array.isArray(r.data) ? r.data
                 : r.data?.listings || r.data?.items || r.data?.results || [];
        if (listings.length > 0) {
          sessionLog(session, `✅ Found ${listings.length} listings via ${p}`);
          break;
        }
      }
    } catch(e) {}
  }

  if (listings.length === 0) {
    sessionLog(session, `✗ Could not fetch listings — check token or endpoint`);
    finishJob(session, 'offer', stats, 'error');
    return;
  }

  // Filter by fighter if specified
  if (fighter) {
    listings = listings.filter(l =>
      (l.playerName || l.name || '').toLowerCase().includes(fighter.toLowerCase())
    );
    sessionLog(session, `Filtered to ${listings.length} listings matching "${fighter}"`);
  }

  for (const listing of listings) {
    if (shouldStop(session, 'offer')) break;
    if (stats.offered >= target) break;

    const listingId = listing.id || listing.listingId;
    const price     = listing.price || listing.askingPrice || listing.value;

    // Skip own listings
    if (listing.userId === session.userId || listing.sellerId === session.userId) {
      stats.skipped++;
      continue;
    }

    const offerPaths = [
      { path: `/marketplace/listings/${listingId}/offers`, body: { duration, price } },
      { path: `/marketplace/offers`,  body: { listingId, duration, price, sport } },
      { path: `/offers`,              body: { listingId, duration, price } },
    ];

    let done = false;
    for (const { path, body } of offerPaths) {
      try {
        const r = await rsCall(session, 'POST', path, body);
        if (r.ok) {
          stats.offered++;
          sessionLog(session, `💰 Offered on ${listing.playerName || listing.name || listingId} (${price} Rax)`);
          done = true;
          break;
        }
        if (r.status === 404) continue;
        if (r.status === 409) { stats.skipped++; done = true; break; } // already offered
        sessionLog(session, `✗ Offer error ${r.status}: ${JSON.stringify(r.data).slice(0,80)}`);
        break;
      } catch(e) {}
    }
    if (!done) stats.failed++;

    updateJob(session, 'offer', { stats });
    await sleep(1200);
  }

  finishJob(session, 'offer', stats, shouldStop(session, 'offer') ? 'stopped' : 'done');
}

// ─── BULK QUICKSELL ─────────────────────────────────────────
async function runQuicksell(session, config) {
  const { sport, season, protectRarities = ['iconic', 'mystic'] } = config;
  const stats = { sold: 0, failed: 0, skipped: 0, raxEarned: 0 };
  updateJob(session, 'sell', { status: 'running', stats });
  sessionLog(session, `▶ Quicksell: sport=${sport}`);

  // Fetch user's cards
  let cards = [];
  const cardPaths = [
    `/collecting/${sport}/cards?season=${season || ''}&owned=true&limit=500`,
    `/collecting/cards?sport=${sport}${season ? `&season=${season}` : ''}&limit=500`,
    `/users/me/cards?sport=${sport}&limit=500`,
  ];

  for (const p of cardPaths) {
    try {
      const r = await rsCall(session, 'GET', p, null);
      if (r.ok) {
        cards = Array.isArray(r.data) ? r.data : r.data?.cards || r.data?.items || [];
        if (cards.length > 0) { sessionLog(session, `✅ Found ${cards.length} cards`); break; }
      }
    } catch(e) {}
  }

  if (cards.length === 0) {
    sessionLog(session, `✗ No cards found to sell`);
    finishJob(session, 'sell', stats, 'error');
    return;
  }

  for (const card of cards) {
    if (shouldStop(session, 'sell')) break;

    const rarity = (card.rarity || card.tier || '').toLowerCase();
    if (protectRarities.some(r => rarity.includes(r.toLowerCase()))) {
      stats.skipped++;
      continue;
    }

    const cardId   = card.id || card.cardId;
    const sellValue = card.quicksellValue || card.value || 0;

    const sellPaths = [
      { path: `/collecting/quicksell`,              body: { cardId, sport } },
      { path: `/collecting/cards/${cardId}/sell`,   body: {} },
      { path: `/cards/${cardId}/quicksell`,         body: {} },
    ];

    let done = false;
    for (const { path, body } of sellPaths) {
      try {
        const r = await rsCall(session, 'POST', path, body);
        if (r.ok) {
          stats.sold++;
          stats.raxEarned += sellValue;
          sessionLog(session, `💵 Sold ${card.playerName || card.id} for ${sellValue} Rax`);
          done = true;
          break;
        }
        if (r.status === 404) continue;
        break;
      } catch(e) {}
    }
    if (!done) stats.failed++;

    updateJob(session, 'sell', { stats });
    await sleep(500);
  }

  finishJob(session, 'sell', stats, shouldStop(session, 'sell') ? 'stopped' : 'done');
}

// ─── PACK FEED ──────────────────────────────────────────────
async function runPackFeed(session, config) {
  const { sport } = config;
  const stats = { seen: 0, filtered: 0 };
  updateJob(session, 'live', { status: 'running', stats });
  sessionLog(session, `▶ Pack feed: sport=${sport || 'all'}`);

  let cursor = null;
  while (!shouldStop(session, 'live')) {
    const qs = sport ? `?sport=${sport}` : '';
    const cursorQs = cursor ? `${qs ? '&' : '?'}cursor=${cursor}` : '';

    // confirmed: /livefeed/all/feed works
    const feedPaths = [
      `/livefeed/${sport || 'all'}/feed${qs}${cursorQs}`,
      `/livefeed/all/feed${cursorQs}`,
      `/packs/feed${qs}${cursorQs}`,
      `/activity/packs${qs}${cursorQs}`,
    ];

    let packs = [];
    for (const p of feedPaths) {
      try {
        const r = await rsCall(session, 'GET', p, null);
        if (r.ok) {
          packs  = Array.isArray(r.data) ? r.data : r.data?.packs || r.data?.items || r.data?.feed || [];
          cursor = r.data?.cursor || r.data?.nextCursor || null;
          if (packs.length > 0) break;
        }
      } catch(e) {}
    }

    for (const pack of packs) {
      stats.seen++;
      const playerName = pack.playerName || pack.name || pack.card?.playerName || 'Unknown';
      const rarity     = pack.rarity || pack.tier || '';
      const owner      = pack.username || pack.userName || pack.userId || '';
      sessionLog(session, `📦 ${playerName} (${rarity}) — opened by ${owner}`);
    }

    updateJob(session, 'live', { stats });
    await sleep(5000);
  }

  finishJob(session, 'live', stats, 'stopped');
}

// ─── LISTINGS ───────────────────────────────────────────────
async function runListings(session, config) {
  const { sport, season, minOwners, maxOwners, price } = config;
  const stats = { listed: 0, failed: 0 };
  updateJob(session, 'listings', { status: 'running', stats });
  sessionLog(session, `▶ Listings: sport=${sport}`);

  // Get user's un-listed cards (confirmed: /collecting/cards works)
  let cards = [];
  const cardPaths = [
    `/collecting/cards?sport=${sport}&listed=false&limit=500`,
    `/collecting/cards?sport=${sport}${season ? `&season=${season}` : ''}&limit=500`,
    `/collecting/${sport}/cards?season=${season || ''}&listed=false&limit=500`,
    `/users/me/cards?sport=${sport}&listed=false&limit=500`,
  ];
  for (const p of cardPaths) {
    try {
      const r = await rsCall(session, 'GET', p, null);
      if (r.ok) {
        cards = Array.isArray(r.data) ? r.data : r.data?.cards || r.data?.items || [];
        if (cards.length > 0) { sessionLog(session, `✅ Found ${cards.length} un-listed cards`); break; }
      }
    } catch(e) {}
  }

  if (cards.length === 0) {
    sessionLog(session, `✗ No un-listed cards found`);
    finishJob(session, 'listings', stats, 'error');
    return;
  }

  for (const card of cards) {
    if (shouldStop(session, 'listings')) break;
    const cardId = card.id || card.cardId;
    const askPrice = price || card.marketValue || card.value || 1;

    const listPaths = [
      { path: `/marketplace/listings`,     body: { cardId, sport, price: askPrice } },
      { path: `/marketplace`,              body: { cardId, sport, askingPrice: askPrice } },
      { path: `/listings`,                 body: { cardId, price: askPrice } },
    ];

    let done = false;
    for (const { path, body } of listPaths) {
      try {
        const r = await rsCall(session, 'POST', path, body);
        if (r.ok) {
          stats.listed++;
          sessionLog(session, `🏪 Listed ${card.playerName || card.id} for ${askPrice} Rax`);
          done = true;
          break;
        }
        if (r.status === 404) continue;
        break;
      } catch(e) {}
    }
    if (!done) stats.failed++;

    updateJob(session, 'listings', { stats });
    await sleep(800);
  }

  finishJob(session, 'listings', stats, shouldStop(session, 'listings') ? 'stopped' : 'done');
}

// ============================================================
//  START SERVER
// ============================================================
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   mybot — Real Sports Automation      ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║   Open: http://localhost:${PORT}          ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});

wss.on('connection', ws => {
  console.log('[WS] client connected');
  ws.on('close', () => console.log('[WS] client disconnected'));
});
