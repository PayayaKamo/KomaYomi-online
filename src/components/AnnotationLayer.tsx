/**
 * Vector annotation overlay for the panel editor.
 *
 * Coordinates are normalized to the owning scope, so annotations survive zoom,
 * window resizing and full-resolution exports without re-layout:
 * - page scope:  0..1 across the whole page
 * - panel scope: 0..1 inside that panel's rect
 * Stroke width is a fraction of the page width and font size a fraction of the
 * page height, for the same reason. Only `select` lets pointer events fall through
 * to the panel boxes underneath; every drawing tool captures the page.
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Annotation, AnnotationKind, Lang, Panel, PanelRect } from '../types';
import { clamp01, uid } from '../lib/geometry';
import { annotationLeader, annotationMatchesLang } from '../../shared/annotations.ts';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';

export type AnnotationTool = 'select' | AnnotationKind;

/** Toolbar order: selection first, then shapes, then freehand/text helpers. */
export const ANNOTATION_TOOL_ORDER: AnnotationTool[] = [
  'select',
  'arrow',
  'rect',
  'ellipse',
  'highlight',
  'pen',
  'text',
  'badge',
  'mosaic',
];

export const ANNOTATION_TOOLS: Record<AnnotationTool, { icon: string; labelKey: MessageKey }> = {
  select: { icon: '↖', labelKey: 'ann.tool.select' },
  arrow: { icon: '→', labelKey: 'ann.tool.arrow' },
  rect: { icon: '▭', labelKey: 'ann.tool.rect' },
  ellipse: { icon: '○', labelKey: 'ann.tool.ellipse' },
  highlight: { icon: '▬', labelKey: 'ann.tool.highlight' },
  pen: { icon: '✎', labelKey: 'ann.tool.pen' },
  text: { icon: 'T', labelKey: 'ann.tool.text' },
  badge: { icon: '①', labelKey: 'ann.tool.badge' },
  mosaic: { icon: '▦', labelKey: 'ann.tool.mosaic' },
};

/** Swatches keep good contrast on both light and dark page images. */
export const ANNOTATION_COLORS = ['#e0453a', '#f0a020', '#2f9e44', '#2b7de9', '#111111'];

const PAGE_RECT: PanelRect = { x: 0, y: 0, w: 1, h: 1 };
/** Smallest drag that still counts as a shape (normalized). */
const MIN_SIZE = 0.004;
/** Freehand sampling distance; keeps point lists small. */
const PEN_MIN_STEP = 0.004;
const DEFAULT_WIDTH = 0.0035;
const DEFAULT_FONT = 0.035;

type Point = { x: number; y: number };
type Box = { w: number; h: number };
type Draft = { kind: AnnotationKind; rect: PanelRect; panelId: string | null; points: Point[] };
type TextEdit = {
  kind: 'text' | 'badge';
  rect: PanelRect;
  panelId: string | null;
  point: Point;
  value: string;
};

/** Minimal shape description accepted by the renderer, so drafts reuse it. */
type Shape = {
  kind: AnnotationKind;
  points: Point[];
  color?: string;
  width?: number;
  text?: string;
  fontSize?: number;
};

