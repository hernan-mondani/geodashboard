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
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
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
    return arr(doc.rss.channel?.item).map((it) => {
      // ReliefWeb puts countries and the reporting organisation in tagged divs at the top of the description
      let desc = text(it.description).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const tagDiv = (cls) => { const m = desc.match(new RegExp(`<div class="tag ${cls}">\\s*[^:<]*:\\s*([^<]*)</div>`)); if (m) desc = desc.replace(m[0], ' '); return m ? stripHtml(m[1]) : ''; };
      const rwCountries = tagDiv('country'), rwSource = tagDiv('source');
      return {
        title: stripHtml(text(it.title)),
        link: text(it.link).trim(),
        date: new Date(text(it.pubDate) || text(it['dc:date'])),
        summary: stripHtml(desc).replace(/^Please refer to the attached [^.]*\.\s*/i, '').replace(/\s*The post .{0,300}? appeared first on .{0,80}?\.?\s*$/i, ''),
        tags: [...arr(it.category).map((c) => stripHtml(text(c))), ...(rwCountries ? rwCountries.split(/,\s*/) : [])].filter((t) => t && t !== 'All' && t !== 'Featured Slider'),
        author: rwSource || stripHtml(text(it['dc:creator'])),
      };
    });
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

// US Treasury OFAC "Recent Actions" page: one link per day, /recent-actions/YYYYMMDD, titled with that day's actions
function parseOfac(body, base) {
  const out = [];
  for (const m of body.matchAll(/href="(\/recent-actions\/(\d{8}(?:_\d+)?))"[^>]*>([^<]+)</g)) {
    const d = m[2].slice(0, 8);
    out.push({ title: stripHtml(m[3]), link: new URL(m[1], base).href, date: new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T20:00:00Z`), summary: '', tags: [], author: '' });
  }
  if (!out.length) throw new Error('No actions found on the page');
  return out;
}

const statuses = [];
let items = [];
for (const src of sources.news.filter((s) => s.enabled !== false)) {
  for (const feed of src.feeds) {
    const f = typeof feed === 'string' ? { url: feed } : feed;
    const url = f.url, type = f.type ?? src.type ?? 'news';
    const st = { source: src.id, name: src.name, kind: 'news feed', type, url, retrieved_at: new Date().toISOString() };
    try {
      const parsed = (f.format === 'ofac-html' ? parseOfac(await get(url), url) : parseFeed(await get(url))).filter((p) => !f.url_contains || p.link.includes(f.url_contains));
      st.status = 'ok'; st.items = parsed.length;
      items.push(...parsed.map((p) => ({ ...p, type, source: src.id, publisher: src.publisher })));
    } catch (e) {
      st.status = e.skipped ? 'skipped' : 'failed'; st.error = String(e.message || e);
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
const contextIds = themesCfg.themes.find((t) => t.id === top.id)?.indicators ?? [];
for (const ind of sources.indicators.filter((i) => !i.library || contextIds.includes(i.id))) {
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

// ---------- market signals ----------
const markets = { series: [], window: { start: windowStart.toISOString(), end: now.toISOString() } };
const mk = sources.markets;
if (mk) {
  const since = new Date(now - (mk.days ?? 180) * 86400000).toISOString().slice(0, 10);
  const until = now.toISOString().slice(0, 10);
  // US EIA daily spot prices: an HTML table with one row per week ("2026 Nov- 2 to Nov- 6") and a cell per weekday
  for (const s of mk.eia ?? []) {
    const url = `https://www.eia.gov/dnav/pet/hist/${s.series}D.htm`;
    const st = { source: 'eia', name: 'US Energy Information Administration', kind: 'market', indicator: s.series, url, retrieved_at: new Date().toISOString() };
    try {
      const html = await get(url);
      const values = [];
      for (const row of html.matchAll(/<td class='B6'>(?:&nbsp;)*\s*(\d{4}) (\w{3})-\s*(\d+) to [^<]*<\/td>((?:\s*<td class='B3'>[^<]*<\/td>){5})/g)) {
        const start = new Date(`${row[2]} ${row[3]}, ${row[1]} 12:00 UTC`);
        [...row[4].matchAll(/<td class='B3'>([^<]*)<\/td>/g)].forEach((c, i) => {
          const v = parseFloat(c[1]); const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
          if (Number.isFinite(v) && d >= since) values.push({ date: d, value: v });
        });
      }
      if (!values.length) throw new Error('No prices found on the page');
      markets.series.push({ ...s, provider: 'US Energy Information Administration', dataset: 'Spot Prices for Crude Oil and Petroleum Products', release: 'EIA', column: s.series, link: url, values });
      st.status = 'ok'; st.items = values.length;
    } catch (e) { st.status = 'failed'; st.error = String(e.message || e); (markets.missing ??= []).push({ id: s.id, label: s.label, provider: 'US Energy Information Administration', column: s.series, reason: st.error }); }
    statuses.push(st);
    console.log(`${st.status.padEnd(6)} eia ${s.series}${st.error ? ' — ' + st.error : ` (${st.items} days)`}`);
  }
  // Yahoo Finance (unofficial): one batched "spark" request for every symbol, so the rate limit is hit once,
  // with a retry after a pause. Symbols missing from the batch fall back to one chart request each.
  const ySeries = mk.yahoo ?? [];
  if (ySeries.length) {
    const yget = async (url) => {
      for (let k = 0; ; k++) {
        try { return await get(url, { json: true, tries: 1 }); }
        catch (e) { if (!/429/.test(e.message) || k >= 3) throw e; await sleep(20000 * (k + 1)); }
      }
    };
    const toValues = (ts, close) => (ts ?? []).map((t, j) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), value: close?.[j] })).filter((v) => Number.isFinite(v.value) && v.date >= since);
    const got = {};
    const sparkUrl = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${ySeries.map((s) => encodeURIComponent(s.symbol)).join(',')}&range=6mo&interval=1d`;
    try {
      const body = await yget(sparkUrl);
      for (const r of body?.spark?.result ?? []) { const x = r.response?.[0]; if (x) got[r.symbol] = { values: toValues(x.timestamp, x.indicators?.quote?.[0]?.close), currency: x.meta?.currency }; }
    } catch (e) { console.log(`failed yahoo spark — ${e.message}`); }
    for (const s of ySeries) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.symbol)}?range=6mo&interval=1d`;
      const st = { source: 'yahoo', name: 'Yahoo Finance', kind: 'market', indicator: s.symbol, url: got[s.symbol] ? sparkUrl : url, retrieved_at: new Date().toISOString() };
      try {
        if (!got[s.symbol]?.values?.length) {
          await sleep(5000);
          const r = (await yget(url))?.chart?.result?.[0];
          if (!r) throw new Error('No data returned');
          got[s.symbol] = { values: toValues(r.timestamp, r.indicators?.quote?.[0]?.close), currency: r.meta?.currency };
        }
        const { values, currency } = got[s.symbol];
        if (!values.length) throw new Error('No closing prices');
        markets.series.push({ ...s, currency, provider: 'Yahoo Finance', dataset: 'Daily closing prices', release: 'Yahoo', column: s.symbol, link: `https://finance.yahoo.com/quote/${encodeURIComponent(s.symbol)}/history/`, values });
        st.status = 'ok'; st.items = values.length;
      } catch (e) { st.status = 'failed'; st.error = String(e.message || e); (markets.missing ??= []).push({ id: s.id, label: s.label, provider: 'Yahoo Finance', column: s.symbol, reason: st.error }); }
      statuses.push(st);
      console.log(`${st.status.padEnd(6)} yahoo ${s.symbol}${st.error ? ' — ' + st.error : ` (${st.items} days)`}`);
    }
  }
  // Federal Reserve Board Data Download Program: CSV with five label rows, then date,value,... per day ("ND" = no data)
  const fedByPkg = {};
  for (const s of mk.fed ?? []) (fedByPkg[`${s.release}|${s.package}`] ??= []).push(s);
  for (const [key, list] of Object.entries(fedByPkg)) {
    const [release, pkg] = key.split('|');
    const rel = release.replace('.', '');
    const url = `https://www.federalreserve.gov/datadownload/Output.aspx?rel=${rel}&series=${pkg}&from=${since}&to=${until}&filetype=csv&label=include&layout=seriescolumn`;
    const st = { source: 'federal-reserve', name: 'Federal Reserve Board', kind: 'market', indicator: list.map((s) => s.column).join(', '), url, retrieved_at: new Date().toISOString() };
    try {
      // the service occasionally answers with an error page instead of the CSV, so try twice
      let rows, head;
      for (let k = 0; k < 2 && !head; k++) {
        if (k) await sleep(5000);
        rows = (await get(url)).trim().split(/\r?\n/).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')));
        head = rows.find((r) => r[0] === 'Time Period');
      }
      if (!head) throw new Error(`Unexpected file layout: ${rows[0]?.join(' ').slice(0, 80)}`);
      const data = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0]));
      for (const s of list) {
        const col = head.indexOf(s.column);
        if (col < 0) throw new Error(`Column ${s.column} not in package`);
        const values = data.map((r) => ({ date: r[0], value: +r[col] })).filter((v) => r_ok(v.value));
        markets.series.push({ ...s, provider: 'Federal Reserve Board', dataset: `${s.release} Selected Interest Rates and Exchange Rates`.replace('Selected Interest Rates and Exchange Rates', s.release === 'H.10' ? 'Foreign Exchange Rates' : 'Selected Interest Rates'), link: `https://www.federalreserve.gov/releases/${rel.toLowerCase()}/`, values });
      }
      st.status = 'ok'; st.items = data.length;
    } catch (e) { st.status = 'failed'; st.error = String(e.message || e); }
    statuses.push(st);
    console.log(`${st.status.padEnd(6)} fed ${release}${st.error ? ' — ' + st.error : ` (${st.items} days)`}`);
  }
  // ECB euro reference rates for the region's currencies, turned into units per US dollar
  const regionCur = [...new Set(focus.map((f) => mk.ecb_currencies?.[f.iso3]).filter(Boolean))];
  const curs = [...new Set([...(mk.ecb_always ?? []), ...regionCur])];
  const noEcb = focus.filter((f) => !mk.ecb_currencies?.[f.iso3] && f.iso3 !== 'USA').map((f) => f.iso3);
  const asked = [...new Set(['USD', ...curs.filter((c) => c !== 'EUR')])];
  const url = `https://data-api.ecb.europa.eu/service/data/EXR/D.${asked.join('+')}.EUR.SP00.A?format=csvdata&startPeriod=${since}&endPeriod=${until}`;
  const st = { source: 'ecb', name: 'European Central Bank', kind: 'market', indicator: `EXR ${asked.join(', ')}`, url, retrieved_at: new Date().toISOString() };
  try {
    const lines = (await get(url)).trim().split(/\r?\n/);
    const h = lines[0].split(',');
    const iC = h.indexOf('CURRENCY'), iT = h.indexOf('TIME_PERIOD'), iV = h.indexOf('OBS_VALUE');
    const by = {};
    for (const l of lines.slice(1)) { const r = l.split(','); if (r[iV] !== '') (by[r[iC]] ??= {})[r[iT]] = +r[iV]; }
    const usd = by.USD ?? {};
    for (const c of curs) {
      const values = Object.keys(usd).sort().map((d) => ({ date: d, value: c === 'EUR' ? 1 / usd[d] : by[c]?.[d] / usd[d] })).filter((v) => r_ok(v.value));
      const last = values.at(-1)?.date;
      if (!last || now - new Date(last) > 14 * 86400000) continue; // suspended (e.g. RUB since 2022)
      const isos = c === 'EUR' ? [] : Object.entries(mk.ecb_currencies).filter(([, v]) => v === c).map(([k]) => k).filter((k) => focus.some((f) => f.iso3 === k));
      markets.series.push({ id: `fx_${c.toLowerCase()}`, label: `${c} per US dollar`, unit: c, currency: c, isos, provider: 'European Central Bank', dataset: 'Euro foreign exchange reference rates (EXR)', release: 'EXR', column: c === 'EUR' ? 'EXR.D.USD.EUR.SP00.A' : `EXR.D.${c}.EUR.SP00.A`, link: 'https://data.ecb.europa.eu/data/datasets/EXR', note: c === 'EUR' ? 'Rises when the euro weakens against the dollar.' : `Cross rate from ECB reference rates. Rises when the ${c} weakens against the dollar.`, values });
    }
    markets.no_rate = noEcb;
    st.status = 'ok'; st.items = Object.keys(usd).length;
  } catch (e) { st.status = 'failed'; st.error = String(e.message || e); }
  statuses.push(st);
  console.log(`${st.status.padEnd(6)} ecb EXR${st.error ? ' — ' + st.error : ` (${st.items} days)`}`);
}
function r_ok(v) { return Number.isFinite(v) && v > 0; }

