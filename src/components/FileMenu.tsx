import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Library } from '../types';
import type { Selection } from '../hooks/usePage';
import { formatDate, useI18n } from '../i18n';
import { clearRecent, pushRecent, readRecent, removeRecent } from '../lib/recent';
import type { RecentPage } from '../lib/recent';

type Props = {
  library: Library | null;
  selection: Selection | null;
  dirty: boolean;
  hasDoc: boolean;
  onOpenSelection: (selection: Selection) => void;
  onOpenProject: () => void;
  onExport: () => void;
  onSave: () => void;
  /** Viewer mode: export stays available, saving the page or project does not. */
  readOnly?: boolean;
};

/**
 * Word-style File menu for the static edition: open project, recent pages, save and export.
 * Folder scanning, template exchange and backups are intentionally absent — they need the
 * local edition, which can read and write the disk.
 */
export function FileMenu({
  library,
  selection,
  dirty,
  hasDoc,
  onOpenSelection,
  onOpenProject,
  onExport,
  onSave,
  readOnly = false,
}: Props) {
  const { t, formatNumber: fmt } = useI18n();
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<RecentPage[]>([]);
  // "Recent" is a flyout submenu so a long list cannot stretch the File menu.
  const [recentOpen, setRecentOpen] = useState(false);
  const [subPos, setSubPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const recentWrapRef = useRef<HTMLDivElement>(null);
  const recentBtnRef = useRef<HTMLButtonElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const recentOpenRef = useRef(false);
  const subItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const setRecentMenu = useCallback((next: boolean) => {
    recentOpenRef.current = next;
    setRecentOpen(next);
  }, []);

  useEffect(() => {
    if (open) setRecent(readRecent());
    else setRecentMenu(false);
  }, [open, setRecentMenu]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (recentOpenRef.current) setRecentMenu(false);
      else setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, setRecentMenu]);

  // File shortcuts work even while typing in an input, matching desktop apps.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'o') {
        e.preventDefault();
        setOpen(false);
        onOpenProject();
      } else if (key === 's') {
        e.preventDefault();
        setOpen(false);
        if (e.shiftKey) onOpenProject();
        else if (hasDoc) onSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasDoc, onOpenProject, onSave]);

  const resolve = (entry: RecentPage) => {
    const volume = library?.volumes.find((v) => v.id === entry.volume);
    const chapter = volume?.chapters.find((c) => c.chapter === entry.chapter);
    const pageCount = chapter?.pages.length ?? 0;
    return {
      missing: !volume || !chapter || pageCount === 0,
      title: volume?.title ?? entry.volume,
      pageIndex: Math.min(Math.max(0, entry.pageIndex), Math.max(0, pageCount - 1)),
      pageCount,
    };
  };

  const openRecent = (entry: RecentPage) => {
    const info = resolve(entry);
    if (info.missing) return;
    setOpen(false);
    onOpenSelection({ volume: entry.volume, chapter: entry.chapter, pageIndex: info.pageIndex });
    setRecent(pushRecent({ volume: entry.volume, chapter: entry.chapter, pageIndex: info.pageIndex }));
  };

  const dropRecent = (entry: RecentPage) => {
    setRecent(removeRecent(entry.volume, entry.chapter));
  };

  /** Place the flyout next to its row, flipping left when the right edge is too close. */
  const placeSub = () => {
    const wrap = recentWrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const width = Math.min(640, window.innerWidth - 24);
    const flip = r.right + width + 12 > window.innerWidth;
    setSubPos({ top: Math.max(8, r.top - 8), left: flip ? Math.max(8, r.left - width - 6) : r.right + 6 });
  };

  const openSub = (focusFirst = false) => {
    placeSub();
    setRecentMenu(true);
    if (focusFirst) {
      window.requestAnimationFrame(() => {
        for (const el of subItemRefs.current) {
          if (el && !el.disabled) {
            el.focus();
            return;
          }
        }
      });
    }
  };

  useLayoutEffect(() => {
    if (!recentOpen || !subRef.current) return;
    const maxTop = window.innerHeight - subRef.current.offsetHeight - 8;
    setSubPos((p) => (p.top > maxTop ? { ...p, top: Math.max(8, maxTop) } : p));
  }, [recentOpen, recent.length]);

  const onRecentItemKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'Enter') return;
    if (!recent.length) return;
    e.preventDefault();
    e.stopPropagation();
    openSub(true);
  };

  const onSubKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      setRecentMenu(false);
      recentBtnRef.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const items: HTMLButtonElement[] = [];
    for (const el of subItemRefs.current) if (el && !el.disabled) items.push(el);
    const index = items.findIndex((el) => el === document.activeElement);
    if (e.key === 'ArrowDown') items[Math.min(items.length - 1, index + 1)]?.focus();
    else if (index <= 0) recentBtnRef.current?.focus();
    else items[index - 1]?.focus();
  };

  return (
    <div className="file-menu" ref={rootRef}>
      <button
        type="button"
        className={`btn file-menu-btn ${open ? 'on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t('file.menuTitle')}
      >
        <span className="file-btn-icon" aria-hidden="true">
          ▤
        </span>
        <span className="file-btn-label">{t('file.menu')}</span>
        <span className="file-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="file-pop" role="menu">
          <div className="file-group">{t('file.groupOpen')}</div>
          <button
            type="button"
            role="menuitem"
            className="file-item"
            onClick={() => {
              setOpen(false);
              onOpenProject();
            }}
          >
            {t('file.openProject')}
            <kbd className="file-kbd">Ctrl+O</kbd>
          </button>

          <div className="file-sep" />
          <div className="file-sub-wrap" ref={recentWrapRef} onPointerEnter={() => !recentOpen && openSub()}>
            <button
              ref={recentBtnRef}
              type="button"
              role="menuitem"
              className={`file-item has-sub ${recentOpen ? 'open' : ''}`}
              aria-haspopup="menu"
              aria-expanded={recentOpen}
              disabled={recent.length === 0}
              onClick={() => (recentOpen ? setRecentMenu(false) : openSub())}
              onKeyDown={onRecentItemKeyDown}
            >
              <span>{t('file.groupRecent')}</span>
              <span className="file-item-tail">
                {recent.length > 0 && <span className="file-count">{fmt(recent.length)}</span>}
                <span className="file-item-arrow" aria-hidden="true">
                  ›
                </span>
              </span>
            </button>

            {recentOpen && (
              <div
                ref={subRef}
                className="file-sub"
                role="menu"
                aria-label={t('file.groupRecent')}
                style={{ '--sub-top': `${subPos.top}px`, '--sub-left': `${subPos.left}px` } as CSSProperties}
                onKeyDown={onSubKeyDown}
              >
                <div className="file-sub-head">
                  <span>{t('file.groupRecent')}</span>
                  <span className="file-count">{fmt(recent.length)}</span>
                </div>
                <div className="file-sub-list">
                  {recent.length === 0 ? (
                    <div className="file-empty">{t('file.recentEmpty')}</div>
                  ) : (
                    recent.map((entry, i) => {
                      const info = resolve(entry);
                      const path = `${info.title}${entry.chapter ? ` / ${entry.chapter}` : ''}`;
                      const newGroup = i === 0 || recent[i - 1].volume !== entry.volume;
                      return (
                        <div key={`${entry.volume}/${entry.chapter}`}>
                          {newGroup && <div className="file-sub-group">{info.title}</div>}
                          <div className={`file-recent ${info.missing ? 'missing' : ''}`}>
                            <button
                              ref={(el) => {
                                subItemRefs.current[i] = el;
                              }}
                              type="button"
                              role="menuitem"
                              className="file-recent-main"
                              disabled={info.missing}
                              onClick={() => openRecent(entry)}
                              title={info.missing ? t('file.recentMissing') : t('file.recentOpen')}
                            >
                              <span className="file-recent-name">
                                {info.title} / {entry.chapter || t('sidebar.singleChapter')}
                                {info.missing && <em className="file-badge">{t('file.recentMissing')}</em>}
                              </span>
                              <span className="file-recent-path" title={path}>
                                {path}
                              </span>
                              <span className="file-recent-when">
                                {t('format.page', { page: fmt(info.pageIndex + 1) })} · {formatDate(entry.at)}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="file-recent-remove"
                              onClick={() => dropRecent(entry)}
                              title={t('file.recentRemove')}
                              aria-label={t('file.recentRemove')}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="file-sub-foot">
                  <button
                    type="button"
                    className="file-clear block"
                    disabled={recent.length === 0}
                    onClick={() => setRecent(clearRecent())}
                  >
                    {t('file.recentClear')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {!readOnly && (
            <>
              <div className="file-sep" />
              <div className="file-group">{t('file.groupSave')}</div>
              <button
                type="button"
                role="menuitem"
                className="file-item"
                disabled={!hasDoc}
                onClick={() => {
                  setOpen(false);
                  onSave();
                }}
              >
                {t('file.savePage')}
                <kbd className="file-kbd">Ctrl+S</kbd>
              </button>
              <button
                type="button"
                role="menuitem"
                className="file-item"
                onClick={() => {
                  setOpen(false);
                  onOpenProject();
                }}
              >
                {t('file.saveAsProject')}
                <kbd className="file-kbd">Ctrl+Shift+S</kbd>
              </button>
            </>
          )}

          <div className="file-sep" />
          <button
            type="button"
            role="menuitem"
            className="file-item"
            disabled={!hasDoc}
            onClick={() => {
              setOpen(false);
              onExport();
            }}
          >
            {t('file.export')}
            <kbd className="file-kbd">E</kbd>
          </button>
        </div>
      )}
    </div>
  );
}