type Props = {
  annotations: Annotation[];
  visible: boolean;
  tool: AnnotationTool;
  color: string;
  /** Stroke width as a fraction of the page width. */
  width: number;
  /** Panel that new annotations belong to; null means whole page. */
  activePanel: Panel | null;
  panels: Panel[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (updater: (list: Annotation[]) => Annotation[]) => void;
  /**
   * Page region shown by this layer. Defaults to the whole page; the compare view
   * passes one panel crop, so the same normalized annotations stay in sync.
   */
  viewport?: PanelRect;
  /** Language lane of this pane; new marks are stamped with it and other lanes are hidden. */
  lang?: Lang;
};

function panelRect(panels: Panel[], id: string | null): PanelRect {
  if (!id) return PAGE_RECT;
  return panels.find((p) => p.id === id)?.rect ?? PAGE_RECT;
}

function toScope(p: Point, rect: PanelRect): Point {
  if (rect.w <= 0 || rect.h <= 0) return { x: 0, y: 0 };
  return { x: clamp01((p.x - rect.x) / rect.w), y: clamp01((p.y - rect.y) / rect.h) };
}

/** Scope-relative points to overlay pixels, cropped to the visible viewport. */
function toPixels(points: Point[], rect: PanelRect, box: Box, viewport: PanelRect = PAGE_RECT): Point[] {
  return points.map((p) => ({
    x: ((rect.x + p.x * rect.w - viewport.x) / viewport.w) * box.w,
    y: ((rect.y + p.y * rect.h - viewport.y) / viewport.h) * box.h,
  }));
}

function arrowHead(a: Point, b: Point, size: number): string {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const spread = Math.PI / 7;
  const p1 = { x: b.x - size * Math.cos(angle - spread), y: b.y - size * Math.sin(angle - spread) };
  const p2 = { x: b.x - size * Math.cos(angle + spread), y: b.y - size * Math.sin(angle + spread) };
  return `${b.x},${b.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`;
}

function renderShape(
  shape: Shape,
  rect: PanelRect,
  box: Box,
  extraClass = '',
  viewport: PanelRect = PAGE_RECT,
): ReactNode {
  const pts = toPixels(shape.points, rect, box, viewport);
  const color = shape.color ?? ANNOTATION_COLORS[0];
  const sw = Math.max(1, ((shape.width ?? DEFAULT_WIDTH) * box.w) / viewport.w);
  const fontSize = Math.max(10, ((shape.fontSize ?? DEFAULT_FONT) * box.h) / viewport.h);

  if (pts.length === 0) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];

  switch (shape.kind) {
    case 'arrow':
      if (pts.length < 2) return null;
      return (
        <g className={`ann-shape ${extraClass}`} stroke={color} fill="none" strokeWidth={sw} strokeLinecap="round">
          <line x1={first.x} y1={first.y} x2={last.x} y2={last.y} />
          <polygon points={arrowHead(first, last, Math.max(10, sw * 4))} fill={color} stroke="none" />
        </g>
      );
    case 'rect':
      return (
        <rect
          className={`ann-shape ${extraClass}`}
          x={Math.min(first.x, last.x)}
          y={Math.min(first.y, last.y)}
          width={Math.abs(last.x - first.x)}
          height={Math.abs(last.y - first.y)}
          fill="none"
          stroke={color}
          strokeWidth={sw}
        />
      );
    case 'ellipse': {
      const cx = (first.x + last.x) / 2;
      const cy = (first.y + last.y) / 2;
      return (
        <ellipse
          className={`ann-shape ${extraClass}`}
          cx={cx}
          cy={cy}
          rx={Math.abs(last.x - first.x) / 2}
          ry={Math.abs(last.y - first.y) / 2}
          fill="none"
          stroke={color}
          strokeWidth={sw}
        />
      );
    }
    case 'highlight':
      if (pts.length < 2) return null;
      return (
        <line
          className={`ann-shape ${extraClass}`}
          x1={first.x}
          y1={first.y}
          x2={last.x}
          y2={last.y}
          stroke={color}
          strokeWidth={Math.max(6, sw * 4)}
          strokeOpacity={0.35}
          strokeLinecap="round"
        />
      );
    case 'pen':
      return (
        <polyline
          className={`ann-shape ${extraClass}`}
          points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke={color}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case 'text':
      return (
        <text
          className={`ann-shape ${extraClass}`}
          x={first.x}
          y={first.y}
          fill={color}
          fontSize={fontSize}
          fontWeight={600}
          paintOrder="stroke"
          stroke="rgba(255,255,255,0.9)"
          strokeWidth={Math.max(2, fontSize / 8)}
          strokeLinejoin="round"
        >
          {shape.text ?? ''}
        </text>
      );
    case 'badge': {
      const r = fontSize * 0.62;
      return (
        <g className={`ann-shape ${extraClass}`}>
          <circle cx={first.x} cy={first.y} r={r} fill={color} />
          <text
            x={first.x}
            y={first.y}
            fill="#fff"
            fontSize={fontSize}
            fontWeight={700}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {shape.text ?? '1'}
          </text>
        </g>
      );
    }
    case 'mosaic': {
      const x = Math.min(first.x, last.x);
      const y = Math.min(first.y, last.y);
      const w = Math.abs(last.x - first.x);
      const h = Math.abs(last.y - first.y);
      return (
        <foreignObject className={`ann-shape ${extraClass}`} x={x} y={y} width={w} height={h}>
          <div className="ann-mosaic" />
        </foreignObject>
      );
    }
    default:
      return null;
  }
}

/** Dashed selection frame around one shape, padded a few screen pixels. */
function selectionFrame(
  shape: Shape,
  rect: PanelRect,
  box: Box,
  color: string,
  viewport: PanelRect = PAGE_RECT,
): ReactNode {
  const pts = toPixels(shape.points, rect, box, viewport);
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const pad = 6;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  const w = Math.abs(Math.max(...xs) - Math.min(...xs)) + pad * 2;
  const h = Math.abs(Math.max(...ys) - Math.min(...ys)) + pad * 2;
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      fill="none"
      stroke={color}
      strokeWidth={1}
      strokeDasharray="4 3"
      pointerEvents="none"
    />
  );
}

