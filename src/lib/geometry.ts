import type { Note, NoteImage, NoteSource, Panel, PanelRect, ReadingDirection } from '../types';
import { formatDate } from '../i18n';
import { sortReadingOrder } from '../../shared/panelOrder';

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

export { applyGroupOrder, normalizeGroupOrder, sortReadingOrder } from '../../shared/panelOrder';

/** Reading order shared with the desktop edition and every exporter. */
export function sortPanels(panels: Panel[], dir: ReadingDirection): Panel[] {
  return sortReadingOrder(panels, dir, (panel) => panel.rect);
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
