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
    const { league, team, player, kit, season } = catalogShirt;
    const query = `${player} ${team} ${kit} football shirt ${signature === 'Original' ? '' : signature}`.trim();
    const listing = await marketEstimate(query);
    const matchWorn = signature === 'Match used';
    const value = estimateShirtValue({ player, signature, matchUsedType, importance, base: listing.price || 55, season, match });
    const shirt = { id: crypto.randomUUID(), shirtId, league, team, player, kit, season: catalogShirt.season, signature, matchUsedType: matchWorn ? matchUsedType : '', importance: matchWorn ? importance : '', match: matchWorn ? String(match || '').trim().slice(0, 120) : '', value, marketSource: `${listing.source}${matchWorn ? ' · player, competition and occasion premium applied' : ''}`, createdAt: new Date().toISOString() };
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
const GAME_CATALOG = mergeCatalog(CURRENT_SQUADS_2026_27.concat(makeIconicArchive(), makeNationalTeams()));
function mergeCatalog(clubs) {
  const merged = new Map();
  for (const club of clubs) { const key = `${club.league}|${club.team}`; if (!merged.has(key)) merged.set(key, { league: club.league, team: club.team, shirts: [] }); merged.get(key).shirts.push(...club.shirts); }
  return [...merged.values()];
}

