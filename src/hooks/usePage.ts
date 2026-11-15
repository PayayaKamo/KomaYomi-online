import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { HistorySource } from '../api';
import { t } from '../i18n';
import { dropOutbox, enqueueOutbox, outboxKeyOf } from '../lib/outbox';
import type { PageDoc, PageEntry } from '../types';

export type Selection = { volume: string; chapter: string; pageIndex: number };

/** Save mode: auto = debounced autosave; confirm = only saves when ✓ is clicked. */
export type SaveMode = 'auto' | 'confirm';

const SAVE_MODE_KEY = 'manga-memo.save-mode';
const HISTORY_LIMIT = 60;
const HISTORY_COALESCE_MS = 600;

function readSaveMode(): SaveMode {
  try {
    return localStorage.getItem(SAVE_MODE_KEY) === 'confirm' ? 'confirm' : 'auto';
  } catch {
    return 'auto';
  }
}

const cloneDoc = (doc: PageDoc): PageDoc => JSON.parse(JSON.stringify(doc)) as PageDoc;

type State = {
  doc: PageDoc | null;
  page: PageEntry | null;
  exists: boolean;
  loading: boolean;
  error: string | null;
  detecting: boolean;
  dirty: boolean;
  saving: boolean;
};

const initial: State = {
  doc: null,
  page: null,
  exists: false,
  loading: false,
  error: null,
  detecting: false,
  dirty: false,
  saving: false,
};

/**
 * Loading / auto panel detection / saving / undo-redo for a page document.
 * auto mode debounces writes by 700ms; confirm mode writes only on commit(), and discard() reverts to disk.
 */
