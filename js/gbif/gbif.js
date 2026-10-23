// Nearby Sightings: GBIF occurrences near the house, same calendar window across past years.

const API = 'https://api.gbif.org/v1/occurrence/search';
const SPECIES_API = 'https://api.gbif.org/v1/species';
const BACKBONE = 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c';   // GBIF Backbone Taxonomy
const PAGE_SIZE = 300;
const MAX_PAGES = 2;          // per year, so 600 records max
const MAX_PAGES_ANY = 10;     // 'Any time' is one query for the whole span, so 3000 records max
const MAX_ROWS = 5;           // record rows shown per species
const MAX_THUMBS = 6;
const TILE = 256;
const MAP_W = 288, MAP_H = 180;   // map thumbnail viewport, in px
const CONCURRENCY = 2;        // GBIF rate-limits (429) and times out when hit with too many requests
const REQUEST_GAP_MS = 300;   // pause before each request
const RETRIES = 4;            // retries for timeouts, 429s and 5xx errors
const TIMEOUT_MS = 30000;

const $ = id => document.getElementById(id);
const iso = d => d.toISOString().slice(0, 10);
const kmToMiles = km => km * 0.621371;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let searchId = 0;             // lets a newer search discard a slower, older one

/* ---------- helpers ---------- */

function setStatus(msg, isError = false) {
    const el = $('status');
    el.className = isError ? 'form-error' : 'note';
    el.textContent = msg;
}

const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);

