/* Geopolitical Dashboard: renders one weekly snapshot.
   Expects globals d3, topojson, window.WORLD (world-atlas TopoJSON) and window.SNAPSHOT. */
(function () {
  'use strict';
  const PRISTINE = '<!doctype html>\n' + document.documentElement.outerHTML;
  // Colour mode: dark by default; ?theme=light|dark in the URL or the viewer's last choice overrides it.
  const urlTheme = new URLSearchParams(location.search).get('theme');
  let savedTheme = null; try { savedTheme = localStorage.getItem('geo-theme'); } catch (e) { /* storage blocked */ }
  const theme0 = ['light', 'dark'].includes(urlTheme) ? urlTheme : ['light', 'dark'].includes(savedTheme) ? savedTheme : 'dark';
  document.documentElement.setAttribute('data-theme', theme0);
  const S = window.SNAPSHOT;
  const $ = (sel, el = document) => el.querySelector(sel);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmtDate = d3.utcFormat('%-d %b %Y');
  const fmtDay = d3.utcFormat('%a %-d %b');
  const fmtShort = d3.utcFormat('%-d %b');
  const themeById = new Map(S.themes.map((t) => [t.id, t]));
  const topTheme = themeById.get(S.top_theme);
  const topThemes = S.top_themes.map((id) => themeById.get(id));
  const themeVar = (id) => `--t${themeById.get(id)?.idx ?? 10}`;
  const themeColor = (id) => css(themeVar(id));
  let selTheme = S.top_theme;
  const top10 = (S.top10 ?? Object.entries(S.mentions).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([iso3, n]) => ({ iso3, n }))).map((t) => t.iso3);
  function setTheme(id) { selTheme = id; renderThemes(); renderTimeline(); }
  const cname = (iso3) => S.countries[iso3]?.name ?? iso3;
  const sourceName = (id) => S.sources.config.find((s) => s.id === id)?.name ?? id;
  const ind = Object.fromEntries(S.indicators.map((i) => [i.id, i]));

  // ---------- geography ----------
  const world = topojson.feature(WORLD, WORLD.objects.countries);
  world.features = world.features.filter((f) => f.id !== '010'); // Antarctica
  const byNumeric = new Map(world.features.map((f) => [f.id, f]));
  const isoByNumeric = new Map(Object.entries(S.countries).map(([iso3, c]) => [c.numeric, iso3]));
  const featureFor = (iso3) => byNumeric.get(S.countries[iso3]?.numeric);
  const themeMentions = topTheme.byCountry;
  const focusIsos = S.focus.map((f) => f.iso3).filter((i) => featureFor(i));
  const maxM = d3.max(Object.values(themeMentions)) || 1;
  const seq = () => d3.scaleQuantize([0, maxM], ['--seq-1', '--seq-2', '--seq-3', '--seq-4'].map(css));
  const fillFor = (iso3) => { const n = themeMentions[iso3]; return n ? seq()(n) : css('--land'); };

  // ---------- text ----------
  function renderText() {
    const w = S.window;
    const wkNum = S.week.split('-W')[1];
    $('#dateline').textContent = `Week ${+wkNum}, ${S.week.slice(0, 4)} · ${fmtDate(new Date(w.start))} to ${fmtDate(new Date(w.end))} · snapshot taken ${fmtDate(new Date(S.generated_at))}`;
    $('#top-theme').textContent = topTheme.label;
    const names = S.focus.slice(0, 4).map((f) => cname(f.iso3));
    $('#lede-text').textContent = `${topTheme.label} was the most prevalent theme this period, appearing in ${topTheme.items} of ${S.totals.items} analysis and news items (${d3.format('.0%')(topTheme.share)}). Coverage of it centred on ${listJoin(names)}. ` + (topThemes[1] ? `The next most prevalent themes were ${topThemes.slice(1).map((t) => t.label).join(' and ')}.` : '');
    $('#f-theme').firstChild.textContent = d3.format('.0%')(topTheme.share);
    $('#f-theme-sub').textContent = `of items touch on the theme`;
    $('#f-region').firstChild.textContent = cname(S.focus[0]?.iso3) || '—';
    $('#f-region-sub').textContent = S.focus.length > 1 ? `with ${listJoin(S.focus.slice(1, 4).map((f) => cname(f.iso3)))}` : '';
    $('#f-items').firstChild.textContent = d3.format(',')(S.totals.items);
    $('#f-items-sub').textContent = `from ${S.totals.sources} sources over ${S.window.days} days${S.window.widened ? ' (window widened for coverage)' : ''}`;
    document.title = `Geopolitical Dashboard · ${S.week}`;
  }
  const listJoin = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a.at(-1));

  // ---------- tooltip ----------
  function tipFor(container) {
    let t = container.querySelector(':scope > .tip');
    if (!t) { t = document.createElement('div'); t.className = 'tip'; t.hidden = true; container.append(t); }
    return {
      show(ev, rows) {
        t.replaceChildren(...rows.map((r, i) => { const d = document.createElement('div'); if (i === 0 && r.head) d.className = 'h'; if (r.color) { const s = document.createElement('span'); s.className = 'sw'; s.style.background = r.color; d.append(s); } d.append(r.text); return d; }));
        t.hidden = false;
        const b = container.getBoundingClientRect();
        let x = ev.clientX - b.left + 14, y = ev.clientY - b.top + 14;
        if (x + t.offsetWidth > b.width) x = ev.clientX - b.left - t.offsetWidth - 14;
        if (y + t.offsetHeight > b.height) y = Math.max(0, ev.clientY - b.top - t.offsetHeight - 10);
        t.style.left = Math.max(0, x) + 'px'; t.style.top = y + 'px';
      },
      hide() { t.hidden = true; },
    };
  }
  const countryTip = (iso3) => {
    const rows = [{ head: true, text: cname(iso3) }];
    rows.push({ text: `${fmtN(themeMentions[iso3] || 0)} ${topTheme.label} mentions` });
    if (S.mentions[iso3]) rows.push({ text: `${fmtN(S.mentions[iso3])} mentions across all themes` });
    return rows;
  };
  const fmtN = (n) => (Number.isInteger(n) ? d3.format(',')(n) : d3.format('.1f')(n));

  // ---------- (i) world overview map ----------
  function renderWorld() {
    const el = $('#world-map');
    el.replaceChildren();
    const W = el.clientWidth || 600, H = Math.round(W * 0.52);
    const proj = d3.geoNaturalEarth1().fitExtent([[4, 4], [W - 4, H - 4]], { type: 'Sphere' });
    const path = d3.geoPath(proj);
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
      .attr('aria-label', `World map highlighting the region of interest for ${topTheme.label}`);
    svg.append('path').attr('class', 'grat').attr('d', path(d3.geoGraticule10()));
    const tip = tipFor(el);
    svg.append('g').selectAll('path').data(world.features).join('path')
      .attr('class', (f) => 'country' + (isoByNumeric.has(f.id) ? ' hit' : ''))
      .attr('d', path).style('fill', (f) => fillFor(isoByNumeric.get(f.id)))
      .on('pointermove', (ev, f) => { const iso = isoByNumeric.get(f.id); if (iso) tip.show(ev, countryTip(iso)); else tip.hide(); })
      .on('pointerleave', () => tip.hide())
      .on('click', (ev, f) => { const iso = isoByNumeric.get(f.id); if (iso) { selectCountry(iso); zoomTo(iso); } });

    // pointer: a ring around the weighted centre of the region of interest
    const pts = S.focus.filter((f) => featureFor(f.iso3)).slice(0, 4);
    if (!pts.length) return;
    const [x, y] = path.centroid(featureFor(pts[0].iso3));
    const r = Math.max(14, W * 0.05);
    const g = svg.append('g');
    g.append('circle').attr('class', 'roi pulse').attr('cx', x).attr('cy', y).attr('r', r);
    g.append('circle').attr('class', 'roi').attr('cx', x).attr('cy', y).attr('r', r);
    g.append('circle').attr('class', 'roi-dot').attr('cx', x).attr('cy', y).attr('r', 3.5);
    const right = x < W * 0.4;
    const lx = right ? x + r + 12 : x - r - 12, ly = Math.max(16, y - r * 0.6);
    g.append('line').attr('x1', x + (right ? r : -r) * 0.72).attr('y1', y - r * 0.7).attr('x2', lx + (right ? -4 : 4)).attr('y2', ly).attr('stroke', css('--bad')).attr('stroke-width', 1.2);
    g.append('text').attr('class', 'callout').attr('x', lx).attr('y', ly - 2).attr('text-anchor', right ? 'start' : 'end').text('Region of interest');
    g.append('text').attr('class', 'callout').attr('x', lx).attr('y', ly + 13).attr('text-anchor', right ? 'start' : 'end').style('font-weight', 400).text(listJoin(pts.slice(0, 3).map((f) => cname(f.iso3))));
  }

  function renderTopCountries() {
    const ol = $('#top-countries'); ol.replaceChildren();
    const rows = top10.map((iso) => [iso, S.mentions[iso] || 0]);
    const max = rows[0]?.[1] || 1;
    rows.forEach(([iso, n]) => {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.textContent = cname(iso);
      const bar = document.createElement('i'); bar.style.width = `${(n / max) * 100}%`;
      if (themeMentions[iso]) bar.classList.add('on');
      const val = document.createElement('b'); val.textContent = fmtN(n);
      const track = document.createElement('span'); track.className = 'track'; track.append(bar);
      li.append(name, track, val);
      li.onclick = () => { selectCountry(iso); zoomTo(iso); };
      ol.append(li);
    });
  }

  // ---------- (ii) zoomable regional map ----------
  let zoomTo = () => {};
  function renderRegion() {
    const el = $('#region-map');
    el.querySelectorAll('svg').forEach((n) => n.remove());
    const W = el.clientWidth || 700, H = Math.round(W * 0.78);
    const feats = focusIsos.map(featureFor);
    if (!feats.length) return;
    const c = d3.geoCentroid(feats[0]);
    const proj = d3.geoMercator().rotate([-c[0], 0]);
    const a0 = d3.geoArea(feats[0]);
    const fc = { type: 'FeatureCollection', features: feats.filter((f, i) => i === 0 || d3.geoArea(f) < a0 * 6) };
    proj.fitExtent([[30, 30], [W - 30, H - 30]], fc);
    const path = d3.geoPath(proj);
    const svg = d3.select(el).insert('svg', ':first-child').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
      .attr('aria-label', `Zoomable map of the region of interest: ${focusIsos.map(cname).join(', ')}`);
    const g = svg.append('g');
    g.append('path').attr('class', 'grat').attr('d', path(d3.geoGraticule().step([5, 5])()));
    const tip = tipFor(el);
    g.append('g').selectAll('path').data(world.features).join('path')
      .attr('class', (f) => 'country' + (isoByNumeric.has(f.id) ? ' hit' : ''))
      .attr('data-iso', (f) => isoByNumeric.get(f.id) || null)
      .attr('d', path).style('fill', (f) => fillFor(isoByNumeric.get(f.id)))
      .on('pointermove', (ev, f) => { const iso = isoByNumeric.get(f.id); if (iso) tip.show(ev, countryTip(iso)); else tip.hide(); })
      .on('pointerleave', () => tip.hide())
      .on('click', (ev, f) => { const iso = isoByNumeric.get(f.id); if (iso) selectCountry(iso); });
    const labels = g.append('g').selectAll('text').data(focusIsos).join('text').attr('class', 'lbl')
      .attr('text-anchor', 'middle').text(cname)
      .each(function (iso) { const p = path.centroid(featureFor(iso)); d3.select(this).attr('x', p[0]).attr('y', p[1]); });

    const zoom = d3.zoom().scaleExtent([1, 14]).translateExtent([[-W, -H], [2 * W, 2 * H]])
      .on('zoom', (ev) => { g.attr('transform', ev.transform); labels.style('font-size', `${11 / ev.transform.k}px`).style('stroke-width', `${3 / ev.transform.k}px`); });
    svg.call(zoom);
    const zb = $('.zoombar', el);
    zb.querySelector('[data-z="in"]').onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1.6);
    zb.querySelector('[data-z="out"]').onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.6);
    zb.querySelector('[data-z="reset"]').onclick = () => svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
    zoomTo = (iso) => {
      const f = featureFor(iso); if (!f) return;
      const [[x0, y0], [x1, y1]] = path.bounds(f);
      if (!isFinite(x0)) return;
      const k = Math.min(10, 0.8 / Math.max((x1 - x0) / W, (y1 - y0) / H));
      svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(Math.max(1, k)).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };

    // legend
    const lg = $('#region-legend');
    lg.replaceChildren();
    const ramp = document.createElement('span'); ramp.className = 'ramp';
    ['--seq-1', '--seq-2', '--seq-3', '--seq-4'].forEach((v) => { const i = document.createElement('i'); i.style.background = css(v); ramp.append(i); });
    const lo = document.createElement('span'); lo.textContent = 'Fewer';
    const hi = document.createElement('span'); hi.textContent = `More mentions (max ${fmtN(maxM)})`;
    lg.append(lo, ramp, hi);
  }

  function selectCountry(iso) {
    d3.selectAll('#region-map .country').classed('sel', function () { return this.dataset.iso === iso; });
    const box = $('#country-detail');
    box.replaceChildren();
    const h = document.createElement('h5'); h.textContent = cname(iso); box.append(h);
    const dl = document.createElement('dl');
    const add = (k, v) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); };
    add(`${topTheme.label} mentions`, fmtN(themeMentions[iso] || 0));
    add('Mentions, all themes', fmtN(S.mentions[iso] || 0));
    const order = ['population', 'gdp', 'gdp_growth', 'inflation', 'military', 'pol_stability', 'imf_gdp_proj'];
    for (const i of [...S.indicators].sort((a, b) => (order.indexOf(a.id) + 99) % 99 - (order.indexOf(b.id) + 99) % 99)) {
      const v = latest(i, iso);
      add(i.short, v ? `${fmtVal(i, v.value)} (${v.year})` : 'No data');
    }
    const wrapper = document.createElement('div'); wrapper.append(dl); box.append(wrapper);
    const related = S.news.filter((n) => n.countries.includes(iso)).slice(0, 3);
    if (related.length) {
      const p = document.createElement('p'); p.className = 'hint'; p.style.marginTop = '8px';
      p.append('Recent items: ');
      related.forEach((n, k) => { const a = document.createElement('a'); a.href = n.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = n.title; p.append(a); if (k < related.length - 1) p.append(' · '); });
      box.append(p);
    }
  }
  const latest = (i, iso, maxYear = new Date(S.generated_at).getUTCFullYear()) => {
    const vs = i.values.filter((v) => v.iso3 === iso && v.year <= maxYear);
    return vs.length ? vs.reduce((a, b) => (b.year > a.year ? b : a)) : null;
  };
  const big = (v) => d3.format('.3~s')(v).replace('G', 'B');
  const fmtVal = (i, v) => (i.unit.startsWith('%') ? d3.format('.1f')(v) + '%' : i.unit === 'people' || i.unit === 'TIV' ? big(v) : i.unit === 'US$' ? '$' + big(v) : d3.format('+.2f')(v));

  // ---------- (iv) charts ----------
  function measure(svg, strings) {
    const t = svg.append('text'); let m = 0;
    strings.forEach((s) => { t.text(s); m = Math.max(m, t.node().getComputedTextLength()); });
    t.remove(); return m;
  }

  function renderThemes() {
    const el = $('#chart-themes'); el.querySelectorAll('svg').forEach((n) => n.remove());
    const rows = S.themes.filter((t) => t.items > 0);
    const W = el.clientWidth || 500, rowH = 38, H = rows.length * rowH;
    const svg = d3.select(el).insert('svg', ':first-child').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Share of items by theme');
    const vw = measure(svg, ['100%']) + 8;
    const x = d3.scaleLinear([0, d3.max(rows, (r) => r.share)], [0, W - vw]);
    const y = (id) => rows.findIndex((r) => r.id === id) * rowH + 18;
    const y_bw = 12; const yb = { bandwidth: () => y_bw };
    const tip = tipFor(el);
    const g = svg.append('g').selectAll('g').data(rows).join('g');
    g.append('text').attr('x', 0).attr('y', (r) => y(r.id) - 5).style('fill', css('--ink')).style('font-weight', (r) => (r.id === selTheme ? 600 : 400)).text((r) => `${r.label} (${r.items})`);
    g.append('rect').attr('x', 0).attr('y', (r) => y(r.id)).attr('height', y_bw).attr('rx', 3)
      .attr('width', (r) => Math.max(2, x(r.share))).attr('fill', (r) => themeColor(r.id)).attr('fill-opacity', (r) => (r.id === selTheme ? 1 : 0.4));
    g.append('text').attr('class', 'val').attr('x', (r) => x(r.share) + 6).attr('y', (r) => y(r.id) + y_bw / 2).attr('dy', '.32em').text((r) => d3.format('.0%')(r.share));
    g.append('rect').attr('x', 0).attr('width', W).attr('y', (r) => y(r.id) - 18).attr('height', rowH).attr('fill', 'transparent').style('cursor', 'pointer')
      .on('click', (ev, r) => setTheme(r.id))
      .on('pointermove', (ev, r) => tip.show(ev, [{ head: true, text: r.label }, { text: `${r.items} of ${S.totals.items} items (${d3.format('.0%')(r.share)})` }, { text: 'By source: ' + Object.entries(r.bySource).map(([s, n]) => `${sourceName(s)} ${n}`).join(', ') }, { text: 'Select to follow this theme' }]))
      .on('pointerleave', () => tip.hide());
  }

  function renderTimeline() {
    const el = $('#chart-timeline'); el.querySelectorAll('svg').forEach((n) => n.remove());
    const days = Object.keys(topTheme.byDay).map((d) => new Date(d + 'T00:00:00Z'));
    const W = el.clientWidth || 500, H = 200;
    const svg = d3.select(el).insert('svg', ':first-child').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Items per day for the top themes');
    const shown = [...new Set([...S.top_themes, selTheme])].map((id) => themeById.get(id));
    const maxY = Math.max(2, d3.max(shown, (t) => d3.max(Object.values(t.byDay))));
    const endW = measure(svg, shown.map((t) => shortLabel(t.label)));
    const m = { t: 10, r: Math.min(endW + 12, W * 0.4), b: 24, l: 26 };
    const x = d3.scaleUtc(d3.extent(days), [m.l, W - m.r]);
    const y = d3.scaleLinear([0, maxY], [H - m.b, m.t]).nice();
    svg.append('g').attr('class', 'grid').selectAll('line').data(y.ticks(Math.min(4, maxY))).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y).attr('y2', y);
    svg.append('g').selectAll('text').data(y.ticks(Math.min(4, maxY)).filter(Number.isInteger)).join('text').attr('x', m.l - 6).attr('y', y).attr('dy', '.32em').attr('text-anchor', 'end').text((d) => d);
    const xa = svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickValues(days.slice(0, -1).filter((d, i, arr) => i % Math.max(1, Math.ceil(arr.length / Math.floor((W - m.l - m.r) / 60))) === 0)).tickFormat(fmtShort).tickSizeOuter(0));
    xa.attr('font-size', null).attr('font-family', null);
    const line = d3.line().x((d) => x(d[0])).y((d) => y(d[1]));
    const series = shown.map((t) => ({ t, pts: days.map((d) => [d, t.byDay[d.toISOString().slice(0, 10)] || 0]) }));
    svg.append('g').selectAll('path').data(series).join('path').attr('d', (s) => line(s.pts)).attr('fill', 'none')
      .attr('stroke', (s) => themeColor(s.t.id)).attr('stroke-width', (s) => (s.t.id === selTheme ? 3 : 1.5)).attr('stroke-opacity', (s) => (s.t.id === selTheme ? 1 : 0.55)).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
    const ends = series.map((s) => ({ s, y: y(s.pts.at(-1)[1]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    svg.append('g').selectAll('text').data(ends).join('text').attr('x', W - m.r + 6).attr('y', (e) => e.y).attr('dy', '.32em').style('fill', css('--ink')).style('font-weight', (e) => (e.s.t.id === selTheme ? 600 : 400)).text((e) => shortLabel(e.s.t.label));
    // legend
    const lg = $('#timeline-legend'); lg.replaceChildren();
    S.themes.filter((t) => t.items > 0).forEach((t) => {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(t.id === selTheme));
      const sw = document.createElement('i'); sw.className = 'sw'; sw.style.background = themeColor(t.id);
      b.append(sw, `${t.label} (${t.items})`); b.onclick = () => setTheme(t.id); lg.append(b);
    });
    // hover
    const tip = tipFor(el);
    const rule = svg.append('line').attr('y1', m.t).attr('y2', H - m.b).attr('stroke', css('--axis')).attr('visibility', 'hidden');
    const dots = svg.append('g').selectAll('circle').data(series).join('circle').attr('r', 4).attr('fill', (s) => themeColor(s.t.id)).attr('stroke', css('--surface')).attr('stroke-width', 2).attr('visibility', 'hidden');
    svg.append('rect').attr('x', m.l).attr('y', 0).attr('width', W - m.l - m.r).attr('height', H).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [px] = d3.pointer(ev);
        const d = d3.least(days, (t) => Math.abs(x(t) - px)); const k = days.indexOf(d);
        rule.attr('x1', x(d)).attr('x2', x(d)).attr('visibility', 'visible');
        dots.attr('visibility', 'visible').attr('cx', x(d)).attr('cy', (s) => y(s.pts[k][1]));
        tip.show(ev, [{ head: true, text: fmtDay(d) }, ...series.map((s) => ({ color: themeColor(s.t.id), text: `${s.t.label}: ${s.pts[k][1]} items` }))]);
      })
      .on('pointerleave', () => { rule.attr('visibility', 'hidden'); dots.attr('visibility', 'hidden'); tip.hide(); });

    // event timeline list
    const ul = $('#event-list'); ul.replaceChildren();
    const sel = themeById.get(selTheme);
    const items = S.news.filter((n) => n.themes.includes(selTheme));
    $('#event-title').textContent = `${sel.label}: ${items.length} item${items.length === 1 ? '' : 's'}, newest first`;
    items.forEach((n) => {
      const li = document.createElement('li'); li.style.setProperty('--dot', themeColor(selTheme));
      const t = document.createElement('time'); t.dateTime = n.date; t.textContent = fmtDay(new Date(n.date));
      const a = document.createElement('a'); a.href = n.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = n.title;
      const row = document.createElement('div'); row.className = 'row';
      row.append(kindTag(n), themeTag(selTheme));
      const s = document.createElement('span'); s.textContent = n.publisher; row.append(s);
      li.append(t, a, row); ul.append(li);
    });
  }
  function themeTag(id) { const s = document.createElement('span'); s.className = 'tag theme'; s.style.setProperty('--tc', themeColor(id)); s.textContent = themeById.get(id)?.label ?? id; return s; }
  const KINDS = { news: 'News', analysis: 'Analysis', official: 'Official' };
  function kindTag(n) { const k = KINDS[n.type] ? n.type : 'news'; const s = document.createElement('span'); s.className = 'tag kind ' + k; s.textContent = KINDS[k]; return s; }
  const shortLabel = (l) => (l.length > 22 ? l.split(/[ ,]/)[0] + '…' : l);

  // ---------- country context: theme indicators + stability trend ----------
  function renderContext() {
    const regionIsos = focusIsos;
    const cols = (S.context_indicators ?? []).map((id) => ind[id]).filter(Boolean);
    $('#ctx-title').textContent = `Country context: ${topTheme.label}`;
    // table
    const table = $('#ctx-table');
    const thead = table.tHead.rows[0]; thead.replaceChildren();
    const th = (t) => { const e = document.createElement('th'); e.textContent = t; thead.append(e); };
    th('Country');
    cols.forEach((c) => th(`${c.short} (${unitLabel(c)})`));
    const tb = table.tBodies[0]; tb.replaceChildren();
    regionIsos.forEach((iso) => {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td'); td0.textContent = cname(iso); tr.append(td0);
      cols.forEach((c) => {
        const td = document.createElement('td');
        const v = latest(c, iso);
        if (!v) { td.textContent = '—'; td.className = 'na'; tr.append(td); return; }
        const wrap = document.createElement('div'); wrap.className = 'cell';
        const val = document.createElement('span'); val.textContent = fmtVal(c, v.value);
        const yr = document.createElement('small'); yr.textContent = v.year;
        wrap.append(val, yr);
        const pts = c.values.filter((x) => x.iso3 === iso).sort((p, q) => p.year - q.year).slice(-10);
        if (pts.length > 2) {
          const w = 72, h = 18;
          const sx = d3.scaleLinear(d3.extent(pts, (p) => p.year), [2, w - 3]);
          const sy = d3.scaleLinear(d3.extent([...pts.map((p) => p.value), 0]), [h - 2, 2]);
          const svg = d3.select(wrap).append('svg').attr('width', w).attr('height', h).attr('aria-label', `${c.short} ${pts[0].year} to ${pts.at(-1).year}`);
          svg.append('path').attr('d', d3.line().x((p) => sx(p.year)).y((p) => sy(p.value))(pts)).attr('fill', 'none').attr('stroke', css('--ink-2')).attr('stroke-width', 1.25).attr('stroke-linejoin', 'round');
          svg.append('circle').attr('cx', sx(pts.at(-1).year)).attr('cy', sy(pts.at(-1).value)).attr('r', 2.2).attr('fill', css('--ink'));
        }
        td.append(wrap); tr.append(td);
      });
      tr.style.cursor = 'pointer';
      tr.onclick = () => { selectCountry(iso); zoomTo(iso); };
      tb.append(tr);
    });
    // political stability small multiples, one shared scale
    const box = $('#ctx-stability'); box.replaceChildren();
    const ps = ind.pol_stability;
    const series = regionIsos.map((iso) => ({ iso, pts: ps.values.filter((v) => v.iso3 === iso).sort((p, q) => p.year - q.year) })).filter((s) => s.pts.length > 1);
    const years = d3.extent(series.flatMap((s) => s.pts.map((p) => p.year)));
    series.forEach((s) => {
      const fig = document.createElement('figure'); fig.className = 'mult';
      const cap = document.createElement('figcaption');
      const nm = document.createElement('span'); nm.textContent = cname(s.iso);
      const last = s.pts.at(-1), first = s.pts[0];
      const vl = document.createElement('b'); vl.textContent = `${d3.format('+.2f')(last.value)} (${last.year})`;
      const ch = document.createElement('small'); const d = last.value - first.value; ch.textContent = `${d3.format('+.2f')(d)} since ${first.year}`;
      ch.className = d < 0 ? 'down' : 'up';
      cap.append(nm, vl, ch); fig.append(cap);
      box.append(fig);
      const W = fig.clientWidth || 260, H = 74, m = { l: 26, r: 6, t: 6, b: 16 };
      const x = d3.scaleLinear(years, [m.l, W - m.r]);
      const y = d3.scaleLinear([-2.5, 2.5], [H - m.b, m.t]);
      const svg = d3.select(fig).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', `Political stability in ${cname(s.iso)}, ${first.year} to ${last.year}`);
      svg.append('rect').attr('x', m.l).attr('width', W - m.l - m.r).attr('y', y(0)).attr('height', y(-2.5) - y(0)).attr('fill', css('--div-neg')).attr('fill-opacity', 0.07);
      svg.append('g').attr('class', 'grid').selectAll('line').data([-2, 2]).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y).attr('y2', y);
      svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', css('--axis'));
      svg.append('g').selectAll('text').data([-2, 0, 2]).join('text').attr('x', m.l - 4).attr('y', y).attr('dy', '.32em').attr('text-anchor', 'end').text((v) => (v > 0 ? '+' : '') + v);
      svg.append('g').selectAll('text').data(years).join('text').attr('x', x).attr('y', H - 3).attr('text-anchor', (v, i) => (i ? 'end' : 'start')).text((v) => v);
      svg.append('path').attr('d', d3.line().x((p) => x(p.year)).y((p) => y(p.value))(s.pts)).attr('fill', 'none').attr('stroke', last.value < 0 ? css('--div-neg') : css('--div-pos')).attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round');
      svg.append('circle').attr('cx', x(last.year)).attr('cy', y(last.value)).attr('r', 3).attr('fill', last.value < 0 ? css('--div-neg') : css('--div-pos'));
      const tip = tipFor(fig);
      svg.append('rect').attr('x', m.l).attr('y', 0).attr('width', W - m.l - m.r).attr('height', H).attr('fill', 'transparent')
        .on('pointermove', (ev) => { const [px] = d3.pointer(ev); const p = d3.least(s.pts, (q) => Math.abs(x(q.year) - px)); tip.show(ev, [{ head: true, text: `${cname(s.iso)}, ${p.year}` }, { text: `Political stability ${d3.format('+.2f')(p.value)}` }]); })
        .on('pointerleave', () => tip.hide());
    });
    if (!series.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'No political stability data for these countries.'; box.append(p); }
    // citations
    const c = $('#ctx-cite'); c.replaceChildren();
    [...cols, ps].forEach((i, k) => { if (k) c.append(document.createElement('br')); c.append(citeNode(i)); });
  }
  const unitLabel = (c) => (c.unit.startsWith('index') ? 'index' : c.unit === 'people' ? 'people' : c.unit === 'US$' ? 'US$' : c.unit.startsWith('%') ? c.unit.replace('% of ', '% ') : c.unit);

  function citeNode(i) {
    const span = document.createElement('span');
    span.append(`Source: ${i.publisher}, “${i.label}” (${i.code}). `);
    const a = document.createElement('a'); a.href = i.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open dataset'; span.append(a);
    span.append(`. Retrieved ${fmtDate(new Date(S.generated_at))}.`);
    if (i.status !== 'ok') span.append(' Not available in this snapshot.');
    return span;
  }

  // ---------- market signals ----------
  function renderMarkets() {
    const card = $('#markets'); const M = S.markets;
    if (!M?.series?.length) { card.hidden = true; return; }
    card.hidden = false;
    const box = $('#mk-charts'); box.replaceChildren();
    const ws = new Date(M.window.start), we = new Date(M.window.end);
    const xStart = d3.min(M.series, (m) => new Date(m.values[0]?.date + 'T12:00:00Z'));
    // three rows, each a four-column grid so every tile has the same width and height
    const ROWS = [['Commodities', ['brent', 'wti', 'gold', 'wheat']], ['Stock markets', ['spx', 'sx5e', 'n225', 'sse']], ['Currencies and rates', null]];
    const known = ROWS.flatMap(([, ids]) => ids ?? []);
    const rowOf = (id) => (known.includes(id) ? ROWS.findIndex(([, ids]) => ids?.includes(id)) : 2);
    const rank = (id) => (known.includes(id) ? known.indexOf(id) : 100);
    const items = [...M.series.map((m) => ({ m, ok: true })), ...(M.missing ?? []).map((m) => ({ m, ok: false }))]
      .sort((p, q) => rank(p.m.id) - rank(q.m.id));
    const grids = ROWS.map(([label]) => {
      const sec = document.createElement('div'); sec.className = 'mk-group';
      const h = document.createElement('h5'); h.className = 'ctx-h'; h.textContent = label;
      const g = document.createElement('div'); g.className = 'mk-row';
      sec.append(h, g); box.append(sec); return g;
    });
    const line = css('--div-neg');
    items.forEach(({ m, ok }) => {
      const grid = grids[rowOf(m.id)];
      const fig = document.createElement('figure'); fig.className = 'mult' + (ok ? '' : ' mk-missing'); fig.dataset.id = m.id;
      const cap = document.createElement('figcaption');
      const nm = document.createElement('span'); nm.textContent = m.label + (m.isos?.length ? ` (${m.isos.map(cname).join(', ')})` : '');
      cap.append(nm); fig.append(cap); grid.append(fig);
      if (!ok) {
        const w = document.createElement('small'); w.textContent = 'not available this week'; cap.append(w);
        const ph = document.createElement('div'); ph.className = 'ph'; ph.textContent = `${m.provider} did not return data (${m.column})`; fig.append(ph);
        return;
      }
      const pts = m.values.map((v) => ({ d: new Date(v.date + 'T12:00:00Z'), v: v.value }));
      if (pts.length < 2) return;
      const last = pts.at(-1);
      const before = d3.least(pts.filter((p) => p.d < ws), (p) => -p.d) ?? pts[0];
      const stale = last.d < ws;
      const pct = m.unit === '%' ? last.v - before.v : (last.v / before.v - 1) * 100;
      const fmtV = m.unit === 'US$' ? d3.format('$,.2f') : m.unit === 'USc' ? (v) => `${d3.format(',.2f')(v)}¢/bu` : m.unit === '%' ? (v) => d3.format('.2f')(v) + '%' : m.unit === 'index' ? (v) => d3.format(v >= 1000 ? ',.0f' : '.1f')(v) : (v) => (v >= 100 ? d3.format(',.0f')(v) : v >= 10 ? d3.format('.2f')(v) : d3.format('.4f')(v));
      const sub = document.createElement('div'); sub.className = 'mk-val';
      const vl = document.createElement('b'); vl.textContent = fmtV(last.v);
      const ch = document.createElement('small'); ch.textContent = stale ? `latest ${fmtDate(last.d)}, before this period` : m.unit === '%' ? `${d3.format('+.2f')(pct)} pts this period` : `${d3.format('+.1f')(pct)}% this period`;
      sub.append(vl, ch); cap.append(sub);
      const W = 260, H = 84, mg = { l: 2, r: 2, t: 8, b: 4 };
      const x = d3.scaleUtc([xStart, we], [mg.l, W - mg.r]);
      const y = d3.scaleLinear(d3.extent(pts, (p) => p.v), [H - mg.b, mg.t]).nice();
      const svg = d3.select(fig).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'none').attr('role', 'img').attr('aria-label', `${m.label}, last six months`);
      const x0 = Math.max(mg.l, x(ws)), x1 = Math.min(W - mg.r, x(we));
      svg.append('rect').attr('x', x0).attr('width', Math.max(2, x1 - x0)).attr('y', mg.t).attr('height', H - mg.b - mg.t).attr('fill', css('--band'));
      svg.append('line').attr('x1', mg.l).attr('x2', W - mg.r).attr('y1', H - mg.b).attr('y2', H - mg.b).attr('stroke', css('--axis')).attr('vector-effect', 'non-scaling-stroke');
      svg.append('path').attr('d', d3.line().x((p) => x(p.d)).y((p) => y(p.v))(pts)).attr('fill', 'none').attr('stroke', line).attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('vector-effect', 'non-scaling-stroke');
      const axis = document.createElement('div'); axis.className = 'mk-axis';
      const a0 = document.createElement('span'); a0.textContent = d3.utcFormat('%b %-d')(xStart);
      const a1 = document.createElement('span'); a1.textContent = d3.utcFormat('%b %-d')(we);
      axis.append(a0, a1);
      const dot = document.createElement('i'); dot.className = 'mk-dot'; dot.style.left = `${(x(last.d) / W) * 100}%`; dot.style.top = `${y(last.v)}px`; dot.style.background = line;
      const wrap = document.createElement('div'); wrap.className = 'mk-plot'; wrap.append(svg.node(), dot); fig.append(wrap, axis);
      const tip = tipFor(fig);
      svg.append('rect').attr('x', 0).attr('y', 0).attr('width', W).attr('height', H).attr('fill', 'transparent')
        .on('pointermove', (ev) => { const r = svg.node().getBoundingClientRect(); const px = ((ev.clientX - r.left) / r.width) * W; const p = d3.least(pts, (q) => Math.abs(x(q.d) - px)); tip.show(ev, [{ head: true, text: m.label }, { text: `${fmtDate(p.d)}: ${fmtV(p.v)}` }]); })
        .on('pointerleave', () => tip.hide());
    });
    const missing = (M.no_rate ?? []).filter((i) => i !== 'USA');
    $('#mk-note').textContent = `Daily closes over the last six months: oil, gold and wheat, four leading stock indexes, the US dollar and Treasury yield, and the region's currencies. The shaded band is this snapshot's period, and the change beside each name runs from the last value before it to the latest.${missing.length ? ` No reference exchange rate is published for ${missing.map(cname).join(', ')}.` : ''}`;
    const c = $('#mk-cite'); c.replaceChildren();
    const groups = d3.groups(M.series, (m) => m.provider + '|' + m.dataset);
    groups.forEach(([k, list], i) => {
      if (i) c.append(document.createElement('br'));
      const [prov, ds] = k.split('|');
      c.append(`Source: ${prov}, ${ds} (${list.map((m) => m.column).join(', ')}). `);
      const a = document.createElement('a'); a.href = list[0].link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open dataset'; c.append(a, `. Retrieved ${fmtDate(new Date(S.generated_at))}.`);
    });
  }

  // ---------- (iii) news ----------
  let newsFilter = 'top', newsKind = 'all';
  function renderNews() {
    const bar = $('#news-filters'); bar.replaceChildren();
    const opts = [...S.themes.filter((t) => t.items > 0).map((t) => [t.id === S.top_theme ? 'top' : t.id, t.label, t.items, t.id]), ['all', 'All items', S.news.length, null]];
    opts.forEach(([id, label, count, tid]) => {
      const b = document.createElement('button'); b.className = 'chip'; b.type = 'button';
      if (tid) { const sw = document.createElement('i'); sw.className = 'sw'; sw.style.background = themeColor(tid); b.append(sw); }
      const n = document.createElement('span'); n.className = 'n'; n.textContent = count; b.append(label, n);
      b.setAttribute('aria-pressed', String(newsFilter === id));
      b.onclick = () => { newsFilter = id; renderNews(); };
      bar.append(b);
    });
    const want = newsFilter === 'top' ? S.top_theme : newsFilter;
    const byTheme = S.news.filter((n) => want === 'all' || n.themes.includes(want));
    // type filter: click a tag to show only that type, click again (or All types) to clear
    const kb = $('#news-kinds'); kb.replaceChildren();
    const lab = document.createElement('span'); lab.className = 'klab'; lab.textContent = 'Type:'; kb.append(lab);
    [['all', 'All types', ''], ['news', 'News', 'reporting of events'], ['analysis', 'Analysis', 'commentary and research'], ['official', 'Official', 'UN and government statements, sanctions notices']].forEach(([k, label, desc]) => {
      const n = k === 'all' ? byTheme.length : byTheme.filter((x) => (KINDS[x.type] ? x.type : 'news') === k).length;
      if (k !== 'all' && !S.news.some((x) => x.type === k)) return;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'kbtn';
      b.setAttribute('aria-pressed', String(newsKind === k));
      const t = document.createElement('span'); t.className = k === 'all' ? 'tag' : 'tag kind ' + k; t.textContent = label;
      const c = document.createElement('span'); c.className = 'n'; c.textContent = n;
      b.append(t, c); if (desc) { const d = document.createElement('span'); d.className = 'desc'; d.textContent = desc; b.append(d); }
      b.disabled = k !== 'all' && n === 0 && newsKind !== k;
      b.onclick = () => { newsKind = newsKind === k ? 'all' : k; renderNews(); };
      kb.append(b);
    });
    const list = byTheme.filter((n) => newsKind === 'all' || (KINDS[n.type] ? n.type : 'news') === newsKind);
    const ul = $('#news-list'); ul.replaceChildren();
    if (!list.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = newsKind === 'all' ? 'No items for this theme in the snapshot.' : `No ${KINDS[newsKind].toLowerCase()} items for this theme in the snapshot.`; ul.append(li); }
    list.forEach((n) => {
      const li = document.createElement('li');
      const meta = document.createElement('div'); meta.className = 'meta';
      const pub = document.createElement('b'); pub.textContent = n.publisher;
      const dt = document.createElement('time'); dt.dateTime = n.date; dt.textContent = fmtDate(new Date(n.date));
      meta.prepend(kindTag(n)); meta.append(pub, dt); if (n.author) { const au = document.createElement('span'); au.textContent = n.author; meta.append(au); }
      const h = document.createElement('h5'); const a = document.createElement('a'); a.href = n.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = n.title; h.append(a);
      li.append(meta, h);
      if (n.summary) { const p = document.createElement('p'); p.textContent = n.summary.length > 260 ? n.summary.slice(0, 257).replace(/\s\S*$/, '') + '…' : n.summary; li.append(p); }
      const tags = document.createElement('div'); tags.className = 'tags';
      n.themes.forEach((t) => tags.append(themeTag(t)));
      n.countries.slice(0, 5).forEach((c) => { const s = document.createElement('span'); s.className = 'tag'; s.textContent = cname(c); tags.append(s); });
      li.append(tags);
      const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'copy'; cp.textContent = 'Copy citation';
      cp.onclick = () => copyText(cp, citation(n));
      li.append(cp);
      ul.append(li);
    });
  }
  // full list, shown only in the PDF / print version
  function renderItemsPrint() {
    const list = [...S.news].sort((a, b) => new Date(b.date) - new Date(a.date));
    $('#items-note').textContent = `All ${list.length} news and analysis items collected for this period, newest first, with the themes each one counts toward. Titles link to the original.`;
    const ol = $('#items-list'); ol.replaceChildren();
    list.forEach((n) => {
      const li = document.createElement('li');
      const meta = document.createElement('div'); meta.className = 'meta';
      const pub = document.createElement('b'); pub.textContent = n.publisher;
      const dt = document.createElement('time'); dt.dateTime = n.date; dt.textContent = fmtDate(new Date(n.date));
      meta.append(kindTag(n), pub, dt);
      if (n.author) { const au = document.createElement('span'); au.textContent = n.author; meta.append(au); }
      const h = document.createElement('a'); h.className = 'ttl'; h.href = n.link; h.textContent = n.title;
      const tags = document.createElement('div'); tags.className = 'tags';
      n.themes.forEach((t) => tags.append(themeTag(t)));
      li.append(meta, h, tags); ol.append(li);
    });
  }
  const citation = (n) => `${n.author ? n.author + '. ' : ''}(${d3.utcFormat('%Y, %B %-d')(new Date(n.date))}). ${n.title}. ${n.publisher}. ${n.link}`;
  function copyText(btn, text) {
    const done = () => { const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = o), 1400); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* leave selected */ } ta.remove();
  }

  // ---------- sources ----------
  function renderSources() {
    const tb = $('#src-table').tBodies[0]; tb.replaceChildren();
    S.sources.statuses.forEach((s) => {
      const tr = document.createElement('tr');
      const td = (content) => { const e = document.createElement('td'); if (content instanceof Node) e.append(content); else e.textContent = content; tr.append(e); return e; };
      const viaName = s.kind === 'indicator' || s.kind === 'market' || s.kind === 'events';
      td(viaName ? s.name : sourceName(s.source));
      td(viaName ? s.indicator : `${KINDS[s.type] ?? 'News'} feed`);
      const pill = document.createElement('span'); pill.className = 'pill ' + s.status; pill.textContent = s.status === 'ok' ? `Loaded (${d3.format(',')(s.items)})` : s.status === 'empty' ? 'No data' : s.status === 'skipped' ? 'Not set up' : 'Failed';
      const st = td(pill); if (s.error) { const sm = document.createElement('div'); sm.style.cssText = 'font-size:11px;color:var(--muted)'; sm.textContent = s.error; st.append(sm); }
      if (s.url) { const a = document.createElement('a'); a.href = s.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = s.url.replace(/^https?:\/\//, '').slice(0, 70) + (s.url.length > 78 ? '…' : ''); td(a); } else td('—');
      td(fmtDate(new Date(s.retrieved_at)));
      tb.append(tr);
    });
    $('#method-text').textContent = S.method;
    const url = location.protocol.startsWith('http') ? location.href.split('#')[0] : '[URL]';
    $('#cite-dashboard').textContent = `Geopolitical Dashboard. (${d3.utcFormat('%Y, %B %-d')(new Date(S.generated_at))}). Weekly snapshot ${S.week}: ${topTheme.label}. Compiled from ${[...new Set(S.sources.statuses.filter((s) => s.status === 'ok').map((s) => (s.kind === 'indicator' || s.kind === 'market' || s.kind === 'events') ? s.name.split(',')[0] : sourceName(s.source)))].join(', ')}. ${url}`;
    $('#cite-copy').onclick = (ev) => copyText(ev.currentTarget, $('#cite-dashboard').textContent);
    const failed = S.sources.statuses.filter((s) => s.status !== 'ok' && s.status !== 'skipped');
    $('#src-note').textContent = failed.length ? `${failed.length} source request${failed.length > 1 ? 's' : ''} did not load this week; the dashboard shows everything else and marks what is missing.` : 'Every configured source loaded this week.';
  }

  // ---------- export ----------
  function setupExport() {
    $('#btn-html').onclick = () => {
      const blob = new Blob([PRISTINE], { type: 'text/html' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `geopolitical-dashboard-${S.week}.html`;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    // The PDF follows the colour mode: the pre-built dark or light file on the website, the print dialog elsewhere.
    $('#btn-pdf').onclick = () => {
      const dark = document.documentElement.getAttribute('data-theme') !== 'light';
      const pdf = dark ? document.body.dataset.pdf : document.body.dataset.pdfLight;
      if (pdf && location.protocol.startsWith('http')) { const a = document.createElement('a'); a.href = pdf; a.download = ''; document.body.append(a); a.click(); a.remove(); }
      else window.print();
    };
    const tb = $('#btn-theme');
    const label = () => {
      const dark = document.documentElement.getAttribute('data-theme') !== 'light';
      tb.querySelector('span').textContent = dark ? 'Light mode' : 'Dark mode';
      tb.setAttribute('aria-pressed', String(!dark));
      tb.title = dark ? 'Switch to light mode (the PDF follows)' : 'Switch to dark mode (the PDF follows)';
    };
    label();
    tb.onclick = () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('geo-theme', next); } catch (e) { /* storage blocked */ }
      label(); redraw();
    };
    const weeks = window.WEEKS || [];
    const sel = $('#week-select');
    if (weeks.length > 1 && location.protocol.startsWith('http')) {
      weeks.forEach((w) => sel.append(new Option(w.replace('-W', ' · week '), w)));
      sel.value = S.week; sel.hidden = false;
      sel.onchange = () => { location.href = (document.body.dataset.base || '') + `weeks/${sel.value}.html`; };
    }
  }

  // ---------- boot ----------
  function drawAll() { renderWorld(); renderRegion(); renderThemes(); renderTimeline(); renderContext(); renderMarkets(); }
  renderText(); setupExport(); drawAll(); renderTopCountries(); renderNews(); renderItemsPrint(); renderSources();
  if (S.focus[0]) selectCountry(S.focus[0].iso3);
  let lastW = innerWidth;
  addEventListener('resize', () => { if (Math.abs(innerWidth - lastW) > 40) { lastW = innerWidth; drawAll(); } });
  // Charts are sized to their card, so re-draw them for the print layout and again afterwards
  addEventListener('beforeprint', drawAll);
  addEventListener('afterprint', drawAll);
  matchMedia('print').addEventListener?.('change', drawAll);
  // Re-draw everything that reads colours from the theme
  function redraw() { drawAll(); renderTopCountries(); renderNews(); renderItemsPrint(); const sel = document.querySelector('#region-map .country.sel'); if (sel) selectCountry(sel.dataset.iso); }
})();
