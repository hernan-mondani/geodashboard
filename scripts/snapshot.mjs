// Builds one weekly snapshot: fetches the configured news feeds and indicators,
// works out the week's most prevalent themes and where they are happening,
// and writes data/snapshots/<week>.json plus data/latest.json.
//
// Usage: node scripts/snapshot.mjs [--date YYYY-MM-DD]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json' with { type: 'json' };

countries.registerLocale(en);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (p) => JSON.parse(await fs.readFile(path.join(root, p), 'utf8'));
const sources = await readJson('config/sources.json');
const themesCfg = await readJson('config/themes.json');
const places = await readJson('config/places.json');

const argDate = process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null;
const now = argDate ? new Date(argDate + 'T23:59:59Z') : new Date();
const UA = sources.user_agent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ----------
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}
const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8216;|&lsquo;/g, '‘')
  .replace(/&#8220;|&ldquo;/g, '“').replace(/&#8221;|&rdquo;/g, '”').replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&nbsp;|&#160;/g, ' ').replace(/&#8230;|&hellip;/g, '…')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const text = (v) => (v == null ? '' : typeof v === 'object' ? (v['#text'] ?? '') : String(v));
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A keyword written in capitals only matches in capitals; anything else is case-insensitive.
function matcher(term) {
  const caseSensitive = term === term.toUpperCase() && /[A-Z]/.test(term);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(term)}(?=$|[^\\p{L}\\p{N}])`, caseSensitive ? 'u' : 'iu');
}

async function get(url, { json = false, tries = 2 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  throw last;
}

// ---------- news ----------
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
function parseFeed(body) {
  const doc = xml.parse(body);
  if (doc.rss) {
    return arr(doc.rss.channel?.item).map((it) => ({
      title: stripHtml(text(it.title)),
      link: text(it.link).trim(),
      date: new Date(text(it.pubDate) || text(it['dc:date'])),
      summary: stripHtml(text(it.description)).replace(/\s*The post .{0,300}? appeared first on .{0,80}?\.?\s*$/i, ''),
      tags: arr(it.category).map((c) => stripHtml(text(c))).filter((t) => t && t !== 'All' && t !== 'Featured Slider'),
      author: stripHtml(text(it['dc:creator'])),
    }));
  }
  if (doc.feed) {
    return arr(doc.feed.entry).map((e) => {
      const links = arr(e.link);
      const alt = links.find((l) => !l['@rel'] || l['@rel'] === 'alternate') ?? links[0];
      return {
        title: stripHtml(text(e.title)),
        link: (alt?.['@href'] ?? text(alt)).trim(),
        date: new Date(text(e.published) || text(e.updated)),
        summary: stripHtml(text(e.summary) || text(e.content)).replace(/\s*The post .{0,300}? appeared first on .{0,80}?\.?\s*$/i, ''),
        tags: arr(e.category).map((c) => c['@term'] ?? c['@label']).filter(Boolean),
        author: arr(e.author).map((a) => stripHtml(text(a.name))).filter(Boolean).join(', '),
      };
    });
  }
  if (doc.urlset) {
    // Google News sitemap (used by Reuters): <url><loc/><news:news><news:title/><news:publication_date/><news:keywords/></news:news></url>
    return arr(doc.urlset.url).map((u) => {
      const n = u['news:news'] ?? {};
      return {
        title: stripHtml(text(n['news:title'])),
        link: text(u.loc).trim(),
        date: new Date(text(n['news:publication_date'])),
        summary: '',
        tags: text(n['news:keywords']).split(',').map((k) => k.trim()).filter(Boolean),
        author: '',
      };
    });
  }
  throw new Error('Not an RSS, Atom or news sitemap feed');
}

const statuses = [];
let items = [];
for (const src of sources.news.filter((s) => s.enabled !== false)) {
  for (const feed of src.feeds) {
    const f = typeof feed === 'string' ? { url: feed } : feed;
    const url = f.url, type = f.type ?? src.type ?? 'news';
    const st = { source: src.id, name: src.name, kind: 'news feed', type, url, retrieved_at: new Date().toISOString() };
    try {
      const parsed = parseFeed(await get(url)).filter((p) => !f.url_contains || p.link.includes(f.url_contains));
      st.status = 'ok'; st.items = parsed.length;
      items.push(...parsed.map((p) => ({ ...p, type, source: src.id, publisher: src.publisher })));
    } catch (e) {
      st.status = 'failed'; st.error = String(e.message || e);
    }
    statuses.push(st);
    console.log(`${st.status.padEnd(6)} ${url}${st.error ? ' — ' + st.error : ` (${st.items} items)`}`);
  }
}

// dedupe, keep valid dates
const seen = new Set();
items = items.filter((it) => it.link && !isNaN(it.date) && it.date <= now && !seen.has(it.link) && seen.add(it.link));

// window: the configured days, widened if too few items fall inside it
let windowDays = sources.window_days ?? 7;
const inWindow = (d) => items.filter((it) => now - it.date <= d * 86400000);
let weekItems = inWindow(windowDays);
for (const d of [14, 30]) if (weekItems.length < 10) { windowDays = d; weekItems = inWindow(d); }
const windowStart = new Date(now - windowDays * 86400000);

// ---------- classify ----------
const themeMatchers = themesCfg.themes.map((t) => ({ ...t, res: t.keywords.map(matcher) }));
const nameToIso = new Map();
for (const [a2, names] of Object.entries(countries.getNames('en', { select: 'all' }))) {
  const a3 = countries.alpha2ToAlpha3(a2);
  for (const n of names) if (n.length > 3) nameToIso.set(n, [a3]);
}
nameToIso.set('Russia', ['RUS']); nameToIso.set('Iran', ['IRN']); nameToIso.set('Syria', ['SYR']); nameToIso.set('Taiwan', ['TWN']);
nameToIso.set('South Korea', ['KOR']); nameToIso.set('North Korea', ['PRK']); nameToIso.set('Vietnam', ['VNM']); nameToIso.set('Venezuela', ['VEN']);
nameToIso.set('Palestine', ['PSE']); nameToIso.set('Türkiye', ['TUR']); nameToIso.set('Turkey', ['TUR']);
for (const [alias, isos] of Object.entries(places.aliases)) nameToIso.set(alias, isos);
const placeMatchers = [...nameToIso].map(([n, isos]) => ({ n, isos, re: matcher(n) }));

for (const it of weekItems) {
  const hay = `${it.title} \n ${it.summary} \n ${it.tags.join(' \n ')}`;
  it.themes = themeMatchers.filter((t) => t.res.some((re) => re.test(hay))).map((t) => t.id);
  const w = {};
  for (const p of placeMatchers) if (p.re.test(hay)) p.isos.forEach((i) => (w[i] = Math.max(w[i] || 0, p.isos.length > 1 ? 0.5 : 1)));
  it.countries = Object.keys(w);
  it.weights = w;
}

const day = (d) => d.toISOString().slice(0, 10);
const days = [];
for (let t = new Date(Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth(), windowStart.getUTCDate() + 1)); t <= now; t = new Date(t.getTime() + 86400000)) days.push(day(t));

const themeStats = themesCfg.themes.map((t, idx) => {
  const its = weekItems.filter((it) => it.themes.includes(t.id));
  const byCountry = {};
  its.forEach((it) => it.countries.forEach((c) => (byCountry[c] = (byCountry[c] || 0) + it.weights[c])));
  const byDay = Object.fromEntries(days.map((d) => [d, 0]));
  its.forEach((it) => { const k = day(it.date); if (k in byDay) byDay[k]++; });
  const bySource = {};
  its.forEach((it) => (bySource[it.source] = (bySource[it.source] || 0) + 1));
  return { id: t.id, idx, label: t.label, keywords: t.keywords, items: its.length, share: weekItems.length ? its.length / weekItems.length : 0, byCountry, byDay, bySource };
}).sort((a, b) => b.items - a.items || Object.keys(b.bySource).length - Object.keys(a.bySource).length || d3sum(b.byCountry) - d3sum(a.byCountry) || a.label.localeCompare(b.label));
function d3sum(o) { return Object.values(o).reduce((x, y) => x + y, 0); }

const top = themeStats[0];
const topThemes = themeStats.filter((t) => t.items > 0).slice(0, 3);
const rank = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
const ranked = rank(top.byCountry);
const maxN = ranked[0]?.[1] ?? 0;
// region of interest: countries named at least 30% as often as the most-named one (at least two, at most eight)
const focus = ranked.filter(([, n], i) => i < 2 || n >= 0.3 * maxN).slice(0, 8).map(([iso3, n]) => ({ iso3, n }));
const allCountries = {};
weekItems.forEach((it) => it.countries.forEach((c) => (allCountries[c] = (allCountries[c] || 0) + it.weights[c])));

// ---------- indicators ----------
const top10 = rank(allCountries).slice(0, 10).map(([iso3, n]) => ({ iso3, n }));
const focusIsos = [...new Set([...focus.map((f) => f.iso3), ...top10.map((t) => t.iso3)])];
const indicators = [];
// The World Bank rejects the whole request if one code is unknown to it (e.g. Taiwan), so ask only for codes it lists.
let wbKnown = null;
async function wbCountries() {
  if (!wbKnown) {
    try {
      const body = await get('https://api.worldbank.org/v2/country?format=json&per_page=400', { json: true });
      wbKnown = new Set(body[1].filter((c) => c.region?.value !== 'Aggregates').map((c) => c.id));
    } catch (e) { wbKnown = new Set(focusIsos); }
  }
  return focusIsos.filter((c) => wbKnown.has(c));
}
const y1 = now.getUTCFullYear();
for (const ind of sources.indicators) {
  const st = { source: ind.provider, name: ind.publisher, kind: 'indicator', indicator: ind.code, retrieved_at: new Date().toISOString() };
  const out = { ...ind, values: [] };
  try {
    if (ind.provider === 'worldbank') {
      const url = `https://api.worldbank.org/v2/country/${(await wbCountries()).join(';')}/indicator/${ind.code}?format=json&date=${y1 - 12}:${y1}&per_page=1000${ind.wb_source ? `&source=${ind.wb_source}` : ''}`;
      st.url = url;
      const body = await get(url, { json: true });
      if (!Array.isArray(body) || !Array.isArray(body[1])) throw new Error(body?.[0]?.message?.[0]?.value || 'No data returned');
      out.values = body[1].filter((r) => r.value != null).map((r) => ({ iso3: r.countryiso3code, year: +r.date, value: r.value }));
      out.link = `https://data.worldbank.org/indicator/${ind.code}`;
      if (ind.wb_source === 3) out.link = 'https://www.worldbank.org/en/publication/worldwide-governance-indicators';
      out.last_updated = body[0]?.lastupdated;
    } else if (ind.provider === 'imf') {
      const url = `https://www.imf.org/external/datamapper/api/v1/${ind.code}/${focusIsos.join('/')}?periods=${y1 - 1},${y1},${y1 + 1}`;
      st.url = url;
      const body = await get(url, { json: true });
      const vals = body?.values?.[ind.code] ?? {};
      for (const [iso3, byYear] of Object.entries(vals)) if (focusIsos.includes(iso3)) for (const [year, value] of Object.entries(byYear)) out.values.push({ iso3, year: +year, value });
      out.link = `https://www.imf.org/external/datamapper/${ind.code}@WEO`;
    }
    st.status = out.values.length ? 'ok' : 'empty';
    st.items = out.values.length;
  } catch (e) {
    st.status = 'failed'; st.error = String(e.message || e);
    out.link = ind.provider === 'imf' ? `https://www.imf.org/external/datamapper/${ind.code}@WEO` : `https://data.worldbank.org/indicator/${ind.code}`;
  }
  out.status = st.status;
  indicators.push(out);
  statuses.push(st);
  console.log(`${st.status.padEnd(6)} ${ind.provider} ${ind.code}${st.error ? ' — ' + st.error : ` (${st.items} values)`}`);
}

