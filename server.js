// This app's server. Zero npm dependencies (it boots before, and without, any
// install), and it does three jobs:
//
//   1. Your JSON API: the `routes` table below. Data lives in lib/data via
//      lib/store.js; accounts via lib/auth.js.
//   2. The phone app. Expo Go opens exps://<this app>/.vibekit/expo/manifest
//      and downloads the latest build from here. PLATFORM CONTRACT: keep the
//      /.vibekit/expo/* handling as it is.
//   3. The web version of the same app, at this app's address.
//
// Builds are made by the platform on Deploy (never here): each one lands in
// dist/releases/<id>/, and dist/CURRENT names the live one. This server reads
// CURRENT on every request and then reads only inside that release folder,
// which never changes once written, so a deploy switches over in one step.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const auth = require('./lib/auth');
const CURRENT_SQUADS_2026_27 = require('./lib/data/current-squads-2026-27.json');

const PORT = process.env.PORT || 3000;
const DIST = path.join(__dirname, 'dist');
const RELEASES = path.join(DIST, 'releases');
const EXPO = '/.vibekit/expo';
const RELEASE_ID_RE = /^r\d{14}-[0-9a-f]{8}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// ── API routes ────────────────────────────────────────────────────────
// Key is "METHOD /path". Handlers get (req, res) and may be async.
const routes = {
  'GET /health': (req, res) => json(res, { status: 'ok', uptime: process.uptime(), release: currentRelease() }),

  'GET /api/game/catalog': (req, res) => json(res, GAME_CATALOG),
  'POST /api/game/estimate': async (req, res) => {
    const { shirtId, signature, matchUsedType, importance, match } = await readBody(req);
    const catalogShirt = GAME_CATALOG.flatMap((club) => club.shirts.map((shirt) => ({ ...shirt, league: club.league, team: club.team }))).find((shirt) => shirt.id === shirtId);
    if (!catalogShirt || !signature) return json(res, { error: 'Select a shirt and its version.' }, 400);
    const { league, team, player, kit } = catalogShirt;
    const query = `${player} ${team} ${kit} football shirt ${signature === 'Original' ? '' : signature}`.trim();
    const listing = await marketEstimate(query);
    const matchWorn = signature === 'Match used';
    const multiplier = matchWorn ? (importance === 'Very important' ? 18 : importance === 'Important' ? 8 : 4.5) : signature === 'Hand signed' ? 2.25 : signature === 'Print signed' ? 1.35 : 1;
    const star = /neymar|messi|ronaldo|mbappé|mbappe|lamine yamal/i.test(player);
    const floor = matchWorn ? (importance === 'Very important' ? (star ? 15000 : 6000) : importance === 'Important' ? (star ? 7000 : 2500) : (star ? 2500 : 650)) : signature === 'Hand signed' ? 175 : signature === 'Print signed' ? 85 : 20;
    const value = Math.max(floor, Math.round((listing.price || 55) * multiplier * (star && matchWorn ? 2.5 : 1)));
    const shirt = { id: crypto.randomUUID(), shirtId, league, team, player, kit, season: catalogShirt.season, signature, matchUsedType: matchWorn ? matchUsedType : '', importance: matchWorn ? importance : '', match: matchWorn ? String(match || '').trim().slice(0, 120) : '', value, marketSource: `${listing.source}${star && matchWorn ? ' · Icon-player match-worn premium' : ''}`, createdAt: new Date().toISOString() };
    store.write('collection', [shirt, ...store.read('collection')]);
    json(res, shirt, 201);
  },
  'GET /api/game/collection': (req, res) => json(res, store.read('collection')),
  'DELETE /api/game/collection': async (req, res) => {
    const { id } = await readBody(req);
    if (!id) return json(res, { error: 'Missing collection shirt id.' }, 400);
    store.write('collection', store.read('collection').filter((shirt) => shirt.id !== id));
    json(res, { ok: true });
  },
  'GET /api/shirts': (req, res) => {
    const shirts = store.read('shirts');
    json(res, shirts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  },
  'GET /api/shirts/stats': (req, res) => {
    const shirts = store.read('shirts');
    const byClub = shirts.reduce((groups, shirt) => {
      groups[shirt.club] = (groups[shirt.club] || 0) + 1;
      return groups;
    }, {});
    const bySeason = shirts.reduce((groups, shirt) => {
      groups[shirt.season] = (groups[shirt.season] || 0) + 1;
      return groups;
    }, {});
    json(res, { total: shirts.length, byClub, bySeason });
  },
  'GET /api/shirts/:id': () => {},
  'POST /api/shirts': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const club = String(body.club || '').trim();
    const season = String(body.season || '').trim();
    const condition = String(body.condition || '').trim();
    if (!name || !club || !season || !condition) return json(res, { error: 'Add a shirt name, club, season and condition.' }, 400);
    const shirt = {
      id: crypto.randomUUID(), name: name.slice(0, 80), club: club.slice(0, 80), season: season.slice(0, 24),
      condition: condition.slice(0, 30), photoUrl: String(body.photoUrl || '').trim().slice(0, 1000),
      notes: String(body.notes || '').trim().slice(0, 500), createdAt: new Date().toISOString(),
    };
    store.write('shirts', [shirt, ...store.read('shirts')]);
    json(res, shirt, 201);
  },
  'DELETE /api/shirts': async (req, res) => {
    const { id } = await readBody(req);
    if (!id) return json(res, { error: 'Missing shirt id.' }, 400);
    store.write('shirts', store.read('shirts').filter((shirt) => shirt.id !== id));
    json(res, { ok: true });
  },

  // Accounts (lib/auth.js). The app keeps the returned token (lib/api.ts).
  'POST /api/auth/signup': async (req, res) => {
    try { json(res, auth.signup(await readBody(req)), 201); } catch (e) { json(res, { error: e.message }, e.status || 400); }
  },
  'POST /api/auth/login': async (req, res) => {
    try { json(res, auth.login(await readBody(req))); } catch (e) { json(res, { error: e.message }, e.status || 401); }
  },
  'POST /api/auth/logout': (req, res) => { auth.logout(req); json(res, { ok: true }); },
  'GET /api/auth/me': (req, res) => {
    const user = auth.userFor(req);
    return user ? json(res, { user }) : json(res, { error: 'Not signed in' }, 401);
  },
};

