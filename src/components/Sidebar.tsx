import { useMemo, useState } from 'react';
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
            <div className="page-grid">
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
          </>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="root-path" title={rootPath}>
          {t('format.volumesChapters', {
            volumes: formatNumber(library.volumes.length),
            chapters: formatNumber(library.volumes.reduce((n, v) => n + v.chapters.length, 0)),
          })}
        </div>
      </div>
      <div className="sidebar-scroll">
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
