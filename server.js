// Singapore traffic-aware route planner
// - Candidate routes: OSRM (public demo server; swap for your own instance in production)
// - Live traffic:     LTA DataMall TrafficSpeedBands (v3) + TrafficIncidents
// - Geocoding:        OneMap search (no token needed)
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const KEY = process.env.LTA_API_KEY;
if (!KEY) { console.error('Missing LTA_API_KEY. Run:  LTA_API_KEY=xxxx node server.js'); process.exit(1); }

const LTA = 'https://datamall2.mytransport.sg/ltaodataservice';
const OSRM = process.env.OSRM_URL || 'https://router.project-osrm.org';

async function lta(path) {
  const r = await fetch(LTA + path, { headers: { AccountKey: KEY, accept: 'application/json' } });
  if (!r.ok) throw new Error(`LTA ${r.status} on ${path}`);
  return (await r.json()).value || [];
}

// Cache with in-flight de-duplication; serves stale data if a refresh fails.
function cached(ttlMs, fn) {
  let data = null, at = 0, pending = null;
  return async () => {
    if (data && Date.now() - at < ttlMs) return data;
    if (!pending) pending = fn().then(d => { data = d; at = Date.now(); return d; }).finally(() => { pending = null; });
    try { return await pending; } catch (e) { if (data) return data; throw e; }
  };
}

/* ---------- Speed band spatial index ---------- */
const CELL = 0.0005; // ~55 m
const cellKey = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;

function buildIndex(raw) {
  const links = [], grid = new Map();
  for (const r of raw) {
    let x1 = +r.StartLon, y1 = +r.StartLat, x2 = +r.EndLon, y2 = +r.EndLat;
    if (r.Location) { // newer versions: "lat1 lon1 lat2 lon2"
      const [la1, lo1, la2, lo2] = String(r.Location).trim().split(/\s+/).map(Number);
      x1 = lo1; y1 = la1; x2 = lo2; y2 = la2;
    }
    if (![x1, y1, x2, y2].every(Number.isFinite) || (x1 === 0 && y1 === 0)) continue;
    const band = +r.SpeedBand, min = +r.MinimumSpeed, max = +r.MaximumSpeed;
    const speed = band >= 8 ? Math.max(min, 70) : Math.max(5, (min + max) / 2); // km/h
    const idx = links.length;
    links.push({ x1, y1, x2, y2, band, speed, road: r.RoadName });
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) / CELL));
    for (let i = 0; i <= n; i++) {
      const k = cellKey(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n);
      let arr = grid.get(k); if (!arr) grid.set(k, arr = []);
      if (arr[arr.length - 1] !== idx) arr.push(idx);
    }
  }
  return { links, grid, loadedAt: Date.now() };
}

// LTA has versioned this endpoint over time; use whichever one answers for your key.
const BAND_PATHS = ['/v4/TrafficSpeedBands', '/v4/TrafficSpeedBands', '/v2/TrafficSpeedBands', '/TrafficSpeedBands'];
let bandPath = null;

async function detectBandPath() {
  if (bandPath) return bandPath;
  const errors = [];
  for (const p of BAND_PATHS) {
    const r = await fetch(LTA + p + '?$skip=0', { headers: { AccountKey: KEY, accept: 'application/json' } });
    if (r.ok) { console.log('Using LTA endpoint', p); return (bandPath = p); }
    errors.push(`${p} -> ${r.status}`);
    if (r.status === 401 || r.status === 403) throw new Error(`LTA rejected the AccountKey (${r.status}). Check LTA_API_KEY.`);
  }
  throw new Error('No TrafficSpeedBands endpoint worked: ' + errors.join(', '));
}

const getBands = cached(5 * 60 * 1000, async () => {   // LTA refreshes every ~5 min
  const path = await detectBandPath();
  const raw = [], BATCH = 8;
  for (let skip = 0; ; skip += 500 * BATCH) {
    const pages = await Promise.all(Array.from({ length: BATCH }, (_, i) => lta(`${path}?$skip=${skip + i * 500}`)));
    let done = false;
    for (const p of pages) { raw.push(...p); if (p.length < 500) done = true; }
    if (done) break;
  }
  const idx = buildIndex(raw);
  console.log(`Loaded ${raw.length} speed band records, ${idx.links.length} usable`);
  if (raw.length && !idx.links.length) console.error('Unexpected record format:', JSON.stringify(raw[0]));
  return idx;
});

const getIncidents = cached(2 * 60 * 1000, async () =>
  (await lta('/TrafficIncidents')).map(i => ({ type: i.Type, lat: +i.Latitude, lon: +i.Longitude, message: i.Message })));

// Find the live link closest to a route segment, matching direction of travel.
function matchLink(index, lon, lat, vx, vy) {
  const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  const vlen = Math.hypot(vx, vy);
  let best = null, bestD = 40; // metres
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const arr = index.grid.get(`${cx + dx},${cy + dy}`); if (!arr) continue;
    for (const i of arr) {
      const L = index.links[i];
      const ax = (L.x1 - lon) * kx, ay = (L.y1 - lat) * ky, bx = (L.x2 - lon) * kx, by = (L.y2 - lat) * ky;
      const sx = bx - ax, sy = by - ay, len2 = sx * sx + sy * sy;
      if (len2 < 1) continue;
      if (vlen > 1 && (sx * vx + sy * vy) / (Math.sqrt(len2) * vlen) < 0.5) continue; // opposite carriageway
      const t = Math.max(0, Math.min(1, -(ax * sx + ay * sy) / len2));
      const d = Math.hypot(ax + t * sx, ay + t * sy);
      if (d < bestD) { bestD = d; best = L; }
    }
  }
  return best;
}

