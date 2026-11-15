/**
 * Offline write queue for page documents.
 *
 * When a save request fails (browser offline, server restarting, 5xx), the document is
 * kept in localStorage instead of being lost. Entries are keyed by page, so a newer
 * write always replaces the older one; replaying is therefore safe to repeat.
 */
import type { HistorySource } from '../api';
import type { PageDoc } from '../types';

const STORAGE_KEY = 'manga-memo.outbox.v1';
/** Hard cap so a long offline session cannot grow the queue without bound. */
const MAX_ENTRIES = 100;

export type OutboxEntry = {
  /** volume|chapter|pageIndex: one entry per page, latest write wins. */
  key: string;
  doc: PageDoc;
  source: HistorySource;
  at: string;
  attempts: number;
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to queue changes (enqueue / drop / clear) for the pending-count chip. */
export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function outboxKeyOf(doc: Pick<PageDoc, 'volume' | 'chapter' | 'pageIndex'>): string {
  return `${doc.volume}|${doc.chapter}|${doc.pageIndex}`;
}

function isEntry(value: unknown): value is OutboxEntry {
  const entry = value as OutboxEntry | null;
  return Boolean(
    entry &&
    typeof entry.key === 'string' &&
    typeof entry.at === 'string' &&
    entry.doc &&
    typeof entry.doc.volume === 'string' &&
    typeof entry.doc.chapter === 'string' &&
    Number.isInteger(entry.doc.pageIndex),
  );
}

function readRaw(): OutboxEntry[] {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return [];
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/**
 * Persist the queue. On a quota error, retry once after dropping pasted screenshots
 * (by far the largest field) so the note text itself always survives.
 */
function writeRaw(entries: OutboxEntry[]): boolean {
  const save = (list: OutboxEntry[]): boolean => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  };
  if (save(entries)) return true;
  const slim = entries.map((entry) => ({
    ...entry,
    doc: {
      ...entry.doc,
      notes: entry.doc.notes.map((note) => (note.images?.length ? { ...note, images: undefined } : note)),
    },
  }));
  return save(slim);
}

export function listOutbox(): OutboxEntry[] {
  return readRaw();
}

export function pendingOutboxCount(): number {
  return readRaw().length;
}

/** Queue a document for later replay; a previous entry for the same page is replaced. */
export function enqueueOutbox(doc: PageDoc, source: HistorySource = 'auto'): boolean {
  const key = outboxKeyOf(doc);
  const entries = readRaw();
  const previous = entries.find((entry) => entry.key === key);
  const next = entries.filter((entry) => entry.key !== key);
  next.push({
    key,
    doc,
    source,
    at: new Date().toISOString(),
    attempts: (previous?.attempts ?? 0) + 1,
  });
  const ok = writeRaw(next.slice(-MAX_ENTRIES));
  if (ok) emit();
  return ok;
}

export function dropOutbox(key: string): void {
  const entries = readRaw();
  const next = entries.filter((entry) => entry.key !== key);
  if (next.length === entries.length) return;
  writeRaw(next);
  emit();
}

export function clearOutbox(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Ignored when storage is unavailable. */
  }
  emit();
}
