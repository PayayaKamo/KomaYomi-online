import type { Annotation, Lang, PanelRect } from './types';

export const ANNOTATION_PAGE_RECT: PanelRect = { x: 0, y: 0, w: 1, h: 1 };

export type PagePoint = { x: number; y: number };
export type Leader = { from: PagePoint; to: PagePoint };

/**
 * Whether a mark belongs to one language lane.
 * Marks without `lang` predate lane scoping and there is no way to know where they were
 * drawn, so they stay visible everywhere; `allLangs` makes that choice explicit for new ones.
 */
export function annotationMatchesLang(a: Annotation, lang?: Lang | null): boolean {
  if (!lang) return true;
  if (a.allLangs) return true;
  if (!a.lang) return true;
  return a.lang === lang;
}

/** Marks to render/export for one lane. Without a lane every mark is kept. */
export function annotationsForLang(list: Annotation[], lang?: Lang | null): Annotation[] {
  return lang ? list.filter((a) => annotationMatchesLang(a, lang)) : list;
}

/** Whole page unless the annotation belongs to a panel. */
export function annotationScope(a: Annotation, panels: { id: string; rect: PanelRect }[]): PanelRect {
  if (a.scope !== 'panel') return ANNOTATION_PAGE_RECT;
  return panels.find((p) => p.id === a.panelId)?.rect ?? ANNOTATION_PAGE_RECT;
}

/** Annotation bounding box in page coordinates. */
export function annotationBBox(a: Annotation, scope: PanelRect): PanelRect {
  const xs = a.points.map((p) => scope.x + p.x * scope.w);
  const ys = a.points.map((p) => scope.y + p.y * scope.h);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Centre of the locator (point or box), in page coordinates. */
export function annotationAnchorPoint(a: Annotation): PagePoint | null {
  if (!a.anchor) return null;
  return { x: a.anchor.x + (a.anchor.w ?? 0) / 2, y: a.anchor.y + (a.anchor.h ?? 0) / 2 };
}

/**
 * Leader line between an annotation and the place it points at.
 * An explicit anchor always wins; callouts (text/badge) fall back to the centre of the
 * owning panel so annotations without anchors still get a sensible line.
 */
export function annotationLeader(a: Annotation, scope: PanelRect): Leader | null {
  if (a.showLeader === false) return null;
  const anchor = annotationAnchorPoint(a);
  const callout = a.kind === 'text' || a.kind === 'badge';
  if (!anchor && !callout) return null;

  const box = annotationBBox(a, scope);
  const from: PagePoint = callout
    ? { x: scope.x + a.points[0].x * scope.w, y: scope.y + a.points[0].y * scope.h }
    : { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const to = anchor ?? { x: scope.x + scope.w / 2, y: scope.y + scope.h / 2 };
  if (Math.hypot(to.x - from.x, to.y - from.y) < 0.002) return null;
  return { from, to };
}
