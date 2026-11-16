import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Lang, PageDoc, PageEntry } from '../types';
import { isRightToLeft, isVerticalReading, langShort } from '../types';
import { useCompareLayout } from '../hooks/useCompareLayout';
import { langLabel, readingLabel, useI18n } from '../i18n';

type Props = {
  doc: PageDoc;
  page: PageEntry;
  /** Language order chosen in the compare view; this view only reads it. */
  langs: Lang[];
  /** Library language order discovered from the scanned volumes. */
  allLangs: Lang[];
  /** Previous/next page in reading order, shared with the [ / ] shortcuts. */
  onStepPage: (delta: number) => void;
  hasPrevPage: boolean;
  hasNextPage: boolean;
};

type PaneView = { x: number; y: number; scale: number };
const DEFAULT_VIEW: PaneView = { x: 0, y: 0, scale: 1 };
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/*
 * Masking is a reading preference shared with the compare view: the same storage
 * key and shape, so flipping it here also affects comparison reading next visit.
 */
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

/* Linked pan/zoom is a per-user reading preference; it is on unless the user turned it off. */
const LINKED_KEY = 'manga-memo.original-linked';

function loadLinked(): boolean {
  try {
    return localStorage.getItem(LINKED_KEY) !== '0';
  } catch {
    return true;
  }
}

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

/**
 * Original reading view: the whole page as one image per language, no panel crops.
 *
 * Dragging pans a page, the wheel zooms it (0.5x–6x) and the usual mask switches
 * apply, so long pages can be inspected without leaving the view. Page turns use
 * the shell's reading-order navigation, which also keeps the arrow keys working.
 */
