import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** Panes never take more than this share of the window, so the stage stays usable. */
const VIEWPORT_SHARE = 0.45;

export function clampPaneWidth(value: number, min: number, max: number): number {
  const viewportMax = Math.round(window.innerWidth * VIEWPORT_SHARE);
  const upper = Math.max(min, Math.min(max, viewportMax));
  return Math.round(Math.min(upper, Math.max(min, value)));
}

/** Reads a stored pane width; returns null when the user never resized that pane. */
export function loadPaneWidth(key: string, min: number, max: number): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? clampPaneWidth(n, min, max) : null;
  } catch {
    return null;
  }
}

/** Persists a pane width, or clears the key so the responsive CSS default applies again. */
export function savePaneWidth(key: string, width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(width)));
  } catch {
    /* private mode / quota: resizing still works for the session */
  }
}

type Props = {
  /** Which border of the stage the handle sits on. */
  edge: 'left' | 'right';
  /** Selector of the pane that should be measured and resized. */
  target: string;
  /** CSS custom property on `.body-area` that drives the grid column width. */
  cssVar: string;
  min: number;
  max: number;
  label: string;
  onCommit: (width: number) => void;
  onReset: () => void;
};

/**
 * Thin drag handle between the stage and a side pane.
 *
 * Drags write the grid CSS variable directly (one style write per animation
 * frame) instead of lifting React state on every pointermove, so the layout is
 * not re-rendered dozens of times per second. State and localStorage are updated
 * once on pointerup.
 */
export function PaneSplitter({ edge, target, cssVar, min, max, label, onCommit, onReset }: Props) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(0);
  const frameRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const bodyArea = () => document.querySelector<HTMLElement>('.body-area');

  const paint = (width: number) => {
    frameRef.current = 0;
    bodyArea()?.style.setProperty(cssVar, `${width}px`);
  };

  const cancelFrame = () => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const pane = document.querySelector<HTMLElement>(target);
    if (!pane) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: pane.getBoundingClientRect().width };
    widthRef.current = dragRef.current.startWidth;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.classList.add('pane-resizing');
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = edge === 'left' ? e.clientX - drag.startX : drag.startX - e.clientX;
    const next = clampPaneWidth(drag.startWidth + delta, min, max);
    widthRef.current = next;
    if (!frameRef.current) frameRef.current = requestAnimationFrame(() => paint(widthRef.current));
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    cancelFrame();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    document.body.classList.remove('pane-resizing');
    // Land exactly on the last value, then hand it to React/localStorage once.
    paint(widthRef.current);
    if (widthRef.current !== drag.startWidth) onCommit(widthRef.current);
  };

  const reset = () => {
    cancelFrame();
    bodyArea()?.style.removeProperty(cssVar);
    onReset();
  };

  return (
    <div
      className={`pane-splitter ${edge} ${dragging ? 'active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(widthRef.current) || undefined}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={reset}
    />
  );
}
