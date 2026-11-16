import type { AlignOffset, Lang, Note, NoteAnchor, Panel, PanelRect } from './types';

/**
 * Note anchors: pins on the artwork that tie one or more notes to a spot on the page.
 *
 * Coordinates are whole-page fractions (0..1), like annotation anchors, so a pin stays on
 * the same artwork detail when the canvas is zoomed, the window resized or the language
 * columns are shifted by their alignment offsets. The `lang` on the anchor follows the same
 * lane rule as annotations: a pin belongs to one language column and is only shown there.
 */

const EPSILON = 1e-6;

/** Same lane rule as annotations: no lane at all = every column, missing lang = shared. */
export function noteAnchorMatchesLang(anchor: NoteAnchor, lang?: Lang | null): boolean {
  if (!lang) return true;
  if (!anchor.lang) return true;
  return anchor.lang === lang;
}

export function anchorInRect(point: { x: number; y: number }, rect: PanelRect): boolean {
  return (
    point.x >= rect.x - EPSILON &&
    point.x <= rect.x + rect.w + EPSILON &&
    point.y >= rect.y - EPSILON &&
    point.y <= rect.y + rect.h + EPSILON
  );
}

export function clampToRect(point: { x: number; y: number }, rect: PanelRect): { x: number; y: number } {
  return {
    x: Math.min(rect.x + rect.w, Math.max(rect.x, point.x)),
    y: Math.min(rect.y + rect.h, Math.max(rect.y, point.y)),
  };
}

export type NoteAnchorGroup = {
  /** Stable key: same position, same lane and same owner panel share one dot. */
  key: string;
  x: number;
  y: number;
  lang: Lang;
  notes: Note[];
};

/**
 * Anchored notes visible in one pane, grouped by position.
 * Panel notes only show in their own panel; page notes show in whichever panel contains
 * the pin, so a whole-page note does not sprout a dot in every cell.
 */
export function groupAnchoredNotes(notes: Note[], panel: Panel, lang: Lang): NoteAnchorGroup[] {
  const groups = new Map<string, NoteAnchorGroup>();
  for (const note of notes) {
    const anchor = note.anchor;
    if (!anchor) continue;
    if (!noteAnchorMatchesLang(anchor, lang)) continue;
    if (note.scope === 'panel' && note.panelId !== panel.id) continue;
    // A panel note always belongs to its own cell, so an out-of-cell pin is pulled to the edge
    // instead of vanishing; a page note only shows where its pin really is.
    if (note.scope !== 'panel' && !anchorInRect(anchor, panel.rect)) continue;
    const point = note.scope === 'panel' ? clampToRect(anchor, panel.rect) : anchor;
    const key = `${note.scope === 'panel' ? panel.id : 'page'}:${point.x.toFixed(3)}:${point.y.toFixed(3)}`;
    const existing = groups.get(key);
    if (existing) existing.notes.push(note);
    else groups.set(key, { key, x: point.x, y: point.y, lang, notes: [note] });
  }
  return [...groups.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Page point → fraction inside the rendered pane.
 * Mirrors the layer transforms: the offset `translate(off) scale(s)` is about the element
 * centre, and the detail view applies an extra zoom around that same centre.
 */
export function pagePointToPane(
  point: { x: number; y: number },
  rect: PanelRect,
  offset: AlignOffset,
  zoom = 1,
): { u: number; v: number } {
  if (rect.w <= 0 || rect.h <= 0) return { u: 0.5, v: 0.5 };
  const scale = offset.scale || 1;
  const du = ((point.x - rect.x) / rect.w - 0.5) * scale + offset.x;
  const dv = ((point.y - rect.y) / rect.h - 0.5) * scale + offset.y;
  return { u: 0.5 + du * zoom, v: 0.5 + dv * zoom };
}

/** Inverse of `pagePointToPane`: a click inside a pane → page coordinates. */
export function panePointToPage(
  u: number,
  v: number,
  rect: PanelRect,
  offset: AlignOffset,
  zoom = 1,
): { x: number; y: number } {
  const scale = offset.scale || 1;
  const z = zoom || 1;
  const localU = 0.5 + ((u - 0.5) / z - offset.x) / scale;
  const localV = 0.5 + ((v - 0.5) / z - offset.y) / scale;
  return { x: rect.x + localU * rect.w, y: rect.y + localV * rect.h };
}
