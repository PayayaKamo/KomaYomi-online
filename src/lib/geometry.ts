import type { Note, NoteImage, NoteSource, Panel, PanelRect, ReadingDirection } from '../types';
import { formatDate } from '../i18n';

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function normalizeRect(rect: PanelRect): PanelRect {
  const x = clamp01(rect.x);
  const y = clamp01(rect.y);
  const w = Math.min(1 - x, Math.max(0.02, rect.w));
  const h = Math.min(1 - y, Math.max(0.02, rect.h));
  return { x, y, w, h };
}

/** Convert a pointer position into page-normalized coordinates. */
export function pointToNorm(el: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return {
    x: clamp01((clientX - r.left) / r.width),
    y: clamp01((clientY - r.top) / r.height),
  };
}

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';

export function applyDrag(start: PanelRect, handle: ResizeHandle, dx: number, dy: number, minSize = 0.02): PanelRect {
  let { x, y, w, h } = start;
  if (handle === 'move') {
    x = Math.min(1 - w, Math.max(0, x + dx));
    y = Math.min(1 - h, Math.max(0, y + dy));
    return { x, y, w, h };
  }
  if (handle.includes('w')) {
    const nx = Math.min(x + w - minSize, Math.max(0, x + dx));
    w += x - nx;
    x = nx;
  }
  if (handle.includes('e')) {
    w = Math.min(1 - x, Math.max(minSize, w + dx));
  }
  if (handle.includes('n')) {
    const ny = Math.min(y + h - minSize, Math.max(0, y + dy));
    h += y - ny;
    y = ny;
  }
  if (handle.includes('s')) {
    h = Math.min(1 - y, Math.max(minSize, h + dy));
  }
  return { x, y, w, h };
}

export function unionRects(rects: PanelRect[]): PanelRect {
  if (!rects.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export { applyGroupOrder, normalizeGroupOrder } from '../../shared/panelOrder';

/** Reading order matching the server: rtl = right-to-left within a row, ltr = left-to-right,
 *  ttb = top-to-bottom within columns ordered right-to-left. */
export function sortPanels(panels: Panel[], dir: ReadingDirection): Panel[] {
  if (panels.length < 2) return panels;
  // A hand-saved order is stored as explicit numbers; it wins over the geometry so
  // every view (compare, export, thumbnails) reads the same sequence.
  if (panels.some((p) => typeof p.number === 'number')) {
    return [...panels].sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER));
  }
  if (dir === 'ttb') {
    const mw = median(panels.map((p) => p.rect.w)) || 0.2;
    const cols: Panel[][] = [];
    for (const p of [...panels].sort((a, b) => b.rect.x + b.rect.w / 2 - (a.rect.x + a.rect.w / 2))) {
      const cx = p.rect.x + p.rect.w / 2;
      const group = cols.find((g) => Math.abs(g[0].rect.x + g[0].rect.w / 2 - cx) < mw * 0.6);
      if (group) group.push(p);
      else cols.push([p]);
    }
    return cols.flatMap((g) => [...g].sort((a, b) => a.rect.y - b.rect.y));
  }
  const mh = median(panels.map((p) => p.rect.h)) || 0.2;
  const rows: Panel[][] = [];
  for (const p of [...panels].sort((a, b) => a.rect.y + a.rect.h / 2 - (b.rect.y + b.rect.h / 2))) {
    const cy = p.rect.y + p.rect.h / 2;
    const group = rows.find((g) => Math.abs(g[0].rect.y + g[0].rect.h / 2 - cy) < mh * 0.6);
    if (group) group.push(p);
    else rows.push([p]);
  }
  return rows.flatMap((g) => [...g].sort((a, b) => (dir === 'rtl' ? b.rect.x - a.rect.x : a.rect.x - b.rect.x)));
}

export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function newNote(
  scope: 'page' | 'panel',
  panelId: string | null,
  text: string,
  tags: string[],
  source?: NoteSource,
  /** Pasted/dropped screenshots; kept inline so the page JSON stays self-contained. */
  images?: NoteImage[],
): Note {
  const now = new Date().toISOString();
  return {
    id: uid('n'),
    scope,
    panelId,
    text,
    tags,
    source,
    images: images?.length ? images : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/** Extract the hostname from a link so note sources can be told apart at a glance. */
export function sourceDomain(source?: NoteSource): string {
  if (!source?.url) return source?.text?.slice(0, 24) ?? '';
  try {
    return new URL(source.url).hostname.replace(/^www\./, '');
  } catch {
    return source.url.slice(0, 24);
  }
}

/** Locale-aware note timestamp; kept as a named export for existing callers. */
export function formatTime(iso: string): string {
  return formatDate(iso);
}
