import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AlignMode, AlignOffset, AlignPreset, Lang, PageDoc, PageEntry, Panel } from '../types';
import { DEFAULT_OFFSET, DEFAULT_LANGUAGES, langShort } from '../types';
import { applyGroupOrder, sortPanels } from '../lib/geometry';
import { api } from '../api';
import type { HistorySource } from '../api';
import { langLabel, readingLabel, useI18n } from '../i18n';
import type { MessageKey } from '../i18n';
import { AnnotationOverlay } from './AnnotationOverlay';
import { ANNOTATION_COLORS, ANNOTATION_TOOL_ORDER, ANNOTATION_TOOLS, AnnotationLayer } from './AnnotationLayer';
import type { AnnotationTool } from './AnnotationLayer';
import { CropLayer } from './CropLayer';
import { PanelDetail } from './PanelDetail';
import { useAnnSurface } from '../lib/annotationSurface';

type Props = {
  doc: PageDoc;
  page: PageEntry;
  mutate: (fn: (doc: PageDoc) => PageDoc, opts?: { history?: boolean; source?: HistorySource }) => void;
  reload: () => void;
  selected: string[];
  setSelected: (ids: string[]) => void;
  langs: Lang[];
  setLangs: (langs: Lang[]) => void;
  /** Library language order discovered from the scanned volumes. */
  allLangs: Lang[];
  overlay: boolean;
  setOverlay: (v: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Panel id whose detail view is open, or null. */
  detailPanel: string | null;
  onOpenDetail: (panelId: string) => void;
  onCloseDetail: () => void;
  /** Panel navigation that runs past a page edge; the shell lands on the neighbouring page. */
  onStepPage: (dir: -1 | 1) => void;
  onDetailPrevPanel?: () => void;
  onDetailNextPanel?: () => void;
  onDetailPrevPage?: () => void;
  onDetailNextPage?: () => void;
  /** Viewer mode: hide authoring tools and skip writes. */
  readOnly?: boolean;
};

const sizeCache = new Map<string, { w: number; h: number }>();
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

const ALIGN_MODES: AlignMode[] = ['page', 'panel', 'anchors', 'grid'];

const ALIGN_MODE_KEY: Record<AlignMode, MessageKey> = {
  page: 'align.mode.page',
  panel: 'align.mode.panel',
  anchors: 'align.mode.anchors',
  grid: 'align.mode.grid',
};

const ALIGN_HINT_KEY: Record<AlignMode, MessageKey> = {
  page: 'align.hint.page',
  panel: 'align.hint.panel',
  anchors: 'align.hint.anchors',
  grid: 'align.hint.grid',
};

/**
 * Returns the image pane under a viewport point, or null.
 *
 * Hit-testing by coordinates (instead of the event target) keeps the wheel
 * behaviour identical over badges, masks and the pane border: anything inside
 * the cell zooms, anything outside scrolls the page. `elementsFromPoint` also
 * skips overlays that opt out with pointer-events: none.
 */
function paneAtPoint(x: number, y: number): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!(el instanceof HTMLElement)) continue;
    const pane = el.closest('.lang-pane') as HTMLElement | null;
    if (!pane || pane.dataset.hasImage !== '1') continue;
    const r = pane.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return pane;
  }
  return null;
}

/* ---------- Drag/zoom scope ---------- */
type DragScope = 'page' | 'panel';
const DRAG_SCOPE_KEY = 'manga-memo.drag-scope';

function loadDragScope(): DragScope {
  try {
    return localStorage.getItem(DRAG_SCOPE_KEY) === 'panel' ? 'panel' : 'page';
  } catch {
    return 'page';
  }
}

/* ---------- Language mask preferences (remembered across sessions; never read by exports) ---------- */
type MaskPrefs = {
  master: boolean;
  masked: Record<Lang, boolean>;
  style: 'blur' | 'solid';
};
const MASK_KEY = 'manga-memo.mask-prefs';
const DEFAULT_MASK_PREFS: MaskPrefs = {
  master: false,
  masked: { ja: false, zh: true, en: true },
  style: 'blur',
};

function loadMaskPrefs(): MaskPrefs {
  try {
    const raw = localStorage.getItem(MASK_KEY);
    if (!raw) return DEFAULT_MASK_PREFS;
    const parsed = JSON.parse(raw) as Partial<MaskPrefs>;
    return {
      master: Boolean(parsed.master),
      masked: { ...DEFAULT_MASK_PREFS.masked, ...(parsed.masked ?? {}) },
      style: parsed.style === 'solid' ? 'solid' : 'blur',
    };
  } catch {
    return DEFAULT_MASK_PREFS;
  }
}

/* ---------- Overlay opacity/blend mode (remembered per language across sessions) ---------- */
type OverlayPrefs = { opacities: Partial<Record<Lang, number>>; blend: boolean };
const OVERLAY_KEY = 'manga-memo.overlay-prefs';
const DEFAULT_OPACITIES: Record<Lang, number> = { ja: 1, zh: 0.55, en: 0.45 };
const DEFAULT_OVERLAY_PREFS: OverlayPrefs = { opacities: {}, blend: true };

function loadOverlayPrefs(): OverlayPrefs {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (!raw) return DEFAULT_OVERLAY_PREFS;
    const parsed = JSON.parse(raw) as Partial<OverlayPrefs>;
    const opacities: Partial<Record<Lang, number>> = {};
    for (const [lang, value] of Object.entries(parsed.opacities ?? {})) {
      const n = Number(value);
      if (Number.isFinite(n)) opacities[lang as Lang] = Math.min(1, Math.max(0.1, n));
    }
    return { opacities, blend: parsed.blend !== false };
  } catch {
    return DEFAULT_OVERLAY_PREFS;
  }
}

