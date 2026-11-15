/**
 * Which panel-workspace toolbar groups are folded. The choice lives in sessionStorage:
 * it should survive switching pages or tabs in this session, but a fresh visit starts
 * from sensible defaults instead of inheriting a long-forgotten fold.
 */
import { useSyncExternalStore } from 'react';

export type ToolbarFold = 'split' | 'save' | 'view';

const FOLDS: ToolbarFold[] = ['split', 'save', 'view'];
const STORAGE_KEY = 'komayomi.panel-toolbar-folds';

/** Phones fold the secondary view group so the primary tools fit on one row. */
function defaults(): Record<ToolbarFold, boolean> {
  const narrow = typeof window !== 'undefined' && window.innerWidth <= 900;
  return { split: true, save: true, view: !narrow };
}

function isFold(value: unknown): value is ToolbarFold {
  return FOLDS.includes(value as ToolbarFold);
}

function load(): Record<ToolbarFold, boolean> {
  const state = defaults();
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return state;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return state;
    for (const id of FOLDS) {
      const value = (parsed as Record<string, unknown>)[id];
      if (typeof value === 'boolean') state[id] = value;
    }
  } catch {
    /* blocked storage: keep the defaults */
  }
  return state;
}

let current: Record<ToolbarFold, boolean> = load();
const listeners = new Set<() => void>();

function commit(next: Record<ToolbarFold, boolean>): void {
  current = next;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the fold still applies while the page stays mounted */
  }
  for (const listener of listeners) listener();
}

/** Whether the group is open. Unknown ids read as open so a typo cannot hide tools. */
export function isToolbarFoldOpen(id: ToolbarFold): boolean {
  return isFold(id) ? current[id] : true;
}

export function toggleToolbarFold(id: ToolbarFold): void {
  if (!isFold(id)) return;
  commit({ ...current, [id]: !current[id] });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useToolbarFolds(): Record<ToolbarFold, boolean> {
  return useSyncExternalStore(subscribe, () => current);
}
