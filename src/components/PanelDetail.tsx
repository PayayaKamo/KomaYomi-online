import { useEffect, useRef, useState } from 'react';
import type { Annotation, AlignOffset, Lang, PageDoc, PageEntry, Panel } from '../types';
import { langShort } from '../types';
import { langLabel, useI18n } from '../i18n';
import { renderMarkdown } from '../../shared/markdown';
import { ANNOTATION_TOOLS } from './AnnotationLayer';
import { AnnotationOverlay } from './AnnotationOverlay';
import { NoteAnchorLayer } from './NoteAnchorLayer';
import { CropLayer } from './CropLayer';
import { useCompareLayout } from '../hooks/useCompareLayout';

type MaskStyle = 'blur' | 'solid';

type Props = {
  doc: PageDoc;
  page: PageEntry;
  panel: Panel;
  /** Zero-based position in reading order, and the number of panels on this page. */
  index: number;
  total: number;
  /** Enabled languages in the configured order; masking follows the compare view. */
  langs: Lang[];
  maskStyle: MaskStyle;
  isMasked: (panelId: string, lang: Lang) => boolean;
  reveal: (panelId: string, lang: Lang) => void;
  annotations: Annotation[];
  annotationsVisible: boolean;
  /** Panel crop width/height ratio for one language. */
  aspectOf: (lang: Lang) => number;
  /** Stored alignment offset for one language on this panel. */
  offsetOf: (lang: Lang) => AlignOffset;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** Page turns that keep the detail open; undefined at the first/last page. */
  onPrevPage?: () => void;
  onNextPage?: () => void;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(3))));
}

/**
 * Enlarged comparison for one panel: every enabled language side by side (stacked on
 * phones and tablets), followed by this panel's notes and annotations.
 *
 * Keyboard handling lives here while the view is open so arrow keys switch panels
 * instead of turning pages; Esc and the browser Back button both leave.
 */