export function OriginalTab({ doc, page, langs, allLangs, onStepPage, hasPrevPage, hasNextPage }: Props) {
  const { t } = useI18n();
  const layout = useCompareLayout();
  const [views, setViews] = useState<Record<string, PaneView>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [maskPrefs, setMaskPrefs] = useState<MaskPrefs>(loadMaskPrefs);
  const [linked, setLinked] = useState<boolean>(loadLinked);
  const [draggingLang, setDraggingLang] = useState<Lang | null>(null);
  const dragRef = useRef<{ lang: Lang; sx: number; sy: number; rect: DOMRect; start: PaneView } | null>(null);
  const movedRef = useRef(false);

  // Keep the masked columns in the page's language order; missing files still get a placeholder lane.
  const availableLangs = useMemo(() => {
    const pageLangs = [...new Set([...Object.keys(page.files), ...(page.missing ?? [])])];
    const ordered = allLangs.filter((l) => pageLangs.includes(l));
    return [...ordered, ...pageLangs.filter((l) => !ordered.includes(l))];
  }, [page, allLangs]);

  const activeLangs = useMemo(() => {
    const kept = langs.filter((l) => availableLangs.includes(l));
    if (kept.length) return kept;
    return availableLangs.length ? availableLangs : langs;
  }, [langs, availableLangs]);

  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  const activeLangsRef = useRef(activeLangs);
  activeLangsRef.current = activeLangs;

  // Touch layouts show one lane on phones and a rotating pair on tablets, like the compare view.
  const [focusLang, setFocusLang] = useState<Lang>(activeLangs[0] ?? 'ja');
  useEffect(() => {
    if (!activeLangs.includes(focusLang)) setFocusLang(activeLangs[0] ?? 'ja');
  }, [activeLangs, focusLang]);

  const paneLangs = useMemo<Lang[]>(() => {
    if (!activeLangs.length || layout.mode === 'desktop') return activeLangs;
    const slots = layout.mode === 'phone' ? 1 : layout.columns;
    if (activeLangs.length <= slots) return activeLangs;
    const start = Math.max(0, activeLangs.indexOf(focusLang));
    return [...activeLangs.slice(start), ...activeLangs.slice(0, start)].slice(0, slots);
  }, [layout.mode, layout.columns, activeLangs, focusLang]);

  // Panning/zoom is per page: turning the page starts with the full page in view again.
  useEffect(() => {
    setViews({});
    setRevealed({});
  }, [doc.volume, doc.chapter, doc.pageIndex]);

  useEffect(() => {
    try {
      localStorage.setItem(MASK_KEY, JSON.stringify(maskPrefs));
    } catch {
      /* Ignored in private mode */
    }
  }, [maskPrefs]);

  useEffect(() => {
    try {
      localStorage.setItem(LINKED_KEY, linked ? '1' : '0');
    } catch {
      /* Ignored in private mode */
    }
  }, [linked]);

  const maskWanted = (lang: Lang) => maskPrefs.masked[lang] ?? lang !== activeLangs[0];
  const maskOn = (lang: Lang) => maskPrefs.master && maskWanted(lang) && Boolean(page.files[lang]);

  const viewOf = (lang: Lang) => views[lang] ?? DEFAULT_VIEW;

  /* Linked mode writes the same relative offset and zoom to every column; each column
     resolves the fractions against its own box, so pages stay aligned while resizing. */
  const applyView = (lang: Lang, next: PaneView) => {
    setViews((prev) => {
      if (!linked || activeLangs.length < 2) return { ...prev, [lang]: next };
      const out: Record<string, PaneView> = {};
      for (const l of activeLangs) out[l] = next;
      return out;
    });
  };

  const setView = (lang: Lang, next: PaneView) => applyView(lang, next);
  const zoomBy = (lang: Lang, factor: number) => {
    const current = viewOf(lang);
    applyView(lang, { ...current, scale: +clamp(current.scale * factor, 0.5, 6).toFixed(3) });
  };

  const toggleLinked = () => {
    const next = !linked;
    setLinked(next);
    // Turning linking on adopts the first visible column's view, then keeps every column in sync.
    if (next && paneLangs.length) {
      const source = viewOf(paneLangs[0]);
      setViews(() => {
        const out: Record<string, PaneView> = {};
        for (const l of activeLangs) out[l] = source;
        return out;
      });
    }
  };

  // Wheel zoom: capture at the window level so the pane keeps the gesture even over masks/badges.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    const el = e.target instanceof Element ? (e.target.closest('.original-pane') as HTMLElement | null) : null;
    const lang = el?.dataset.lang;
    if (!el || !lang || el.dataset.hasImage !== '1') return;
    e.preventDefault();
    zoomBy(lang, e.deltaY < 0 ? 1.08 : 0.93);
  };
  useEffect(() => {
    const onWheel = (e: WheelEvent) => wheelRef.current(e);
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  useEffect(() => {
    if (!draggingLang) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) movedRef.current = true;
      const next = {
        ...d.start,
        x: clamp(d.start.x + (e.clientX - d.sx) / d.rect.width, -4, 4),
        y: clamp(d.start.y + (e.clientY - d.sy) / d.rect.height, -4, 4),
      };
      setViews((prev) => {
        if (!linkedRef.current) return { ...prev, [d.lang]: next };
        const out: Record<string, PaneView> = {};
        for (const l of activeLangsRef.current) out[l] = next;
        return out;
      });
    };
    const up = () => {
      const d = dragRef.current;
      // A press without movement is a click: put a temporarily revealed page back behind the mask.
      if (d && !movedRef.current) {
        setRevealed((r) => (r[d.lang] ? { ...r, [d.lang]: false } : r));
      }
      dragRef.current = null;
      setDraggingLang(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [draggingLang]);

  const startPan = (e: ReactPointerEvent<HTMLDivElement>, lang: Lang) => {
    if (e.button !== 0 || e.currentTarget.dataset.hasImage !== '1') return;
    e.preventDefault();
    movedRef.current = false;
    dragRef.current = {
      lang,
      sx: e.clientX,
      sy: e.clientY,
      rect: e.currentTarget.getBoundingClientRect(),
      start: viewOf(lang),
    };
    setDraggingLang(lang);
  };

  const renderPane = (lang: Lang) => {
    const url = page.files[lang];
    const view = viewOf(lang);
    if (!url) {
      return (
        <div className="lang-pane original-pane empty" key={lang}>
          <span className="lang-tag">{langShort(lang)}</span>
          <div className="pane-missing">{t('compare.missingLangImage', { lang: langLabel(lang) })}</div>
        </div>
      );
    }
    return (
      <div
        key={lang}
        className={`lang-pane original-pane ${draggingLang === lang ? 'dragging' : ''}`}
        data-lang={lang}
        data-has-image="1"
        onPointerDown={(e) => startPan(e, lang)}
      >
        <div
          className="crop-inner"
          style={{ transform: `translate(${view.x * 100}%, ${view.y * 100}%) scale(${view.scale})` }}
        >
          <img className="original-img" src={url} alt="" draggable={false} loading="eager" decoding="async" />
        </div>
        {maskOn(lang) && !revealed[lang] && (
          <div
            className={`lang-mask ${maskPrefs.style}`}
            title={t('compare.maskTitle', { lang: langLabel(lang) })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setRevealed((r) => ({ ...r, [lang]: true }));
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
          ×{view.scale.toFixed(2)}
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => zoomBy(lang, 0.85)}
            title={t('compare.zoomOut')}
          >
            −
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => zoomBy(lang, 1.18)}
            title={t('compare.zoomIn')}
          >
            +
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setView(lang, DEFAULT_VIEW)}
            title={t('original.resetView')}
          >
            ⟲
          </button>
        </span>
      </div>
    );
  };

  const vertical = isVerticalReading(doc.readingDirection);
  const nextOnLeft = !vertical && isRightToLeft(doc.readingDirection);
  const prevButton = (
    <button
      type="button"
      className="btn tiny"
      onClick={() => onStepPage(-1)}
      disabled={!hasPrevPage}
      title={t('app.prevPageTitle')}
      aria-label={t('app.prevPageTitle')}
    >
      {t('app.prevPage')}
    </button>
  );
  const nextButton = (
    <button
      type="button"
      className="btn tiny"
      onClick={() => onStepPage(1)}
      disabled={!hasNextPage}
      title={t('app.nextPageTitle')}
      aria-label={t('app.nextPageTitle')}
    >
      {t('app.nextPage')}
    </button>
  );

  return (
    <div className={`original-tab layout-${layout.mode}`}>
      <div className="stage-toolbar">
        <div className="tb-group">
          <span className="muted tiny">{t('original.hint')}</span>
          <button
            type="button"
            className={`btn tiny ${linked ? 'on' : ''}`}
            aria-pressed={linked}
            onClick={toggleLinked}
            title={t('original.linkTitle')}
          >
            {linked ? t('original.linkOn') : t('original.linkOff')}
          </button>
        </div>

        <div className="tb-group mask-group">
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
                onClick={() => setMaskPrefs((p) => ({ ...p, masked: { ...p.masked, [l]: !maskWanted(l) } }))}
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
            <select
              className="tb-select"
              value={maskPrefs.style}
              onChange={(e) => setMaskPrefs((p) => ({ ...p, style: e.target.value === 'solid' ? 'solid' : 'blur' }))}
              title={t('compare.maskStyle')}
            >
              <option value="blur">{t('compare.maskStyleBlur')}</option>
              <option value="solid">{t('compare.maskStyleSolid')}</option>
            </select>
          )}
        </div>

        <div className="tb-group right">
          <span className="muted tiny">{readingLabel(doc.readingDirection)}</span>
          {nextOnLeft ? (
            <>
              {nextButton}
              {prevButton}
            </>
          ) : (
            <>
              {prevButton}
              {nextButton}
            </>
          )}
          <button
            type="button"
            className="btn icon tiny"
            onClick={() => setViews({})}
            title={t('compare.resetAll')}
            aria-label={t('compare.resetAll')}
          >
            ↺
          </button>
        </div>
      </div>

      {layout.tabs && activeLangs.length > layout.columns && (
        <div className="compare-lang-tabs" role="tablist" aria-label={t('compare.language')}>
          {activeLangs.map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              aria-selected={paneLangs.includes(l)}
              className={`lang-tab ${paneLangs.includes(l) ? 'on' : ''} ${l === focusLang ? 'focus' : ''}`}
              title={langLabel(l)}
              onClick={() => setFocusLang(l)}
            >
              {langShort(l)}
            </button>
          ))}
        </div>
      )}

      {paneLangs.length ? (
        <div className="lang-grid original-viewport" style={{ '--cols': paneLangs.length } as CSSProperties}>
          {paneLangs.map(renderPane)}
        </div>
      ) : (
        <div className="stage-loading">{t('app.noImages')}</div>
      )}
    </div>
  );
}
