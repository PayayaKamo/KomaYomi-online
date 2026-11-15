/**
 * Builds the bundled sample project (public/samples/demo.mnproj) from the CC0 demo
 * artwork that ships with KomaYomi. Run with `node scripts/make-sample.mjs`.
 *
 * The archive follows the .mnproj v1 layout:
 *   manifest.json, config/library.json, pages/<volume>/<chapter>/<index>.json, assets/<sha1>.<ext>
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const repoRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(repoRoot, '..', 'KomaYomi', 'samples', 'demo-library');
const volume = 'Star Cafe';
const chapter = '01';
const langs = ['ja', 'zh', 'en'];
const pages = 3;
const readingDirection = 'rtl';

const panels = [
  { id: 'p1', rect: { x: 0.04, y: 0.03, w: 0.48, h: 0.24 } },
  { id: 'p2', rect: { x: 0.54, y: 0.03, w: 0.42, h: 0.28 } },
  { id: 'p3', rect: { x: 0.04, y: 0.3, w: 0.4, h: 0.3 } },
  { id: 'p4', rect: { x: 0.48, y: 0.34, w: 0.48, h: 0.26 } },
  { id: 'p5', rect: { x: 0.04, y: 0.63, w: 0.56, h: 0.33 } },
  { id: 'p6', rect: { x: 0.64, y: 0.63, w: 0.32, h: 0.3 } },
];

const notesByPage = {
  0: {
    page: 'Sample project — the two characters introduce themselves over coffee. Everything on this page is original demo artwork.',
    panels: {
      p1: 'Opening panel: keep the establishing shot readable at print size.',
      p5: 'Check the lettering position when the image is scaled down.',
    },
  },
  1: {
    page: 'Second page of the sample chapter. Try adding your own note here.',
    panels: {
      p3: 'Example of a panel note: the balloon sits close to the border.',
      p6: 'Panel notes can be tagged, e.g. #pacing.',
    },
  },
  2: {
    page: 'Last page of the sample. Export this chapter to HTML or PNG to see the result.',
    panels: {
      p2: 'Compare the Japanese, Chinese and English wording side by side.',
    },
  },
};

const entries = {};
const images = [];
const sha1 = (data) => createHash('sha1').update(data).digest('hex');
const now = new Date().toISOString();

for (const lang of langs) {
  for (let index = 0; index < pages; index += 1) {
    const name = `${String(index + 1).padStart(3, '0')}.png`;
    const file = join(sourceRoot, volume, lang, chapter, name);
    const data = readFileSync(file);
    const digest = sha1(data);
    const asset = `assets/${digest}.png`;
    entries[asset] = new Uint8Array(data);
    images.push({
      volume,
      chapter,
      pageIndex: index,
      lang,
      name,
      sha1: digest,
      size: data.length,
      path: `${volume}/${lang}/${chapter}/${name}`,
      asset,
    });
  }
}

for (let index = 0; index < pages; index += 1) {
  const notes = notesByPage[index];
  const doc = {
    schemaVersion: 1,
    volume,
    chapter,
    pageIndex: index,
    panels: panels.map((panel) => ({ ...panel, source: 'auto' })),
    groups: [],
    notes: [
      {
        id: `n-page-${index}`,
        scope: 'page',
        panelId: null,
        text: notes.page,
        tags: ['sample'],
        createdAt: now,
        updatedAt: now,
      },
      ...Object.entries(notes.panels).map(([panelId, text], i) => ({
        id: `n-${index}-${i}`,
        scope: 'panel',
        panelId,
        text,
        tags: panelId === 'p6' ? ['sample', 'pacing'] : ['sample'],
        createdAt: now,
        updatedAt: now,
      })),
    ],
    offsets: {},
    alignMode: 'page',
    panelOffsets: {},
    annotations: [],
    readingDirection,
    detectSource: 'auto',
    updatedAt: now,
  };
  entries[`pages/${volume}/${chapter}/${index}.json`] = strToU8(JSON.stringify(doc, null, 2));
}

entries['config/library.json'] = strToU8(
  JSON.stringify({ schemaVersion: 1, langOrder: langs, volumes: {} }, null, 2),
);

const manifest = {
  schemaVersion: 1,
  appVersion: '0.1.0-online',
  createdAt: now,
  updatedAt: now,
  storageMode: 'packaged',
  name: 'Star Cafe (sample)',
  language: {
    volumes: { [volume]: { ja: 'ja', zh: 'zh', en: 'en' } },
    resolved: { [volume]: { ja: 'ja', zh: 'zh', en: 'en' } },
  },
  inventory: {
    volumes: [
      {
        volume,
        languages: langs,
        langDirs: { ja: 'ja', zh: 'zh', en: 'en' },
        chapters: [{ chapter, pages, images: langs.length * pages }],
      },
    ],
    images,
    pageCount: pages,
  },
};

entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

const archive = zipSync(entries, { level: 9 });
const outDir = join(repoRoot, 'public', 'samples');
mkdirSync(dirname(join(outDir, 'demo.mnproj')), { recursive: true });
writeFileSync(join(outDir, 'demo.mnproj'), archive);
console.log(`Wrote ${join(outDir, 'demo.mnproj')} (${(archive.length / 1024).toFixed(1)} KB)`);
