import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { dropOutbox, listOutbox, pendingOutboxCount, subscribeOutbox } from '../lib/outbox';

/** How often a queued write is retried while the tab stays open. */
const RETRY_INTERVAL_MS = 30_000;

/**
 * Replays documents queued by offline saves: on mount, when the browser reconnects,
 * every 30s while anything is pending, and on demand from the pending-count chip.
 */
export function useOutbox() {
  const [count, setCount] = useState(pendingOutboxCount);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => subscribeOutbox(() => setCount(pendingOutboxCount())), []);

  const replay = useCallback(async () => {
    if (running.current) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (!pendingOutboxCount()) return;
    running.current = true;
    setSyncing(true);
    setError(null);
    try {
      for (const entry of listOutbox()) {
        try {
          await api.savePage(entry.doc, entry.source);
          dropOutbox(entry.key);
        } catch (err) {
          // Keep the entry and stop: replaying later writes are pointless until the
          // first failure clears, and ordering matters for the version history.
          setError(err instanceof Error ? err.message : String(err));
          break;
        }
      }
    } finally {
      running.current = false;
      setSyncing(false);
      setCount(pendingOutboxCount());
    }
  }, []);

  useEffect(() => {
    void replay();
    const onOnline = () => void replay();
    window.addEventListener('online', onOnline);
    const timer = window.setInterval(() => {
      if (pendingOutboxCount() > 0) void replay();
    }, RETRY_INTERVAL_MS);
    return () => {
      window.removeEventListener('online', onOnline);
      window.clearInterval(timer);
    };
  }, [replay]);

  return { count, syncing, error, replay };
}
