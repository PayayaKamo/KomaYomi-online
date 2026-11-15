import type { Annotation, ExportConfig, Lang, Note, PageDoc, Panel, PageEntry } from '../../shared/types.ts';
import { orderPageIndices } from '../../shared/types.ts';
import { escapeHtml, renderMarkdown } from '../../shared/markdown.ts';
import { applyGroupOrder } from '../../shared/panelOrder.ts';
import { sortPanels } from '../lib/geometry';
import { t, langLabel } from '../i18n';
import { getPage } from './db';
import { loadLibrary, pageKey } from './projectStore';

const OFFSET_BY_LANG = (doc: PageDoc, lang: Lang) => doc.offsets?.[lang] ?? { x: 0, y: 0, scale: 1 };

async function toDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function safeName(input: string): string {
  return input.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'export';
}

function annotationSvg(annotations: Annotation[], scope: 'page' | 'panel', panelId?: string): string {
  const list = annotations.filter(
    (annotation) => annotation.scope === scope && (scope === 'page' || (annotation.panelId ?? null) === (panelId ?? null)),
  );
  if (!list.length) return '';
  const parts: string[] = [];
  for (const annotation of list) {
    const color = annotation.color ?? '#e0563c';
    const width = annotation.width ?? 4;
    const opacity = annotation.opacity ?? 1;
    const points = annotation.points.map((point) => ({ x: point.x * 1000, y: point.y * 1000 }));
    const common = `stroke="${color}" stroke-width="${width}" fill="none" opacity="${opacity}"`;
    if (annotation.kind === 'arrow' && points.length >= 2) {
      const [from, to] = points;
      parts.push(`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" ${common} marker-end="url(#arrow)" />`);
    } else if (annotation.kind === 'pen' && points.length >= 2) {
      parts.push(
        `<polyline points="${points.map((point) => `${point.x},${point.y}`).join(' ')}" ${common} stroke-linecap="round" stroke-linejoin="round" />`,
      );
    } else if ((annotation.kind === 'rect' || annotation.kind === 'highlight' || annotation.kind === 'mosaic') && points.length >= 2) {
      const [a, b] = points;
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(a.x - b.x);
      const h = Math.abs(a.y - b.y);
      const fill =
        annotation.kind === 'highlight' ? color : annotation.kind === 'mosaic' ? '#808080' : 'none';
      parts.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${common} fill="${fill}" fill-opacity="${annotation.kind === 'rect' ? 0 : 0.35}" />`,
      );
    } else if (annotation.kind === 'ellipse' && points.length >= 2) {
      const [a, b] = points;
      parts.push(
        `<ellipse cx="${(a.x + b.x) / 2}" cy="${(a.y + b.y) / 2}" rx="${Math.abs(a.x - b.x) / 2}" ry="${Math.abs(a.y - b.y) / 2}" ${common} />`,
      );
    } else if ((annotation.kind === 'text' || annotation.kind === 'badge') && points.length) {
      const point = points[0];
      parts.push(
        `<text x="${point.x}" y="${point.y}" fill="${color}" font-size="${annotation.fontSize ?? 28}" opacity="${opacity}">${escapeHtml(annotation.text ?? '')}</text>`,
      );
    }
  }
  return `<svg class="anno" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
  ${parts.join('\n  ')}
</svg>`;
}

function noteBlock(note: Note, panelNo: number | null, tags: string[]): string {
  const source = note.source
    ? `<p class="src">${escapeHtml(
        [note.source.title, note.source.url, note.source.text].filter(Boolean).join(' · '),
      )}</p>`
    : '';
  const tagHtml = note.tags?.length
    ? `<p class="tags">${note.tags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join(' ')}</p>`
    : '';
  const label = panelNo ? `<span class="note-no">${escapeHtml(t('format.panel', { number: panelNo }))}</span>` : '';
  return `<div class="note">${label}<div class="note-body">${renderMarkdown(note.text ?? '')}${source}${tagHtml}</div></div>`;
}

function panelNotes(doc: PageDoc, ordered: Panel[], onlyTags: string[], filterTags: boolean): string {
  const rows: string[] = [];
  for (const [index, panel] of ordered.entries()) {
    const notes = (doc.notes ?? []).filter(
      (note) =>
        note.scope === 'panel' &&
        note.panelId === panel.id &&
        (!filterTags || !onlyTags.length || (note.tags ?? []).some((tag) => onlyTags.includes(tag))),
    );
    for (const note of notes) rows.push(noteBlock(note, panel.number ?? index + 1, note.tags ?? []));
  }
  return rows.join('');
}

function pageNotes(doc: PageDoc, onlyTags: string[], filterTags: boolean): string {
  return (doc.notes ?? [])
    .filter(
      (note) =>
        note.scope === 'page' && (!filterTags || !onlyTags.length || (note.tags ?? []).some((tag) => onlyTags.includes(tag))),
    )
    .map((note) => noteBlock(note, null, note.tags ?? []))
    .join('');
}

type RenderPage = {
  index: number;
  entry: PageEntry;
  doc: PageDoc | undefined;
  ordered: Panel[];
  images: Partial<Record<Lang, string>>;
};

function renderImages(page: RenderPage, config: ExportConfig, languages: Lang[]): string {
  const available = languages.filter((lang) => page.images[lang]);
  if (!available.length) {
    return `<p class="missing">${escapeHtml('No image is available for this page in the online edition.')}</p>`;
  }
  const cells = available.map((lang) => {
    const offset = page.doc ? OFFSET_BY_LANG(page.doc, lang) : { x: 0, y: 0, scale: 1 };
    const transform = `translate(${offset.x * 100}%, ${offset.y * 100}%) scale(${offset.scale})`;
    const boxes = config.showPanelBoxes
      ? page.ordered
          .map(
            (panel, index) =>
              `<span class="pbox" style="left:${panel.rect.x * 100}%;top:${panel.rect.y * 100}%;width:${panel.rect.w * 100}%;height:${panel.rect.h * 100}%">${panel.number ?? index + 1}</span>`,
          )
          .join('')
      : '';
    const annotations =
      page.doc && page.doc.annotationsVisible !== false
        ? annotationSvg(page.doc.annotations ?? [], 'page')
        : '';
    const panelAnnotations = (page.doc?.panels ?? [])
      .map((panel) =>
        page.doc && page.doc.annotationsVisible !== false
          ? `<div class="panel-anno" style="left:${panel.rect.x * 100}%;top:${panel.rect.y * 100}%;width:${panel.rect.w * 100}%;height:${panel.rect.h * 100}%">${annotationSvg(page.doc.annotations ?? [], 'panel', panel.id)}</div>`
          : '',
      )
      .join('');
    return `<figure class="shot">
  <div class="shot-frame">
    <div class="shot-inner" style="transform:${transform}"><img src="${page.images[lang]}" alt="" /></div>
    ${annotations}${panelAnnotations}${boxes}
  </div>
  <figcaption>${escapeHtml(langLabel(lang))}</figcaption>
</figure>`;
  });
  return `<div class="shots">${cells.join('')}</div>`;
}

function renderPage(page: RenderPage, config: ExportConfig, languages: Lang[], onlyTags: string[]): string {
  const filterTags = Boolean(config.noteFilterTags?.length);
  const notes = config.includeNotes
    ? `<div class="notes">
    ${page.doc ? pageNotes(page.doc, onlyTags, filterTags) : ''}
    ${page.doc ? panelNotes(page.doc, page.ordered, onlyTags, filterTags) : ''}
  </div>`
    : '';
  const images = renderImages(page, config, languages);
  const head = `<h2>${escapeHtml(t('format.page', { page: page.index + 1 }))}</h2>`;
  if (config.template === 'two-column') {
    return `<section class="page two-column">${head}<div class="cols"><div class="col-images">${images}</div><div class="col-notes">${notes}</div></div></section>`;
  }
  if (config.template === 'compare-wide') {
    return `<section class="page compare-wide">${head}${images}${notes}</section>`;
  }
  return `<section class="page stack">${head}${images}${notes}</section>`;
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: #fff; color: #111; font: 15px/1.65 -apple-system, "Segoe UI", "Noto Sans", "Noto Sans CJK SC", sans-serif; }
header.doc { max-width: 1100px; margin: 0 auto 24px; border-bottom: 2px solid #111; padding-bottom: 12px; }
header.doc h1 { margin: 0 0 6px; font-size: 26px; }
header.doc p { margin: 0; color: #555; font-size: 13px; }
.page { max-width: 1100px; margin: 0 auto 32px; padding-top: 8px; border-top: 1px solid #e3e3e3; break-inside: avoid; page-break-inside: avoid; }
.page h2 { font-size: 18px; margin: 0 0 12px; }
.two-column .cols { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.stack .shots { display: grid; gap: 14px; }
.compare-wide .shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
.shots { display: grid; gap: 12px; }
.two-column .shots { grid-template-columns: 1fr; }
figure.shot { margin: 0; }
.shot-frame { position: relative; overflow: hidden; background: #f2f2f2; border: 1px solid #ddd; }
.shot-inner { transform-origin: center; }
.shot-inner img { display: block; width: 100%; height: auto; }
figcaption { font-size: 12px; color: #666; padding-top: 4px; }
.anno { position: absolute; inset: 0; width: 100%; height: 100%; color: #e0563c; pointer-events: none; }
.panel-anno { position: absolute; pointer-events: none; }
.pbox { position: absolute; display: flex; align-items: flex-start; justify-content: flex-start; font-size: 11px; font-weight: 700; color: #fff; background: rgba(224, 86, 60, 0.82); padding: 1px 5px; border-radius: 0 0 6px 0; }
.notes { margin-top: 12px; display: grid; gap: 10px; }
.note { display: grid; grid-template-columns: auto 1fr; gap: 8px; background: #faf7f2; border: 1px solid #eadfce; border-radius: 8px; padding: 10px 12px; break-inside: avoid; }
.note-no { font-size: 12px; font-weight: 700; color: #b0492f; white-space: nowrap; }
.note-body > :first-child { margin-top: 0; }
.note-body > :last-child { margin-bottom: 0; }
.note-body p, .note-body ul, .note-body ol, .note-body blockquote { margin: 0 0 6px; }
.note-body code { background: #f0e9df; padding: 1px 4px; border-radius: 4px; font-size: 12px; }
.note-body pre { background: #2b2b2b; color: #f5f5f5; padding: 8px; border-radius: 6px; overflow: auto; }
.note-body table { border-collapse: collapse; }
.note-body td, .note-body th { border: 1px solid #d8cfc0; padding: 3px 6px; }
.src { font-size: 12px; color: #777; margin: 2px 0 0; word-break: break-all; }
.tags { margin: 4px 0 0; font-size: 12px; color: #9a6a3a; display: flex; flex-wrap: wrap; gap: 6px; }
.missing { color: #a33; font-size: 13px; background: #fdf0ee; border: 1px dashed #d8998c; padding: 10px; border-radius: 6px; }
footer.doc { max-width: 1100px; margin: 32px auto 0; color: #777; font-size: 12px; border-top: 1px solid #e3e3e3; padding-top: 10px; }
@page { size: A4; margin: 12mm; }
@media print {
  body { padding: 0; font-size: 11pt; }
  header.doc, .page { max-width: none; }
  .page { break-before: page; page-break-before: always; }
  .page:first-of-type { break-before: auto; page-break-before: auto; }
  .two-column .cols { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); }
  .shot-frame { border: 0; background: transparent; }
  .shot-inner img { max-height: 225mm; width: auto; max-width: 100%; margin: 0 auto; }
  .pbox { background: #b0492f; }
  .note { background: #fafafa; }
  a { color: inherit; text-decoration: none; }
}
`;

export type HtmlExportResult = { blob: Blob; filename: string; pages: number; warnings: string[] };

export async function exportHtml(config: ExportConfig): Promise<HtmlExportResult> {
  const library = await loadLibrary();
  if (!library) throw new Error(t('online.noProject'));
  const volume = library.volumes.find((item) => item.id === config.volume);
  const chapter = volume?.chapters.find((item) => item.chapter === config.chapter);
  if (!volume || !chapter) throw new Error('Chapter not found in the opened project.');

  const english = t('export.pageNotes');
  const warnings: string[] = [];
  const available = chapter.pages.filter((page) => !page.excluded);
  const indices = config.pageIndices?.length
    ? orderPageIndices(config.pageIndices, available)
    : available.map((page) => page.index);
  const languages = (config.languages?.length ? config.languages : volume.languages).filter((lang) =>
    volume.languages.includes(lang),
  );

  const renderPages: RenderPage[] = [];
  for (const index of indices) {
    const entry = chapter.pages.find((page) => page.index === index);
    if (!entry) continue;
    const doc = (await getPage<PageDoc>(pageKey(volume.id, chapter.chapter, index))) ?? undefined;
    if (config.onlyWithNotes && !(doc && (doc.notes ?? []).length)) continue;
    const ordered = applyGroupOrder(sortPanels(doc?.panels ?? [], doc?.readingDirection ?? 'rtl'), doc?.groups);
    const images: Partial<Record<Lang, string>> = {};
    for (const lang of languages) {
      const url = entry.files[lang];
      if (!url) continue;
      const dataUrl = await toDataUrl(url);
      if (dataUrl) images[lang] = dataUrl;
      else warnings.push(`${t('format.page', { page: index + 1 })}: ${langLabel(lang)} image could not be read.`);
    }
    renderPages.push({ index, entry, doc, ordered, images });
  }

  if (!renderPages.length) throw new Error(english + ' — ' + 'nothing matched the selected pages.');

  const title = config.title?.trim() || t('export.defaultTitle', { chapter: chapter.title || chapter.chapter });
  const body = renderPages.map((page) => renderPage(page, config, languages, config.noteFilterTags ?? [])).join('\n');
  const stamp = new Date().toISOString().slice(0, 10);
  const printScript = config.print
    ? `<script>window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 300); });</script>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="doc"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(
    [volume.title, chapter.title || chapter.chapter, stamp].filter(Boolean).join(' · '),
  )}</p></header>
${body}
<footer class="doc">${escapeHtml('Exported from KomaYomi Online — images embedded in this single file.')}</footer>
${printScript}
</body>
</html>`;

  const filename = `${safeName(title)}${config.print ? '-print' : ''}.html`;
  return {
    blob: new Blob([html], { type: 'text/html;charset=utf-8' }),
    filename,
    pages: renderPages.length,
    warnings,
  };
}