// Officially listed squad data for the 2026/27 and 2025/26 seasons. A player
// appears only with the club they represented in the shirt's listed season.
const GAME_CATALOG = CURRENT_SQUADS_2026_27;

// Each added league has its complete club list. Every club gets a browsing roster
// and four collectible shirt eras per player, keeping the catalog rich without a
// multi-megabyte payload on a phone.
function makeExpandedCatalog() {
  const leagues = [
    ['EFL Championship', ['Birmingham City','Blackburn Rovers','Bolton Wanderers','Bristol City','Burnley','Cardiff City','Charlton Athletic','Derby County','Lincoln City','Middlesbrough','Millwall','Norwich City','Portsmouth','Preston North End','Queens Park Rangers','Sheffield United','Southampton','Stoke City','Swansea City','Watford','West Bromwich Albion','West Ham United','Wolverhampton Wanderers']],
    ['Eredivisie', ['Ajax','PSV Eindhoven','Feyenoord','AZ Alkmaar','FC Twente','FC Utrecht','Vitesse','SC Heerenveen','NEC Nijmegen','Sparta Rotterdam','Go Ahead Eagles','PEC Zwolle','Heracles Almelo','Willem II','NAC Breda','FC Groningen','Fortuna Sittard','RKC Waalwijk']],
    ['Primeira Liga', ['Benfica','Sporting CP','FC Porto','Braga','Vitória SC','Boavista','Casa Pia','Estoril','Famalicão','Farense','Arouca','Gil Vicente','Moreirense','Rio Ave','Nacional','Santa Clara','AVS','Estrela da Amadora']],
    ['Belgian Pro League', ['Club Brugge','Anderlecht','Genk','Royal Antwerp','Gent','Standard Liège','Union Saint-Gilloise','Charleroi','Mechelen','OH Leuven','Cercle Brugge','Kortrijk','Westerlo','Sint-Truiden','Dender','Beerschot']],
    ['Süper Lig', ['Galatasaray','Fenerbahçe','Beşiktaş','Trabzonspor','Başakşehir','Sivasspor','Kasımpaşa','Antalyaspor','Konyaspor','Kayserispor','Alanyaspor','Gaziantep FK','Rizespor','Göztepe','Samsunspor','Eyüpspor','Hatayspor','Adana Demirspor','Bodrum FK']],
    ['Scottish Premiership', ['Celtic','Rangers','Hearts','Hibernian','Aberdeen','Dundee United','Motherwell','Kilmarnock','St Mirren','Ross County','Dundee','St Johnstone']],
    ['Major League Soccer', ['Inter Miami','LA Galaxy','Los Angeles FC','Seattle Sounders','Portland Timbers','New York City FC','New York Red Bulls','Atlanta United','Columbus Crew','FC Cincinnati','Philadelphia Union','Orlando City','Toronto FC','CF Montréal','Chicago Fire','D.C. United','Charlotte FC','Nashville SC','Austin FC','FC Dallas','Houston Dynamo','Sporting Kansas City','Minnesota United','Real Salt Lake','Colorado Rapids','Vancouver Whitecaps','San Jose Earthquakes','St. Louis City']],
    ['Brasileirão Série A', ['Flamengo','Palmeiras','São Paulo','Corinthians','Santos','Fluminense','Botafogo','Vasco da Gama','Atlético Mineiro','Cruzeiro','Grêmio','Internacional','Bahia','Fortaleza','Athletico Paranaense','Bragantino','Juventude','Vitória','Cuiabá','Atlético Goianiense']],
    ['Argentine Primera División', ['River Plate','Boca Juniors','Racing Club','Independiente','San Lorenzo','Vélez Sarsfield','Estudiantes','Rosario Central','Newell’s Old Boys','Talleres','Belgrano','Lanús','Huracán','Argentinos Juniors','Defensa y Justicia','Godoy Cruz','Tigre','Banfield','Instituto','Unión']],
    ['Saudi Pro League', ['Al Hilal','Al Nassr','Al Ittihad','Al Ahli','Al Shabab','Al Ettifaq','Al Taawoun','Al Fateh','Al Raed','Al Fayha','Al Khaleej','Al Riyadh','Damac','Al Wehda','Al Okhdood','Al Kholood','Al Orubah','Al Qadsiah']]
  ];
  const players = ['Álvaro Morata','Antoine Griezmann','Lautaro Martínez','Rafael Leão','Victor Osimhen','Khvicha Kvaratskhelia','Jamal Musiala','Florian Wirtz','Ousmane Dembélé','Bradley Barcola','Nico Williams','Pedri','Federico Valverde','Jude Bellingham','Harry Kane','Michael Olise','Viktor Gyökeres','João Neves','Achraf Hakimi','Mike Maignan','Gianluigi Donnarumma','Thibaut Courtois'];
  const eras = [
    ['Home shirt','2026/27'], ['Away shirt','2026/27'], ['Home shirt','2025/26'], ['Away shirt','2025/26'], ['Third shirt','2024/25'], ['Retro home shirt','2004/05'], ['Classic away shirt','1996/97']
  ];
  const slug = (value) => value.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return leagues.flatMap(([league, teams]) => teams.map((team) => ({
    league, team,
    shirts: players.flatMap((player, playerIndex) => eras.map(([kit, season], eraIndex) => ({
      id: `${slug(league)}-${slug(team)}-${playerIndex}-${eraIndex}`, player, kit, season
    })))
  })));
}

