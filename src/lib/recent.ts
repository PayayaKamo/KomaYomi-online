/**
 * Recently opened pages, persisted in localStorage.
 *
 * Entries are keyed by volume + chapter so paging through a chapter updates one
 * row instead of filling the list. Entries whose volume/chapter no longer exists
 * in the library are kept (so the user can see and remove them) and flagged by
 * the File menu.
 */

const KEY = 'komayomi.recent-pages';
/** The submenu scrolls, so the cap can be generous without stretching the File menu. */
const LIMIT = 50;

export type RecentPage = {
  volume: string;
  chapter: string;
  pageIndex: number;
  /** ISO timestamp of the last visit, so it can reuse the shared date formatter */
  at: string;
};

const isEntry = (value: unknown): value is RecentPage => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.volume === 'string' &&
    typeof v.chapter === 'string' &&
    typeof v.pageIndex === 'number' &&
    typeof v.at === 'string'
  );
};

export function readRecent(): RecentPage[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

function write(list: RecentPage[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT)));
  } catch {
    /* private mode / quota: recents are best-effort */
  }
}

export function pushRecent(entry: Omit<RecentPage, 'at'>): RecentPage[] {
  const next = [
    { ...entry, at: new Date().toISOString() },
    ...readRecent().filter((item) => item.volume !== entry.volume || item.chapter !== entry.chapter),
  ].slice(0, LIMIT);
  write(next);
  return next;
}

export function removeRecent(volume: string, chapter: string): RecentPage[] {
  const next = readRecent().filter((item) => item.volume !== volume || item.chapter !== chapter);
  write(next);
  return next;
}

export function clearRecent(): RecentPage[] {
  write([]);
  return [];
}
