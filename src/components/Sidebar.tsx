import { useMemo, useRef, useState } from 'react';
import type { ChapterEntry, Lang, Library, PageEntry, VolumeEntry } from '../types';
import { langShort, SINGLE_CHAPTER } from '../types';
import type { Selection } from '../hooks/usePage';
import { thumbUrl } from '../api';
import { useI18n } from '../i18n';
import { ProjectDialog } from './ProjectDialog';

type Props = {
  library: Library | null;
  rootPath: string;
  selection: Selection | null;
  onOpen: (sel: Selection) => void;
  onReload: (library?: Library) => void;
  /** Whether the current page has unsaved edits; warned before project export/import. */
  dirty: boolean;
};

function pickFile(page: PageEntry, volume?: VolumeEntry): { url: string; lang: Lang } | null {
  const order = [
    ...(volume?.languages ?? []),
    ...Object.keys(page.files).filter((l) => !volume?.languages.includes(l)),
  ];
  for (const lang of order) {
    const url = page.files[lang];
    if (url) return { url, lang };
  }
  return null;
}

/** How chapter pages are listed in the sidebar; persisted locally per browser. */
type PageListLayout = 'grid' | 'single' | 'list';

const PAGE_LIST_KEY = 'manga-memo.page-list-layout';

function readPageListLayout(): PageListLayout {
  try {
    const saved = localStorage.getItem(PAGE_LIST_KEY);
    if (saved === 'grid' || saved === 'single' || saved === 'list') return saved;
  } catch {
    // Storage can be disabled; fall through to the viewport default.
  }
  return window.matchMedia('(max-width: 720px)').matches ? 'single' : 'grid';
}

