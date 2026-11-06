# Geopolitical Dashboard

A weekly, citable snapshot of the most prevalent geopolitical theme: where it is happening, the news and analysis behind it, and the economic and governance indicators for the countries involved. Built for an academic audience, for general knowledge and preliminary analysis.

## What each page shows

1. A world map that marks the region of interest for the week's most prevalent theme.
2. A zoomable, clickable map of that region, with each country's indicators.
3. A list of the relevant news and analysis, each with its source, date, link and a ready-made citation.
4. A country context block for the region's countries: indicators chosen for the week's top theme (set per theme in `config/themes.json`), plus a 10-year political-stability trend as the risk score.
5. Charts for the leading themes: theme prevalence and an event timeline.
5. A sources table that shows every request made for the snapshot, whether it loaded, and when.

Every page is one self-contained HTML file (data, code and map inside), so it opens offline and can be saved with **Save as webpage**. **Download PDF** gives a print-ready A4 portrait version, always in dark mode, laid out over 7 pages: summary and world view; region map and country card; country context; event timeline; theme prevalence; sources (the news list stays on the web page).

## Run it

```bash
npm ci
node scripts/snapshot.mjs          # fetch sources, write data/snapshots/<week>.json
node scripts/build.mjs --pdf       # write dist/index.html, dist/weeks/<week>.html and .pdf
```

`--pdf` needs Playwright with Chromium. Behind an HTTP proxy, run the snapshot with `NODE_USE_ENV_PROXY=1`.

## Change the sources

All of it is configuration, not code:

| File | What it controls |
|---|---|
| `config/sources.json` | News feeds (any RSS or Atom URL) and indicators (World Bank codes, IMF DataMapper codes). Indicators marked `"library": true` are fetched only when the top theme asks for them. Set `"enabled": false` to switch one off. |
| `config/themes.json` | The themes and the keywords that count an item toward each. |
| `config/places.json` | Extra names that point to countries, such as demonyms, capitals and regions. |

## Weekly update

`.github/workflows/weekly.yml` runs every Monday at 06:00 UTC. It takes the snapshot, commits it to `data/`, builds the pages and PDF, and publishes `dist/` to GitHub Pages. Past weeks stay available in `dist/weeks/` and in the week picker.

## Sources and licences

- World Bank: World Development Indicators and Worldwide Governance Indicators (CC BY 4.0).
- International Monetary Fund: World Economic Outlook via DataMapper.
- Geopolitical Monitor and RAND Corporation: headlines, short summaries and links from their public feeds. Full articles stay on the publishers' sites.
- BBC News World and UN News: headlines, summaries and links from their official RSS feeds.
- Boundaries: Natural Earth via world-atlas (public domain).