function clone(templateId) {
    return $(templateId).content.firstElementChild.cloneNode(true);
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, rad = x => x * Math.PI / 180;
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

// Bounding-box WKT, counter-clockwise (GBIF requires this winding)
function boxWkt(lat, lon, km) {
    const dLat = km / 111.32;
    const dLon = km / (111.32 * Math.cos(lat * Math.PI / 180));
    const w = lon - dLon, e = lon + dLon, s = lat - dLat, n = lat + dLat;
    return `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
}

// The same calendar window, anchored to a given year
function windowFor(kind, year) {
    const now = new Date(), m = now.getMonth(), d = now.getDate();
    let start, end;
    if (kind === 'month') {
        start = new Date(Date.UTC(year, m, 1));
        end = new Date(Date.UTC(year, m + 1, 0));
    } else {
        // 'around': +/- 3 days
        start = new Date(Date.UTC(year, m, d - 3));
        end = new Date(Date.UTC(year, m, d + 3));
    }
    return `${iso(start)},${iso(end)}`;
}

const isHttp = url => /^https?:\/\//i.test(url || '');

/* ---------- taxon limiter ---------- */

// Everyday group names -> [scientific name, rank]. Anything else is looked up in GBIF.
const RAPTORS = [
    ['Accipitriformes', 'ORDER'],   // hawks, eagles, kites, osprey
    ['Falconiformes', 'ORDER'],     // falcons, caracaras
    ['Cathartiformes', 'ORDER'],    // New World vultures
    ['Strigiformes', 'ORDER']       // owls (delete this line to exclude them)
];

const ALIASES = {
    mushroom: ['Agaricomycetes', 'CLASS'],   // most mushrooms, bracket fungi, puffballs
    fungus: ['Fungi', 'KINGDOM'],
    fungi: ['Fungi', 'KINGDOM'],
    plant: ['Plantae', 'KINGDOM'],
    orchid: ['Orchidaceae', 'FAMILY'],
    animal: ['Animalia', 'KINGDOM'],
    bird: ['Aves', 'CLASS'],
    mammal: ['Mammalia', 'CLASS'],
    reptile: ['Reptilia', 'CLASS'],
    amphibian: ['Amphibia', 'CLASS'],
    insect: ['Insecta', 'CLASS'],
    spider: ['Araneae', 'ORDER'],
    raptor: RAPTORS,
    'bird of prey': RAPTORS,
    'birds of prey': RAPTORS
};

const titleCase = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

async function matchName(name, rank) {
    const params = new URLSearchParams({ name });
    if (rank) params.set('rank', rank);
    const m = await fetchJson(`${SPECIES_API}/match?${params}`);
    // HIGHERRANK means GBIF only matched a parent of what was typed
    if (!m.usageKey || m.matchType === 'NONE' || m.matchType === 'HIGHERRANK') return null;
    if (rank && m.rank !== rank) return null;
    return {
        key: m.acceptedUsageKey ?? m.usageKey,
        label: `${m.canonicalName || m.scientificName} (${m.rank.toLowerCase()})`
    };
}

// Handles both [name, rank] and [[name, rank], ...]
async function matchAlias(alias, text) {
    const pairs = Array.isArray(alias[0]) ? alias : [alias];
    const hits = [];
    for (const [name, rank] of pairs) {      // sequential, to be kind to GBIF's rate limit
        const hit = await matchName(name, rank);
        if (hit) hits.push(hit);
    }
    if (!hits.length) return null;
    return {
        key: hits.map(h => h.key),
        label: `${text} → ${hits.map(h => h.label).join(', ')}`
    };
}

// Turns the text box + rank dropdown into a GBIF taxonKey (or null for no limit)
async function resolveTaxon() {
    const text = $('taxon').value.trim();
    if (!text) return null;
    const rank = $('taxonRank').value;

    setStatus('Looking up ' + text + '…');

    if (rank) {
        const hit = await matchName(titleCase(text), rank);
        if (!hit) throw new Error(`No ${rank.toLowerCase()} named "${text}" found in GBIF.`);
        return hit;
    }

    // Auto: everyday group name, then scientific name, then common (vernacular) name
    const lower = text.toLowerCase();
    const alias = ALIASES[lower] || ALIASES[lower.replace(/s$/, '')];
    if (alias) {
        const hit = await matchAlias(alias, text);
        if (hit) return hit;
    }

    const sci = await matchName(titleCase(text));
    if (sci) return sci;

    const params = new URLSearchParams({
        q: text, qField: 'VERNACULAR', datasetKey: BACKBONE,
        rank: 'SPECIES', status: 'ACCEPTED', limit: 1
    });
    const data = await fetchJson(`${SPECIES_API}/search?${params}`);
    const top = data.results?.[0];
    if (top) {
        return {
            key: top.nubKey ?? top.key,
            label: `${text} → ${top.canonicalName || top.scientificName} (species)`
        };
    }
    throw new Error(`Couldn't match "${text}" to a taxon. Try its scientific name, or pick a rank.`);
}

/* ---------- GBIF ---------- */

// GET with a timeout and exponential backoff on timeouts, 429s and 5xx errors
async function fetchJson(url) {
    for (let attempt = 0; ; attempt++) {
        let waitMs = 2000 * 2 ** attempt;          // 2s, 4s, 8s, 16s
        try {
            await sleep(REQUEST_GAP_MS);
            const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (res.ok) return await res.json();
            const err = new Error('GBIF returned ' + res.status);
            err.status = res.status;
            err.retry = res.status === 429 || res.status >= 500;
            const retryAfter = +res.headers.get('Retry-After');   // null if CORS hides it
            if (retryAfter > 0) waitMs = Math.max(waitMs, retryAfter * 1000);
            throw err;
        } catch (e) {
            const retry = e.retry ?? true;         // network errors and timeouts are retryable
            if (!retry || attempt >= RETRIES) {
                if (e.name === 'TimeoutError') throw new Error('GBIF timed out');
                if (e.status === 429) throw new Error('GBIF is rate limiting requests. Wait a minute and try again, or narrow the search.');
                throw e;
            }
            await sleep(waitMs);
        }
    }
}

// Run fn over items with at most `limit` in flight
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// Pages through one eventDate range ("start,end"); returns the records and whether the cap cut it short
async function fetchRange(range, base, maxPages) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(base)) {
        (Array.isArray(v) ? v : [v]).forEach(x => params.append(k, x));
    }
    params.set('eventDate', range);
    
    const recs = [];
    let capped = false;
    for (let page = 0; page < maxPages; page++) {
        const data = await fetchJson(`${API}?${params}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
        recs.push(...data.results);
        if (data.endOfRecords) break;
        if (page === maxPages - 1) capped = true;
    }
    return { recs, capped };
}

// Same calendar window in each year: one query per year
async function fetchYear(year, base, kind) {
    const { recs, capped } = await fetchRange(windowFor(kind, year), base, MAX_PAGES);
    return { year, recs: recs.map(r => ({ ...r, _year: year })), capped };
}

// Any time: a single query spanning the whole period, split back into years afterwards
async function fetchAnyTime(years, base) {
    const first = Math.min(...years), last = Math.max(...years);
    const { recs, capped } = await fetchRange(`${first}-01-01,${last}-12-31`, base, MAX_PAGES_ANY);

    const byYear = new Map(years.map(y => [y, []]));
    for (const r of recs) {
        const y = r.year ?? +(r.eventDate || '').slice(0, 4);
        if (byYear.has(y)) byYear.get(y).push({ ...r, _year: y });
    }
    // The cap applies to the whole span, so flag every year
    return years.map(y => ({ year: y, recs: byYear.get(y), capped }));
}

async function search(lat, lon) {
    const id = ++searchId;
    const km = +$('radius').value;
    const kind = $('window').value;
    const count = +$('years').value;
    const thisYear = new Date().getFullYear();
    const years = Array.from({ length: count }, (_, i) => thisYear - i);

    const base = {
        geometry: boxWkt(lat, lon, km),
        occurrenceStatus: 'PRESENT',
        hasCoordinate: 'true'
    };
    if ($('imgOnly').checked) base.mediaType = 'StillImage';

    setStatus(`Searching GBIF across ${count} years…`);
    $('yearSummary').textContent = '';
    $('results').replaceChildren();

    try {
        const taxon = await resolveTaxon();
        if (id !== searchId) return;
        if (taxon) base.taxonKey = taxon.key;
        setStatus(`Searching GBIF across ${count} years…`);

        let perYear;
        if (kind === 'any') {
            perYear = await fetchAnyTime(years, base);
        } else {
            let done = 0;
            perYear = await mapLimit(years, CONCURRENCY, async y => {
                if (id !== searchId) throw new Error('superseded');
                const result = await fetchYear(y, base, kind);
                if (id === searchId) setStatus(`Searching GBIF… ${++done} of ${count} years`);
                return result;
            });
        }
        if (id !== searchId) return;   // a newer search superseded this one
        render(perYear, { lat, lon, km, taxon });
    } catch (e) {
        if (id === searchId) setStatus('Error: ' + e.message, true);   // stale searches stay silent
    }
}

/* ---------- rendering ---------- */

function groupSpecies(perYear, { lat, lon, km }) {
    const groups = new Map();
    const yearCounts = new Map();
    let total = 0, anyCapped = false;

    for (const { year, recs, capped } of perYear) {
        anyCapped ||= capped;
        // The query uses a bounding box; trim to the true circle here.
        const near = recs.filter(r => r.decimalLatitude != null &&
            haversineKm(lat, lon, r.decimalLatitude, r.decimalLongitude) <= km);
        yearCounts.set(year, near.length);
        total += near.length;

        for (const r of near) {
            const key = r.speciesKey || r.taxonKey || r.scientificName;
            if (!groups.has(key)) {
                groups.set(key, {
                    name: r.species || r.scientificName,
                    common: r.vernacularName,
                    kingdom: r.kingdom || 'Unknown',
                    taxClass: r.class || 'Unknown',
                    recs: []
                });
            }
            const g = groups.get(key);
            g.common ||= r.vernacularName;
            g.recs.push(r);
        }
    }
    return { groups, yearCounts, total, anyCapped };
}

/* ---------- map thumbnails ---------- */

// Zoom from the record's coordinate uncertainty: tighter fix = closer in
function zoomFor(uncertaintyM) {
    if (!(uncertaintyM > 0)) return 16;       // not reported
    if (uncertaintyM <= 50) return 17;
    if (uncertaintyM <= 250) return 16;
    if (uncertaintyM <= 1000) return 15;
    if (uncertaintyM <= 4000) return 14;
    return 13;
}

// OpenStreetMap tiles stitched to fill the viewport, record centered, with an uncertainty circle
function buildMap(r, zoom) {
    const lat = Math.max(-85.0511, Math.min(85.0511, r.decimalLatitude));
    const lon = r.decimalLongitude;
    const u = r.coordinateUncertaintyInMeters;
    const hasU = u > 0;
    const z = Math.max(3, Math.min(18, zoom ?? zoomFor(u)));
    const n = 2 ** z;
    const latRad = lat * Math.PI / 180;

    // Record position in world pixels at this zoom; viewport is centered on it
    const px = (lon + 180) / 360 * n * TILE;
    const py = (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n * TILE;
    const left = px - MAP_W / 2, top = py - MAP_H / 2;

    const map = clone('tpl-map');
    const view = slot(map, 'view');
    view.style.width = MAP_W + 'px';
    view.style.height = MAP_H + 'px';

    const tiles = slot(map, 'tiles');
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + MAP_H) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + MAP_W) / TILE); tx++) {
            const img = document.createElement('img');
            img.alt = '';
            img.width = img.height = TILE;
            img.style.left = (tx * TILE - left) + 'px';
            img.style.top = (ty * TILE - top) + 'px';
            img.src = `https://tile.openstreetmap.org/${z}/${((tx % n) + n) % n}/${ty}.png`;
            tiles.append(img);
        }
    }

    if (hasU) {
        const metersPerPx = 156543.03392 * Math.cos(latRad) / n;
        const radius = Math.max(u / metersPerPx, 6);
        const acc = slot(map, 'acc');
        acc.style.width = acc.style.height = (radius * 2) + 'px';
        acc.style.left = (MAP_W / 2 - radius) + 'px';
        acc.style.top = (MAP_H / 2 - radius) + 'px';
        acc.hidden = false;
    }

    slot(map, 'caption').textContent = hasU
        ? `Location uncertainty ±${Math.round(u)} m · zoom ${z}`
        : `Uncertainty not reported · zoom ${z}`;

    const { decimalLatitude: la, decimalLongitude: lo } = r;
    slot(map, 'osm').href =
        `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=17/${la}/${lo}`;
    slot(map, 'sat').href =
        `https://www.google.com/maps/@?api=1&map_action=map&center=${la},${lo}&zoom=18&basemap=satellite`;
    slot(map, 'zoomOut').addEventListener('click', () => map.replaceWith(buildMap(r, z - 1)));
    slot(map, 'zoomIn').addEventListener('click', () => map.replaceWith(buildMap(r, z + 1)));

    return map;
}

