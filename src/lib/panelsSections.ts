/**
 * Which panel-workspace sections are expanded. The sidebar used to stack the grid
 * builder, templates and the JSON path on separate rows even when they were not in
 * use, so those sections now collapse to a single rail entry and remember the choice.
 * Annotations and groups keep their own headers; they share the same store so the
 * "Display" menu and the arrows can never disagree.
 */
import { useSyncExternalStore } from 'react';

export type PanelSection = 'grid' | 'template' | 'path' | 'ann' | 'groups';

export const PANEL_SECTIONS: PanelSection[] = ['grid', 'template', 'path', 'ann', 'groups'];

/** Low-frequency tools start folded; annotations and groups stay open as before. */
const DEFAULTS: Record<PanelSection, boolean> = {
  grid: false,
  template: false,
  path: false,
  ann: true,
  groups: true,
};

const STORAGE_KEY = 'komayomi.panels-sections';

function isSection(value: unknown): value is PanelSection {
  return PANEL_SECTIONS.includes(value as PanelSection);
}

function load(): Record<PanelSection, boolean> {
  const state = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return state;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return state;
    for (const id of PANEL_SECTIONS) {
      const value = (parsed as Record<string, unknown>)[id];
      if (typeof value === 'boolean') state[id] = value;
    }
  } catch {
    /* corrupted or blocked storage: fall back to the defaults */
  }
  return state;
}

let current: Record<PanelSection, boolean> = load();
const listeners = new Set<() => void>();

function commit(next: Record<PanelSection, boolean>): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the choice still applies for this session */
  }
  for (const listener of listeners) listener();
}

export function getPanelSections(): Record<PanelSection, boolean> {
  return current;
}

export function setPanelSection(id: PanelSection, open: boolean): void {
  if (!isSection(id) || current[id] === open) return;
  commit({ ...current, [id]: open });
}

export function togglePanelSection(id: PanelSection): void {
  if (!isSection(id)) return;
  commit({ ...current, [id]: !current[id] });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the caller whenever any section is expanded or folded. */
export function usePanelSections(): Record<PanelSection, boolean> {
  return useSyncExternalStore(subscribe, getPanelSections);
}
