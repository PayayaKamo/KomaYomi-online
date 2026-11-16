import type { PanelGroup, PanelRect, ReadingDirection } from './types.ts';
import { isRightToLeft, isVerticalReading } from './types.ts';

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Canonical panel reading order shared by the canvas, compare view and every exporter.
 *
 * Explicit `number` wins: a hand-saved order is stored that way, so the UI, navigation
 * and exports must all read the same sequence for the same panel data.
 *
 * Otherwise panels are grouped into rows (horizontal directions) or columns (vertical
 * directions), the groups follow the direction, and members follow the group axis.
 * Legacy `rtl`/`ltr` are horizontal aliases and `ttb` is a vertical alias.
 */
export function sortReadingOrder<T>(
  items: T[],
  dir: ReadingDirection,
  getRect: (item: T) => PanelRect = (item) => item as unknown as PanelRect,
): T[] {
  const list = [...items];
  if (list.length < 2) return list;

  const numberOf = (item: T) => {
    const value = (item as { number?: unknown }).number;
    return typeof value === 'number' ? value : null;
  };
  if (list.some((item) => numberOf(item) !== null)) {
    return list.sort((a, b) => (numberOf(a) ?? Number.MAX_SAFE_INTEGER) - (numberOf(b) ?? Number.MAX_SAFE_INTEGER));
  }

  const rects = list.map((item) => ({ item, rect: getRect(item) }));
  const centerX = (r: PanelRect) => r.x + r.w / 2;
  const centerY = (r: PanelRect) => r.y + r.h / 2;

  if (isVerticalReading(dir)) {
    const medianW = median(rects.map((r) => r.rect.w)) || 0.2;
    const columns: (typeof rects)[] = [];
    const xSorted = [...rects].sort((a, b) =>
      isRightToLeft(dir) ? centerX(b.rect) - centerX(a.rect) : centerX(a.rect) - centerX(b.rect),
    );
    for (const r of xSorted) {
      const cx = centerX(r.rect);
      const group = columns.find((g) => Math.abs(centerX(g[0].rect) - cx) < medianW * 0.6);
      if (group) group.push(r);
      else columns.push([r]);
    }
    return columns.flatMap((g) => [...g].sort((a, b) => a.rect.y - b.rect.y).map((r) => r.item));
  }

  const medianH = median(rects.map((r) => r.rect.h)) || 0.2;
  const rows: (typeof rects)[] = [];
  const ySorted = [...rects].sort((a, b) => centerY(a.rect) - centerY(b.rect));
  for (const r of ySorted) {
    const cy = centerY(r.rect);
    const group = rows.find((g) => Math.abs(centerY(g[0].rect) - cy) < medianH * 0.6);
    if (group) group.push(r);
    else rows.push([r]);
  }
  return rows.flatMap((g) =>
    [...g].sort((a, b) => (isRightToLeft(dir) ? b.rect.x - a.rect.x : a.rect.x - b.rect.x)).map((r) => r.item),
  );
}

/**
 * Reorder an already reading-ordered panel list so members of a group stay together.
 *
 * Groups are anchored at the reading position of their first member, members follow the
 * order stored in `group.panelIds`, and panels that belong to no group keep their
 * natural reading position. This is the single ordering rule shared by the canvas,
 * export and compare navigation.
 */
export function applyGroupOrder<T extends { id: string }>(ordered: T[], groups: PanelGroup[] | undefined): T[] {
  if (!groups?.length) return ordered;
  const byId = new Map(ordered.map((panel) => [panel.id, panel]));
  const groupOf = new Map<string, PanelGroup>();
  for (const group of groups) {
    if (!group?.panelIds?.length) continue;
    for (const id of group.panelIds) {
      if (byId.has(id) && !groupOf.has(id)) groupOf.set(id, group);
    }
  }
  if (!groupOf.size) return ordered;

  const out: T[] = [];
  const placed = new Set<string>();
  for (const panel of ordered) {
    if (placed.has(panel.id)) continue;
    const group = groupOf.get(panel.id);
    if (!group) {
      out.push(panel);
      placed.add(panel.id);
      continue;
    }
    for (const id of group.panelIds) {
      const member = byId.get(id);
      if (member && !placed.has(id)) {
        out.push(member);
        placed.add(id);
      }
    }
  }
  return out;
}

/**
 * Sort groups and their members to match the reading order: groups by their first
 * member, members by their reading position. Used by the one-click “sort by group”.
 */
export function normalizeGroupOrder(groups: PanelGroup[], readingOrder: string[]): PanelGroup[] {
  const rank = new Map(readingOrder.map((id, index) => [id, index]));
  const rankOf = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  return groups
    .map((group) => ({
      ...group,
      panelIds: [...group.panelIds].sort((a, b) => rankOf(a) - rankOf(b)),
    }))
    .sort((a, b) => rankOf(a.panelIds[0] ?? '') - rankOf(b.panelIds[0] ?? ''));
}