function buildRecordRow(r, origin) {
    const row = clone('tpl-record');
    const miles = kmToMiles(
        haversineKm(origin.lat, origin.lon, r.decimalLatitude, r.decimalLongitude)
    ).toFixed(1);
    slot(row, 'meta').textContent = `${(r.eventDate || '').slice(0, 10)} · ${miles} mi`;
    slot(row, 'link').href = `https://www.gbif.org/occurrence/${r.key}`;

    // Tiles are only requested the first time the map is opened
    const btn = slot(row, 'mapBtn'), holder = slot(row, 'map');
    btn.addEventListener('click', () => {
        if (!holder.firstChild) holder.append(buildMap(r));
        holder.hidden = !holder.hidden;
        btn.textContent = holder.hidden ? 'Map' : 'Hide map';
        btn.setAttribute('aria-expanded', String(!holder.hidden));
    });
    return row;
}

function buildSpeciesCard(g, origin) {
    g.recs.sort((a, b) => (b.eventDate || '').localeCompare(a.eventDate || ''));
    const card = clone('tpl-species');

    slot(card, 'name').textContent = g.common || g.name;
    if (g.common) {
        const sci = slot(card, 'sci');
        sci.textContent = g.name;
        sci.hidden = false;
    }

    slot(card, 'records').textContent =
        `${g.recs.length} record${g.recs.length !== 1 ? 's' : ''}`;

    // Per-year badges, newest first
    const byYear = new Map();
    g.recs.forEach(r => byYear.set(r._year, (byYear.get(r._year) || 0) + 1));
    [...byYear].sort((a, b) => b[0] - a[0]).forEach(([year, n]) => {
        const badge = clone('tpl-year-badge');
        badge.textContent = `${year} · ${n}`;
        slot(card, 'years').append(badge);
    });

    // Images
    const imgs = g.recs.flatMap(r =>
        (r.media || [])
            .filter(m => m.type === 'StillImage' && isHttp(m.identifier))
            .map(m => ({ src: m.identifier, year: r._year }))
    );
    if (imgs.length) {
        const chip = slot(card, 'images');
        chip.textContent = `${imgs.length} image${imgs.length !== 1 ? 's' : ''}`;
        chip.hidden = false;

        const thumbs = slot(card, 'thumbs');
        imgs.slice(0, MAX_THUMBS).forEach(i => {
            const a = clone('tpl-thumb');
            a.href = i.src;
            a.title = i.year;
            a.querySelector('img').src = i.src;
            thumbs.append(a);
        });
        thumbs.hidden = false;
    }

    // Most recent records
    slot(card, 'recs').append(...g.recs.slice(0, MAX_ROWS).map(r => buildRecordRow(r, origin)));
    if (g.recs.length > MAX_ROWS) {
        const more = slot(card, 'more');
        more.textContent = `+ ${g.recs.length - MAX_ROWS} more`;
        more.hidden = false;
    }
    return card;
}