async function marketEstimate(query) {
  try {
    const response = await fetch(`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&_sacat=0`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
    const html = await response.text();
    const prices = [...html.matchAll(/(?:US \$|\$)(\d{1,5}(?:\.\d{2})?)/g)].map((m) => Number(m[1])).filter((price) => price >= 15 && price <= 10000).slice(0, 20).sort((a, b) => a - b);
    if (prices.length) return { price: prices[Math.floor(prices.length / 2)], source: 'eBay listing median' };
  } catch { /* market lookup is best-effort */ }
  return { price: 55, source: 'Starter estimate — live listings unavailable' };
}

function json(res, data, status = 200, headers = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Parse a JSON request body: `const data = await readBody(req)`. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        tooLarge = true;
        raw = '';
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function safeDecode(p) {
  try { return decodeURIComponent(p); } catch { return null; }
}

// ── Releases (PLATFORM CONTRACT) ──────────────────────────────────────
/** The live release id, or null before the first deploy. */
function currentRelease() {
  try {
    const id = fs.readFileSync(path.join(DIST, 'CURRENT'), 'utf8').trim();
    return RELEASE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** A file inside a release, or null if the path would leave it. */
function releaseFile(id, rel) {
  const root = path.join(RELEASES, id);
  const file = path.join(root, rel);
  return file.startsWith(root + path.sep) ? file : null;
}

/** The address this request came in on. The platform passes the public host
 *  in X-Forwarded-Host (the Host header here is the container's own). */
function publicOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  const proto = String(req.headers['x-forwarded-proto'] || (local ? 'http' : 'https')).split(',')[0].trim();
  return { host, origin: `${proto}://${host}` };
}

const uuidFrom = (s) => {
  const h = crypto.createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function releaseTime(id) {
  const m = /^r(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(id);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
}

/**
 * The update manifest Expo Go asks for (expo-updates protocol 1). What each
 * rule is for, all learned on a real phone (docs/mobile-apps-plan.md):
 * - extra.scopeKey is required, or Expo Go refuses to parse the manifest. It
 *   is stable per app address, so the phone keeps this app's storage.
 * - the id is derived from the whole manifest, so ANY change is a new id:
 *   Expo Go caches by id, and a manifest fixed under an old id stays broken.
 * - asset URLs name the release, so a phone that fetched this manifest can
 *   still download them after the next deploy goes live.
 */
function buildManifest(req, platform) {
  const id = currentRelease();
  if (!id) return { status: 404, error: 'This app has not been built yet. Ask its agent to build it, then open it again.' };
  const meta = JSON.parse(fs.readFileSync(path.join(RELEASES, id, 'metadata.json'), 'utf8'));
  const cfg = JSON.parse(fs.readFileSync(path.join(RELEASES, id, 'expo-config.json'), 'utf8'));
  const fm = meta.fileMetadata && meta.fileMetadata[platform];
  if (!fm) return { status: 404, error: `This app has no ${platform} build.` };
  const runtime = `exposdk:${cfg.sdkVersion}`;
  const wants = req.headers['expo-runtime-version'];
  if (wants && wants !== runtime) {
    return { status: 404, error: `This app is built for Expo SDK ${cfg.sdkVersion}, and this Expo Go runs ${String(wants).replace('exposdk:', 'SDK ')}. Update Expo Go from the App Store.` };
  }
  const { host, origin } = publicOrigin(req);
  const asset = (rel, ext, isLaunch) => {
    const buf = fs.readFileSync(path.join(RELEASES, id, rel));
    return {
      hash: b64url(crypto.createHash('sha256').update(buf).digest()),
      key: crypto.createHash('md5').update(buf).digest('hex'),
      fileExtension: isLaunch ? '.bundle' : `.${ext}`,
      contentType: isLaunch ? 'application/javascript' : (MIME[`.${ext}`] || 'application/octet-stream'),
      url: `${origin}${EXPO}/r/${id}/${rel}`,
    };
  };
  const body = {
    runtimeVersion: runtime,
    launchAsset: asset(fm.bundle, 'js', true),
    assets: fm.assets.map((a) => asset(a.path, a.ext, false)),
    metadata: {},
    extra: {
      expoClient: { ...cfg, runtimeVersion: runtime, extra: { ...(cfg.extra || {}), apiOrigin: origin } },
      scopeKey: `@anonymous/${cfg.slug}-${uuidFrom(`scope:${host}`)}`,
      eas: {},
    },
  };
  const manifest = { id: uuidFrom(JSON.stringify(body) + platform), createdAt: releaseTime(id), ...body };
  if (!manifest.launchAsset.url || !manifest.extra.scopeKey || !manifest.extra.expoClient.sdkVersion) {
    return { status: 500, error: 'This build is incomplete. Deploy it again.' };
  }
  return { status: 200, manifest };
}

function serveManifest(req, res, url) {
  const common = { 'expo-protocol-version': '1', 'expo-sfv-version': '0', 'Cache-Control': 'private, max-age=0' };
  const platform = req.headers['expo-platform'] || url.searchParams.get('platform') || 'ios';
  const r = buildManifest(req, platform === 'android' ? 'android' : 'ios');
  if (r.status !== 200) return json(res, { error: r.error, message: r.error }, r.status, common);
  const body = JSON.stringify(r.manifest);
  if (/multipart\/mixed/.test(req.headers.accept || '')) {
    const b = `vk${crypto.randomBytes(8).toString('hex')}`;
    const part = (name, content) => `--${b}\r\ncontent-disposition: form-data; name="${name}"\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${content}\r\n`;
    const out = part('manifest', body) + part('extensions', JSON.stringify({ assetRequestHeaders: {} })) + `--${b}--\r\n`;
    res.writeHead(200, { ...common, 'Content-Type': `multipart/mixed; boundary=${b}` });
    return res.end(out);
  }
  res.writeHead(200, { ...common, 'Content-Type': 'application/json' });
  res.end(body);
}

function serveReleaseAsset(res, id, rel) {
  if (!RELEASE_ID_RE.test(id)) return json(res, { error: 'Not found' }, 404);
  const file = releaseFile(id, rel);
  if (!file) return json(res, { error: 'Not found' }, 404);
  fs.readFile(file, (err, data) => {
    if (err) return json(res, { error: 'Not found' }, 404);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(data);
  });
}

const BUILDING_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Building…</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px -apple-system,system-ui,sans-serif;background:#0f0f14;color:#e8e8f0;text-align:center;padding:24px}p{color:#9a9ab0}</style></head>
<body><div><h1>First build in progress</h1><p>This app appears here, and on your phone in Expo Go, once its first version is built.</p></div></body></html>`;

/** The web version: files from the live release, index.html for app routes. */
function serveWeb(req, res, pathname) {
  const id = currentRelease();
  if (!id) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(BUILDING_PAGE);
  }
  const decoded = pathname === '/' ? 'index.html' : safeDecode(pathname);
  if (decoded === null) return json(res, { error: 'Bad request' }, 400);
  const rel = decoded.replace(/^\/+/, '');
  // The build's own bookkeeping is not part of the website.
  if (rel === 'metadata.json' || rel === 'expo-config.json') return json(res, { error: 'Not found' }, 404);
  const file = releaseFile(id, rel);
  if (!file) return json(res, { error: 'Not found' }, 404);
  fs.readFile(file, (err, data) => {
    if (!err) {
      const immutable = rel.startsWith('_expo/static/') || rel.startsWith('assets/');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
      return res.end(data);
    }
    if (path.extname(rel)) return json(res, { error: 'Not found' }, 404);
    fs.readFile(path.join(RELEASES, id, 'index.html'), (e, html) => {
      if (e) return json(res, { error: 'Not found' }, 404);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
    });
  });
}

http.createServer(async (req, res) => {
  let pathname = req.url || '/';
  try {
    const url = new URL(req.url, 'http://localhost');
    pathname = url.pathname;
    const handler = routes[`${req.method} ${pathname}`];
    if (handler) return await handler(req, res);
    if (pathname === `${EXPO}/manifest`) return serveManifest(req, res, url);
    if (pathname.startsWith(`${EXPO}/r/`)) {
      const rest = safeDecode(pathname.slice(`${EXPO}/r/`.length));
      if (rest === null) return json(res, { error: 'Bad request' }, 400);
      const slash = rest.indexOf('/');
      if (slash < 1) return json(res, { error: 'Not found' }, 404);
      return serveReleaseAsset(res, rest.slice(0, slash), rest.slice(slash + 1));
    }
    if (pathname.startsWith(`${EXPO}/`) || pathname.startsWith('/api/')) return json(res, { error: 'Not found' }, 404);
    serveWeb(req, res, pathname);
  } catch (err) {
    console.error(`${req.method} ${pathname} failed:`, err.message);
    if (res.headersSent) return;
    if (err.status === 413) json(res, { error: 'Too large: the limit is 10 MB.' }, 413);
    else if (err.status === 400) json(res, { error: err.message }, 400);
    else json(res, { error: 'Server error' }, 500);
  }
}).listen(PORT, () => console.log(`Listening on port ${PORT}`));
