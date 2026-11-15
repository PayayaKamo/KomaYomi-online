import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Lang, PageDoc, PageEntry, Panel, PanelGroup, PanelRect, PanelTemplate } from '../types';
import {
  applyDrag,
  applyGroupOrder,
  clamp01,
  normalizeGroupOrder,
  normalizeRect,
  sortPanels,
  uid,
  unionRects,
} from '../lib/geometry';
import type { ResizeHandle } from '../lib/geometry';
import { api } from '../api';
import type { HistorySource } from '../api';
import { formatDate, formatNumber, langLabel, useI18n } from '../i18n';
import type { MessageKey } from '../i18n';
import { ANNOTATION_COLORS, ANNOTATION_TOOL_ORDER, ANNOTATION_TOOLS, AnnotationLayer } from './AnnotationLayer';
import type { AnnotationTool } from './AnnotationLayer';
import { useAnnSurface } from '../lib/annotationSurface';
import { PANEL_SECTIONS, setPanelSection, togglePanelSection, usePanelSections } from '../lib/panelsSections';
import type { PanelSection } from '../lib/panelsSections';
import { toggleToolbarFold, useToolbarFolds } from '../lib/panelToolbarFolds';
import { PanelOrderDialog } from './PanelOrderDialog';

type Props = {
  doc: PageDoc;
  page: PageEntry;
  mutate: (fn: (doc: PageDoc) => PageDoc, opts?: { history?: boolean; source?: HistorySource }) => void;
  detecting: boolean;
  onDetect: (lang?: string) => void;
  selected: string[];
  setSelected: (ids: string[]) => void;
  onReload: () => void;
  /** auto = debounced autosave; confirm = only saves via ✓ or Enter. */
  saveMode: 'auto' | 'confirm';
  setSaveMode: (mode: 'auto' | 'confirm') => void;
  dirty: boolean;
  saving: boolean;
  onCommit: () => void;
  onDiscard: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Library language order; the page's own files decide which columns exist. */
  allLangs: Lang[];
};

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Alignment modes are stored per page; the chip lists them with the same wording as the compare bar. */
const ALIGN_MODE_KEYS: Record<PageDoc['alignMode'], MessageKey> = {
  page: 'align.mode.page',
  panel: 'align.mode.panel',
  anchors: 'align.mode.anchors',
  grid: 'align.mode.grid',
};

/** Snapping distance in screen pixels while drawing a new panel. */
const SNAP_PX = 6;
/** Pointer travel below this is treated as a click, so double-click still works. */
const CLICK_SLOP_PX = 3;
/** A marquee must be at least this large in both screen pixels and normalized size. */
const MIN_MARQUEE_PX = 8;
const MIN_MARQUEE_NORM = 0.01;

type Marquee = { rect: PanelRect; wPx: number; hPx: number };