function buildTaxonomy(groups, origin) {
    const taxonomy = new Map();   // kingdom -> class -> species[]
    for (const sp of groups.values()) {
        if (!taxonomy.has(sp.kingdom)) taxonomy.set(sp.kingdom, new Map());
        const classes = taxonomy.get(sp.kingdom);
        if (!classes.has(sp.taxClass)) classes.set(sp.taxClass, []);
        classes.get(sp.taxClass).push(sp);
    }

    const byName = (a, b) => a[0].localeCompare(b[0]);
    const kingdomEls = [];

    for (const [kingdom, classes] of [...taxonomy].sort(byName)) {
        const kEl = clone('tpl-kingdom');
        let kingdomCount = 0;

        for (const [taxClass, species] of [...classes].sort(byName)) {
            kingdomCount += species.length;
            const cEl = clone('tpl-class');
            slot(cEl, 'name').textContent = taxClass;
            slot(cEl, 'count').textContent = `${species.length} taxa`;
            species
                .sort((a, b) => b.recs.length - a.recs.length)
                .forEach(g => cEl.append(buildSpeciesCard(g, origin)));
            kEl.append(cEl);
        }

        slot(kEl, 'name').textContent = kingdom;
        slot(kEl, 'count').textContent = `${kingdomCount} taxa`;
        kingdomEls.push(kEl);
    }
    return kingdomEls;
}