const INCIDENT_PENALTY_SEC = { 'Road Block': 300, Accident: 120, 'Vehicle Breakdown': 60, 'Road Works': 45, Obstacle: 45 };

function scoreRoute(route, index, incidents) {
  const coords = route.geometry.coordinates, ann = route.legs[0].annotation;
  let base = 0, live = 0, matched = 0, total = 0;
  const segments = []; let cur = null;

  for (let i = 0; i < coords.length - 1; i++) {
    const [x1, y1] = coords[i], [x2, y2] = coords[i + 1];
    const dist = ann.distance[i], dur = ann.duration[i];
    base += dur; total += dist;
    let band = 0, adj = dur;
    if (dist > 0.5 && dur > 0) {
      const kx = 111320 * Math.cos(y1 * Math.PI / 180);
      const L = matchLink(index, (x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) * kx, (y2 - y1) * 110540);
      if (L) {
        band = L.band; matched += dist;
        const osrmKmh = dist / dur * 3.6;
        if (L.speed < osrmKmh) adj = dur * osrmKmh / L.speed; // only ever slow down vs free-flow
      }
    }
    live += adj;
    if (cur && cur.band === band) cur.coords.push([y2, x2]);
    else segments.push(cur = { band, coords: [[y1, x1], [y2, x2]] });
  }

  // Incidents within ~100 m of the route
  const hits = [];
  for (const inc of incidents) {
    const kx = 111320 * Math.cos(inc.lat * Math.PI / 180);
    for (let i = 0; i < coords.length; i += 2) {
      if (Math.hypot((coords[i][0] - inc.lon) * kx, (coords[i][1] - inc.lat) * 110540) < 100) {
        hits.push(inc); live += INCIDENT_PENALTY_SEC[inc.type] ?? 30; break;
      }
    }
  }

  // "via" label: the two longest named steps
  const byRoad = {};
  for (const s of route.legs[0].steps) if (s.name) byRoad[s.name] = (byRoad[s.name] || 0) + s.distance;
  const via = Object.entries(byRoad).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);

  return {
    via, distanceKm: total / 1000,
    baseSec: Math.round(base), liveSec: Math.round(live),
    coverage: total ? matched / total : 0, segments, incidents: hits
  };
}

/* ---------- API ---------- */
// Serve the web app files. Works whether they sit in ./public (normal) or
// directly in the project root (e.g. if a GitHub upload flattened the folders).
// Only this fixed list of files is ever served, so server.js and .env stay private.
const fs = require('fs');
const path = require('path');
const WEB_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']);
function findWebFile(name) {
  if (!WEB_FILES.has(name)) return null;
  for (const dir of ['public', 'public/icons', 'icons', '.']) {
    const f = path.join(__dirname, dir, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const sendWeb = (name) => (req, res) => {
  const f = findWebFile(name);
  if (!f) return res.status(404).send('File not found on server: ' + name + '. Check that it was uploaded to GitHub.');
  res.sendFile(f);
};
app.get(['/', '/index.html'], sendWeb('index.html'));
app.get('/manifest.webmanifest', sendWeb('manifest.webmanifest'));
app.get('/sw.js', sendWeb('sw.js'));
app.get('/icons/:name', (req, res) => sendWeb(req.params.name)(req, res));

app.get('/api/incidents', async (req, res) => {
  try { res.json(await getIncidents()); } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/geocode', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim(); if (q.length < 2) return res.json([]);
    const r = await fetch(`https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`);
    const j = await r.json();
    res.json((j.results || []).slice(0, 6).map(x => ({
      label: x.SEARCHVAL, address: x.ADDRESS, lat: +x.LATITUDE, lon: +x.LONGITUDE })));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/route', async (req, res) => {
  try {
    const { fromLat, fromLon, toLat, toLon } = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, +v]));
    if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)) return res.status(400).json({ error: 'Invalid coordinates' });

    const url = `${OSRM}/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}` +
      `?alternatives=3&overview=full&geometries=geojson&annotations=distance,duration&steps=true`;
    const [osrmRes, index, incidents] = await Promise.all([fetch(url), getBands(), getIncidents().catch(() => [])]);
    const o = await osrmRes.json();
    if (o.code !== 'Ok') return res.status(404).json({ error: 'No route found' });

    const scored = o.routes.map(r => scoreRoute(r, index, incidents));
    const usualLive = scored[0].liveSec; // OSRM's default pick, re-timed with live traffic
    const routes = scored.map((r, i) => ({ ...r, isDefault: i === 0 }))
      .sort((a, b) => a.liveSec - b.liveSec)
      .map((r, i) => ({ ...r, fastest: i === 0, delaySec: r.liveSec - r.baseSec, savedVsDefaultSec: usualLive - r.liveSec }));

    res.json({ routes, trafficUpdatedAt: index.loadedAt });
  } catch (e) { console.error(e); res.status(502).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  getBands().catch(e => console.error('Initial speed band load failed:', e.message)); // warm cache
});
