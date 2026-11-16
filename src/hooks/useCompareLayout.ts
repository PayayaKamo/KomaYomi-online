import { useEffect, useState } from 'react';

export type CompareLayoutMode = 'phone' | 'tablet-portrait' | 'tablet-landscape' | 'desktop';

export interface CompareLayout {
  mode: CompareLayoutMode;
  /** Columns side-by-side before any extra language needs the tab switcher. */
  columns: number;
  /** Whether the language tab switcher is available in this layout. */
  tabs: boolean;
}

/**
 * Compare view layout is decided by touch capability plus the aspect ratio, not width alone:
 * a narrow desktop window has a fine pointer and keeps the desktop behaviour, while a tablet
 * in portrait gets two columns instead of one. Landscape touch screens up to 900px get two
 * columns (phone landscape) and up to 1200px get three (tablet landscape).
 */
export function resolveCompareLayout(width: number, height: number, hasTouch: boolean): CompareLayout {
  if (!hasTouch) return { mode: 'desktop', columns: 0, tabs: false };
  const portrait = height >= width;
  if (portrait) {
    if (width <= 480) return { mode: 'phone', columns: 1, tabs: true };
    if (width <= 1100) return { mode: 'tablet-portrait', columns: 2, tabs: true };
    return { mode: 'desktop', columns: 0, tabs: false };
  }
  if (width <= 900) return { mode: 'tablet-portrait', columns: 2, tabs: true };
  if (width < 1200) return { mode: 'tablet-landscape', columns: 3, tabs: true };
  return { mode: 'desktop', columns: 0, tabs: false };
}

function detectTouch(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

export function useCompareLayout(): CompareLayout {
  const [layout, setLayout] = useState<CompareLayout>(() =>
    resolveCompareLayout(window.innerWidth, window.innerHeight, detectTouch()),
  );

  useEffect(() => {
    const update = () => setLayout(resolveCompareLayout(window.innerWidth, window.innerHeight, detectTouch()));
    const coarse = window.matchMedia('(pointer: coarse)');
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    coarse.addEventListener('change', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      coarse.removeEventListener('change', update);
    };
  }, []);

  return layout;
}