/** Snap a normalized value to the nearest candidate that is within SNAP_PX screen pixels. */
function snapValue(value: number, candidates: number[], pxPerUnit: number): number {
  let best = value;
  let bestDist = SNAP_PX + 1;
  for (const c of candidates) {
    const dist = Math.abs(c - value) * pxPerUnit;
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return bestDist <= SNAP_PX ? best : value;
}

/** Candidate lines: page edges/center plus every existing panel edge/center on one axis. */
function snapCandidates(panels: Panel[], axis: 'x' | 'y'): number[] {
  const values = [0, 0.5, 1];
  for (const p of panels) {
    const start = axis === 'x' ? p.rect.x : p.rect.y;
    const size = axis === 'x' ? p.rect.w : p.rect.h;
    values.push(start, start + size / 2, start + size);
  }
  return values;
}

/** Build a clamped marquee from the fixed anchor and the moving pointer (normalized coords). */
function buildMarquee(
  anchor: { x: number; y: number },
  point: { x: number; y: number },
  box: DOMRect,
  panels: Panel[],
  shift: boolean,
  disableSnap: boolean,
): Marquee {
  let ax = anchor.x;
  let ay = anchor.y;
  let px = point.x;
  let py = point.y;
  if (!disableSnap) {
    const xs = snapCandidates(panels, 'x');
    const ys = snapCandidates(panels, 'y');
    ax = snapValue(ax, xs, box.width);
    ay = snapValue(ay, ys, box.height);
    px = snapValue(px, xs, box.width);
    py = snapValue(py, ys, box.height);
  }
  if (shift) {
    // Keep the marquee square on screen (equal pixel sides) while preserving drag direction.
    const dx = (px - ax) * box.width;
    const dy = (py - ay) * box.height;
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    px = ax + ((Math.sign(dx) || 1) * size) / box.width;
    py = ay + ((Math.sign(dy) || 1) * size) / box.height;
  }
  px = clamp01(px);
  py = clamp01(py);
  const x = Math.min(ax, px);
  const y = Math.min(ay, py);
  const w = Math.abs(px - ax);
  const h = Math.abs(py - ay);
  return { rect: { x, y, w, h }, wPx: w * box.width, hPx: h * box.height };
}

export function PanelsTab({
  doc,
  page,
  mutate,
  detecting,
  onDetect,
  selected,
  setSelected,
  onReload,
  saveMode,
  setSaveMode,
  dirty,
  saving,
  onCommit,
  onDiscard,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  allLangs,
}: Props) {
  const { t } = useI18n();
  const availableLangs = useMemo(() => {
    const files = Object.keys(page.files);
    const ordered = allLangs.filter((l) => files.includes(l));
    return [...ordered, ...files.filter((l) => !ordered.includes(l))];
  }, [page, allLangs]);
  const [refLang, setRefLang] = useState<Lang>(availableLangs[0] ?? 'ja');
  const [zoom, setZoom] = useState(1);
  const [showNumbers, setShowNumbers] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [templates, setTemplates] = useState<PanelTemplate[]>([]);
  const [tplName, setTplName] = useState('');
  const [selectedTpl, setSelectedTpl] = useState('');
  const [tplBusy, setTplBusy] = useState(false);
  const [tplMsg, setTplMsg] = useState('');
  const [gridRows, setGridRows] = useState(2);
  const [gridCols, setGridCols] = useState(2);
  const [gridGap, setGridGap] = useState(1.2);
  const [copied, setCopied] = useState(false);
  const [annTool, setAnnTool] = useState<AnnotationTool>('select');
  const [annSelected, setAnnSelected] = useState<string | null>(null);
  const [annColor, setAnnColor] = useState(ANNOTATION_COLORS[0]);

  const annSurface = useAnnSurface();
  /** Annotations belong to the reading view by default; the workspace opts in. */
  const annAllowed = annSurface !== 'read';

  /* Collapsible sidebar sections share one stored state so the arrows and the
     "Display" menu always agree. */
  const sections = usePanelSections();
  const [secMenuOpen, setSecMenuOpen] = useState(false);
  const secMenuRef = useRef<HTMLDivElement>(null);
  const folds = useToolbarFolds();
  const [metaOpen, setMetaOpen] = useState(false);
  const metaRef = useRef<HTMLDivElement>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const sectionLabels: Record<PanelSection, string> = {
    grid: t('panels.grid'),
    template: t('panels.templates'),
    path: t('panels.dataPath'),
    ann: t('ann.layer'),
    groups: t('panels.sectionGroups'),
  };

  useEffect(() => {
    if (!secMenuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!secMenuRef.current?.contains(e.target as Node)) setSecMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSecMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [secMenuOpen]);

  useEffect(() => {
    if (!metaOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!metaRef.current?.contains(e.target as Node)) setMetaOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMetaOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [metaOpen]);

  const annotations = doc.annotations ?? [];
  // Older pages have no flag; annotations were visible by default before the toggle existed.
  const annotationsVisible = annAllowed && doc.annotationsVisible !== false && sections.ann;

  useEffect(() => {
    if (!annAllowed) {
      setAnnTool('select');
      setAnnSelected(null);
    }
  }, [annAllowed]);

  const applyAnnotations = useCallback(
    (updater: (list: NonNullable<PageDoc['annotations']>) => NonNullable<PageDoc['annotations']>) => {
      // Tag annotation changes so the page history panel can label them.
      mutate((current) => ({ ...current, annotations: updater(current.annotations ?? []) }), { source: 'annotation' });
    },
    [mutate],
  );

  const loadTemplates = () => {
    api
      .panelTemplates()
      .then((res) => setTemplates(res.templates))
      .catch(() => setTemplates([]));
  };
  useEffect(loadTemplates, []);

  const shotRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: string;
    handle: ResizeHandle;
    start: PanelRect;
    sx: number;
    sy: number;
    rect: DOMRect;
  } | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [marqueeActive, setMarqueeActive] = useState(false);
  const marqueeStartRef = useRef<{
    anchor: { x: number; y: number };
    from: { x: number; y: number };
    box: DOMRect;
    moved: boolean;
  } | null>(null);
  const marqueeRectRef = useRef<Marquee | null>(null);

  useEffect(() => {
    setImgLoaded(false);
    setAnnSelected(null);
  }, [refLang, page.index]);

  useEffect(() => {
    if (!availableLangs.includes(refLang)) setRefLang(availableLangs[0] ?? 'ja');
  }, [availableLangs, refLang]);

  const ordered = useMemo(
    () => applyGroupOrder(sortPanels(doc.panels, doc.readingDirection), doc.groups),
    [doc.panels, doc.readingDirection, doc.groups],
  );
  const numberMap = useMemo(() => {
    const m = new Map<string, number>();
    ordered.forEach((p, i) => m.set(p.id, i + 1));
    return m;
  }, [ordered]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (e.clientX - d.sx) / d.rect.width;
      const dy = (e.clientY - d.sy) / d.rect.height;
      const rect = applyDrag(d.start, d.handle, dx, dy);
      mutate((doc2) => ({
        ...doc2,
        panels: doc2.panels.map((p) => (p.id === d.id ? { ...p, rect, source: 'manual' as const } : p)),
      }));
    };
    const up = () => {
      setDragging(false);
      dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging, mutate]);

  useEffect(() => {
    if (!marqueeActive) return;
    const move = (e: PointerEvent) => {
      const d = marqueeStartRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.from.x, e.clientY - d.from.y) < CLICK_SLOP_PX) return;
      d.moved = true;
      const point = {
        x: clamp01((e.clientX - d.box.left) / d.box.width),
        y: clamp01((e.clientY - d.box.top) / d.box.height),
      };
      const next = buildMarquee(d.anchor, point, d.box, doc.panels, e.shiftKey, e.altKey);
      marqueeRectRef.current = next;
      setMarquee(next);
    };
    const end = (commit: boolean) => {
      const d = marqueeStartRef.current;
      const m = marqueeRectRef.current;
      marqueeStartRef.current = null;
      marqueeRectRef.current = null;
      setMarqueeActive(false);
      setMarquee(null);
      // A click without travel must not create anything, so double-click keeps working.
      if (!commit || !d || !d.moved || !m) return;
      if (m.rect.w < MIN_MARQUEE_NORM || m.rect.h < MIN_MARQUEE_NORM) return;
      if (m.wPx < MIN_MARQUEE_PX || m.hPx < MIN_MARQUEE_PX) return;
      const id = uid('p');
      // One mutate call keeps undo/redo and confirm-save mode working like other edits.
      mutate((doc2) => ({ ...doc2, panels: [...doc2.panels, { id, rect: m.rect, source: 'manual' }] }));
      setSelected([id]);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [marqueeActive, doc.panels, mutate, setSelected]);

  const startDrag = (e: ReactPointerEvent, panel: Panel, handle: ResizeHandle) => {
    e.preventDefault();
    e.stopPropagation();
    setAnnSelected(null);
    const el = shotRef.current;
    if (!el) return;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (additive) {
      setSelected(selected.includes(panel.id) ? selected.filter((id) => id !== panel.id) : [...selected, panel.id]);
    } else if (!selected.includes(panel.id)) {
      setSelected([panel.id]);
    }
    dragRef.current = {
      id: panel.id,
      handle,
      start: panel.rect,
      sx: e.clientX,
      sy: e.clientY,
      rect: el.getBoundingClientRect(),
    };
    setDragging(true);
  };

  /** Pointer down on empty page area: clear selection and arm a drag-to-draw marquee. */
  const startMarquee = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Drawing tools own the page surface; leaving this armed would draw both at once.
    if (annTool !== 'select') return;
    setAnnSelected(null);
    if (e.button !== 0 || !e.isPrimary) return;
    // Panels and handles stop propagation themselves; this guard keeps nested markers safe.
    if ((e.target as HTMLElement).closest('.pbox')) return;
    setSelected([]);
    const el = shotRef.current;
    if (!el || !imgLoaded) return;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return;
    marqueeStartRef.current = {
      anchor: {
        x: clamp01((e.clientX - box.left) / box.width),
        y: clamp01((e.clientY - box.top) / box.height),
      },
      from: { x: e.clientX, y: e.clientY },
      box,
      moved: false,
    };
    marqueeRectRef.current = null;
    setMarqueeActive(true);
  };

  const addPanel = (center?: { x: number; y: number }) => {
    const rect: PanelRect = center
      ? {
          x: Math.max(0, Math.min(0.75, center.x - 0.125)),
          y: Math.max(0, Math.min(0.8, center.y - 0.075)),
          w: 0.25,
          h: 0.15,
        }
      : { x: 0.3, y: 0.4, w: 0.4, h: 0.2 };
    const id = uid('p');
    mutate((d) => ({ ...d, panels: [...d.panels, { id, rect, source: 'manual' }] }));
    setSelected([id]);
  };

  const deleteSelected = () => {
    if (!selected.length) return;
    mutate((d) => ({
      ...d,
      panels: d.panels.filter((p) => !selected.includes(p.id)),
      notes: d.notes.filter((n) => !(n.scope === 'panel' && n.panelId && selected.includes(n.panelId))),
      groups: (d.groups ?? [])
        .map((g) => ({ ...g, panelIds: g.panelIds.filter((id) => !selected.includes(id)) }))
        .filter((g) => g.panelIds.length > 0),
    }));
    setSelected([]);
  };

  /** Reordering writes the array order plus consecutive numbers; undo restores both. */
  const applyPanelOrder = (order: string[]) => {
    mutate((d) => {
      const byId = new Map(d.panels.map((p) => [p.id, p]));
      const panels = order
        .map((id) => byId.get(id))
        .filter((p): p is Panel => Boolean(p))
        .map((p, i) => ({ ...p, number: i + 1 }));
      return { ...d, panels };
    });
    setOrderOpen(false);
  };

  /** Re-detecting rebuilds the array, so a hand-saved order needs an explicit yes. */
  const requestDetect = () => {
    if (doc.panels.some((p) => typeof p.number === 'number') && !window.confirm(t('panels.redetectLosesOrder'))) return;
    onDetect(refLang);
  };

  const mergeSelected = () => {
    if (selected.length < 2) return;
    const chosen = doc.panels.filter((p) => selected.includes(p.id));
    const rect = unionRects(chosen.map((p) => p.rect));
    const id = uid('p');
    mutate((d) => ({
      ...d,
      panels: [...d.panels.filter((p) => !selected.includes(p.id)), { id, rect, source: 'merged' }],
      notes: d.notes.map((n) =>
        n.scope === 'panel' && n.panelId && selected.includes(n.panelId) ? { ...n, panelId: id } : n,
      ),
      groups: (d.groups ?? [])
        .map((g) => ({ ...g, panelIds: g.panelIds.filter((pid) => !selected.includes(pid)) }))
        .filter((g) => g.panelIds.length > 0),
    }));
    setSelected([id]);
  };

  /* ---------------- groups ---------------- */

  const groupColors = ['#e11d48', '#f59e0b', '#10b981', '#3b82f6', '#a855f7', '#64748b'];

  const groupColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of doc.groups ?? []) {
      if (!group.color) continue;
      for (const id of group.panelIds) if (!map.has(id)) map.set(id, group.color);
    }
    return map;
  }, [doc.groups]);

  const createGroup = () => {
    const ids = ordered.filter((panel) => selected.includes(panel.id)).map((panel) => panel.id);
    if (!ids.length) return;
    const gid = uid('grp');
    mutate((d) => {
      // Grouping takes the panels out of any earlier group, so groups never overlap.
      const kept = (d.groups ?? [])
        .map((g) => ({ ...g, panelIds: g.panelIds.filter((id) => !ids.includes(id)) }))
        .filter((g) => g.panelIds.length > 0);
      return {
        ...d,
        groups: [
          ...kept,
          {
            id: gid,
            name: t('groups.defaultName', { n: formatNumber(kept.length + 1) }),
            panelIds: ids,
            color: groupColors[kept.length % groupColors.length],
          },
        ],
      };
    });
    setSelected([]);
  };

  const patchGroup = (id: string, patch: Partial<PanelGroup>) => {
    mutate((d) => ({ ...d, groups: (d.groups ?? []).map((g) => (g.id === id ? { ...g, ...patch } : g)) }));
  };

  const removeFromGroup = (gid: string, pid: string) => {
    mutate((d) => ({
      ...d,
      groups: (d.groups ?? [])
        .map((g) => (g.id === gid ? { ...g, panelIds: g.panelIds.filter((id) => id !== pid) } : g))
        .filter((g) => g.panelIds.length > 0),
    }));
  };

  const dragChip = useRef<{ gid: string; index: number } | null>(null);

  const dropChip = (gid: string, target: number) => {
    const drag = dragChip.current;
    dragChip.current = null;
    if (!drag || drag.gid !== gid || drag.index === target) return;
    mutate((d) => ({
      ...d,
      groups: (d.groups ?? []).map((g) => {
        if (g.id !== gid) return g;
        const ids = [...g.panelIds];
        const [moved] = ids.splice(drag.index, 1);
        ids.splice(target, 0, moved);
        return { ...g, panelIds: ids };
      }),
    }));
  };

  const mergeGroupUp = (index: number) => {
    if (index <= 0) return;
    mutate((d) => {
      const groups = [...(d.groups ?? [])];
      const target = groups[index - 1];
      const source = groups[index];
      if (!target || !source) return d;
      groups[index - 1] = { ...target, panelIds: [...target.panelIds, ...source.panelIds] };
      groups.splice(index, 1);
      return { ...d, groups };
    });
  };

  const splitGroup = (id: string) => {
    mutate((d) => {
      const groups = d.groups ?? [];
      const index = groups.findIndex((g) => g.id === id);
      if (index < 0 || groups[index].panelIds.length < 2) return d;
      const source = groups[index];
      const pieces: PanelGroup[] = source.panelIds.map((pid, i) => ({
        id: uid('grp'),
        name: `${source.name || t('groups.defaultName', { n: formatNumber(index + 1) })} · ${i + 1}`,
        panelIds: [pid],
        color: source.color,
      }));
      const next = [...groups];
      next.splice(index, 1, ...pieces);
      return { ...d, groups: next };
    });
  };

  const deleteGroup = (id: string) => {
    // Removing a group never removes panels.
    mutate((d) => ({ ...d, groups: (d.groups ?? []).filter((g) => g.id !== id) }));
  };

  const sortByGroup = () => {
    mutate((d) => ({
      ...d,
      groups: normalizeGroupOrder(
        d.groups ?? [],
        ordered.map((panel) => panel.id),
      ),
    }));
  };

  const singleSelected = doc.panels.find((p) => p.id === selected[0]);

  const patchRect = (patch: Partial<PanelRect>) => {
    if (!singleSelected) return;
    const rect = normalizeRect({ ...singleSelected.rect, ...patch });
    mutate((d) => ({
      ...d,
      panels: d.panels.map((p) => (p.id === singleSelected.id ? { ...p, rect, source: 'manual' as const } : p)),
    }));
  };

  const replacePanels = (rects: PanelRect[], label: string) => {
    const oldOrder = sortPanels(doc.panels, doc.readingDirection);
    const panels: Panel[] = rects.map((rect) => ({ id: uid('p'), rect, source: 'manual' }));
    const sameCount = oldOrder.length === panels.length;
    if (
      doc.panels.length > 0 &&
      !window.confirm(
        t(sameCount ? 'panels.replaceSame' : 'panels.replaceDifferent', {
          count: formatNumber(doc.panels.length),
          label,
        }),
      )
    ) {
      return false;
    }
    mutate((d) => {
      if (!sameCount) {
        return { ...d, panels, notes: d.notes.filter((n) => n.scope !== 'panel'), groups: [] };
      }
      const map = new Map(oldOrder.map((p, i) => [p.id, panels[i].id]));
      return {
        ...d,
        panels,
        notes: d.notes.map((n) =>
          n.scope === 'panel' && n.panelId && map.has(n.panelId) ? { ...n, panelId: map.get(n.panelId)! } : n,
        ),
        groups: [],
      };
    });
    setSelected([panels[0].id]);
    return true;
  };

  const makeGrid = () => {
    const rows = Math.min(8, Math.max(1, gridRows));
    const cols = Math.min(6, Math.max(1, gridCols));
    const gap = Math.max(0, gridGap) / 100;
    const w = (1 - gap * (cols - 1)) / cols;
    const h = (1 - gap * (rows - 1)) / rows;
    const rects: PanelRect[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        rects.push({ x: c * (w + gap), y: r * (h + gap), w, h });
      }
    }
    replacePanels(rects, t('panels.gridLabel', { rows: formatNumber(rows), cols: formatNumber(cols) }));
  };

  const saveTemplate = async () => {
    if (!doc.panels.length) return;
    setTplBusy(true);
    try {
      const res = await api.savePanelTemplate({
        name:
          tplName.trim() ||
          t('panels.defaultTemplateName', {
            chapter: doc.chapter,
            page: formatNumber(doc.pageIndex + 1),
          }),
        volume: doc.volume,
        chapter: doc.chapter,
        panels: doc.panels.map((p) => p.rect),
        readingDirection: doc.readingDirection,
      });
      setTplName('');
      setSelectedTpl(res.template.id);
      setTplMsg(t('panels.templateSaved', { name: res.template.name }));
      loadTemplates();
    } catch (err) {
      setTplMsg(err instanceof Error ? err.message : t('panels.templateSaveFailed'));
    } finally {
      setTplBusy(false);
    }
  };

  const applyTemplate = async (scope: 'page' | 'chapter') => {
    if (!selectedTpl) return;
    if (scope === 'chapter' && !window.confirm(t('panels.applyTemplateConfirm'))) return;
    setTplBusy(true);
    try {
      // Flush unsaved edits first so applying a template cannot silently drop them.
      await api.savePage(doc);
      const res = await api.applyPanelTemplate(
        selectedTpl,
        doc.volume,
        doc.chapter,
        scope === 'page' ? [doc.pageIndex] : undefined,
      );
      setTplMsg(
        res.droppedNotes
          ? t('panels.templateAppliedWithDropped', {
              pages: formatNumber(res.applied),
              notes: formatNumber(res.droppedNotes),
            })
          : t('panels.templateApplied', { pages: formatNumber(res.applied) }),
      );
      onReload();
    } catch (err) {
      setTplMsg(err instanceof Error ? err.message : t('panels.templateApplyFailed'));
    } finally {
      setTplBusy(false);
    }
  };

  const deleteTemplate = async () => {
    if (!selectedTpl) return;
    await api.deletePanelTemplate(selectedTpl).catch(() => null);
    setSelectedTpl('');
    setTplMsg(t('panels.templateDeleted'));
    loadTemplates();
  };

  const jsonPath = `data/pages/${doc.volume}/${doc.chapter}/${doc.pageIndex}.json`;

  const copyJsonPath = async () => {
    try {
      await navigator.clipboard.writeText(jsonPath);
    } catch {
      window.prompt(t('panels.copyPrompt'), jsonPath);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
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

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // Annotation focus is more specific than page-level actions: Esc only leaves the
    // annotation mode, and Delete only removes the selected annotation.
    if (e.key === 'Escape' && annSelected) {
      e.preventDefault();
      setAnnSelected(null);
      return;
    }
    if (e.key === 'Escape' && annTool !== 'select') {
      e.preventDefault();
      setAnnTool('select');
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && annSelected) {
      e.preventDefault();
      deleteAnnotation();
      return;
    }
    // In confirm mode Enter/Esc map to ✓/×; while marquee-selecting, Esc cancels the selection instead.
    if (saveMode === 'confirm') {
      if (e.key === 'Enter' && dirty) {
        e.preventDefault();
        onCommit();
        return;
      }
      if (e.key === 'Escape' && dirty && !marqueeActive) {
        e.preventDefault();
        onDiscard();
        return;
      }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
      e.preventDefault();
      deleteSelected();
      return;
    }
    if (selected.length && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? 0.01 : 0.002;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      mutate((d) => ({
        ...d,
        panels: d.panels.map((p) =>
          selected.includes(p.id) ? { ...p, rect: applyDrag(p.rect, 'move', dx, dy), source: 'manual' } : p,
        ),
      }));
    }
  };

  const url = page.files[refLang];
  /** Same wording the old status strip used, now shown inside the details popover. */
  const detectSourceLabel =
    doc.detectSource === 'manual' || doc.panels.some((p) => p.source !== 'auto')
      ? t('panels.manualEdited')
      : doc.detectSource === 'template'
        ? t('panels.fromTemplate')
        : doc.detectSource === 'plugin'
          ? t('panels.fromPlugin')
          : t('panels.autoDetectSource');

  return (
    <div className="panels-tab" onKeyDown={onKeyDown} tabIndex={0}>
      {page.warnings.length > 0 && (
        <div className="warn-strip">
          {page.warnings.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
      )}

      <div className="stage-toolbar panels-toolbar">
        <div className="tb-group tb-base">
          <label className="tb-label">{t('panels.baseImage')}</label>
          <select value={refLang} onChange={(e) => setRefLang(e.target.value as Lang)} className="tb-select">
            {availableLangs.map((l) => (
              <option value={l} key={l}>
                {langLabel(l)}
              </option>
            ))}
          </select>
        </div>

        <div className="tb-group tb-split">
          <button
            type="button"
            className="tb-fold"
            aria-expanded={folds.split}
            title={t(folds.split ? 'panels.foldGroup' : 'panels.unfoldGroup')}
            onClick={() => toggleToolbarFold('split')}
          >
            {folds.split ? '▾' : '▸'}
          </button>
          <span className="tb-label tb-group-label">{t('panels.grpSplit')}</span>
          {folds.split && (
            <>
              <span className="local-only-chip" title={t('online.unsupported')}>
                {t('online.localOnly')}
              </span>
              <button type="button" className="btn" onClick={() => addPanel()} disabled={!imgLoaded}>
                {t('panels.addPanel')}
              </button>
              <button type="button" className="btn" onClick={mergeSelected} disabled={selected.length < 2}>
                {t('panels.merge')} {selected.length >= 2 ? `(${formatNumber(selected.length)})` : ''}
              </button>
              <button type="button" className="btn" onClick={() => setOrderOpen(true)} disabled={doc.panels.length < 2}>
                {t('panels.order')}
              </button>
              <button type="button" className="btn" onClick={createGroup} disabled={!selected.length}>
                {t('groups.create')} {selected.length ? `(${formatNumber(selected.length)})` : ''}
              </button>
              <button type="button" className="btn danger" onClick={deleteSelected} disabled={!selected.length}>
                {t('common.delete')}
              </button>
            </>
          )}
        </div>

        <div className="tb-group save-group tb-edit">
          <button
            type="button"
            className="tb-fold"
            aria-expanded={folds.save}
            title={t(folds.save ? 'panels.foldGroup' : 'panels.unfoldGroup')}
            onClick={() => toggleToolbarFold('save')}
          >
            {folds.save ? '▾' : '▸'}
          </button>
          <span className="tb-label tb-group-label">{t('panels.grpEdit')}</span>
          {folds.save && (
            <>
              <div className="seg">
                <button
                  type="button"
                  className={saveMode === 'auto' ? 'on' : ''}
                  onClick={() => setSaveMode('auto')}
                  title={t('panels.saveAutoTitle')}
                >
                  {t('panels.saveAuto')}
                </button>
                <button
                  type="button"
                  className={saveMode === 'confirm' ? 'on' : ''}
                  onClick={() => setSaveMode('confirm')}
                  title={t('panels.saveConfirmTitle')}
                >
                  {t('panels.saveConfirm')}
                </button>
              </div>
              {saveMode === 'confirm' && dirty && <span className="unsaved-flag">{t('panels.unsaved')}</span>}
              <button
                type="button"
                className="btn icon"
                disabled={!canUndo}
                onClick={onUndo}
                title={t('panels.undoTitle')}
              >
                ↶
              </button>
              <button
                type="button"
                className="btn icon"
                disabled={!canRedo}
                onClick={onRedo}
                title={t('panels.redoTitle')}
              >
                ↷
              </button>
              {saveMode === 'confirm' && dirty && (
                <>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={onCommit}
                    disabled={saving}
                    title={t('panels.commitTitle')}
                  >
                    ✓
                  </button>
                  <button type="button" className="btn danger" onClick={onDiscard} title={t('panels.discardTitle')}>
                    ×
                  </button>
                </>
              )}
            </>
          )}
        </div>

        {/* Detection details are status, not controls: keep them behind ⓘ so the
            primary row stays a single line. */}
        <div className="tb-group tb-info" ref={metaRef}>
          <button
            type="button"
            className={`btn icon ${metaOpen ? 'on' : ''}`}
            aria-expanded={metaOpen}
            aria-haspopup="dialog"
            title={t('panels.infoTitle')}
            aria-label={t('panels.infoTitle')}
            onClick={() => setMetaOpen((v) => !v)}
          >
            ⓘ
          </button>
          {metaOpen && (
            <div className="meta-pop" role="dialog" aria-label={t('panels.infoTitle')}>
              <dl className="meta-list">
                <dt>{t('panels.detectLabel')}</dt>
                <dd>
                  <span className="chip-mini" title={t('panels.detectorVersionTitle')}>
                    {doc.detectorVersion ?? t('panels.legacyData')}
                  </span>
                </dd>
                <dt>{t('panels.sourceLabel')}</dt>
                <dd>{detectSourceLabel}</dd>
                <dt>{t('panels.saveCountLabel')}</dt>
                <dd>{formatNumber(doc.editCount ?? 0)}</dd>
                <dt>{t('panels.lastSavedLabel')}</dt>
                <dd>{doc.lastEditedAt ? formatDate(doc.lastEditedAt) : '—'}</dd>
                <dt>{t('panels.alignModeLabel')}</dt>
                <dd>{t(ALIGN_MODE_KEYS[doc.alignMode])}</dd>
                {doc.lastEditSummary && (
                  <>
                    <dt>{t('panels.lastEditLabel')}</dt>
                    <dd>{doc.lastEditSummary}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
        </div>

        <div className="tb-group right tb-view">
          <button
            type="button"
            className="tb-fold"
            aria-expanded={folds.view}
            title={t(folds.view ? 'panels.foldGroup' : 'panels.unfoldGroup')}
            onClick={() => toggleToolbarFold('view')}
          >
            {folds.view ? '▾' : '▸'}
          </button>
          <span className="tb-label tb-group-label">{t('panels.grpView')}</span>
          {folds.view && (
            <label className="tb-check" title={t('panels.numbers')}>
              <input type="checkbox" checked={showNumbers} onChange={(e) => setShowNumbers(e.target.checked)} />
              <span className="tb-num-text">{t('panels.numbers')}</span>
            </label>
          )}
          {folds.view && (
            <div className="zoom">
              <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))}>
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button type="button" onClick={() => setZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))}>
                ＋
              </button>
            </div>
          )}
        </div>
      </div>

      {singleSelected && (
        <div className="stage-toolbar sub">
          <div className="tb-group rect-inputs">
            <span className="tb-label">{t('panels.panelRect')}</span>
            <label className="num">
              X
              <input
                type="number"
                step={0.1}
                value={+(singleSelected.rect.x * 100).toFixed(2)}
                onChange={(e) => patchRect({ x: Number(e.target.value) / 100 })}
              />
              %
            </label>
            <label className="num">
              Y
              <input
                type="number"
                step={0.1}
                value={+(singleSelected.rect.y * 100).toFixed(2)}
                onChange={(e) => patchRect({ y: Number(e.target.value) / 100 })}
              />
              %
            </label>
            <label className="num">
              {t('panels.width')}
              <input
                type="number"
                step={0.1}
                value={+(singleSelected.rect.w * 100).toFixed(2)}
                onChange={(e) => patchRect({ w: Number(e.target.value) / 100 })}
              />
              %
            </label>
            <label className="num">
              {t('panels.height')}
              <input
                type="number"
                step={0.1}
                value={+(singleSelected.rect.h * 100).toFixed(2)}
                onChange={(e) => patchRect({ h: Number(e.target.value) / 100 })}
              />
              %
            </label>
          </div>
        </div>
      )}

      {/* One rail keeps every collapsed section visible in a single row; a folded
          section renders no body at all, so it costs no height. */}
      <div className="sec-rail">
        <button
          type="button"
          className="sec-tab"
          aria-expanded={sections.grid}
          title={t('panels.grid')}
          onClick={() => togglePanelSection('grid')}
        >
          {sections.grid ? '▾' : '▸'} {t('panels.grid')}
        </button>
        <button
          type="button"
          className="sec-tab"
          aria-expanded={sections.template}
          title={t('panels.templates')}
          onClick={() => togglePanelSection('template')}
        >
          {sections.template ? '▾' : '▸'} {t('panels.templates')}
          {templates.length ? ` (${formatNumber(templates.length)})` : ''}
        </button>
        <button
          type="button"
          className="sec-tab"
          aria-expanded={sections.path}
          title={t('panels.dataPath')}
          onClick={() => togglePanelSection('path')}
        >
          {sections.path ? '▾' : '▸'} {t('panels.dataPath')}
        </button>
        <div className="sec-menu" ref={secMenuRef}>
          <button
            type="button"
            className={`btn tiny ${secMenuOpen ? 'on' : ''}`}
            aria-expanded={secMenuOpen}
            aria-haspopup="true"
            title={t('panels.displayHint')}
            onClick={() => setSecMenuOpen((v) => !v)}
          >
            {t('panels.display')} ▾
          </button>
          {secMenuOpen && (
            <div className="sec-pop" role="group" aria-label={t('panels.display')}>
              <div className="sec-pop-head">{t('panels.displayHint')}</div>
              {PANEL_SECTIONS.filter((id) => id !== 'ann' || annAllowed).map((id) => (
                <label key={id} className="sec-pop-item">
                  <input
                    type="checkbox"
                    checked={sections[id]}
                    onChange={(e) => setPanelSection(id, e.target.checked)}
                  />
                  <span>{sectionLabels[id]}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {sections.grid && (
        <div className="sec-body">
          <span className="tb-label">{t('panels.grid')}</span>
          <label className="num">
            {t('panels.rows')}
            <input
              type="number"
              min={1}
              max={8}
              value={gridRows}
              onChange={(e) => setGridRows(Number(e.target.value) || 1)}
            />
          </label>
          <label className="num">
            {t('panels.cols')}
            <input
              type="number"
              min={1}
              max={6}
              value={gridCols}
              onChange={(e) => setGridCols(Number(e.target.value) || 1)}
            />
          </label>
          <label className="num">
            {t('panels.gap')}
            <input
              type="number"
              min={0}
              max={8}
              step={0.2}
              value={gridGap}
              onChange={(e) => setGridGap(Number(e.target.value))}
            />
            %
          </label>
          <button type="button" className="btn tiny" onClick={makeGrid}>
            {t('panels.makeGrid')}
          </button>
        </div>
      )}

      {sections.path && (
        <div className="sec-body sec-path">
          <code>{jsonPath}</code>
          <button
            type="button"
            className="btn tiny"
            onClick={() => void copyJsonPath()}
            title={t('panels.copyJsonPathTitle')}
          >
            {copied ? t('panels.copiedPath') : t('panels.copyJsonPath')}
          </button>
        </div>
      )}

      {sections.template && (
        <div className="sec-body tpl-box">
          <div className="tpl-row">
            <input
              className="preset-name"
              placeholder={t('panels.templateNamePlaceholder')}
              value={tplName}
              onChange={(e) => setTplName(e.target.value)}
            />
            <button
              type="button"
              className="btn tiny"
              onClick={() => void saveTemplate()}
              disabled={tplBusy || !doc.panels.length}
            >
              {t('panels.saveAsTemplate')}
            </button>
          </div>
          <div className="tpl-row">
            <select className="tb-select" value={selectedTpl} onChange={(e) => setSelectedTpl(e.target.value)}>
              <option value="">{t('panels.selectTemplate')}</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name} · {t('panels.panelCount', { count: formatNumber(tpl.panels.length) })}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn tiny"
              onClick={() => void applyTemplate('page')}
              disabled={tplBusy || !selectedTpl}
            >
              {t('panels.applyPage')}
            </button>
            <button
              type="button"
              className="btn tiny"
              onClick={() => void applyTemplate('chapter')}
              disabled={tplBusy || !selectedTpl}
            >
              {t('panels.applyChapter')}
            </button>
            <button
              type="button"
              className="btn tiny danger"
              onClick={() => void deleteTemplate()}
              disabled={tplBusy || !selectedTpl}
            >
              {t('panels.deleteTemplate')}
            </button>
            <span className="muted tiny">
              {t('panels.dataFile', {
                volume: doc.volume,
                chapter: doc.chapter,
                page: String(doc.pageIndex),
              })}
            </span>
          </div>
          {tplMsg && <div className="tpl-msg">{tplMsg}</div>}
        </div>
      )}

      {annAllowed && (
        <div className="ann-toolbar">
          <button
            type="button"
            className="btn tiny"
            aria-expanded={sections.ann}
            title={t('ann.toggleTools')}
            onClick={() => {
              const next = !sections.ann;
              togglePanelSection('ann');
              if (!next) {
                setAnnTool('select');
                setAnnSelected(null);
              }
            }}
          >
            {sections.ann ? '▾' : '▸'} {t('ann.layer')}
          </button>
          {sections.ann && (
            <>
              <button
                type="button"
                className={`btn tiny ${annotationsVisible ? 'on' : ''}`}
                aria-pressed={annotationsVisible}
                title={annotationsVisible ? t('ann.hide') : t('ann.show')}
                onClick={() => {
                  mutate((current) => ({ ...current, annotationsVisible: !annotationsVisible }));
                  if (annotationsVisible) {
                    setAnnTool('select');
                    setAnnSelected(null);
                  }
                }}
              >
                {annotationsVisible ? t('ann.on') : t('ann.off')}
              </button>
              <div className="ann-tools">
                {ANNOTATION_TOOL_ORDER.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`btn icon ann-tool ${annTool === item ? 'on' : ''}`}
                    title={t(ANNOTATION_TOOLS[item].labelKey)}
                    aria-label={t(ANNOTATION_TOOLS[item].labelKey)}
                    aria-pressed={annTool === item}
                    disabled={!annotationsVisible}
                    onClick={() => {
                      setAnnTool(item);
                      // Keep a single selected panel: it decides whether new marks use page
                      // scope or panel scope. The text in the toolbar states which one.
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
                      // Changing a swatch recolours the selected annotation, which is the
                      // quickest way to fix a wrong colour without deleting the shape.
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
              <button type="button" className="btn tiny danger" onClick={deleteAnnotation} disabled={!annSelected}>
                {t('ann.delete')}
              </button>
              <button
                type="button"
                className="btn tiny danger"
                onClick={clearAnnotations}
                disabled={!annotations.length}
              >
                {t('ann.clear')}
              </button>
              <span className="muted tiny ann-hint">
                {!annotationsVisible
                  ? t('ann.hiddenHint')
                  : singleSelected
                    ? t('ann.scopePanel', { n: formatNumber(numberMap.get(singleSelected.id) ?? 0) })
                    : t('ann.scopePage')}
              </span>
            </>
          )}
        </div>
      )}

      <div className="groups-panel">
        <div className="groups-head">
          <button
            type="button"
            className="btn tiny"
            aria-expanded={sections.groups}
            title={t('groups.toggle')}
            onClick={() => togglePanelSection('groups')}
          >
            {sections.groups ? '▾' : '▸'} {t('groups.title', { n: formatNumber((doc.groups ?? []).length) })}
          </button>
          <button
            type="button"
            className="btn tiny"
            onClick={sortByGroup}
            disabled={(doc.groups ?? []).length < 1}
            title={t('groups.sortHint')}
          >
            {t('groups.sort')}
          </button>
        </div>
        {sections.groups &&
          ((doc.groups ?? []).length ? (
            <div className="group-list">
              {(doc.groups ?? []).map((group, index) => (
                <div className="group-row" key={group.id}>
                  <input
                    type="color"
                    className="group-color"
                    value={group.color ?? groupColors[index % groupColors.length]}
                    title={t('groups.color')}
                    aria-label={t('groups.color')}
                    onChange={(e) => patchGroup(group.id, { color: e.target.value })}
                  />
                  <input
                    className="group-name"
                    value={group.name ?? ''}
                    placeholder={t('groups.namePlaceholder')}
                    aria-label={t('groups.name')}
                    onChange={(e) => patchGroup(group.id, { name: e.target.value })}
                  />
                  <div className="group-chips">
                    {group.panelIds.map((pid, chipIndex) => (
                      <div
                        key={pid}
                        className="group-chip"
                        draggable
                        title={t('groups.chipHint')}
                        onDragStart={() => {
                          dragChip.current = { gid: group.id, index: chipIndex };
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => dropChip(group.id, chipIndex)}
                      >
                        <span className="group-chip-num">{formatNumber(numberMap.get(pid) ?? 0)}</span>
                        <button
                          type="button"
                          className="group-chip-x"
                          title={t('groups.removePanel')}
                          aria-label={t('groups.removePanel')}
                          onClick={() => removeFromGroup(group.id, pid)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="group-actions">
                    <button
                      type="button"
                      className="btn tiny"
                      title={t('groups.merge')}
                      onClick={() => mergeGroupUp(index)}
                      disabled={index === 0}
                    >
                      {t('groups.merge')}
                    </button>
                    <button
                      type="button"
                      className="btn tiny"
                      title={t('groups.split')}
                      onClick={() => splitGroup(group.id)}
                      disabled={group.panelIds.length < 2}
                    >
                      {t('groups.split')}
                    </button>
                    <button
                      type="button"
                      className="btn tiny danger"
                      title={t('groups.deleteHint')}
                      onClick={() => deleteGroup(group.id)}
                    >
                      {t('groups.delete')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted tiny groups-empty">{t('groups.empty')}</div>
          ))}
      </div>

      <div className="stage-scroll">
        {!url ? (
          <div className="stage-empty">{t('panels.emptyPage')}</div>
        ) : (
          <div className="canvas-wrap" style={{ width: `${zoom * 100}%` }}>
            <div
              className={`shot ${annTool !== 'select' ? 'ann-drawing' : ''}`}
              ref={shotRef}
              onPointerDown={startMarquee}
              onDoubleClick={(e) => {
                if (annTool !== 'select') return;
                if ((e.target as HTMLElement).closest('.pbox')) return;
                const r = e.currentTarget.getBoundingClientRect();
                addPanel({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
              }}
            >
              <img
                src={url}
                alt={t('format.page', { page: formatNumber(doc.pageIndex + 1) })}
                draggable={false}
                onLoad={() => setImgLoaded(true)}
              />
              {imgLoaded && annAllowed && (
                <AnnotationLayer
                  annotations={annotations}
                  visible={annotationsVisible}
                  tool={annTool}
                  color={annColor}
                  width={0.0035}
                  activePanel={singleSelected ?? null}
                  panels={doc.panels}
                  selectedId={annSelected}
                  onSelect={setAnnSelected}
                  onChange={applyAnnotations}
                />
              )}
              {imgLoaded &&
                doc.panels.map((panel) => {
                  const isSel = selected.includes(panel.id);
                  return (
                    <div
                      key={panel.id}
                      className={`pbox ${isSel ? 'sel' : ''} ${groupColorMap.has(panel.id) ? 'grouped' : ''}`}
                      style={{
                        left: `${panel.rect.x * 100}%`,
                        top: `${panel.rect.y * 100}%`,
                        width: `${panel.rect.w * 100}%`,
                        height: `${panel.rect.h * 100}%`,
                        borderColor: groupColorMap.get(panel.id),
                      }}
                      onPointerDown={(e) => startDrag(e, panel, 'move')}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      {showNumbers && <em className="pnum">{numberMap.get(panel.id)}</em>}
                      {isSel &&
                        HANDLES.map((h) => (
                          <span key={h} className={`handle h-${h}`} onPointerDown={(e) => startDrag(e, panel, h)} />
                        ))}
                    </div>
                  );
                })}
              {marquee && (
                <div
                  className="marquee"
                  style={{
                    left: `${marquee.rect.x * 100}%`,
                    top: `${marquee.rect.y * 100}%`,
                    width: `${marquee.rect.w * 100}%`,
                    height: `${marquee.rect.h * 100}%`,
                  }}
                >
                  <span className="marquee-label">
                    {(marquee.rect.w * 100).toFixed(1)}% × {(marquee.rect.h * 100).toFixed(1)}%
                    <i>
                      {Math.round(marquee.wPx)} × {Math.round(marquee.hPx)} px
                    </i>
                  </span>
                </div>
              )}
            </div>
            {doc.panels.length === 0 && <div className="stage-hint">{t('panels.stageHint')}</div>}
          </div>
        )}
      </div>

      <div className="stage-status">
        <span>
          {t('panels.statusTotalBefore')}
          <b>{formatNumber(doc.panels.length)}</b>
          {t('panels.statusTotalAfter')}
          {selected.length > 0 && t('panels.statusSelected', { count: formatNumber(selected.length) })}
        </span>
        <span className="muted">{t('panels.statusMarquee')}</span>
        <span className="muted">{t('panels.statusEdit')}</span>
      </div>
      {orderOpen && (
        <PanelOrderDialog
          panels={sortPanels(doc.panels, doc.readingDirection)}
          selectedId={selected.length === 1 ? selected[0] : null}
          onClose={() => setOrderOpen(false)}
          onApply={applyPanelOrder}
        />
      )}
    </div>
  );
}