// ---------- write ----------
const countryName = (iso3) => ({ PSE: 'Palestinian territories', TWN: 'Taiwan', RUS: 'Russia', IRN: 'Iran', KOR: 'South Korea', PRK: 'North Korea', USA: 'United States', GBR: 'United Kingdom', SYR: 'Syria', VNM: 'Vietnam', CHN: 'China', BOL: 'Bolivia', VEN: 'Venezuela', TZA: 'Tanzania', LAO: 'Laos', MDA: 'Moldova', COD: 'DR Congo', COG: 'Republic of the Congo' }[iso3] ?? countries.getName(iso3, 'en') ?? iso3);
const countryInfo = Object.fromEntries([...new Set([...Object.keys(allCountries), ...focusIsos])].map((iso3) => [iso3, { name: countryName(iso3), numeric: countries.alpha3ToNumeric(iso3) }]));

const week = isoWeek(now);
const snapshot = {
  schema: 1,
  week,
  generated_at: new Date().toISOString(),
  window: { start: windowStart.toISOString(), end: now.toISOString(), days: windowDays, widened: windowDays !== (sources.window_days ?? 7) },
  method: 'Themes are counted from the titles, summaries and tags of the news, analysis and official items published in the window, using the keyword lists in config/themes.json. Countries are matched by name and by the aliases in config/places.json. The region of interest is the set of countries most often named in items about the most prevalent theme. Ties between themes are broken by the number of distinct sources covering them, then by how many country mentions they carry.',
  totals: { items: weekItems.length, sources: [...new Set(weekItems.map((i) => i.source))].length },
  top_theme: top.id,
  themes: themeStats,
  top_themes: topThemes.map((t) => t.id),
  top10,
  focus,
  context_indicators: contextIds,
  mentions: allCountries,
  countries: countryInfo,
  news: weekItems.sort((a, b) => b.date - a.date).map((it) => ({ type: it.type, title: it.title, link: it.link, date: it.date.toISOString(), source: it.source, publisher: it.publisher, author: it.author, summary: it.summary.slice(0, 320), tags: it.tags.slice(0, 6), themes: it.themes, countries: it.countries })),
  indicators,
  markets,
  sources: { config: sources.news.map(({ id, name, publisher, homepage, note, enabled }) => ({ id, name, publisher, homepage, note, enabled })), statuses },
};

await fs.mkdir(path.join(root, 'data/snapshots'), { recursive: true });
await fs.writeFile(path.join(root, `data/snapshots/${week}.json`), JSON.stringify(snapshot, null, 1));
await fs.writeFile(path.join(root, 'data/latest.json'), JSON.stringify(snapshot, null, 1));
const index = (await fs.readdir(path.join(root, 'data/snapshots'))).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).sort().reverse();
await fs.writeFile(path.join(root, 'data/index.json'), JSON.stringify({ weeks: index }, null, 1));
console.log(`\n${week}: ${weekItems.length} items in ${windowDays} days. Top theme: ${top.label} (${top.items}). Focus: ${focus.map((f) => f.iso3 + ':' + f.n).join(', ')}`);