export function usePage(sel: Selection | null) {
  const [state, setState] = useState<State>(initial);
  const [reloadTick, setReloadTick] = useState(0);
  const [saveMode, setSaveModeState] = useState<SaveMode>(readSaveMode);
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 });

  const pending = useRef<PageDoc | null>(null);
  /** Why the pending save happened; forwarded to the cross-session version history. */
  const pendingSource = useRef<HistorySource>('auto');
  const timer = useRef<number | null>(null);
  const lastKey = useRef<string>('');
  const docRef = useRef<PageDoc | null>(null);
  const savedDoc = useRef<PageDoc | null>(null);
  const saveModeRef = useRef<SaveMode>(saveMode);
  const undoStack = useRef<PageDoc[]>([]);
  const redoStack = useRef<PageDoc[]>([]);
  const lastHistoryAt = useRef(0);

  useEffect(() => {
    saveModeRef.current = saveMode;
    try {
      localStorage.setItem(SAVE_MODE_KEY, saveMode);
    } catch {
      /* Ignored in private mode. */
    }
  }, [saveMode]);

  const syncHistoryCounts = () => {
    setHistoryState({ undo: undoStack.current.length, redo: redoStack.current.length });
  };

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  /** Drop pending edits and reload from disk (after bulk template/preset apply, and by × discard). */
  const reload = useCallback(() => {
    pending.current = null;
    clearTimer();
    setReloadTick((n) => n + 1);
  }, []);

  const flush = useCallback(async () => {
    clearTimer();
    const doc = pending.current;
    if (!doc) return;
    const source = pendingSource.current;
    pendingSource.current = 'auto';
    pending.current = null;
    setState((s) => ({ ...s, saving: true }));
    try {
      const res = await api.savePage(doc, source);
      savedDoc.current = cloneDoc(res.doc);
      // A successful write supersedes any queued copy of the same page.
      dropOutbox(outboxKeyOf(doc));
      setState((s) => ({ ...s, saving: false, dirty: pending.current ? s.dirty : false, exists: true }));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Never lose notes: keep an offline copy that the outbox replays later.
      const queued = enqueueOutbox(doc, source);
      pending.current = doc;
      setState((s) => ({
        ...s,
        saving: false,
        error: queued ? t('outbox.queued', { detail }) : detail,
      }));
    }
  }, []);

  const scheduleSave = useCallback(
    (doc: PageDoc, source: HistorySource = 'auto') => {
      pending.current = doc;
      pendingSource.current = source;
      clearTimer();
      timer.current = window.setTimeout(() => {
        void flush();
      }, 700);
    },
    [flush],
  );

  const pushHistory = useCallback((doc: PageDoc) => {
    const now = Date.now();
    // Dragging fires mutate continuously; coalesce by time window so one undo doesn't move it 1px at a time.
    if (now - lastHistoryAt.current < HISTORY_COALESCE_MS && undoStack.current.length) return;
    undoStack.current.push(cloneDoc(doc));
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
    lastHistoryAt.current = now;
    syncHistoryCounts();
  }, []);

  const mutate = useCallback(
    (fn: (doc: PageDoc) => PageDoc, opts?: { history?: boolean; source?: HistorySource }) => {
      const cur = docRef.current;
      if (!cur) return;
      const next = fn(cur);
      if (next === cur) return;
      if (opts?.history !== false) pushHistory(cur);
      docRef.current = next;
      setState((s) => ({ ...s, doc: next, dirty: true }));
      if (saveModeRef.current === 'auto') scheduleSave(next, opts?.source);
      else {
        pending.current = next;
        pendingSource.current = opts?.source ?? 'auto';
      }
    },
    [pushHistory, scheduleSave],
  );

  /** ✓ save (confirm mode); in auto mode this writes immediately. */
  const commit = useCallback(async () => {
    const doc = docRef.current;
    if (!doc) return;
    pending.current = doc;
    pendingSource.current = 'manual';
    await flush();
  }, [flush]);

  /** × discard: revert to the last content written to disk. */
  const discard = useCallback(() => {
    const base = savedDoc.current;
    if (!base) return;
    pending.current = null;
    clearTimer();
    const restored = cloneDoc(base);
    docRef.current = restored;
    setState((s) => ({ ...s, doc: restored, dirty: false }));
    undoStack.current = [];
    redoStack.current = [];
    syncHistoryCounts();
  }, []);

  const undo = useCallback(() => {
    const cur = docRef.current;
    const prev = undoStack.current.pop();
    if (!cur || !prev) return;
    redoStack.current.push(cloneDoc(cur));
    docRef.current = prev;
    setState((s) => ({ ...s, doc: prev, dirty: true }));
    if (saveModeRef.current === 'auto') scheduleSave(prev);
    else pending.current = prev;
    syncHistoryCounts();
  }, [scheduleSave]);

  const redo = useCallback(() => {
    const cur = docRef.current;
    const next = redoStack.current.pop();
    if (!cur || !next) return;
    undoStack.current.push(cloneDoc(cur));
    docRef.current = next;
    setState((s) => ({ ...s, doc: next, dirty: true }));
    if (saveModeRef.current === 'auto') scheduleSave(next);
    else pending.current = next;
    syncHistoryCounts();
  }, [scheduleSave]);

  const setSaveMode = useCallback(
    (mode: SaveMode) => {
      const prevMode = saveModeRef.current;
      saveModeRef.current = mode;
      setSaveModeState(mode);
      // Switching confirm → auto: flush pending edits now so they are not silently lost.
      if (prevMode === 'confirm' && mode === 'auto' && pending.current) {
        scheduleSave(pending.current);
      }
    },
    [scheduleSave],
  );

  const detect = useCallback(
    async (lang?: string) => {
      if (!sel) return;
      setState((s) => ({ ...s, detecting: true, error: null }));
      try {
        const res = await api.detect(sel.volume, sel.chapter, sel.pageIndex, lang);
        const panels = res.panels.map((rect, i) => ({ id: `p${i + 1}`, rect, source: 'auto' as const }));
        mutate(
          (doc) => ({
            ...doc,
            panels,
            detectorVersion: res.version,
            detectedAt: new Date().toISOString(),
            detectSource: res.source === 'template' || res.source === 'plugin' ? res.source : 'auto',
          }),
          { source: 'detect' },
        );
        // Detector warnings come from the server in their own language; join them for display.
        setState((s) => ({
          ...s,
          detecting: false,
          error: res.warnings?.length ? res.warnings.join(t('common.listSeparator')) : null,
        }));
      } catch (err) {
        setState((s) => ({
          ...s,
          detecting: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [mutate, sel],
  );

  // Load the page.
  useEffect(() => {
    if (!sel) {
      docRef.current = null;
      savedDoc.current = null;
      setState(initial);
      return;
    }
    const key = `${sel.volume}|${sel.chapter}|${sel.pageIndex}`;
    lastKey.current = key;
    let cancelled = false;
    // Confirm mode never writes without ✓. Leaving with unsaved edits is resolved by the
    // navigation guard in App (save or stay); anything still pending is dropped here.
    if (saveModeRef.current === 'confirm') pending.current = null;
    undoStack.current = [];
    redoStack.current = [];
    syncHistoryCounts();
    setState({ ...initial, loading: true });

    api
      .page(sel.volume, sel.chapter, sel.pageIndex)
      .then((res) => {
        if (cancelled) return;
        docRef.current = res.doc;
        savedDoc.current = cloneDoc(res.doc);
        setState({
          doc: res.doc,
          page: res.page,
          exists: res.exists,
          loading: false,
          error: null,
          detecting: false,
          dirty: false,
          saving: false,
        });
        const hasImage = Object.keys(res.page.files).length > 0;
        if (!res.exists && res.doc.panels.length === 0 && hasImage) {
          // First open: auto-detect panels (the result is autosaved along with the next edit).
          void api
            .detect(sel.volume, sel.chapter, sel.pageIndex)
            .then((det) => {
              if (cancelled || lastKey.current !== key) return;
              const panels = det.panels.map((rect, i) => ({ id: `p${i + 1}`, rect, source: 'auto' as const }));
              const nextDoc = {
                ...res.doc,
                panels,
                detectorVersion: det.version,
                detectedAt: new Date().toISOString(),
                detectSource: det.source === 'template' || det.source === 'plugin' ? det.source : ('auto' as const),
              };
              docRef.current = nextDoc;
              setState((s) => (s.doc ? { ...s, doc: nextDoc } : s));
              pending.current = nextDoc;
              pendingSource.current = 'detect';
              if (timer.current !== null) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => void flush(), 700);
            })
            .catch(() => {
              /* Detection failed: stay blank; the user can draw panels manually. */
            });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ ...initial, error: err instanceof Error ? err.message : String(err) });
      });

    return () => {
      cancelled = true;
    };
  }, [sel, flush, reloadTick]);

  // IndexedDB writes cannot be awaited during unload, so persist whenever the tab is
  // hidden (tab switch, minimise, navigation) as a best-effort safety net.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      const doc = pending.current;
      if (!doc) return;
      pending.current = null;
      void api.savePage(doc, pendingSource.current).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  return {
    ...state,
    mutate,
    detect,
    flush,
    reload,
    saveMode,
    setSaveMode,
    commit,
    discard,
    undo,
    redo,
    canUndo: historyState.undo > 0,
    canRedo: historyState.redo > 0,
  };
}
