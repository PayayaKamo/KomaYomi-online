import type { PanelGroup } from './types.ts';

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
