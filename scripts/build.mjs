// Builds self-contained HTML pages from the snapshots:
//   dist/index.html            latest week
//   dist/weeks/<week>.html     every week (archive)
// Each page carries its own data, code and map, so it works offline and can be saved as-is.
// Usage: node scripts/build.mjs [--pdf]   (--pdf also renders dist/weeks/<week>.pdf with Playwright)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFile(p, 'utf8');
const withPdf = process.argv.includes('--pdf');

const tpl = await read(path.join(root, 'app/index.html'));
const style = await read(path.join(root, 'app/style.css'));
const app = await read(path.join(root, 'app/app.js'));
const d3 = await read(path.join(root, 'node_modules/d3/dist/d3.min.js'));
const topo = await read(path.join(root, 'node_modules/topojson-client/dist/topojson-client.min.js'));
const world = await read(path.join(root, 'node_modules/world-atlas/countries-50m.json'));
const weeks = JSON.parse(await read(path.join(root, 'data/index.json'))).weeks;

// keep </script> inside data from closing the tag
const safe = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const fill = (snapshot, { base, pdf }) => '<!doctype html>\n' + tpl
  .replace('/*STYLE*/', () => style)
  .replace('/*D3*/', () => safe(d3))
  .replace('/*TOPOJSON*/', () => safe(topo))
  .replace('/*WORLD*/', () => safe(world))
  .replace('/*WEEKS*/', () => JSON.stringify(weeks))
  .replace('/*SNAPSHOT*/', () => snapshot.replace(/</g, '\\u003c'))
  .replace('/*APP*/', () => safe(app))
  .replace('/*PDF*/', pdf)
  .replace('/*BASE*/', base);

await fs.mkdir(path.join(root, 'dist/weeks'), { recursive: true });
for (const w of weeks) {
  const snap = await read(path.join(root, `data/snapshots/${w}.json`));
  await fs.writeFile(path.join(root, `dist/weeks/${w}.html`), fill(snap, { base: '../', pdf: `${w}.pdf` }));
}
const latest = weeks[0];
await fs.writeFile(path.join(root, 'dist/index.html'), fill(await read(path.join(root, `data/snapshots/${latest}.json`)), { base: '', pdf: `weeks/${latest}.pdf` }));
console.log(`Built dist/index.html and ${weeks.length} weekly page(s).`);

if (withPdf) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  for (const w of weeks.slice(0, 1)) {
    await page.goto('file://' + path.join(root, `dist/weeks/${w}.html`), { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print', colorScheme: 'light' });
    await page.waitForTimeout(800);
    await page.pdf({ path: path.join(root, `dist/weeks/${w}.pdf`), format: 'A4', landscape: true, printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
    console.log(`Rendered dist/weeks/${w}.pdf`);
  }
  await browser.close();
}