export function PanelDetail({
  doc,
  page,
  panel,
  index,
  total,
  langs,
  maskStyle,
  isMasked,
  reveal,
  annotations,
  annotationsVisible,
  aspectOf,
  offsetOf,
  onClose,
  onPrev,
  onNext,
  onPrevPage,
  onNextPage,
}: Props) {
  const { t, formatDate, formatNumber } = useI18n();
  const layout = useCompareLayout();
  const stacked = layout.mode !== 'desktop';
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panesRef = useRef<HTMLDivElement>(null);

  const notes = doc.notes.filter((n) => n.scope === 'panel' && n.panelId === panel.id);
  const panelAnnotations = annotations.filter((a) => a.scope === 'panel' && a.panelId === panel.id);

  // Focus moves into the view and returns to whatever had it before, so the reading
  // shortcuts below cannot act while focus is still on a toolbar underneath.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  // A new panel starts at fit-to-width and at the top of its notes.
  useEffect(() => {
    setZoom(1);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [panel.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const root = dialogRef.current;
        if (!root) return;
        const items = Array.from(
          root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'),
        );
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      const prev = e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === '[';
      const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ']';
      if (prev && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (next && onNext) {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext]);

  // Wheel and pinch zoom the enlarged images only, so the surrounding page keeps scrolling.
  useEffect(() => {
    const el = panesRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return;
      if (!(e.target as HTMLElement | null)?.closest('.detail-pane')) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.08 : 0.92)));
    };
    const distance = (list: TouchList) =>
      Math.hypot(list[0].clientX - list[1].clientX, list[0].clientY - list[1].clientY);
    let startDistance = 0;
    let startZoom = 1;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      startDistance = distance(e.touches);
      startZoom = zoomRef.current;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !startDistance) return;
      if (!(e.target as HTMLElement | null)?.closest('.detail-pane')) return;
      e.preventDefault();
      setZoom(clampZoom(startZoom * (distance(e.touches) / startDistance)));
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) startDistance = 0;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  const zoomBy = (factor: number) => setZoom((z) => clampZoom(z * factor));

  return (
    <div
      className={`panel-detail layout-${layout.mode}`}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('detail.title')}
      tabIndex={-1}
    >
      <header className="pd-head">
        <button type="button" className="btn pd-back" onClick={onClose} title={t('detail.backTitle')}>
          ← <span>{t('detail.back')}</span>
        </button>
        <div className="pd-title">
          <b>{t('format.panel', { number: formatNumber(index + 1) })}</b>
          <span className="muted tiny">
            {t('detail.position', { number: formatNumber(index + 1), total: formatNumber(total) })}
          </span>
        </div>
        <div className="pd-nav">
          <div className="seg pd-zoom" role="group" aria-label={t('detail.zoomHint')}>
            <button
              type="button"
              onClick={() => zoomBy(0.85)}
              title={t('detail.zoomOut')}
              aria-label={t('detail.zoomOut')}
            >
              −
            </button>
            <span className="pd-zoom-value">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => zoomBy(1.18)}
              title={t('detail.zoomIn')}
              aria-label={t('detail.zoomIn')}
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              title={t('detail.zoomReset')}
              aria-label={t('detail.zoomReset')}
            >
              ⟲
            </button>
          </div>
          <button
            type="button"
            className="btn icon"
            onClick={onClose}
            title={t('detail.close')}
            aria-label={t('detail.close')}
          >
            ✕
          </button>
        </div>
      </header>

      <div className="pd-scroll" ref={scrollRef}>
        <div className={`pd-panes ${stacked ? 'column' : 'row'}`} ref={panesRef}>
          {langs.map((lang) => {
            const url = page.files[lang];
            const offset = offsetOf(lang);
            const masked = Boolean(url) && isMasked(panel.id, lang);
            return (
              <div key={lang} className={`detail-pane ${url ? '' : 'empty'}`} style={{ aspectRatio: aspectOf(lang) }}>
                {url ? (
                  <div className="detail-zoom" style={{ transform: `scale(${zoom})` }}>
                    <CropLayer url={url} rect={panel.rect} offset={offset} opacity={1} blend={false} />
                    <div
                      className="ann-crop-layer"
                      style={{
                        transform: `translate(${offset.x * 100}%, ${offset.y * 100}%) scale(${offset.scale})`,
                      }}
                    >
                      <AnnotationOverlay
                        annotations={annotations}
                        panels={doc.panels}
                        rect={panel.rect}
                        visible={annotationsVisible}
                        lang={lang}
                      />
                    </div>
                    <NoteAnchorLayer notes={doc.notes} panel={panel} lang={lang} offset={offset} zoom={zoom} />
                  </div>
                ) : (
                  <div className="pane-missing">{t('compare.missingLangImage', { lang: langLabel(lang) })}</div>
                )}
                {masked && (
                  <div
                    className={`lang-mask detail-mask ${maskStyle}`}
                    title={t('compare.maskTitle', { lang: langLabel(lang) })}
                    onClick={() => reveal(panel.id, lang)}
                  >
                    <span>
                      {langShort(lang)} {t('compare.maskedBadge')}
                      <em>{t('compare.clickReveal')}</em>
                    </span>
                  </div>
                )}
                <span className="lang-tag">{langShort(lang)}</span>
              </div>
            );
          })}
        </div>

        <section className="pd-notes">
          <h3 className="pd-section">
            {t('detail.notes')}
            <span className="muted tiny">{t('detail.notesCount', { count: formatNumber(notes.length) })}</span>
          </h3>
          {notes.length ? (
            notes.map((note) => (
              <article className="pd-note" key={note.id}>
                {(note.tags.length > 0 || note.createdAt) && (
                  <div className="pd-note-meta">
                    {note.tags.map((tag) => (
                      <span className="tag" key={tag}>
                        {tag}
                      </span>
                    ))}
                    <span className="note-time">{formatDate(note.createdAt)}</span>
                  </div>
                )}
                <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(note.text) }} />
                {note.images?.length ? (
                  <div className="note-images">
                    {note.images.map((img) => (
                      <figure key={img.id}>
                        <a href={img.dataUrl} target="_blank" rel="noreferrer noopener" title={img.name}>
                          <img src={img.dataUrl} alt={img.name} loading="lazy" />
                        </a>
                      </figure>
                    ))}
                  </div>
                ) : null}
              </article>
            ))
          ) : (
            <p className="pd-empty">{t('detail.notesEmpty')}</p>
          )}

          <h3 className="pd-section">
            {t('detail.annotations')}
            <span className="muted tiny">{formatNumber(panelAnnotations.length)}</span>
          </h3>
          {panelAnnotations.length ? (
            <ul className="pd-ann-list">
              {panelAnnotations.map((a) => (
                <li className="pd-ann" key={a.id}>
                  <span className="pd-ann-swatch" style={{ background: a.color || '#e0453a' }} />
                  <span className="pd-ann-kind">{t(ANNOTATION_TOOLS[a.kind].labelKey)}</span>
                  {a.text ? <span className="pd-ann-text">{a.text}</span> : null}
                  <span className="note-time">{formatDate(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pd-empty">{t('detail.annotationsEmpty')}</p>
          )}
        </section>
      </div>

      {/* Navigation sits in its own bar below the scroll area: always reachable and
          never covering the panel image or the notes. */}
      <footer className="pd-foot">
        <div className="pd-foot-group">
          <button
            type="button"
            className="btn tiny pd-page"
            onClick={onPrevPage}
            disabled={!onPrevPage}
            title={t('app.prevPage')}
            aria-label={t('app.prevPage')}
          >
            « <span className="pd-foot-label">{t('app.prevPage')}</span>
          </button>
          <button
            type="button"
            className="btn tiny"
            onClick={onPrev}
            disabled={!onPrev}
            title={t('detail.prev')}
            aria-label={t('detail.prev')}
          >
            ‹ <span className="pd-foot-label">{t('detail.prev')}</span>
          </button>
        </div>
        <div className="pd-foot-group pd-foot-right">
          <button
            type="button"
            className="btn tiny"
            onClick={onNext}
            disabled={!onNext}
            title={t('detail.next')}
            aria-label={t('detail.next')}
          >
            <span className="pd-foot-label">{t('detail.next')}</span> ›
          </button>
          <button
            type="button"
            className="btn tiny pd-page"
            onClick={onNextPage}
            disabled={!onNextPage}
            title={t('app.nextPage')}
            aria-label={t('app.nextPage')}
          >
            <span className="pd-foot-label">{t('app.nextPage')}</span> »
          </button>
        </div>
      </footer>
    </div>
  );
}