/** Track the natural size of every language image on the page, however many there are. */
function useImageSizes(files: Record<string, string | undefined>) {
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const key = Object.entries(files)
    .map(([lang, url]) => `${lang}:${url ?? ''}`)
    .join('|');
  useEffect(() => {
    let alive = true;
    const next: Record<string, { w: number; h: number }> = {};
    const pending: { lang: string; url: string }[] = [];
    for (const [lang, url] of Object.entries(files)) {
      if (!url) continue;
      const cached = sizeCache.get(url);
      if (cached) next[lang] = cached;
      else pending.push({ lang, url });
    }
    setSizes(next);
    for (const { lang, url } of pending) {
      const img = new Image();
      img.onload = () => {
        const size = { w: img.naturalWidth, h: img.naturalHeight };
        sizeCache.set(url, size);
        if (alive) setSizes((prev) => ({ ...prev, [lang]: size }));
      };
      img.src = url;
    }
    return () => {
      alive = false;
    };
    // `key` captures every language/url pair; `files` itself is a new object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return sizes;
}

export function CompareTab({
  doc,
  page,
  mutate,
  reload,
  selected,
  setSelected,
  langs,
  setLangs,
  allLangs,
  overlay,
  setOverlay,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  detailPanel,
  onOpenDetail,
  onCloseDetail,
  onStepPage,
  onDetailPrevPanel,
  onDetailNextPanel,
  onDetailPrevPage,
  onDetailNextPage,
  readOnly = false,
}: Props) {
  const { t, formatNumber } = useI18n();
  const ordered = useMemo(
    () => applyGroupOrder(sortPanels(doc.panels, doc.readingDirection), doc.groups),
    [doc.panels, doc.readingDirection, doc.groups],
  );
  const mode: AlignMode = doc.alignMode ?? 'page';
  const alignModeLabel = (m: AlignMode) => t(ALIGN_MODE_KEY[m]);
  const isPanelMode = mode === 'panel' || mode === 'anchors';
  const [dragLang, setDragLang] = useState<Lang>(langs[0] ?? 'ja');
  const [overlayPrefs, setOverlayPrefs] = useState<OverlayPrefs>(loadOverlayPrefs);
  const opacities = { ...DEFAULT_OPACITIES, ...overlayPrefs.opacities };
  const blend = overlayPrefs.blend;
  const setOpacity = (lang: Lang, value: number) =>
    setOverlayPrefs((p) => ({ ...p, opacities: { ...p.opacities, [lang]: clamp(value, 0.1, 1) } }));
  const setBlend = (value: boolean) => setOverlayPrefs((p) => ({ ...p, blend: value }));
  const [alignOpen, setAlignOpen] = useState(false);
  const [presets, setPresets] = useState<AlignPreset[]>([]);
  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetBusy, setPresetBusy] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<{ panelId: string; lang: Lang; x: number; y: number } | null>(
    null,
  );
  const [maskPrefs, setMaskPrefs] = useState<MaskPrefs>(loadMaskPrefs);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [maskDefaultsOpen, setMaskDefaultsOpen] = useState(false);
  // Drag-to-reorder the language bar (only enabled languages are draggable)
  const [langDragIndex, setLangDragIndex] = useState<number | null>(null);
  const [langDropIndex, setLangDropIndex] = useState<number | null>(null);
  const langMovedRef = useRef(false);
  const langStartX = useRef(0);
  const suppressChipClick = useRef(false);
  const langChipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Default scope is remembered across sessions; the current page still follows doc.alignMode
  const [scopePref, setScopePref] = useState<DragScope>(loadDragScope);
  const [activeDrag, setActiveDrag] = useState<{ panelId: string; lang: Lang; scope: DragScope } | null>(null);
  const movedRef = useRef(false);
  const dragRef = useRef<{
    lang: Lang;
    panelId: string;
    mode: AlignMode;
    scope: DragScope;
    sx: number;
    sy: number;
    rect: DOMRect;
    start: AlignOffset;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  /**
   * Compare view is the main annotation surface: it opens with the layer enabled.
   * The panel workspace keeps its own switch (defaults to off) and both persist apart.
   */
  const [annOn, setAnnOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem('manga-memo.compare-ann') !== 'off';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('manga-memo.compare-ann', annOn ? 'on' : 'off');
    } catch {
      /* private mode */
    }
  }, [annOn]);
  const [annTool, setAnnTool] = useState<AnnotationTool>('select');
  const [annColor, setAnnColor] = useState(ANNOTATION_COLORS[0]);
  const [annSelected, setAnnSelected] = useState<string | null>(null);
  const [annScope, setAnnScope] = useState<'page' | 'panel'>('page');
  /** Lane that receives new marks in side-by-side mode; highlighted in the grid. */
  const [annLang, setAnnLang] = useState<Lang>(langs[0] ?? 'ja');
  const [moreOpen, setMoreOpen] = useState(false);

  const annSurface = useAnnSurface();
  /** Reading keeps annotations by default; "panels only" removes them here. */
  const annAllowed = annSurface !== 'panels';
  const annotations = doc.annotations ?? [];
  const annotationsVisible = annAllowed && doc.annotationsVisible !== false && annOn;
  /** Authoring switches off in viewer mode; existing marks stay visible. */
  const annEditable = annAllowed && !readOnly;
  useEffect(() => {
    if (!annAllowed) {
      setAnnTool('select');
      setAnnSelected(null);
    }
  }, [annAllowed]);
  const applyAnnotations = (
    updater: (list: NonNullable<PageDoc['annotations']>) => NonNullable<PageDoc['annotations']>,
  ) => {
    // Same source tag as the panel workspace, so history labels read the same.
    mutate((current) => ({ ...current, annotations: updater(current.annotations ?? []) }), { source: 'annotation' });
  };
  const deleteAnnotation = () => {
    if (!annSelected) return;
    applyAnnotations((list) => list.filter((a) => a.id !== annSelected));
    setAnnSelected(null);
  };
  const clearAnnotations = () => {
    if (!annotations.length) return;
    if (!window.confirm(t('ann.clearConfirm', { count: formatNumber(annotations.length) }))) return;
    applyAnnotations(() => []);
    setAnnSelected(null);
  };

  const scopeOfMode: DragScope = isPanelMode ? 'panel' : 'page';

  useEffect(() => {
    try {
      localStorage.setItem(DRAG_SCOPE_KEY, scopePref);
    } catch {
      /* Ignored in private mode */
    }
  }, [scopePref]);

  // Reuse the last chosen scope when opening a new page (special modes such as anchors/grid are not overridden)
  useEffect(() => {
    if (mode === 'anchors' || mode === 'grid') return;
    if (mode !== scopePref) mutate((d) => ({ ...d, alignMode: scopePref }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.volume, doc.chapter, doc.pageIndex]);

  const availableLangs = useMemo(() => {
    const pageLangs = Object.keys(page.files);
    const ordered = allLangs.filter((l) => pageLangs.includes(l));
    return [...ordered, ...pageLangs.filter((l) => !ordered.includes(l))];
  }, [page, allLangs]);
  /**
   * Columns shown for this page. A language missing from the current page is hidden for
   * this page only: the persisted order is user-owned and must never be rewritten by
   * simply browsing to a page that lacks one language.
   */
  const activeLangs = useMemo(() => {
    const kept = langs.filter((l) => availableLangs.includes(l));
    if (kept.length) return kept;
    return availableLangs.length ? availableLangs : langs;
  }, [langs, availableLangs]);
  const baseLang = useMemo(() => activeLangs[0] ?? 'ja', [activeLangs]);

  useEffect(() => {
    if (!activeLangs.includes(annLang)) setAnnLang(activeLangs[0] ?? 'ja');
  }, [activeLangs, annLang]);

  useEffect(() => {
    if (!activeLangs.includes(dragLang)) setDragLang(activeLangs[0] ?? 'ja');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLangs.join(','), dragLang]);

  // Masking is a reading preference: remembered across sessions; paging only clears temporary reveals, not the switches
  useEffect(() => {
    try {
      localStorage.setItem(MASK_KEY, JSON.stringify(maskPrefs));
    } catch {
      /* Ignored in private mode */
    }
  }, [maskPrefs]);

  // Overlay opacity and blend mode are reading preferences too: per language, kept across refreshes and project reloads
  useEffect(() => {
    try {
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlayPrefs));
    } catch {
      /* Ignored in private mode */
    }
  }, [overlayPrefs]);
  useEffect(() => {
    setRevealed({});
  }, [page.index, doc.chapter, doc.volume]);

  // Unknown languages default to "masked" unless they are the base column; the user can flip any switch.
  const maskWanted = (lang: Lang) => maskPrefs.masked[lang] ?? lang !== activeLangs[0];
  const maskOn = (lang: Lang) => maskPrefs.master && maskWanted(lang) && Boolean(page.files[lang]);
  const revealKey = (panelId: string, lang: Lang) => `${panelId}:${lang}`;
  const isHidden = (panelId: string, lang: Lang) => maskOn(lang) && !revealed[revealKey(panelId, lang)];

  const toggleMaskLang = (lang: Lang) =>
    setMaskPrefs((p) => ({ ...p, master: true, masked: { ...p.masked, [lang]: !maskWanted(lang) } }));

  // H hides everything (clears temporary reveals), Shift+H shows everything
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'h') return;
      e.preventDefault();
      setMaskPrefs((p) => ({ ...p, master: !e.shiftKey }));
      setRevealed({});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // When the page or languages change, missing languages are hidden for this page only (see activeLangs); persisted config is untouched
  const loadPresets = () => {
    api
      .alignPresets()
      .then((res) => setPresets(res.presets))
      .catch(() => setPresets([]));
  };
  useEffect(loadPresets, []);

  // Whole-page and per-panel offsets are stored separately: scope decides which one is read/written, and an Alt override never pollutes the other
  const offsetOf = (lang: Lang, panel: Panel, scope: DragScope = scopeOfMode): AlignOffset =>
    scope === 'panel'
      ? (doc.panelOffsets?.[panel.id]?.[lang] ?? DEFAULT_OFFSET)
      : (doc.offsets[lang] ?? DEFAULT_OFFSET);

  const setOffset = (lang: Lang, panel: Panel, next: AlignOffset, scope: DragScope = scopeOfMode) => {
    mutate((d) =>
      scope === 'panel'
        ? {
            ...d,
            panelOffsets: {
              ...d.panelOffsets,
              [panel.id]: { ...d.panelOffsets?.[panel.id], [lang]: next },
            },
          }
        : { ...d, offsets: { ...d.offsets, [lang]: next } },
    );
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) movedRef.current = true;
      let nx = clamp(d.start.x + (e.clientX - d.sx) / d.rect.width, -2, 2);
      let ny = clamp(d.start.y + (e.clientY - d.sy) / d.rect.height, -2, 2);
      if (d.mode === 'grid') {
        const step = (doc.gridStep ?? 1) / 100;
        nx = Math.round(nx / step) * step;
        ny = Math.round(ny / step) * step;
      }
      mutate((doc2) => {
        const panel = doc2.panels.find((p) => p.id === d.panelId);
        const usePanel = d.scope === 'panel';
        if (usePanel && panel) {
          return {
            ...doc2,
            panelOffsets: {
              ...doc2.panelOffsets,
              [panel.id]: { ...doc2.panelOffsets?.[panel.id], [d.lang]: { ...d.start, x: nx, y: ny } },
            },
          };
        }
        return { ...doc2, offsets: { ...doc2.offsets, [d.lang]: { ...d.start, x: nx, y: ny } } };
      });
    };
    const up = () => {
      const d = dragRef.current;
      // No movement = a click: hide the temporarily revealed language again
      if (d && !movedRef.current) {
        setRevealed((r) => {
          const key = `${d.panelId}:${d.lang}`;
          return r[key] ? { ...r, [key]: false } : r;
        });
      }
      setDragging(false);
      setActiveDrag(null);
      dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging, doc.gridStep, mutate]);

  const startPan = (e: ReactPointerEvent<HTMLDivElement>, lang: Lang, panel: Panel) => {
    if (readOnly) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (mode === 'anchors') {
      e.preventDefault();
      if (!pendingAnchor || pendingAnchor.panelId !== panel.id) {
        setPendingAnchor({
          panelId: panel.id,
          lang,
          x: (e.clientX - rect.left) / rect.width,
          y: (e.clientY - rect.top) / rect.height,
        });
        return;
      }
      if (pendingAnchor.lang === lang) {
        setPendingAnchor({
          panelId: panel.id,
          lang,
          x: (e.clientX - rect.left) / rect.width,
          y: (e.clientY - rect.top) / rect.height,
        });
        return;
      }
      // Two clicks: reference point, then target point; the required translation is computed directly
      const tx = (e.clientX - rect.left) / rect.width;
      const ty = (e.clientY - rect.top) / rect.height;
      const current = offsetOf(lang, panel, 'panel');
      setOffset(
        lang,
        panel,
        {
          ...current,
          x: clamp(current.x + (pendingAnchor.x - tx), -2, 2),
          y: clamp(current.y + (pendingAnchor.y - ty), -2, 2),
        },
        'panel',
      );
      setDragLang(lang);
      setPendingAnchor(null);
      return;
    }
    e.preventDefault();
    movedRef.current = false;
    // Alt is a temporary override: this gesture only affects the current panel and reverts to the active scope on release
    const scope: DragScope = e.altKey ? 'panel' : scopeOfMode;
    dragRef.current = {
      lang,
      panelId: panel.id,
      mode,
      scope,
      sx: e.clientX,
      sy: e.clientY,
      rect,
      start: offsetOf(lang, panel, scope),
    };
    setActiveDrag({ panelId: panel.id, lang, scope });
    setDragLang(lang);
    setDragging(true);
  };

  const zoomBy = (lang: Lang, panel: Panel, deltaY: number, scope: DragScope = scopeOfMode) => {
    const current = offsetOf(lang, panel, scope);
    const next = clamp(+(current.scale * (deltaY < 0 ? 1.06 : 0.94)).toFixed(3), 0.5, 3);
    setOffset(lang, panel, { ...current, scale: next }, scope);
  };

  // Wheel zoom: take over only when the pointer is really inside a language pane; everywhere else the page scrolls normally.
  // React's onWheel is passive on the root node and cannot prevent page scrolling, so use a native non-passive listener;
  // attach it in the window capture phase so scroll containers or inner elements cannot consume the event first (causing zoom + scroll).
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    if (!e.deltaY) return;
    const paneEl = paneAtPoint(e.clientX, e.clientY);
    if (!paneEl) return;
    const lang = paneEl.dataset.lang as Lang | undefined;
    const panel = doc.panels.find((p) => p.id === paneEl.dataset.panelId);
    if (!lang || !panel) return;
    e.preventDefault();
    e.stopPropagation();
    // Alt+wheel also only zooms the current panel, so fine-tuning one panel does not shift the whole column
    zoomBy(lang, panel, e.deltaY, e.altKey ? 'panel' : scopeOfMode);
  };

  useEffect(() => {
    const onWheel = (e: WheelEvent) => wheelRef.current(e);
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  const resetLang = (lang: Lang, panel?: Panel) => {
    if (scopeOfMode === 'panel') {
      if (!panel) return;
      mutate((d) => ({
        ...d,
        panelOffsets: { ...d.panelOffsets, [panel.id]: { ...d.panelOffsets?.[panel.id], [lang]: DEFAULT_OFFSET } },
      }));
      return;
    }
    mutate((d) => ({ ...d, offsets: { ...d.offsets, [lang]: DEFAULT_OFFSET } }));
  };

  /** Clear per-panel offsets for every panel on this page (whole-page offsets are untouched). */
  const resetAllPanelOffsets = () => {
    setPendingAnchor(null);
    mutate((d) => ({ ...d, panelOffsets: {} }));
  };

  /** Clear the per-panel offset of the current panel only (whole-page and other panels are untouched). */
  const resetCurrentPanelOffsets = () => {
    const panel = doc.panels.find((p) => p.id === selected[0]) ?? ordered[0];
    if (!panel) return;
    mutate((d) => {
      const next = { ...d.panelOffsets };
      delete next[panel.id];
      return { ...d, panelOffsets: next };
    });
  };

  const resetAll = () => {
    setPendingAnchor(null);
    mutate((d) => ({ ...d, offsets: {}, panelOffsets: {} }));
  };

  const toggleLang = (lang: Lang) => {
    if (langs.includes(lang)) {
      if (langs.length === 1) return;
      setLangs(langs.filter((l) => l !== lang));
    } else {
      // Append to the end so enabling a language never reshuffles a custom order.
      setLangs([...langs, lang]);
    }
  };

  const langBar = [...new Set([...langs, ...allLangs, ...availableLangs])];

  const startLangDrag = (e: ReactPointerEvent<HTMLButtonElement>, lang: Lang, index: number) => {
    if (!langs.includes(lang)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    langMovedRef.current = false;
    langStartX.current = e.clientX;
    setLangDragIndex(index);
    setLangDropIndex(index);
  };

  const moveLangDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (langDragIndex === null) return;
    const x = e.clientX;
    // Any real movement counts as a drag, so a slight wobble never toggles the chip off.
    if (Math.abs(x - langStartX.current) > 3) langMovedRef.current = true;
    let index = 0;
    for (let i = 0; i < langs.length; i += 1) {
      const el = langChipRefs.current[i];
      if (el && x > el.getBoundingClientRect().left + el.offsetWidth / 2) index = i + 1;
    }
    if (index !== langDropIndex) setLangDropIndex(index);
  };

  const endLangDrag = () => {
    if (langDragIndex === null) return;
    const from = langDragIndex;
    let to = langDropIndex ?? from;
    if (to > from) to -= 1;
    if (langMovedRef.current) {
      suppressChipClick.current = true;
      // Clear on the next tick in case no click event follows the release.
      window.setTimeout(() => {
        suppressChipClick.current = false;
      }, 0);
    }
    if (langMovedRef.current && to !== from && to >= 0 && to < langs.length) {
      const next = [...langs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setLangs(next);
    }
    setLangDragIndex(null);
    setLangDropIndex(null);
  };

  const detailIndex = detailPanel ? ordered.findIndex((p) => p.id === detailPanel) : -1;

  const resetLangOrder = () => {
    setLangs(allLangs.length ? [...allLangs] : [...DEFAULT_LANGUAGES]);
  };

  const goTo = (dir: -1 | 1) => {
    if (!ordered.length) return;
    const currentIdx = ordered.findIndex((p) => selected.includes(p.id));
    const base = currentIdx < 0 ? (dir > 0 ? -1 : ordered.length) : currentIdx;
    const nextIdx = base + dir;
    // Past either end of the page: continue onto the neighbouring page (last/first panel)
    // instead of stopping at the boundary. Chapter edges are handled by the shell.
    if (nextIdx < 0 || nextIdx >= ordered.length) {
      onStepPage(dir);
      return;
    }
    const target = ordered[nextIdx];
    setSelected([target.id]);
    document.getElementById(`panel-${target.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  /** Open the enlarged detail view; selection keeps the reading position behind it. */
  const openDetailFor = (panel: Panel) => {
    setSelected([panel.id]);
    onOpenDetail(panel.id);
  };
  /** Double-tap fallback for touch screens, where dblclick is not reliable over masks. */
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);
  const isDoubleTap = (panelId: string) => {
    const now = Date.now();
    const last = lastTapRef.current;
    lastTapRef.current = last && last.id === panelId && now - last.at < 350 ? null : { id: panelId, at: now };
    return !lastTapRef.current;
  };

  const changeMode = (next: AlignMode) => {
    setPendingAnchor(null);
    // Whole page / current panel are the common choices; remember them as the default scope for the next page
    if (next === 'page' || next === 'panel') setScopePref(next);
    mutate((d) => ({ ...d, alignMode: next }));
  };

  const panelForInput = doc.panels.find((p) => p.id === selected[0]) ?? ordered[0];
  const inputOffset = panelForInput ? offsetOf(dragLang, panelForInput) : DEFAULT_OFFSET;
  const applyNumeric = (patch: Partial<AlignOffset>) => {
    if (!panelForInput) return;
    setOffset(dragLang, panelForInput, { ...inputOffset, ...patch });
  };

  const savePreset = async (scope: 'page' | 'chapter') => {
    if (!presetName.trim()) return;
    setPresetBusy(true);
    try {
      const res = await api.saveAlignPreset({
        name: presetName.trim(),
        scope,
        volume: doc.volume,
        chapter: doc.chapter,
        mode,
        offsets: doc.offsets,
        panelOffsets: doc.panelOffsets,
        gridStep: doc.gridStep,
      });
      setPresetName('');
      setPresetId(res.preset.id);
      loadPresets();
    } catch {
      /* Keep reading; a failed save only shows in the status bar */
    } finally {
      setPresetBusy(false);
    }
  };

  const applyPreset = async (target: 'page' | 'chapter') => {
    if (!presetId) return;
    setPresetBusy(true);
    try {
      await api.applyAlignPreset(presetId, doc.volume, doc.chapter, target === 'page' ? [page.index] : undefined);
      if (target === 'page') reload();
      else reload();
    } catch {
      /* Keep the current state */
    } finally {
      setPresetBusy(false);
    }
  };

  const deletePreset = async () => {
    if (!presetId) return;
    await api.deleteAlignPreset(presetId);
    setPresetId('');
    loadPresets();
  };

  // Stack both offset layers when rendering: the whole-page offset is the base and per-panel offsets are added on top,
  // so a panel tweaked temporarily with Alt still shows its effect in page mode while the two datasets stay separate.
  const offsetsOf = (lang: Lang, panel: Panel): AlignOffset => {
    const base = doc.offsets[lang] ?? DEFAULT_OFFSET;
    const extra = doc.panelOffsets?.[panel.id]?.[lang];
    if (!extra) return base;
    return {
      x: base.x + extra.x,
      y: base.y + extra.y,
      scale: +(base.scale * extra.scale).toFixed(4),
    };
  };

  /** Touch-friendly zoom without a wheel: two buttons on the pane badge. */
  const nudgeZoom = (lang: Lang, panel: Panel, factor: number) => {
    const current = offsetsOf(lang, panel);
    const next = clamp(+(current.scale * factor).toFixed(3), 0.5, 3);
    setOffset(lang, panel, { ...current, scale: next }, scopeOfMode);
  };

  // Natural image sizes for every language present on this page, so each panel keeps its aspect ratio.
  const sizes = useImageSizes(page.files);

  const paneAspect = (lang: Lang, panel: Panel) => {
    const size = sizes[lang];
    return size ? (panel.rect.w * size.w) / (panel.rect.h * size.h) : 0.72;
  };

  const renderLangPane = (lang: Lang, panel: Panel) => {
    const url = page.files[lang];
    const aspect = paneAspect(lang, panel);
    const off = offsetsOf(lang, panel);
    if (!url) {
      return (
        <div className="lang-pane empty" key={lang} style={{ aspectRatio: aspect }}>
          <span className="lang-tag">{langShort(lang)}</span>
          <div className="pane-missing">{t('compare.missingLangImage', { lang: langLabel(lang) })}</div>
        </div>
      );
    }
    return (
      <div
        key={lang}
        className={`lang-pane ${dragging && dragLang === lang ? 'dragging' : ''} ${
          annEditable && annOn && !overlay && lang === annLang ? 'ann-lane' : ''
        } ${
          activeDrag?.panelId === panel.id && activeDrag.lang === lang && activeDrag.scope === 'panel'
            ? 'scope-target'
            : ''
        }`}
        style={{ aspectRatio: aspect }}
        data-lang={lang}
        data-panel-id={panel.id}
        data-has-image="1"
        onPointerDown={(e) => {
          if (annEditable && annOn && lang !== annLang) setAnnLang(lang);
          // A drawing tool owns this pane, so it must not also start a pan.
          if (annEditable && annOn && annTool !== 'select') return;
          startPan(e, lang, panel);
        }}
      >
        <CropLayer url={url} rect={panel.rect} offset={off} opacity={1} blend={false} />
        {/* Only the highlighted lane edits; other lanes mirror the same marks read-only. */}
        <div
          className="ann-crop-layer"
          style={{ transform: `translate(${off.x * 100}%, ${off.y * 100}%) scale(${off.scale})` }}
        >
          {annEditable && annOn && lang === annLang ? (
            <AnnotationLayer
              annotations={annotations}
              visible={annotationsVisible}
              tool={annTool}
              color={annColor}
              width={0.0035}
              activePanel={annScope === 'panel' ? panel : null}
              panels={doc.panels}
              selectedId={annSelected}
              onSelect={setAnnSelected}
              onChange={applyAnnotations}
              viewport={panel.rect}
            />
          ) : (
            <AnnotationOverlay
              annotations={annotations}
              panels={doc.panels}
              rect={panel.rect}
              visible={annotationsVisible}
            />
          )}
        </div>
        {isHidden(panel.id, lang) && (
          <div
            className={`lang-mask ${maskPrefs.style}`}
            title={t('compare.maskTitle', { lang: langLabel(lang) })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setRevealed((r) => ({ ...r, [revealKey(panel.id, lang)]: true }));
            }}
          >
            <span>
              {langShort(lang)} {t('compare.maskedBadge')}
              <em>{t('compare.clickReveal')}</em>
            </span>
          </div>
        )}
        <span className="lang-tag">{langShort(lang)}</span>
        <span className="pane-offset">
          Δ{Math.round(off.x * 100)},{Math.round(off.y * 100)} ×{off.scale.toFixed(2)}
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => nudgeZoom(lang, panel, 0.8)}
            title={t('compare.zoomOut')}
          >
            −
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => nudgeZoom(lang, panel, 1.25)}
            title={t('compare.zoomIn')}
          >
            +
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => resetLang(lang, panel)}
            title={t('compare.resetCellLang')}
          >
            ⟲
          </button>
        </span>
        {pendingAnchor && pendingAnchor.panelId === panel.id && pendingAnchor.lang === lang && (
          <span
            className="anchor-dot"
            style={{ left: `${pendingAnchor.x * 100}%`, top: `${pendingAnchor.y * 100}%` }}
          />
        )}
      </div>
    );
  };

  const renderOverlayPane = (panel: Panel) => {
    const first = activeLangs[0];
    const aspect = first ? paneAspect(first, panel) : 0.72;
    return (
      <div
        className={`lang-pane overlay ${
          activeDrag?.panelId === panel.id && activeDrag.scope === 'panel' ? 'scope-target' : ''
        }`}
        style={{ aspectRatio: aspect }}
        data-lang={dragLang}
        data-panel-id={panel.id}
        data-has-image="1"
        onPointerDown={(e) => {
          if (annEditable && annOn && annTool !== 'select') return;
          startPan(e, dragLang, panel);
        }}
      >
        {activeLangs.map((lang) => {
          const url = page.files[lang];
          if (!url) return null;
          if (isHidden(panel.id, lang)) return null;
          return (
            <CropLayer
              key={lang}
              url={url}
              rect={panel.rect}
              offset={offsetsOf(lang, panel)}
              opacity={opacities[lang] ?? (lang === activeLangs[0] ? 1 : 0.5)}
              blend={blend}
            />
          );
        })}
        {/* Overlay mode keeps a single editable layer on top of the blended panes. */}
        <div
          className="ann-crop-layer"
          style={{
            transform: `translate(${offsetsOf(dragLang, panel).x * 100}%, ${
              offsetsOf(dragLang, panel).y * 100
            }%) scale(${offsetsOf(dragLang, panel).scale})`,
          }}
        >
          {annEditable && annOn ? (
            <AnnotationLayer
              annotations={annotations}
              visible={annotationsVisible}
              tool={annTool}
              color={annColor}
              width={0.0035}
              activePanel={annScope === 'panel' ? panel : null}
              panels={doc.panels}
              selectedId={annSelected}
              onSelect={setAnnSelected}
              onChange={applyAnnotations}
              viewport={panel.rect}
            />
          ) : (
            <AnnotationOverlay
              annotations={annotations}
              panels={doc.panels}
              rect={panel.rect}
              visible={annotationsVisible}
            />
          )}
        </div>
        {activeLangs.some((l) => isHidden(panel.id, l)) && (
          <div
            className={`lang-mask ${maskPrefs.style}`}
            title={t('compare.someMaskedTitle')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setRevealed((r) => {
                const next = { ...r };
                for (const l of activeLangs) if (maskOn(l)) next[revealKey(panel.id, l)] = true;
                return next;
              });
            }}
          >
            <span>
              {t('compare.someMasked')}
              <em>{t('compare.clickReveal')}</em>
            </span>
          </div>
        )}
        <span className="lang-tag">
          {t('compare.overlayTag', {
            langs: activeLangs.map((l) => langShort(l)).join(' + '),
            lang: langShort(dragLang),
          })}
        </span>
      </div>
    );
  };

  if (!doc.panels.length) {
    return (
      <div className="compare-empty">
        <p>{t('compare.emptyPanels')}</p>
        <p className="muted">{t('compare.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div className="compare-tab">
      <div className={`stage-toolbar ${moreOpen ? 'tb-more-open' : ''}`}>
        <div className="tb-group">
          <span className="tb-label">{t('compare.language')}</span>
          <div className="lang-chips">
            {langBar.map((l, barIndex) => {
              const enabled = langs.includes(l);
              const disabled = !availableLangs.includes(l);
              const pos = enabled ? langs.indexOf(l) : -1;
              const isDragging = pos >= 0 && pos === langDragIndex;
              const dropBefore = pos >= 0 && langDragIndex !== null && langDropIndex === pos;
              const dropAfter =
                pos >= 0 &&
                langDragIndex !== null &&
                pos === langs.length - 1 &&
                langDropIndex === langs.length &&
                langDragIndex !== langs.length - 1;
              return (
                <button
                  type="button"
                  key={l}
                  ref={(el) => {
                    langChipRefs.current[barIndex] = enabled ? el : null;
                  }}
                  className={[
                    'lang-chip',
                    enabled ? 'on' : '',
                    isDragging ? 'dragging' : '',
                    dropBefore ? 'drop-before' : '',
                    dropAfter ? 'drop-after' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    if (suppressChipClick.current) {
                      suppressChipClick.current = false;
                      return;
                    }
                    toggleLang(l);
                  }}
                  onPointerDown={(e) => startLangDrag(e, l, barIndex)}
                  onPointerMove={moveLangDrag}
                  onPointerUp={endLangDrag}
                  onPointerCancel={endLangDrag}
                  disabled={disabled}
                  title={
                    disabled
                      ? t('compare.langMissing')
                      : enabled
                        ? `${langLabel(l)} · ${t('compare.langDragHint')}`
                        : langLabel(l)
                  }
                >
                  {langShort(l)}
                </button>
              );
            })}
            {langs.join() !== allLangs.join() && (
              <button
                type="button"
                className="lang-order-reset"
                onClick={resetLangOrder}
                title={t('compare.langOrderReset')}
                aria-label={t('compare.langOrderReset')}
              >
                ↺
              </button>
            )}
          </div>
        </div>

        <div className="tb-group mask-group tb-collapsible">
          <span className="tb-label">{t('compare.mask')}</span>
          <button
            type="button"
            className={`btn tiny ${maskPrefs.master ? 'on' : ''}`}
            onClick={() => {
              setMaskPrefs((p) => ({ ...p, master: !p.master }));
              setRevealed({});
            }}
            title={t('compare.maskToggleTitle')}
          >
            {maskPrefs.master ? t('compare.maskOn') : t('compare.maskOff')}
          </button>
          {maskPrefs.master &&
            availableLangs.map((l) => (
              <button
                type="button"
                key={l}
                className={`lang-chip ${maskWanted(l) ? 'on' : ''}`}
                onClick={() => toggleMaskLang(l)}
                title={
                  maskWanted(l)
                    ? t('compare.maskLangTitleMasked', { lang: langLabel(l) })
                    : t('compare.maskLangTitleVisible', { lang: langLabel(l) })
                }
              >
                {langShort(l)}
                <i className="mask-icon">{maskWanted(l) ? '◐' : '◯'}</i>
              </button>
            ))}
          {maskPrefs.master && (
            <>
              <select
                className="tb-select"
                value={maskPrefs.style}
                onChange={(e) => setMaskPrefs((p) => ({ ...p, style: e.target.value === 'solid' ? 'solid' : 'blur' }))}
                title={t('compare.maskStyle')}
              >
                <option value="blur">{t('compare.maskStyleBlur')}</option>
                <option value="solid">{t('compare.maskStyleSolid')}</option>
              </select>
              <button
                type="button"
                className="btn icon tiny"
                onClick={() => setRevealed({})}
                title={t('compare.maskAllTitle')}
                aria-label={t('compare.maskAllTitle')}
              >
                ◉
              </button>
              <button
                type="button"
                className="btn icon tiny"
                onClick={() => setMaskPrefs((p) => ({ ...p, master: false }))}
                title={t('compare.maskNoneTitle')}
                aria-label={t('compare.maskNoneTitle')}
              >
                ◯
              </button>
              <button
                type="button"
                className={`btn icon tiny ${maskDefaultsOpen ? 'on' : ''}`}
                onClick={() => setMaskDefaultsOpen((v) => !v)}
                title={t('compare.maskDefaultsTitle')}
                aria-label={t('compare.maskDefaultsTitle')}
              >
                ⚙
              </button>
            </>
          )}
        </div>

        <div className="tb-group">
          <div className="seg">
            <button type="button" className={!overlay ? 'on' : ''} onClick={() => setOverlay(false)}>
              {t('compare.sideBySide')}
            </button>
            <button type="button" className={overlay ? 'on' : ''} onClick={() => setOverlay(true)}>
              {t('compare.overlay')}
            </button>
          </div>
          {overlay && (
            <>
              <label className="tb-check">
                <input type="checkbox" checked={blend} onChange={(e) => setBlend(e.target.checked)} />
                {t('compare.multiply')}
              </label>
              <span className="muted tiny">{t('compare.alignTarget')}</span>
              <div className="lang-chips">
                {activeLangs.map((l) => (
                  <button
                    type="button"
                    key={l}
                    className={`lang-chip ${dragLang === l ? 'on' : ''}`}
                    onClick={() => setDragLang(l)}
                  >
                    {langShort(l)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="tb-group align-mode tb-collapsible">
          <span className="tb-label">{t('compare.align')}</span>
          <select
            className={`tb-select mode mode-${mode}`}
            value={mode}
            onChange={(e) => changeMode(e.target.value as AlignMode)}
            title={readOnly ? t('mode.readOnlyHint') : t(ALIGN_HINT_KEY[mode])}
            disabled={readOnly}
          >
            {ALIGN_MODES.map((m) => (
              <option key={m} value={m}>
                {alignModeLabel(m)}
              </option>
            ))}
          </select>
          {mode === 'grid' && (
            <select
              className="tb-select"
              value={doc.gridStep ?? 1}
              onChange={(e) => mutate((d) => ({ ...d, gridStep: Number(e.target.value) }))}
              title={t('compare.snapStep')}
            >
              {[0.5, 1, 2, 5].map((s) => (
                <option key={s} value={s}>
                  {s}%
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={`btn icon tiny ${alignOpen ? 'on' : ''}`}
            onClick={() => setAlignOpen((v) => !v)}
            title={readOnly ? t('mode.readOnlyHint') : t('compare.alignSettingsTitle')}
            aria-label={t('compare.alignSettingsTitle')}
            disabled={readOnly}
          >
            ⚙
          </button>
        </div>

        <div className="tb-group scope-group tb-collapsible">
          <span className="tb-label">{t('compare.dragZoom')}</span>
          <div className="seg scope-seg" title={readOnly ? t('mode.readOnlyHint') : t('compare.scopeTitle')}>
            <button
              type="button"
              className={scopeOfMode === 'page' ? 'on' : ''}
              onClick={() => changeMode('page')}
              title={t('compare.scopePageTitle')}
              aria-label={t('compare.scopePageTitle')}
              disabled={readOnly}
            >
              ▦
            </button>
            <button
              type="button"
              className={scopeOfMode === 'panel' ? 'on' : ''}
              onClick={() => changeMode('panel')}
              title={t('compare.scopePanelTitle')}
              aria-label={t('compare.scopePanelTitle')}
              disabled={readOnly}
            >
              ▣
            </button>
          </div>
          <span className="muted tiny alt-hint" title={t('compare.altHintTitle')}>
            {t('compare.altHint')}
          </span>
        </div>

        {annEditable && (
          <div className="tb-group ann-group">
            <button
              type="button"
              className={`btn tiny ${annOn ? 'on' : ''}`}
              aria-pressed={annOn}
              title={annOn ? t('ann.hide') : t('ann.show')}
              onClick={() => {
                setAnnOn(!annOn);
                if (annOn) {
                  setAnnTool('select');
                  setAnnSelected(null);
                }
              }}
            >
              {t('ann.layer')}
            </button>
            {annOn && (
              <>
                <div className="ann-tools">
                  {ANNOTATION_TOOL_ORDER.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={`btn icon ann-tool ${annTool === item ? 'on' : ''}`}
                      title={t(ANNOTATION_TOOLS[item].labelKey)}
                      aria-label={t(ANNOTATION_TOOLS[item].labelKey)}
                      aria-pressed={annTool === item}
                      onClick={() => {
                        setAnnTool(item);
                        setAnnSelected(null);
                      }}
                    >
                      {ANNOTATION_TOOLS[item].icon}
                    </button>
                  ))}
                </div>
                <div className="ann-colors" role="group" aria-label={t('ann.color')}>
                  {ANNOTATION_COLORS.map((swatch) => (
                    <button
                      key={swatch}
                      type="button"
                      className={`ann-swatch ${annColor === swatch ? 'on' : ''}`}
                      style={{ background: swatch }}
                      title={t('ann.color')}
                      aria-label={t('ann.color')}
                      onClick={() => {
                        setAnnColor(swatch);
                        // Recolour the selected mark, same shortcut as the panel workspace.
                        if (annSelected) {
                          applyAnnotations((list) =>
                            list.map((a) =>
                              a.id === annSelected ? { ...a, color: swatch, updatedAt: new Date().toISOString() } : a,
                            ),
                          );
                        }
                      }}
                    />
                  ))}
                </div>
                <div className="seg ann-scope-seg" title={t('ann.sharedHint')}>
                  <button
                    type="button"
                    className={annScope === 'page' ? 'on' : ''}
                    onClick={() => setAnnScope('page')}
                    title={`${t('ann.scopePage')} · ${t('ann.sharedHint')}`}
                  >
                    ▦
                  </button>
                  <button
                    type="button"
                    className={annScope === 'panel' ? 'on' : ''}
                    onClick={() => setAnnScope('panel')}
                    title={`${t('ann.scopePanelShort')} · ${t('ann.sharedHint')}`}
                  >
                    ▣
                  </button>
                </div>
                <button
                  type="button"
                  className="btn icon tiny"
                  onClick={deleteAnnotation}
                  disabled={!annSelected}
                  title={t('ann.delete')}
                  aria-label={t('ann.delete')}
                >
                  ✕
                </button>
                <button
                  type="button"
                  className="btn icon tiny"
                  onClick={clearAnnotations}
                  disabled={!annotations.length}
                  title={t('ann.clear')}
                  aria-label={t('ann.clear')}
                >
                  ⊗
                </button>
                <button
                  type="button"
                  className="btn icon tiny"
                  onClick={onUndo}
                  disabled={!canUndo}
                  title={t('panels.undoTitle')}
                  aria-label={t('panels.undoTitle')}
                >
                  ↶
                </button>
                <button
                  type="button"
                  className="btn icon tiny"
                  onClick={onRedo}
                  disabled={!canRedo}
                  title={t('panels.redoTitle')}
                  aria-label={t('panels.redoTitle')}
                >
                  ↷
                </button>
                <span className="muted tiny ann-hint">
                  {t('ann.laneHint', { lang: langShort(overlay ? dragLang : annLang) })}
                </span>
              </>
            )}
          </div>
        )}

        <div className="tb-group right">
          <span className="muted tiny">{readingLabel(doc.readingDirection)}</span>
          <button
            type="button"
            className="btn tiny"
            onClick={() => goTo(-1)}
            title={t('compare.prevPanel')}
            aria-label={t('compare.prevPanel')}
          >
            {t('compare.prevPanel')}
          </button>
          <button
            type="button"
            className="btn tiny"
            onClick={() => goTo(1)}
            title={t('compare.nextPanel')}
            aria-label={t('compare.nextPanel')}
          >
            {t('compare.nextPanel')}
          </button>
          <button
            type="button"
            className="btn icon tiny"
            onClick={resetAll}
            title={t('compare.resetAll')}
            aria-label={t('compare.resetAll')}
          >
            ↺
          </button>
          <button
            type="button"
            className="btn tiny tb-more-btn"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
            title={t('toolbar.more')}
          >
            {t('toolbar.more')}
          </button>
        </div>
      </div>

      {alignOpen && !readOnly && (
        <div className="align-box">
          <div className="align-hint">
            <b>{alignModeLabel(mode)}</b>
            <span>{t(ALIGN_HINT_KEY[mode])}</span>
            {mode === 'anchors' && (
              <span className="anchor-tip">
                {pendingAnchor
                  ? t('compare.anchorPending', { lang: langShort(pendingAnchor.lang) })
                  : t('compare.anchorWaiting', { lang: langShort(baseLang) })}
                {pendingAnchor && (
                  <button type="button" className="btn tiny" onClick={() => setPendingAnchor(null)}>
                    {t('compare.cancelAnchor')}
                  </button>
                )}
              </span>
            )}
          </div>

          <div className="align-row">
            <span className="tb-label">{t('compare.target')}</span>
            <div className="lang-chips">
              {langs.map((l) => (
                <button
                  type="button"
                  key={l}
                  className={`lang-chip ${dragLang === l ? 'on' : ''}`}
                  onClick={() => setDragLang(l)}
                  disabled={!page.files[l]}
                >
                  {langShort(l)}
                </button>
              ))}
            </div>
            <span className="muted tiny">
              {isPanelMode
                ? t('compare.appliesPanel', {
                    number: formatNumber(ordered.findIndex((p) => p.id === panelForInput?.id) + 1 || 1),
                  })
                : t('compare.appliesPage')}
            </span>
            <label className="num">
              X
              <input
                type="number"
                step={0.1}
                value={+(inputOffset.x * 100).toFixed(2)}
                onChange={(e) => applyNumeric({ x: Number(e.target.value) / 100 })}
              />
              %
            </label>
            <label className="num">
              Y
              <input
                type="number"
                step={0.1}
                value={+(inputOffset.y * 100).toFixed(2)}
                onChange={(e) => applyNumeric({ y: Number(e.target.value) / 100 })}
              />
              %
            </label>
            <label className="num">
              {t('compare.scale')}
              <input
                type="number"
                step={0.01}
                min={0.5}
                max={3}
                value={+inputOffset.scale.toFixed(2)}
                onChange={(e) => applyNumeric({ scale: clamp(Number(e.target.value), 0.5, 3) })}
              />
            </label>
            <span className="align-sep" />
            <button
              type="button"
              className="btn tiny"
              onClick={resetAllPanelOffsets}
              title={t('compare.resetAllPanelsTitle')}
            >
              {t('compare.resetAllPanels')}
            </button>
            <button
              type="button"
              className="btn tiny"
              onClick={resetCurrentPanelOffsets}
              disabled={!panelForInput}
              title={t('compare.resetCurrentPanelTitle')}
            >
              {t('compare.resetCurrentPanel')}
            </button>
          </div>

          <div className="align-row">
            <input
              className="preset-name"
              placeholder={t('compare.presetNamePlaceholder')}
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <button
              type="button"
              className="btn tiny"
              disabled={!presetName.trim() || presetBusy}
              onClick={() => savePreset('page')}
            >
              {t('compare.savePresetPage')}
            </button>
            <button
              type="button"
              className="btn tiny"
              disabled={!presetName.trim() || presetBusy}
              onClick={() => savePreset('chapter')}
            >
              {t('compare.savePresetChapter')}
            </button>
            <span className="align-sep" />
            <select className="tb-select" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              <option value="">{t('compare.selectPreset')}</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {alignModeLabel(p.mode)} ·{' '}
                  {p.scope === 'chapter' ? t('compare.presetScopeChapter') : t('compare.presetScopePage')}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn tiny"
              disabled={!presetId || presetBusy}
              onClick={() => applyPreset('page')}
            >
              {t('compare.applyPresetPage')}
            </button>
            <button
              type="button"
              className="btn tiny"
              disabled={!presetId || presetBusy}
              onClick={() => applyPreset('chapter')}
            >
              {t('compare.applyPresetChapter')}
            </button>
            <button
              type="button"
              className="btn tiny danger"
              disabled={!presetId || presetBusy}
              onClick={() => void deletePreset()}
            >
              {t('common.delete')}
            </button>
          </div>
        </div>
      )}

      {maskDefaultsOpen && (
        <div className="mask-defaults">
          <b>{t('compare.maskDefaultsHeading')}</b>
          {langBar.map((l) => (
            <label key={l}>
              <input
                type="checkbox"
                checked={maskWanted(l)}
                onChange={() => setMaskPrefs((p) => ({ ...p, masked: { ...p.masked, [l]: !maskWanted(l) } }))}
              />
              {langLabel(l)}
            </label>
          ))}
          <span className="muted tiny">{t('compare.maskDefaultsHint')}</span>
        </div>
      )}

      {overlay && (
        <div className="opacity-bar">
          {activeLangs.map((l) => (
            <label key={l}>
              <span>{langShort(l)}</span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={opacities[l] ?? (l === activeLangs[0] ? 1 : 0.5)}
                onChange={(e) => setOpacity(l, Number(e.target.value))}
              />
            </label>
          ))}
        </div>
      )}

      <div className="compare-scroll">
        {ordered.map((panel, idx) => {
          const isSel = selected.includes(panel.id);
          const notes = doc.notes.filter((n) => n.scope === 'panel' && n.panelId === panel.id);
          return (
            <article
              key={panel.id}
              id={`panel-${panel.id}`}
              className={`panel-card ${isSel ? 'sel' : ''} ${
                activeDrag?.panelId === panel.id && activeDrag.scope === 'page' ? 'scope-page' : ''
              }`}
              onClick={() => setSelected([panel.id])}
              onDoubleClick={() => openDetailFor(panel)}
              onPointerUp={(e) => {
                if (e.pointerType !== 'mouse' && isDoubleTap(panel.id)) openDetailFor(panel);
              }}
              title={t('detail.openHint')}
            >
              <div className="panel-card-head">
                <b>{t('format.panel', { number: formatNumber(idx + 1) })}</b>
                <span className="muted tiny">
                  x {Math.round(panel.rect.x * 100)}% · y {Math.round(panel.rect.y * 100)}% ·{' '}
                  {Math.round(panel.rect.w * 100)}% × {Math.round(panel.rect.h * 100)}%
                </span>
                <span className="spacer" />
                {notes.length > 0 && (
                  <span className="chip">{t('compare.noteCount', { count: formatNumber(notes.length) })}</span>
                )}
              </div>

              {overlay ? (
                <div className="lang-grid overlay">{renderOverlayPane(panel)}</div>
              ) : (
                <div
                  className={`lang-grid cols-${activeLangs.length}`}
                  style={{ ['--cols' as string]: activeLangs.length }}
                >
                  {activeLangs.map((l) => renderLangPane(l, panel))}
                </div>
              )}

              {notes.length > 0 && (
                <ul className="panel-notes">
                  {notes.map((n) => (
                    <li key={n.id}>
                      {n.tags.map((t) => (
                        <span className="tag" key={t}>
                          {t}
                        </span>
                      ))}
                      <span>{n.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>

      {/* Detail view: one panel, every enabled language enlarged, plus its notes and
          annotations. It owns the keyboard while open (see PanelDetail). */}
      {detailPanel && detailIndex >= 0 && (
        <PanelDetail
          doc={doc}
          page={page}
          panel={ordered[detailIndex]}
          index={detailIndex}
          total={ordered.length}
          langs={activeLangs}
          maskStyle={maskPrefs.style}
          isMasked={isHidden}
          reveal={(panelId, lang) => setRevealed((r) => ({ ...r, [revealKey(panelId, lang)]: true }))}
          annotations={annotations}
          annotationsVisible={annotationsVisible}
          aspectOf={(lang) => paneAspect(lang, ordered[detailIndex])}
          offsetOf={(lang) => offsetsOf(lang, ordered[detailIndex])}
          onClose={onCloseDetail}
          onPrev={onDetailPrevPanel}
          onNext={onDetailNextPanel}
          onPrevPage={onDetailPrevPage}
          onNextPage={onDetailNextPage}
        />
      )}
    </div>
  );
}