function PageListIcon({ name }: { name: PageListLayout }) {
  return (
    <svg
      viewBox="0 0 14 14"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'grid' && (
        <>
          <rect x="1.6" y="1.6" width="4.6" height="4.6" rx="0.8" />
          <rect x="7.8" y="1.6" width="4.6" height="4.6" rx="0.8" />
          <rect x="1.6" y="7.8" width="4.6" height="4.6" rx="0.8" />
          <rect x="7.8" y="7.8" width="4.6" height="4.6" rx="0.8" />
        </>
      )}
      {name === 'single' && (
        <>
          <rect x="1.6" y="1.6" width="10.8" height="4.6" rx="0.8" />
          <rect x="1.6" y="7.8" width="10.8" height="4.6" rx="0.8" />
        </>
      )}
      {name === 'list' && (
        <>
          <path d="M4.4 3h8.2M4.4 7h8.2M4.4 11h8.2" />
          <circle cx="1.9" cy="3" r="0.7" fill="currentColor" stroke="none" />
          <circle cx="1.9" cy="7" r="0.7" fill="currentColor" stroke="none" />
          <circle cx="1.9" cy="11" r="0.7" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
}

/** Small monochrome icon for the sidebar footer; it inherits the theme colour. */
function ProjectIcon() {
  return (
    <svg
      className="foot-icon"
      viewBox="0 0 14 14"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 1.8h4l3 3v7.4h-7z" />
      <path d="M7.5 1.8v3h3" />
    </svg>
  );
}

export function Sidebar({ library, rootPath, selection, onOpen, onReload, dirty }: Props) {
  const { t, formatNumber } = useI18n();
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({}));
  const [projectOpen, setProjectOpen] = useState(false);
  const [pageLayout, setPageLayout] = useState<PageListLayout>(readPageListLayout);
  const sidebarScroll = useRef<HTMLDivElement>(null);

  /** Keep the scroll offset while the page list changes shape. */
  const choosePageLayout = (next: PageListLayout) => {
    if (next === pageLayout) return;
    const top = sidebarScroll.current?.scrollTop ?? 0;
    setPageLayout(next);
    try {
      localStorage.setItem(PAGE_LIST_KEY, next);
    } catch {
      // Storage can be disabled; the in-memory choice still applies.
    }
    requestAnimationFrame(() => {
      if (sidebarScroll.current) sidebarScroll.current.scrollTop = top;
    });
  };

  const activeChapterKey = selection ? `${selection.volume}/${selection.chapter}` : '';

  // Auto-expand the active chapter.
  const expanded = useMemo(() => {
    const base = { ...open };
    if (activeChapterKey) base[activeChapterKey] = base[activeChapterKey] ?? true;
    return base;
  }, [open, activeChapterKey]);

  if (!library) {
    return (
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="root-path">{t('sidebar.loadingLibrary')}</div>
        </div>
      </aside>
    );
  }

  if (!library.volumes.length) {
    return (
      <aside className="sidebar">
        <div className="sidebar-empty">
          <p>{t('online.noProject')}</p>
          <p className="muted tiny">{t('online.openHint')}</p>
          <button type="button" className="btn primary block" onClick={() => setProjectOpen(true)}>
            {t('online.openProjectButton')}
          </button>
          <p className="muted tiny">{t('online.dataNote')}</p>
        </div>
        {projectOpen && (
          <ProjectDialog
            dirty={dirty}
            onClose={() => setProjectOpen(false)}
            onImported={(lib) => {
              onReload(lib);
              setProjectOpen(false);
            }}
          />
        )}
      </aside>
    );
  }

  const renderChapter = (volume: VolumeEntry, chapter: ChapterEntry) => {
    const volumeId = volume.id;
    const key = `${volumeId}/${chapter.chapter}`;
    const isOpen = expanded[key];
    // Pages excluded by preprocessing are not part of the reading body.
    const bodyPages = chapter.pages.filter((p) => !p.excluded);
    const pageWarnings = bodyPages.reduce((n, p) => n + p.warnings.length, 0);
    const annotated = bodyPages.filter((p) => p.annotated).length;

    return (
      <div className="chapter" key={key}>
        <button
          type="button"
          className={`chapter-row ${selection?.volume === volumeId && selection.chapter === chapter.chapter ? 'active' : ''}`}
          onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}
        >
          <span className={`chev ${isOpen ? 'open' : ''}`}>▸</span>
          <span className="ch-name">
            {chapter.title?.trim() ||
              (chapter.chapter === SINGLE_CHAPTER
                ? t('sidebar.singleChapter')
                : t('format.chapter', { chapter: chapter.chapter }))}
          </span>
          <span className="ch-meta">
            {annotated > 0 && <span className="chip-mini ok">{formatNumber(annotated)}</span>}
            {pageWarnings > 0 && (
              <span className="chip-mini warn" title={bodyPages.flatMap((p) => p.warnings).join('\n')}>
                !
              </span>
            )}
            <span className="ch-count">{formatNumber(bodyPages.length)}p</span>
          </span>
        </button>

        {isOpen && (
          <>
            {chapter.warnings.map((w) => (
              <div className="warn-line" key={w}>
                {w}
              </div>
            ))}
            {pageLayout === 'list' ? (
              <div className="page-list">
                {bodyPages.map((page, position) => {
                  const active =
                    selection?.volume === volumeId &&
                    selection.chapter === chapter.chapter &&
                    selection.pageIndex === page.index;
                  const pageNo = formatNumber(position + 1);
                  const langs = [
                    ...volume.languages,
                    ...(Object.keys(page.files) as Lang[]).filter((l) => !volume.languages.includes(l)),
                  ];
                  return (
                    <button
                      type="button"
                      key={page.index}
                      className={`page-row${active ? ' is-active' : ''}`}
                      title={`${t('format.page', { page: pageNo })}${
                        page.warnings.length ? '\n' + page.warnings.join('\n') : ''
                      }`}
                      onClick={() => onOpen({ volume: volumeId, chapter: chapter.chapter, pageIndex: page.index })}
                    >
                      <span className="page-row-no">{pageNo}</span>
                      <span className="page-row-langs">
                        {langs.length ? (
                          langs.map((lang) =>
                            page.files[lang] ? (
                              <span className="page-row-lang" key={lang}>
                                {langShort(lang)}
                              </span>
                            ) : (
                              <span
                                className="page-row-lang is-missing"
                                key={lang}
                                title={t('sidebar.langMissing', { lang: langShort(lang) })}
                              >
                                {langShort(lang)}
                              </span>
                            ),
                          )
                        ) : (
                          <span className="page-row-missing">{t('sidebar.missingImage')}</span>
                        )}
                        {page.warnings.length > 0 && <i className="page-row-warn">!</i>}
                      </span>
                      <span className="page-row-notes">{page.annotated ? '✎' : ''}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className={`page-grid${pageLayout === 'single' ? ' is-single' : ''}`}>
                {bodyPages.map((page, position) => {
                  const file = pickFile(page, volume);
                  const active =
                    selection?.volume === volumeId &&
                    selection.chapter === chapter.chapter &&
                    selection.pageIndex === page.index;
                  const pageNo = formatNumber(position + 1);
                  return (
                    <button
                      type="button"
                      key={page.index}
                      className={`thumb ${active ? 'active' : ''} ${file ? '' : 'missing'}`}
                      title={`${t('format.page', { page: pageNo })}${
                        page.warnings.length ? '\n' + page.warnings.join('\n') : ''
                      }`}
                      onClick={() => onOpen({ volume: volumeId, chapter: chapter.chapter, pageIndex: page.index })}
                    >
                      {file ? (
                        <img src={thumbUrl(file.url, 200)} alt={t('format.page', { page: pageNo })} loading="lazy" />
                      ) : (
                        <span>{t('sidebar.missingImage')}</span>
                      )}
                      <em>{pageNo}</em>
                      {page.warnings.length > 0 && <i className="thumb-warn">!</i>}
                      {page.annotated && <i className="thumb-dot" />}
                      {file && <b className="thumb-lang">{langShort(file.lang)}</b>}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-head-row">
          <div className="root-path" title={rootPath}>
            {t('format.volumesChapters', {
              volumes: formatNumber(library.volumes.length),
              chapters: formatNumber(library.volumes.reduce((n, v) => n + v.chapters.length, 0)),
            })}
          </div>
          <div className="page-list-modes" role="group" aria-label={t('sidebar.pageListLayout')}>
            {(['grid', 'single', 'list'] as const).map((mode) => {
              const label =
                mode === 'grid'
                  ? t('sidebar.pageListGrid')
                  : mode === 'single'
                    ? t('sidebar.pageListSingle')
                    : t('sidebar.pageListList');
              return (
                <button
                  key={mode}
                  type="button"
                  className={`page-list-mode${pageLayout === mode ? ' is-active' : ''}`}
                  title={label}
                  aria-label={label}
                  aria-pressed={pageLayout === mode}
                  onClick={() => choosePageLayout(mode)}
                >
                  <PageListIcon name={mode} />
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="sidebar-scroll" ref={sidebarScroll}>
        {library.volumes.map((volume) => (
          <div className="volume" key={volume.id}>
            <div className="volume-title">
              <span className="volume-name" title={volume.title}>
                {volume.title}
              </span>
              <span
                className="volume-langs"
                title={volume.languages.length ? volume.languages.map((l) => langShort(l)).join(' · ') : undefined}
              >
                {volume.languages.length ? (
                  <>
                    {volume.languages
                      .slice(0, 2)
                      .map((l) => langShort(l))
                      .join(' · ')}
                    {volume.languages.length > 2 && <b className="volume-langs-more">+{volume.languages.length - 2}</b>}
                  </>
                ) : (
                  t('sidebar.langsUnconfigured')
                )}
              </span>
            </div>
            {volume.warnings.map((w) => (
              <em className="volume-warn" key={w}>
                {w}
              </em>
            ))}
            {volume.chapters.map((chapter) => renderChapter(volume, chapter))}
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <span className="sidebar-foot-status" title={t('online.dataNote')}>
          {t('online.dataNote')}
        </span>
        <span className="sidebar-foot-actions">
          <button
            type="button"
            className="btn tiny foot-btn"
            onClick={() => setProjectOpen(true)}
            title={t('sidebar.projectFileTitle')}
            aria-label={t('sidebar.projectFileTitle')}
          >
            <ProjectIcon />
            <span className="foot-label">{t('sidebar.projectFile')}</span>
          </button>
          <span className="local-only-chip" title={t('online.limitsBody')}>
            {t('online.localOnly')}
          </span>
        </span>
      </div>

      {projectOpen && (
        <ProjectDialog
          dirty={dirty}
          onClose={() => setProjectOpen(false)}
          onImported={(lib) => {
            onReload(lib);
            setProjectOpen(false);
          }}
        />
      )}
    </aside>
  );
}