function playerTier(player) {
  if (/^(Lionel Messi|Cristiano Ronaldo|Neymar|Kylian Mbappé|Kylian Mbappe|Lamine Yamal|Jude Bellingham)$/i.test(player)) return 10;
  if (/^(Erling Haaland|Vinícius Júnior|Vinicius Junior|Mohamed Salah|Harry Kane|Robert Lewandowski|Kevin De Bruyne|Karim Benzema)$/i.test(player)) return 7;
  return 1;
}
function estimateShirtValue({ player, signature, matchUsedType, importance, base, season, match }) {
  // Special rule: Messi's iconic 2017 Barca vs Madrid home shirt worth 400k only when exact phrase entered
  const momentPhrase = (match || '').toLowerCase();
  const isExactMoment = momentPhrase.includes('barca vs madrid classic') && momentPhrase.includes('messi shirt');
  if (player === 'Lionel Messi' && signature === 'Match used' && season && season.startsWith('2017') && kit.toLowerCase().includes('home') && isExactMoment) {
    return 400000;
  }
  if (signature !== 'Match used') {
    return Math.max(signature === 'Hand signed' ? 175 : signature === 'Print signed' ? 85 : 20, Math.round(base * (signature === 'Hand signed' ? 2.25 : signature === 'Print signed' ? 1.35 : 1)));
  }
  const tier = playerTier(player);
  const competition = { 'Club friendly': 1, 'League match': 4, 'Cup match': 7, 'Champions League match': 13, 'International match': 11 }[matchUsedType] || 4;
  const occasion = { 'Not important': 1, 'Little important': 1.8, 'Important': 3, 'Rivalry': 5.5, 'Really important': 8 }[importance] || 1;
  const floor = Math.round(450 * competition * occasion * (1 + tier * 0.45));
  return Math.max(floor, Math.round(base * competition * occasion * (1 + tier * 0.45)));
}
function makeIconicArchive() {
  const careers = [
    ['Lionel Messi','Barcelona','La Liga',2004,2024],['Lionel Messi','Paris Saint-Germain','Ligue 1',2021,2023],['Lionel Messi','Inter Miami','Major League Soccer',2023,2025],
    ['Cristiano Ronaldo','Sporting CP','Primeira Liga',2002,2003],['Cristiano Ronaldo','Manchester United','Premier League',2003,2009],['Cristiano Ronaldo','Real Madrid','La Liga',2009,2018],['Cristiano Ronaldo','Juventus','Serie A',2018,2021],['Cristiano Ronaldo','Al Nassr','Saudi Pro League',2023,2025],
    ['Neymar','Santos','Brasileirão Série A',2009,2013],['Neymar','Barcelona','La Liga',2013,2017],['Neymar','Paris Saint-Germain','Ligue 1',2017,2023],['Neymar','Al Hilal','Saudi Pro League',2023,2025],
    ['Kylian Mbappé','Monaco','Ligue 1',2015,2017],['Kylian Mbappé','Paris Saint-Germain','Ligue 1',2017,2024],['Kylian Mbappé','Real Madrid','La Liga',2024,2025],
    ['Erling Haaland','Borussia Dortmund','Bundesliga',2020,2024],['Erling Haaland','Manchester City','Premier League',2022,2025],
    ['Lamine Yamal','Barcelona','La Liga',2023,2025],['Zinedine Zidane','Juventus','Serie A',1996,2001],['Zinedine Zidane','Real Madrid','La Liga',2001,2006],['Thierry Henry','Arsenal','Premier League',1999,2007],['Ronaldinho','Barcelona','La Liga',2003,2008],
    ['Xavi','Barcelona','La Liga',1998,2015],['Andrés Iniesta','Barcelona','La Liga',2002,2018],['Carles Puyol','Barcelona','La Liga',1999,2014],['Samuel Eto’o','Barcelona','La Liga',2004,2009],['Luis Suárez','Barcelona','La Liga',2014,2020],['Rivaldo','Barcelona','La Liga',1997,2002],
    ['Raúl','Real Madrid','La Liga',1994,2010],['Iker Casillas','Real Madrid','La Liga',1999,2015],['Sergio Ramos','Real Madrid','La Liga',2005,2021],['Luka Modrić','Real Madrid','La Liga',2012,2024],['David Beckham','Real Madrid','La Liga',2003,2007],
    ['Wayne Rooney','Manchester United','Premier League',2004,2017],['Ryan Giggs','Manchester United','Premier League',1990,2014],['Paul Scholes','Manchester United','Premier League',1993,2013],['David Beckham','Manchester United','Premier League',1992,2003],
    ['Steven Gerrard','Liverpool','Premier League',1998,2015],['Fernando Torres','Liverpool','Premier League',2007,2011],['Jamie Carragher','Liverpool','Premier League',1997,2013],['Frank Lampard','Chelsea','Premier League',2001,2014],['Didier Drogba','Chelsea','Premier League',2004,2012],['John Terry','Chelsea','Premier League',1998,2015],
    ['Francesco Totti','Roma','Serie A',1993,2017],['Alessandro Del Piero','Juventus','Serie A',1993,2012],['Paolo Maldini','AC Milan','Serie A',1985,2009],['Kaká','AC Milan','Serie A',2003,2009],['Javier Zanetti','Inter Milan','Serie A',1995,2014],['Diego Maradona','Napoli','Serie A',1984,1991],
    ['Franz Beckenbauer','Bayern Munich','Bundesliga',1964,1977],['Philipp Lahm','Bayern Munich','Bundesliga',2002,2017],['Bastian Schweinsteiger','Bayern Munich','Bundesliga',2002,2015],['Thomas Müller','Bayern Munich','Bundesliga',2008,2024],['Marco Reus','Borussia Dortmund','Bundesliga',2012,2024],
    ['Zlatan Ibrahimović','Paris Saint-Germain','Ligue 1',2012,2016],['Thiago Silva','Paris Saint-Germain','Ligue 1',2012,2020],['David Ginola','Paris Saint-Germain','Ligue 1',1992,1995]
  ];
  const clubs = new Map();
  for (const [player, team, league, from, to] of careers) for (let year = from; year < to; year++) {
    const key = `${league}|${team}`; if (!clubs.has(key)) clubs.set(key, { league, team, shirts: [] });
    for (const kit of ['Home shirt','Away shirt','Third shirt']) clubs.get(key).shirts.push({ id: `icon-${player}-${team}-${year}-${kit}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), player, kit, season: `${year}/${String(year + 1).slice(-2)}` });
  }
  return [...clubs.values()];
}
function makeNationalTeams() {
  const nationalTeamData = [
    {
      country: 'Argentina',
      recent: ['Lionel Messi', 'Ángel Di María', 'Leandro Paredes'],
      historical2010: ['Lionel Messi', 'Carlos Tévez', 'Gonzalo Higuaín'],
      historical2002: ['Juan Román Riquelme', 'Roberto Ayala', 'Javier Zanetti']
    },
    {
      country: 'Brazil',
      recent: ['Neymar', 'Vinícius Júnior', 'Raphinha'],
      historical2010: ['Neymar', 'Lúcio', 'Juan'],
      historical2002: ['Ronaldo', 'Ronaldinho', 'Kaká']
    },
    {
      country: 'France',
      recent: ['Kylian Mbappé', 'Antoine Griezmann', 'Aurélien Tchouaméni'],
      historical2010: ['Thierry Henry', 'Nicolas Anelka', 'Franck Ribéry'],
      historical2002: ['Zinedine Zidane', 'Thierry Henry', 'David Trezeguet']
    },
    {
      country: 'Spain',
      recent: ['Lamine Yamal', 'Pedri', 'Gavi'],
      historical2010: ['Xavi Hernández', 'Andrés Iniesta', 'David Villa'],
      historical2002: ['Raúl González', 'Iker Casillas', 'Fernando Torres']
    },
    {
      country: 'Germany',
      recent: ['Jamal Musiala', 'Florian Wirtz', 'Kai Havertz'],
      historical2010: ['Thomas Müller', 'Bastian Schweinsteiger', 'Philipp Lahm'],
      historical2002: ['Michael Ballack', 'Oliver Kahn', 'Miroslav Klose']
    },
    {
      country: 'Italy',
      recent: ['Lautaro Martínez', 'Nicola Zalewski', 'Gianluigi Donnarumma'],
      historical2010: ['Francesco Totti', 'Daniele De Rossi', 'Andrea Pirlo'],
      historical2002: ['Alessandro Nesta', 'Fabio Cannavaro', 'Francesco Totti']
    },
    {
      country: 'England',
      recent: ['Harry Kane', 'Phil Foden', 'Declan Rice'],
      historical2010: ['Wayne Rooney', 'Frank Lampard', 'Steven Gerrard'],
      historical2002: ['David Beckham', 'Michael Owen', 'Rio Ferdinand']
    },
    {
      country: 'Netherlands',
      recent: ['Cody Gakpo', 'Xavi Simons', 'Virgil van Dijk'],
      historical2010: ['Arjen Robben', 'Robin van Persie', 'Wesley Sneijder'],
      historical2002: ['Patrick Kluivert', 'Ruud van Nistelrooy', 'Edgar Davids']
    },
    {
      country: 'Belgium',
      recent: ['Kevin De Bruyne', 'Romelu Lukaku', 'Youri Tielemans'],
      historical2010: ['Vincent Kompany', 'Marouane Fellaini', 'Eden Hazard'],
      historical2002: ['Marc Wilmots', 'Daniel Van Buyten', 'Jan Koller']
    },
    {
      country: 'Uruguay',
      recent: ['Darwin Núñez', 'Federico Valverde', 'Rodrigo Bentancur'],
      historical2010: ['Diego Forlán', 'Luis Suárez', 'Edinson Cavani'],
      historical2002: ['Diego Forlán', 'Alvaro Recoba', 'Paolo Montero']
    },
    {
      country: 'Croatia',
      recent: ['Luka Modrić', 'Marcelo Brozović', 'Domagoj Vida'],
      historical2010: ['Luka Modrić', 'Ivan Rakitić', 'Dario Šimić'],
      historical2002: ['Robert Kovač', 'Darijo Srna', 'Ivan Klasnić']
    },
    {
      country: 'Colombia',
      recent: ['Luis Díaz', 'James Rodríguez', 'Rafael Santos'],
      historical2010: ['Radamel Falcao', 'James Rodríguez', 'Mario Yepes'],
      historical2002: ['Faustino Asprilla', 'Ivan Córdoba', 'Humberto Mendoza']
    },
    {
      country: 'Mexico',
      recent: ['Hirving Lozano', 'Raúl Jiménez', 'Édson Álvarez'],
      historical2010: ['Javier Hernández', 'Cuauhtémoc Blanco', 'Pavel Pardo'],
      historical2002: ['Jared Borgetti', 'Luis Hernández', 'Carlos Pavón']
    },
    {
      country: 'United States',
      recent: ['Christian Pulisic', 'Weston McKennie', 'Giovanni Reyna'],
      historical2010: ['Landon Donovan', 'Clint Dempsey', 'Tim Howard'],
      historical2002: ['Claudio Reyna', 'Brian McBride', 'Eddie Johnson']
    },
    {
      country: 'Japan',
      recent: ['Takefusa Kubo', 'Daichi Kamada', 'Yusaku Mitake'],
      historical2010: ['Keisuke Honda', 'Shunsuke Nakamura', 'Yoshito Ōkubo'],
      historical2002: ['Hidetoshi Nakata', 'Atsushi Yanagisawa', 'Takayuki Suzuki']
    },
    {
      country: 'South Korea',
      recent: ['Son Heung-min', 'Hwang Hee-chan', 'Lee Kang-in'],
      historical2010: ['Park Ji-sung', 'Lee Chun-soo', 'Ahn Jung-hwan'],
      historical2002: ['Park Ji-sung', 'Lee Young-pyo', 'Ahn Jung-hwan']
    },
    {
      country: 'Australia',
      recent: ['Mathew Leckie', 'Aaron Mooy', 'Daniel Arzani'],
      historical2010: ['Tim Cahill', 'Brett Holman', 'Mark Bresciano'],
      historical2002: ['Harry Kewell', 'Mark Viduka', 'Craig Moore']
    },
    {
      country: 'Morocco',
      recent: ['Achraf Hakimi', 'Youssef En-Nesyri', 'Sofyan Amrabat'],
      historical2010: ['Bouchaib El Moubarki', 'Youssef Mokhtari', 'Abdelmajid Dolmy'],
      historical2002: ['Mustapha Hadji', 'Youssef Mokhtari', 'Nourredine Naybet']
    },
    {
      country: 'Nigeria',
      recent: ['Victor Osimhen', 'Samuel Chukwueze', 'Wilfred Ndidi'],
      historical2010: ['Nwankwo Kanu', 'Joseph Yobo', 'Obafemi Martins'],
      historical2002: ['Nwankwo Kanu', 'Finidi George', 'Jay-Jay Okocha']
    },
    {
      country: 'Senegal',
      recent: ['Sadio Mané', 'Ismaila Sarr', 'Kalidou Koulibaly'],
      historical2010: ['Henri Camara', 'Tony Sylva', 'Fadiga'],
      historical2002: ['Henri Camara', 'Tony Sylva', 'Fadiga']
    },
    {
      country: 'Cameroon',
      recent: ['André Onana', 'Karl Toko Ekambi', 'Vincent Aboubakar'],
      historical2010: ['Samuel Eto\'o', 'Pierre Womé', 'Rigobert Song'],
      historical2002: ['Samuel Eto\'o', 'Pierre Womé', 'Rigobert Song']
    },
    {
      country: 'Ghana',
      recent: ['Thomas Partey', 'Mohammed Kudus', 'Inaki Williams'],
      historical2010: ['Michael Essien', 'Asamoah Gyan', 'John Paintsil'],
      historical2002: ['Abedi Pelé', 'Stephen Appiah', 'John Paintsil']
    },
    {
      country: 'Egypt',
      recent: ['Mohamed Salah', 'Mohamed El-Shenawy', 'Ahmed Hegazi'],
      historical2010: ['Mohamed Aboutrika', 'Hossam Hassan', 'Emad Moteab'],
      historical2002: ['Hossam Hassan', 'Abdel Zaher El Sakka', 'Hassan Mostafa']
    },
    {
      country: 'Algeria',
      recent: ['Riyad Mahrez', 'Ismaël Bennacer', 'Youcef Belaïli'],
      historical2010: ['Karim Ziani', 'Rafik Saïfi', 'Yazid Mansouri'],
      historical2002: ['Abdelmalek Cherrad', 'Ali Benarbia', 'Liamine Cherifi']
    },
    {
      country: 'Ivory Coast',
      recent: ['Franck Kessié', 'Nicolas Pépé', 'Max Gradel'],
      historical2010: ['Didier Drogba', 'Yaya Touré', 'Kolo Touré'],
      historical2002: ['Didier Drogba', 'Yaya Touré', 'Kolo Touré']
    },
    {
      country: 'South Africa',
      recent: ['Percy Tau', 'Teboho Mokoena', 'Gordon'],
      historical2010: ['Steven Pienaar', 'Aaron Mokoena', 'MacBeth Sibaya'],
      historical2002: ['Benni McCarthy', 'Quinton Fortune', 'Pierre Issa']
    },
    {
      country: 'Tunisia',
      recent: ['Wahbi Khazri', 'Youssef Msakni', 'Dylan Bronn'],
      historical2010: ['Radhi Jaïdi', 'Youssef Msakni', 'Khaled Badra'],
      historical2002: ['Radhi Jaïdi', 'Kaïs Ghodhbane', 'Ferid Chougab']
    },
    {
      country: 'Iran',
      recent: ['Sardar Azmoun', 'Mehdi Taremi', 'Ali Gholizadeh'],
      historical2010: ['Ali Daei', 'Javad Nekounam', 'Mehdi Mahdavikia'],
      historical2002: ['Ali Daei', 'Karim Bagheri', 'Mehdi Mahdavikia']
    },
    {
      country: 'Saudi Arabia',
      recent: ['Salem Al-Dawsari', 'Fahad Al-Muwallad', 'Yahya Al-Shehri'],
      historical2010: ['Yasser Al-Qahtani', 'Mohammed Noor', 'Taisir Al-Jassim'],
      historical2002: ['Sami Al-Jaber', 'Naser Al-Shamrani', 'Omar Al-Ghamdi']
    },
    {
      country: 'Qatar',
      recent: ['Akram Afif', 'Almoez Ali', 'Mohamed Muntashim'],
      historical2010: ['José Carlos Fernández', 'Magid Mohamed', 'Abdulaziz Karim'],
      historical2002: ['Mubarak Mustafa', 'Younis Ahmed', 'Ali Ahmed']
    },
    {
      country: 'United Arab Emirates',
      recent: ['Ali Mabkhout', 'Sebastián Tagliabúe', 'Ali Al-Hofi'],
      historical2010: ['Adnan Al Talyani', 'Khalid Ismaeel', 'Mahmoud Khalil'],
      historical2002: ['Adnan Al Talyani', 'Khalid Ismaeel', 'Mahmoud Khalil']
    },
    {
      country: 'Turkey',
      recent: ['Hakan Çalhanoğlu', 'Cengiz Ünder', 'Okay Yokuşlu'],
      historical2010: ['Hakan Şükür', 'Emre Belözoğlu', 'Tunçay'],
      historical2002: ['Hakan Şükür', 'Emre Belözoğlu', 'Tunçay']
    },
    {
      country: 'Greece',
      recent: ['Anastasios Bakasetas', 'Giorgos Masouras', 'Dimitris Bowzikidis'],
      historical2010: ['Angelos Basinas', 'Theodoros Zagorakis', 'Vangelis Moras'],
      historical2002: ['Angelos Basinas', 'Theodoros Zagorakis', 'Vangelis Moras']
    },
    {
      country: 'Sweden',
      recent: ['Alexander Isak', 'Dejan Kulusevski', 'Robin Olsen'],
      historical2010: ['Zlatan Ibrahimović', 'Christian Wilhelmsson', 'Mattias Jonson'],
      historical2002: ['Zlatan Ibrahimović', 'Fredrik Ljungberg', 'Anders Svensson']
    },
    {
      country: 'Norway',
      recent: ['Erling Haaland', 'Martin Ødegaard', 'Sander Berge'],
      historical2010: ['John Arne Riise', 'Steffen Iversen', 'Joshua King'],
      historical2002: ['John Arne Riise', 'Egil Østenstad', 'Frode Johnsen']
    },
    {
      country: 'Denmark',
      recent: ['Christian Eriksen', 'Pierre-Emile Højbjerg', 'Kasper Dolberg'],
      historical2010: ['Michael Laudrup', 'Jon Dahl Tomasson', 'Martin Jørgensen'],
      historical2002: ['Michael Laudrup', 'Jon Dahl Tomasson', 'Martin Jørgensen']
    },
    {
      country: 'Poland',
      recent: ['Robert Lewandowski', 'Piotr Zielinski', 'Nicola Zalewski'],
      historical2010: ['Maciej Żurawski', 'Paweł Brożek', 'Radosław Matusiak'],
      historical2002: ['Maciej Żurawski', 'Paweł Brożek', 'Radosław Matusiak']
    },
    {
      country: 'Czech Republic',
      recent: ['Patrik Schick', 'Tomáš Souček', 'Kamil Jiříčko'],
      historical2010: ['Pavel Nedvěd', 'Jan Koller', 'Milan Baroš'],
      historical2002: ['Pavel Nedvěd', 'Jan Koller', 'Milan Baroš']
    },
    {
      country: 'Serbia',
      recent: ['Dušan Tadić', 'Filip Kostić', 'Aleksandar Mitrović'],
      historical2010: ['Dejan Stanković', 'Nemanja Vidić', 'Ognjen Koroman'],
      historical2002: ['Dejan Stanković', 'Ilija Petković', 'Vladimir Jugović']
    },
    {
      country: 'Switzerland',
      recent: ['Granit Xhaka', 'Xherdan Shaqiri', 'Breel Embolo'],
      historical2010: ['Alexander Frei', 'Hakan Yakin', 'Tranquillo Barnetta'],
      historical2002: ['Patrick Müller', 'Ricardo Cabanas', 'Marco Streller']
    },
    {
      country: 'Austria',
      recent: ['Marco Sabitzer', 'Roman Jakobovic', 'Michael Arnautovic'],
      historical2010: ['Andreas Ivanschitz', 'Richard Windbichler', 'Friedrich Schacherl'],
      historical2002: ['Andreas Herzog', 'Mario Haas', 'Marion Stalzer']
    },
    {
      country: 'Ukraine',
      recent: ['Oleksandr Zinchenko', 'Mykhailo Mudryk', 'Oleksandr Zub'],
      historical2010: ['Andriy Shevchenko', 'Vitaliy Mandzyuk', 'Oleksandr Hodzij'],
      historical2002: ['Andriy Shevchenko', 'Ihor Leonov', 'Ruslan Rotan']
    },
    {
      country: 'Russia',
      recent: ['Aleksandr Golovin', 'Anton Miranchuk', 'Denis Popov'],
      historical2010: ['Andrey Arshavin', 'Yuri Zhirkov', 'Roman Pavlyuchenko'],
      historical2002: ['Yegor Titov', 'Vladimir Beschastnykh', 'Alexei Smertin']
    },
    {
      country: 'Chile',
      recent: ['Alexis Sánchez', 'Arturo Vidal', 'Charles Aránguiz'],
      historical2010: ['Alexis Sánchez', 'Mark González', 'Jorge Valdivia'],
      historical2002: ['Marcelo Salas', 'Iván Zamorano', 'Clarence Acuña']
    },
    {
      country: 'Peru',
      recent: ['Gianluca Lapadula', 'Pedro Aquino', 'Yordy Reyna'],
      historical2010: ['Claudio Pizarro', 'Roberto Palacios', 'José del Solar'],
      historical2002: ['Claudio Pizarro', 'Roberto Palacios', 'José del Solar']
    },
    {
      country: 'Ecuador',
      recent: ['Enner Valencia', 'Moisés Caicedo', 'Ángel Mena'],
      historical2010: ['Agustín Delgado', 'Iván Kaviedes', 'Luis Capurro'],
      historical2002: ['Agustín Delgado', 'Iván Kaviedes', 'Luis Capurro']
    },
    {
      country: 'Paraguay',
      recent: ['Miguel Almirón', 'Gustavo Gómez', 'Andrés Gómez'],
      historical2010: ['José Saturnino Cardozo', 'Carlos Humberto Paredes', 'Nelson Cuevas'],
      historical2002: ['José Saturnino Cardozo', 'Carlos Humberto Paredes', 'Nelson Cuevas']
    },
    {
      country: 'Costa Rica',
      recent: ['Keylor Navas', 'Johan Villamar', 'Celso Borges'],
      historical2010: ['Paulo Wanchope', 'Wuilberth Soto', 'Floyd Gutiérrez'],
      historical2002: ['Paulo Wanchope', 'Wuilberth Soto', 'Floyd Gutiérrez']
    },
    {
      country: 'Jamaica',
      recent: ['Leon Bailey', 'Danejay Cotton', 'Rice Bosco'],
      historical2010: ['Richard Hughes', 'Onandi Lowe', 'Dean Fowler'],
      historical2002: ['Theodore Whitmore', 'Ricardo Gardner', 'Dale Shannon']
    },
    {
      country: 'Canada',
      recent: ['Alphonso Davies', 'Jonathan David', 'Cyle Larin'],
      historical2010: ['Dwayne De Rosario', 'Ali Gerba', 'Mike Klukowski'],
      historical2002: ['Dwayne De Rosario', 'Ali Gerba', 'Mike Klukowski']
    },
    {
      country: 'New Zealand',
      recent: ['Chris Wood', 'Ryan Nelsen', 'Kosta Barbarouses'],
      historical2010: ['Ryan Nelsen', 'Simon Elliott', 'Darren Bazeley'],
      historical2002: ['Ryan Nelsen', 'Simon Elliott', 'Darren Bazeley']
    }
  ];

  return nationalTeamData.map((data, i) => ({
    league: 'National Teams',
    team: data.country,
    shirts: [
      // 2026/27 kits (recent players)
      { id: `national-${i}-${data.recent[0]}-recent-home`, player: data.recent[0], kit: 'Home shirt', season: '2026/27' },
      { id: `national-${i}-${data.recent[0]}-recent-away`, player: data.recent[0], kit: 'Away shirt', season: '2025/26' },
      { id: `national-${i}-${data.recent[1]}-recent-home`, player: data.recent[1], kit: 'Home shirt', season: '2026/27' },
      { id: `national-${i}-${data.recent[1]}-recent-away`, player: data.recent[1], kit: 'Away shirt', season: '2025/26' },
      { id: `national-${i}-${data.recent[2]}-recent-home`, player: data.recent[2], kit: 'Home shirt', season: '2026/27' },
      { id: `national-${i}-${data.recent[2]}-recent-away`, player: data.recent[2], kit: 'Away shirt', season: '2025/26' },
      // 2010/11 kits (historical 2010 players)
      { id: `icon-national-${i}-${data.historical2010[0]}-2010-home`, player: data.historical2010[0], kit: 'Home shirt', season: '2010/11' },
      { id: `icon-national-${i}-${data.historical2010[0]}-2010-away`, player: data.historical2010[0], kit: 'Away shirt', season: '2009/10' },
      { id: `icon-national-${i}-${data.historical2010[1]}-2010-home`, player: data.historical2010[1], kit: 'Home shirt', season: '2010/11' },
      { id: `icon-national-${i}-${data.historical2010[1]}-2010-away`, player: data.historical2010[1], kit: 'Away shirt', season: '2009/10' },
      { id: `icon-national-${i}-${data.historical2010[2]}-2010-home`, player: data.historical2010[2], kit: 'Home shirt', season: '2010/11' },
      { id: `icon-national-${i}-${data.historical2010[2]}-2010-away`, player: data.historical2010[2], kit: 'Away shirt', season: '2009/10' },
      // 2002/03 kits (historical 2002 players)
      { id: `icon-national-${i}-${data.historical2002[0]}-2002-home`, player: data.historical2002[0], kit: 'Home shirt', season: '2002/03' },
      { id: `icon-national-${i}-${data.historical2002[0]}-2002-away`, player: data.historical2002[0], kit: 'Away shirt', season: '2001/02' },
      { id: `icon-national-${i}-${data.historical2002[1]}-2002-home`, player: data.historical2002[1], kit: 'Home shirt', season: '2002/03' },
      { id: `icon-national-${i}-${data.historical2002[1]}-2002-away`, player: data.historical2002[1], kit: 'Away shirt', season: '2001/02' },
      { id: `icon-national-${i}-${data.historical2002[2]}-2002-home`, player: data.historical2002[2], kit: 'Home shirt', season: '2002/03' },
      { id: `icon-national-${i}-${data.historical2002[2]}-2002-away`, player: data.historical2002[2], kit: 'Away shirt', season: '2001/02' }
    ]
  }));
}

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