function render(perYear, origin) {
    const { groups, yearCounts, total, anyCapped } = groupSpecies(perYear, origin);

    $('yearSummary').textContent = 'Records per year: ' +
        [...yearCounts].map(([y, c]) => `${y}: ${c}`).join(' · ') +
        (anyCapped
            ? ' (results capped, so some records are missing; narrow the radius or years)'
            : '');

    if (!groups.size) {
        setStatus(origin.taxon ? 'Limited to ' + origin.taxon.label : '');
        $('results').replaceChildren(clone('tpl-empty'));
        return;
    }

    setStatus(`${total} records, ${groups.size} taxa within ${kmToMiles(origin.km).toFixed(1)} miles` +
        (origin.taxon ? ` · limited to ${origin.taxon.label}` : ''));
    $('results').replaceChildren(...buildTaxonomy(groups, origin));
}

/* ---------- location + wiring ---------- */

function searchFromInputs() {
    const lat = parseFloat($('lat').value), lon = parseFloat($('lon').value);
    if (isNaN(lat) || isNaN(lon)) { setStatus('Enter valid coordinates.', true); return; }
    search(lat, lon);
}

function useDeviceLocation() {
    if (!navigator.geolocation) { setStatus('Geolocation not supported.', true); return; }
    setStatus('Getting your location…');
    navigator.geolocation.getCurrentPosition(
        p => {
            $('lat').value = p.coords.latitude.toFixed(5);
            $('lon').value = p.coords.longitude.toFixed(5);
            search(p.coords.latitude, p.coords.longitude);
        },
        e => setStatus(`Location failed (${e.message}). Enter coordinates above.`, true),
        { timeout: 15000 }
    );
}

async function loadHouse() {
    setStatus('Loading house location…');
    const { data, error } = await window.supabaseClient
        .from('weather_location').select('lat, lon').limit(1).maybeSingle();

    if (error || !data || data.lat == null || data.lon == null) {
        setStatus('Could not read weather_location' +
            (error ? ` (${error.message})` : '') + '. Enter coordinates above.', true);
        return;
    }
    $('lat').value = (+data.lat).toFixed(5);
    $('lon').value = (+data.lon).toFixed(5);
    setStatus('Ready. Choose your options and click Search.');
}

$('manual').addEventListener('click', searchFromInputs);
$('go').addEventListener('click', useDeviceLocation);

loadHouse();