// ---------- write ----------
const countryName = (iso3) => ({ PSE: 'Palestinian territories', TWN: 'Taiwan', RUS: 'Russia', IRN: 'Iran', KOR: 'South Korea', PRK: 'North Korea', USA: 'United States', GBR: 'United Kingdom', SYR: 'Syria', VNM: 'Vietnam', CHN: 'China', BOL: 'Bolivia', VEN: 'Venezuela', TZA: 'Tanzania', LAO: 'Laos', MDA: 'Moldova', COD: 'DR Congo', COG: 'Republic of the Congo' }[iso3] ?? countries.getName(iso3, 'en') ?? iso3);
const countryInfo = Object.fromEntries([...new Set([...Object.keys(allCountries), ...focusIsos])].map((iso3) => [iso3, { name: countryName(iso3), numeric: countries.alpha3ToNumeric(iso3) }]));

const week = isoWeek(now);
const snapshot = {
  schema: 1,
  week,
  generated_at: new Date().toISOString(),
  window: { start: windowStart.toISOString(), end: now.toISOString(), days: windowDays, widened: windowDays !== (sources.window_days ?? 7) },
  method: 'Themes are counted from the titles, summaries and tags of news and analysis items published in the window, using the keyword lists in config/themes.json. Countries are matched by name and by the aliases in config/places.json. The region of interest is the set of countries most often named in items about the most prevalent theme. Ties between themes are broken by the number of distinct sources covering them, then by how many country mentions they carry.',
  totals: { items: weekItems.length, sources: [...new Set(weekItems.map((i) => i.source))].length },
  top_theme: top.id,
  themes: themeStats,
  top_themes: topThemes.map((t) => t.id),
  top10,
  focus,
  mentions: allCountries,
  countries: countryInfo,
  news: weekItems.sort((a, b) => b.date - a.date).map((it) => ({ type: it.type, title: it.title, link: it.link, date: it.date.toISOString(), source: it.source, publisher: it.publisher, author: it.author, summary: it.summary.slice(0, 320), tags: it.tags.slice(0, 6), themes: it.themes, countries: it.countries })),
  indicators,
  sources: { config: sources.news.map(({ id, name, publisher, homepage, note, enabled }) => ({ id, name, publisher, homepage, note, enabled })), statuses },
};

await fs.mkdir(path.join(root, 'data/snapshots'), { recursive: true });
await fs.writeFile(path.join(root, `data/snapshots/${week}.json`), JSON.stringify(snapshot, null, 1));
await fs.writeFile(path.join(root, 'data/latest.json'), JSON.stringify(snapshot, null, 1));
const index = (await fs.readdir(path.join(root, 'data/snapshots'))).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).sort().reverse();
await fs.writeFile(path.join(root, 'data/index.json'), JSON.stringify({ weeks: index }, null, 1));
console.log(`\n${week}: ${weekItems.length} items in ${windowDays} days. Top theme: ${top.label} (${top.items}). Focus: ${focus.map((f) => f.iso3 + ':' + f.n).join(', ')}`);
