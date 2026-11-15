/**
 * Where annotation tools are offered: only the reading view (default), only the panel
 * workspace, or both. Persisted so the choice survives reloads, and shared through a tiny
 * store so both views react immediately when the setting changes.
 */
import { useSyncExternalStore } from 'react';

export type AnnSurface = 'read' | 'panels' | 'both';

const STORAGE_KEY = 'komayomi.ann-surface';

function isSurface(value: unknown): value is AnnSurface {
  return value === 'read' || value === 'panels' || value === 'both';
}

function detect(): AnnSurface {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isSurface(saved)) return saved;
  } catch {
    /* storage may be unavailable in hardened contexts */
  }
  return 'read';
}

let current: AnnSurface = detect();
const listeners = new Set<() => void>();

export function getAnnSurface(): AnnSurface {
  return current;
}

export function setAnnSurface(next: AnnSurface): void {
  if (!isSurface(next) || next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode: the choice still applies for this session */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the caller whenever the annotation surface preference changes. */
export function useAnnSurface(): AnnSurface {
  return useSyncExternalStore(subscribe, getAnnSurface);
}