export function AnnotationLayer({
  annotations,
  visible,
  tool,
  color,
  width,
  activePanel,
  panels,
  selectedId,
  onSelect,
  onChange,
  viewport = PAGE_RECT,
  lang,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState<Box>({ w: 0, h: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const moveRef = useRef<{ id: string; rect: PanelRect; origin: Point[]; start: Point } | null>(null);
  const [moving, setMoving] = useState(false);

  const activeRect = activePanel?.rect ?? PAGE_RECT;
  const activePanelId = activePanel?.id ?? null;

  // Track the rendered size so pixel-space stroke widths follow zooming.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setBox({ w: rect.width, h: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  const pagePoint = (e: { clientX: number; clientY: number }): Point => {
    const el = svgRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { x: 0, y: 0 };
    // Screen fractions map back into page space, so the same layer works over a crop.
    return {
      x: viewport.x + clamp01((e.clientX - r.left) / r.width) * viewport.w,
      y: viewport.y + clamp01((e.clientY - r.top) / r.height) * viewport.h,
    };
  };

  const createAnnotation = (
    kind: AnnotationKind,
    rect: PanelRect,
    panelId: string | null,
    points: Point[],
    text?: string,
  ) => {
    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: uid('a'),
      kind,
      scope: panelId ? 'panel' : 'page',
      panelId,
      points,
      color,
      width: kind === 'text' || kind === 'badge' ? undefined : width,
      text,
      fontSize: kind === 'text' || kind === 'badge' ? DEFAULT_FONT : undefined,
      lang,
      createdAt: now,
      updatedAt: now,
    };
    onChange((list) => [...list, annotation]);
    onSelect(annotation.id);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!visible || tool === 'select') return;
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    const page = pagePoint(e);
    if (tool === 'text' || tool === 'badge') {
      setTextEdit({
        kind: tool,
        rect: activeRect,
        panelId: activePanelId,
        point: toScope(page, activeRect),
        value: '',
      });
      return;
    }
    const start = toScope(page, activeRect);
    const next: Draft = { kind: tool, rect: activeRect, panelId: activePanelId, points: [start, start] };
    draftRef.current = next;
    setDraft(next);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const current = draftRef.current;
    if (!current) return;
    const point = toScope(pagePoint(e), current.rect);
    if (current.kind === 'pen') {
      const last = current.points[current.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) < PEN_MIN_STEP) return;
      const next = { ...current, points: [...current.points, point] };
      draftRef.current = next;
      setDraft(next);
      return;
    }
    const next = { ...current, points: [current.points[0], point] };
    draftRef.current = next;
    setDraft(next);
  };

  const finishDraft = (e: ReactPointerEvent<SVGSVGElement>) => {
    const current = draftRef.current;
    if (!current) return;
    draftRef.current = null;
    setDraft(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* the pointer may have been released by the browser already */
    }
    const first = current.points[0];
    const last = current.points[current.points.length - 1];
    if (current.kind === 'pen') {
      if (current.points.length < 2) return;
    } else if (Math.abs(last.x - first.x) < MIN_SIZE && Math.abs(last.y - first.y) < MIN_SIZE) {
      return;
    }
    createAnnotation(current.kind, current.rect, current.panelId, current.points);
  };

  const startMove = (e: ReactPointerEvent<SVGGElement>, annotation: Annotation) => {
    if (tool !== 'select') return;
    e.stopPropagation();
    e.preventDefault();
    onSelect(annotation.id);
    moveRef.current = {
      id: annotation.id,
      rect: annotation.scope === 'panel' ? panelRect(panels, annotation.panelId ?? null) : PAGE_RECT,
      origin: annotation.points.map((p) => ({ ...p })),
      start: pagePoint(e),
    };
    setMoving(true);
  };

  // Dragging an annotation is coalesced by the page history window, like panel drags.
  useEffect(() => {
    if (!moving) return;
    const move = (e: PointerEvent) => {
      const current = moveRef.current;
      if (!current) return;
      const point = pagePoint(e);
      const dx = (point.x - current.start.x) / current.rect.w;
      const dy = (point.y - current.start.y) / current.rect.h;
      const now = new Date().toISOString();
      onChange((list) =>
        list.map((a) =>
          a.id === current.id
            ? {
                ...a,
                points: current.origin.map((p) => ({ x: clamp01(p.x + dx), y: clamp01(p.y + dy) })),
                updatedAt: now,
              }
            : a,
        ),
      );
    };
    const up = () => {
      moveRef.current = null;
      setMoving(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [moving, onChange]);

  const commitText = () => {
    const edit = textEdit;
    if (!edit) return;
    setTextEdit(null);
    const value = edit.value.trim();
    if (!value) return;
    createAnnotation(edit.kind, edit.rect, edit.panelId, [edit.point], value);
  };

  if (!visible) return null;

  const interactive = tool !== 'select';
  const shown = lang ? annotations.filter((a) => annotationMatchesLang(a, lang)) : annotations;

  return (
    <div className="ann-layer">
      <svg
        ref={svgRef}
        className={`ann-svg ${interactive ? 'drawing' : ''}`}
        style={{ pointerEvents: interactive ? 'auto' : 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDraft}
        onPointerCancel={() => {
          draftRef.current = null;
          setDraft(null);
        }}
      >
        {shown.map((annotation) => {
          const rect = annotation.scope === 'panel' ? panelRect(panels, annotation.panelId ?? null) : PAGE_RECT;
          const selected = annotation.id === selectedId;
          const leader = annotationLeader(annotation, rect);
          const leaderPoints = leader ? toPixels([leader.from, leader.to], PAGE_RECT, box, viewport) : null;
          return (
            <g
              key={annotation.id}
              className={`ann-item ${selected ? 'sel' : ''}`}
              style={{ pointerEvents: tool === 'select' ? 'all' : 'none' }}
              onPointerDown={(e) => startMove(e, annotation)}
            >
              {/* Invisible fat stroke widens the hit area of thin shapes. */}
              {tool === 'select' && annotation.kind !== 'mosaic' && (
                <polyline
                  points={toPixels(annotation.points, rect, box, viewport)
                    .map((p) => `${p.x},${p.y}`)
                    .join(' ')}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={Math.max(14, ((annotation.width ?? DEFAULT_WIDTH) * box.w) / viewport.w + 12)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {renderShape(annotation, rect, box, '', viewport)}
              {leaderPoints && (
                <g pointerEvents="none">
                  <line
                    x1={leaderPoints[0].x}
                    y1={leaderPoints[0].y}
                    x2={leaderPoints[1].x}
                    y2={leaderPoints[1].y}
                    stroke={annotation.color ?? color}
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    opacity={0.9}
                  />
                  <circle
                    cx={leaderPoints[1].x}
                    cy={leaderPoints[1].y}
                    r={3}
                    fill={annotation.color ?? color}
                  />
                </g>
              )}
              {selected && selectionFrame(annotation, rect, box, annotation.color ?? color, viewport)}
            </g>
          );
        })}
        {draft && renderShape({ ...draft, color, width }, draft.rect, box, 'draft', viewport)}
        {textEdit && (
          <foreignObject x={0} y={0} width={box.w} height={box.h}>
            <div className="ann-input-wrap">
              <input
                className="ann-input"
                autoFocus
                value={textEdit.value}
                placeholder={textEdit.kind === 'badge' ? t('ann.badgePrompt') : t('ann.textPrompt')}
                style={{
                  left: `${((textEdit.rect.x + textEdit.point.x * textEdit.rect.w - viewport.x) / viewport.w) * box.w}px`,
                  top: `${((textEdit.rect.y + textEdit.point.y * textEdit.rect.h - viewport.y) / viewport.h) * box.h}px`,
                  borderColor: color,
                }}
                onChange={(e) => setTextEdit((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitText();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setTextEdit(null);
                  }
                  e.stopPropagation();
                }}
                onBlur={commitText}
              />
            </div>
          </foreignObject>
        )}
      </svg>
    </div>
  );
}
