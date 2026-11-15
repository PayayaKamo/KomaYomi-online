import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { CrumbNav } from './components/CrumbNav';
import { PanelsTab } from './components/PanelsTab';
import { CompareTab } from './components/CompareTab';
import { NotesPanel } from './components/NotesPanel';
import { ExportDialog } from './components/ExportDialog';
import { FileMenu } from './components/FileMenu';
import { AboutDialog } from './components/AboutDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { ProjectDialog } from './components/ProjectDialog';
import { PaneSplitter, clampPaneWidth, loadPaneWidth, savePaneWidth } from './components/PaneSplitter';
import { usePage } from './hooks/usePage';
import type { Selection } from './hooks/usePage';
import { useOutbox } from './hooks/useOutbox';
import { usePwaStatus } from './hooks/usePwaStatus';
import { api, openProject } from './api';
import { pushRecent } from './lib/recent';
import { DEFAULT_LANGUAGES, READING_DIRECTIONS, isRightToLeft, isVerticalReading } from './types';
import type { Lang, Library, ReadingDirection } from './types';
import { langLabel, readingLabel, useI18n } from './i18n';
import type { Locale } from './i18n';
import type { CSSProperties } from 'react';
import { applyGroupOrder, sortPanels } from './lib/geometry';
import { applyTheme, readThemeMode, saveThemeMode, watchSystemTheme } from './theme';
import type { ThemeMode } from './theme';

/** Page delta for an arrow key under a reading direction (0 when the key does not apply). */
function arrowPageStep(dir: ReadingDirection, key: string): number {
  if (isVerticalReading(dir)) return key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  if (isRightToLeft(dir)) return key === 'ArrowLeft' ? 1 : key === 'ArrowRight' ? -1 : 0;
  return key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
}

/** Drag-resizable panes: storage key and the range that keeps both usable. */
const SIDEBAR_PANE = { key: 'manga-memo.sidebar-width', min: 200, max: 420 };
const NOTES_PANE = { key: 'manga-memo.notes-width', min: 260, max: 560 };

export default function App() {
  const { t, locale, setLocale, formatNumber } = useI18n();
  const [library, setLibrary] = useState<Library | null>(null);
  const [rootPath, setRootPath] = useState('');
  const [libError, setLibError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [view, setView] = useState<'panels' | 'compare'>('panels');
  const [langs, setLangsState] = useState<Lang[]>([...DEFAULT_LANGUAGES]);
  const [overlay, setOverlay] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [tagStats, setTagStats] = useState<{ tag: string; count: number }[]>([]);
  const [notesOpen, setNotesOpen] = useState(() => window.innerWidth > 1180);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 1024);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() =>
    loadPaneWidth(SIDEBAR_PANE.key, SIDEBAR_PANE.min, SIDEBAR_PANE.max),
  );
  const [notesWidth, setNotesWidth] = useState<number | null>(() =>
    loadPaneWidth(NOTES_PANE.key, NOTES_PANE.min, NOTES_PANE.max),
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [pendingPanel, setPendingPanel] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(readThemeMode);
  /** Latest page state, read by the navigation guards declared below. */
  const pageRef = useRef<ReturnType<typeof usePage> | null>(null);

  /**
   * Confirm mode promises that nothing is written until ✓ is pressed, so leaving a page
   * asks first instead of quietly saving behind the user's back. Resolves true when the
   * caller may navigate.
   */
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    const cur = pageRef.current;
    if (!cur || !cur.dirty || cur.saveMode !== 'confirm') return true;
    if (!window.confirm(t('app.leaveUnsaved'))) return false;
    await cur.commit();
    return true;
  }, [t]);
  const confirmLeaveRef = useRef(confirmLeave);
  /** The hash that matches what is on screen, used to undo a refused deep-link jump. */
  const hashRef = useRef(location.hash);

  /** On phones/tablets the library is a drawer: picking a page should reveal the stage. */
  const openSelection = useCallback(
    (next: Selection) => {
      void confirmLeave().then((ok) => {
        if (!ok) return;
        setSel(next);
        if (window.matchMedia('(max-width: 1024px)').matches) setSidebarOpen(false);
      });
    },
    [confirmLeave],
  );

  /** The topbar logo goes back to the library landing view. */
  const goHome = useCallback(() => {
    void confirmLeave().then((ok) => {
      if (!ok) return;
      setSel(null);
      setSelected([]);
      setView('panels');
      setSidebarOpen(true);
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    });
  }, [confirmLeave]);

  // Keep the palette in sync with the stored preference and with OS changes when the
  // user picked "system". index.html already applied it before paint, so this only
  // matters for in-app switches and OS flips.
  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(theme);
  }, [theme]);

  // Keep customized pane widths usable when the window shrinks; never invent one.
  useEffect(() => {
    const onResize = () => {
      setSidebarWidth((w) => (w === null ? w : clampPaneWidth(w, SIDEBAR_PANE.min, SIDEBAR_PANE.max)));
      setNotesWidth((w) => (w === null ? w : clampPaneWidth(w, NOTES_PANE.min, NOTES_PANE.max)));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const pageState = usePage(sel);
  const outbox = useOutbox();
  const pwa = usePwaStatus();
  const { doc, page } = pageState;

  // Hash deep link: #/<volume>/<chapter>/<page (1-based)>, for direct opening and sharing.
  useEffect(() => {
    const readHash = () => {
      const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
      if (!raw) return;
      const [volume, chapter, pageNo, mode] = raw.split('/');
      if (!volume || !chapter) return;
      const n = Math.max(1, Number.parseInt(pageNo ?? '1', 10) || 1);
      const target = { volume, chapter, pageIndex: n - 1 };
      void confirmLeaveRef.current().then((ok) => {
        if (!ok) {
          // Refused: put the URL back so it keeps matching the page still on screen.
          history.replaceState(null, '', hashRef.current || `${location.pathname}${location.search}`);
          return;
        }
        if (mode === 'compare' || mode === 'panels') setView(mode);
        setSel((prev) =>
          prev && prev.volume === volume && prev.chapter === chapter && prev.pageIndex === n - 1 ? prev : target,
        );
      });
    };
    readHash();
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  }, []);

  useEffect(() => {
    if (!sel) return;
    const next = `#/${encodeURIComponent(sel.volume)}/${encodeURIComponent(sel.chapter)}/${sel.pageIndex + 1}/${view}`;
    hashRef.current = next;
    if (location.hash !== next) history.replaceState(null, '', next);
  }, [sel, view]);

  // Remember the last page of each chapter for File → Recent.
  useEffect(() => {
    if (sel) pushRecent({ volume: sel.volume, chapter: sel.chapter, pageIndex: sel.pageIndex });
  }, [sel]);

  const loadLibrary = useCallback(() => {
    api
      .library()
      .then((res) => {
        setLibrary(res.library);
        setRootPath(res.root);
        if (res.library.langOrder?.length) setLangsState(res.library.langOrder);
        setLibError(null);
      })
      .catch((err: unknown) => setLibError(err instanceof Error ? err.message : String(err)));
  }, []);

  // Keep the persisted order in sync whenever the compare bar changes it.
  const setLangs = useCallback((next: Lang[]) => {
    setLangsState(next);
    api.saveLangOrder(next).catch(() => undefined);
  }, []);

  const loadTags = useCallback(() => {
    api
      .tags()
      .then((res) => setTagStats(res.tags))
      .catch(() => setTagStats([]));
  }, []);

  useEffect(() => {
    loadLibrary();
    loadTags();
  }, [loadLibrary, loadTags]);

  /** After opening a project the old selection may not exist any more. */
  const reloadWorkspace = useCallback(() => {
    setSel(null);
    setSelected([]);
    loadLibrary();
    loadTags();
  }, [loadLibrary, loadTags]);

  /** The sample project ships with the site, so anyone can try the app in two clicks. */
  const loadSample = useCallback(async () => {
    setSampleBusy(true);
    setLibError(null);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}samples/demo.mnproj`);
      if (!response.ok) throw new Error(`Sample project not found (HTTP ${response.status}).`);
      const file = new File([await response.blob()], 'komayomi-sample.mnproj', { type: 'application/zip' });
      await openProject(file);
      setSel(null);
      const res = await api.library();
      setLibrary(res.library);
      setRootPath(res.root);
      if (res.library.langOrder?.length) setLangsState(res.library.langOrder);
      loadTags();
      const first = res.library.volumes[0]?.chapters[0];
      if (first) setSel({ volume: first.volume, chapter: first.chapter, pageIndex: 0 });
    } catch (err) {
      setLibError(err instanceof Error ? err.message : String(err));
    } finally {
      setSampleBusy(false);
    }
  }, [loadTags]);

  // Refresh the gallery badge once the page is first written to disk.
  useEffect(() => {
    if (pageState.exists) loadLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageState.exists]);

  useEffect(() => {
    if (!doc) return;
    setSelected((prev) => prev.filter((id) => doc.panels.some((p) => p.id === id)));
  }, [doc?.panels, doc]);

  // Navigation guards read the freshest page state without re-creating the callbacks.
  useEffect(() => {
    pageRef.current = pageState;
    confirmLeaveRef.current = confirmLeave;
  }, [pageState, confirmLeave]);

  // In confirm mode, warn before leaving with pending edits; autosave mode needs no guard.
  useEffect(() => {
    if (!pageState.dirty || pageState.saveMode !== 'confirm') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [pageState.dirty, pageState.saveMode]);

  const ordered = useMemo(
    () => (doc ? applyGroupOrder(sortPanels(doc.panels, doc.readingDirection), doc.groups) : []),
    [doc],
  );
  const primaryId = selected[selected.length - 1];
  const primaryPanel = doc?.panels.find((p) => p.id === primaryId) ?? null;
  const primaryIndex = primaryPanel ? ordered.findIndex((p) => p.id === primaryPanel.id) : -1;
  const panelLabel =
    primaryIndex >= 0 ? t('format.panel', { number: formatNumber(primaryIndex + 1) }) : t('notes.thisPanel');

  // Notes-overview jump: switch page first, then select the target panel once panels load,
  // so the "prune invalid selection" effect cannot swallow the selection.
  useEffect(() => {
    if (!doc || !pendingPanel) return;
    if (doc.panels.some((p) => p.id === pendingPanel)) {
      setSelected([pendingPanel]);
      setPendingPanel(null);
    }
  }, [doc, pendingPanel]);

  const jumpTo = useCallback(
    (sel2: Selection, panelId: string | null) => {
      void confirmLeave().then((ok) => {
        if (!ok) return;
        setSel(sel2);
        setPendingPanel(panelId);
        if (panelId) setView('compare');
      });
    },
    [confirmLeave],
  );

  const changeDirection = (dir: ReadingDirection) => pageState.mutate((d) => ({ ...d, readingDirection: dir }));

  const goPage = useCallback(
    (delta: number) => {
      if (!library || !sel) return;
      const vol = library.volumes.find((v) => v.id === sel.volume);
      if (!vol) return;
      const ci = vol.chapters.findIndex((c) => c.chapter === sel.chapter);
      const chapter = vol.chapters[ci];
      if (!chapter) return;
      // Pages excluded by preprocessing are skipped in both directions.
      const body = chapter.pages.filter((p) => !p.excluded);
      const position = body.findIndex((p) => p.index === sel.pageIndex);
      const nextPosition = position + delta;
      if (position >= 0 && nextPosition >= 0 && nextPosition < body.length) {
        const next = { ...sel, pageIndex: body[nextPosition].index };
        void confirmLeave().then((ok) => ok && setSel(next));
        return;
      }
      const nextChapter = vol.chapters[ci + (delta > 0 ? 1 : -1)];
      const nextBody = nextChapter?.pages.filter((p) => !p.excluded) ?? [];
      if (!nextChapter || !nextBody.length) return;
      const next = {
        volume: sel.volume,
        chapter: nextChapter.chapter,
        pageIndex: delta > 0 ? nextBody[0].index : nextBody[nextBody.length - 1].index,
      };
      void confirmLeave().then((ok) => ok && setSel(next));
    },
    [library, sel, confirmLeave],
  );

  // Destructured so the shortcut effect depends on the callbacks themselves
  // instead of the whole pageState object (which changes on every keystroke of a note).
  const undoPage = pageState.undo;
  const redoPage = pageState.redo;

  // Keyboard shortcuts (ignored while an input has focus): [ ] page, P panels, C compare,
  // S sidebar, N notes, E export.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return;
      // Handled lower in the tree (panel nudging, dialogs) — do not page-turn on top of it.
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey) {
        const mod = e.key.toLowerCase();
        if (mod === 'z') {
          e.preventDefault();
          if (e.shiftKey) redoPage();
          else undoPage();
        } else if (mod === 'y') {
          e.preventDefault();
          redoPage();
        }
        return;
      }
      if (e.altKey) return;
      // Arrows turn pages along the page's reading direction: RTL reads leftward,
      // TTB reads downward. Modals keep their own keyboard handling.
      if (e.key.startsWith('Arrow') && doc && !document.querySelector('.modal-backdrop')) {
        const step = arrowPageStep(doc.readingDirection, e.key);
        if (step) {
          e.preventDefault();
          goPage(step);
        }
        return;
      }
      const key = e.key.toLowerCase();
      if (key === '[') {
        e.preventDefault();
        goPage(-1);
      } else if (key === ']') {
        e.preventDefault();
        goPage(1);
      } else if (key === 'p') setView('panels');
      else if (key === 'c') setView('compare');
      else if (key === 's') setSidebarOpen((v) => !v);
      else if (key === 'n') setNotesOpen((v) => !v);
      else if (key === 'e' && doc) setExportOpen(true);
      else if (e.key === '?') setHelpOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, goPage, undoPage, redoPage]);

  // Library-wide language order; the runtime list grows with whatever the scan finds.
  const allLangs = useMemo<Lang[]>(
    () => (library?.langOrder?.length ? library.langOrder : [...DEFAULT_LANGUAGES]),
    [library],
  );
  const pageLangs = useMemo(() => (page ? Object.keys(page.files) : []), [page]);
  const availableLangs = useMemo(
    () => [...allLangs.filter((l) => pageLangs.includes(l)), ...pageLangs.filter((l) => !allLangs.includes(l))],
    [allLangs, pageLangs],
  );
  const expectedLangs = useMemo(() => {
    const volume = sel && library ? library.volumes.find((v) => v.id === sel.volume) : null;
    return volume?.languages?.length ? volume.languages : allLangs;
  }, [allLangs, library, sel]);
  const missingLangs = expectedLangs.filter((l) => !pageLangs.includes(l));

  const saveLabel = !doc
    ? ''
    : pageState.saving
      ? t('app.saveSaving')
      : pageState.dirty
        ? pageState.saveMode === 'confirm'
          ? t('app.saveUnsaved')
          : t('app.savePending')
        : t('app.saveSaved');

  return (
    <div className={`app ${notesOpen ? 'show-notes' : ''} ${sidebarOpen ? '' : 'sidebar-closed'}`}>
      <header className="topbar">
        <div className="tb-left">
          <button
            type="button"
            className="brand-mark"
            onClick={goHome}
            title={t('app.brandHome')}
            aria-label={t('app.brandHome')}
          >
            <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={22} height={22} />
          </button>
          <FileMenu
            library={library}
            selection={sel}
            dirty={pageState.dirty}
            hasDoc={Boolean(doc)}
            onOpenSelection={openSelection}
            onOpenProject={() => setProjectOpen(true)}
            onExport={() => setExportOpen(true)}
            onSave={() => void pageState.commit()}
          />
          <button
            type="button"
            className={`btn icon ${sidebarOpen ? 'on' : ''}`}
            onClick={() => setSidebarOpen((v) => !v)}
            title={t('app.toggleSidebarTitle')}
          >
            ☰
          </button>
          <button
            type="button"
            className="btn icon help-btn"
            onClick={() => setHelpOpen(true)}
            title={t('app.helpTitle')}
          >
            ?
          </button>
          <button
            type="button"
            className="btn icon settings-btn"
            onClick={() => setSettingsOpen(true)}
            title={t('settings.openTitle')}
            aria-label={t('settings.title')}
          >
            ⚙
          </button>
          <button
            type="button"
            className="btn icon"
            onClick={() => setAboutOpen(true)}
            title={t('about.openTitle')}
            aria-label={t('about.title')}
          >
            ⓘ
          </button>
          {sel && (
            <CrumbNav
              library={library}
              selection={sel}
              direction={doc?.readingDirection}
              onOpen={openSelection}
              onStep={goPage}
            />
          )}
          {doc && <span className={`save-state ${pageState.dirty ? 'dirty' : ''}`}>{saveLabel}</span>}
          {!pwa.online && <span className="pwa-chip">{t('pwa.offline')}</span>}
          {outbox.count > 0 && (
            <button
              type="button"
              className="outbox-chip"
              disabled={outbox.syncing}
              onClick={() => void outbox.replay()}
              title={outbox.error ?? t('outbox.retryTitle')}
            >
              {outbox.syncing ? t('outbox.syncing') : t('outbox.pending', { count: formatNumber(outbox.count) })}
            </button>
          )}
          {sel && (
            <span className="pwa-chip online-chip" title={t('online.dataNote')}>
              {t('online.banner')}
            </span>
          )}
        </div>

        <div className="tb-center">
          <div className="seg big">
            <button type="button" className={view === 'panels' ? 'on' : ''} onClick={() => setView('panels')}>
              {t('app.tabPanels')}
            </button>
            <button type="button" className={view === 'compare' ? 'on' : ''} onClick={() => setView('compare')}>
              {t('app.tabCompare')}
            </button>
          </div>
        </div>

        <div className="tb-right">
          {doc && (
            <select
              className="tb-select wide"
              value={doc.readingDirection}
              onChange={(e) => changeDirection(e.target.value as ReadingDirection)}
              title={t('app.readingOrderTitle')}
            >
              {READING_DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {readingLabel(d)}
                </option>
              ))}
            </select>
          )}
          <select
            className="tb-select"
            value={theme}
            onChange={(e) => {
              const next = e.target.value as ThemeMode;
              setTheme(next);
              saveThemeMode(next);
            }}
            title={t('app.themeTitle')}
            aria-label={t('app.themeAria')}
          >
            <option value="system">{t('app.themeSystem')}</option>
            <option value="light">{t('app.themeLight')}</option>
            <option value="dark">{t('app.themeDark')}</option>
          </select>
          <select
            className="tb-select"
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            title={t('app.languageTitle')}
            aria-label={t('app.languageAria')}
          >
            <option value="en">{t('locale.en')}</option>
            <option value="zh">{t('locale.zh')}</option>
            <option value="ja">{t('locale.ja')}</option>
          </select>
          <button type="button" className={`btn ${notesOpen ? 'on' : ''}`} onClick={() => setNotesOpen((v) => !v)}>
            {t('app.notesButton')}
          </button>
          <button type="button" className="btn primary" disabled={!doc} onClick={() => setExportOpen(true)}>
            {t('app.exportButton')}
            <span className="tb-export-extra"> HTML</span>
          </button>
        </div>
      </header>

      <div
        className="body-area"
        style={
          {
            '--sidebar-w': sidebarWidth === null ? undefined : `${sidebarWidth}px`,
            '--notes-w': notesWidth === null ? undefined : `${notesWidth}px`,
          } as CSSProperties
        }
      >
        <Sidebar
          library={library}
          rootPath={rootPath}
          selection={sel}
          onOpen={openSelection}
          onReload={() => reloadWorkspace()}
          dirty={pageState.dirty}
        />
        {sidebarOpen && (
          <div
            className="scrim"
            onPointerDown={() => {
              // The scrim only exists below 1024px; tapping it dismisses the drawer.
              if (window.matchMedia('(max-width: 1024px)').matches) setSidebarOpen(false);
            }}
          />
        )}

        <main className="stage">
          {sidebarOpen && (
            <PaneSplitter
              edge="left"
              target=".sidebar"
              cssVar="--sidebar-w"
              min={SIDEBAR_PANE.min}
              max={SIDEBAR_PANE.max}
              label={t('pane.libraryHandle')}
              onCommit={(w) => {
                setSidebarWidth(w);
                savePaneWidth(SIDEBAR_PANE.key, w);
              }}
              onReset={() => {
                setSidebarWidth(null);
                savePaneWidth(SIDEBAR_PANE.key, null);
              }}
            />
          )}
          {notesOpen && (
            <PaneSplitter
              edge="right"
              target=".notes-col"
              cssVar="--notes-w"
              min={NOTES_PANE.min}
              max={NOTES_PANE.max}
              label={t('pane.notesHandle')}
              onCommit={(w) => {
                setNotesWidth(w);
                savePaneWidth(NOTES_PANE.key, w);
              }}
              onReset={() => {
                setNotesWidth(null);
                savePaneWidth(NOTES_PANE.key, null);
              }}
            />
          )}
          {libError && <div className="banner error">{t('app.libraryError', { error: libError })}</div>}
          {pageState.error && <div className="banner error">{pageState.error}</div>}

          {!sel ? (
            <Welcome
              library={library}
              onOpen={openSelection}
              onOpenProject={() => setProjectOpen(true)}
              onLoadSample={() => void loadSample()}
              sampleBusy={sampleBusy}
            />
          ) : pageState.loading ? (
            <div className="stage-loading">{t('app.loadingPage', { page: formatNumber(sel.pageIndex + 1) })}</div>
          ) : doc && page ? (
            view === 'panels' ? (
              <PanelsTab
                doc={doc}
                page={page}
                mutate={pageState.mutate}
                detecting={pageState.detecting}
                onDetect={(lang) => pageState.detect(lang)}
                selected={selected}
                setSelected={setSelected}
                onReload={pageState.reload}
                saveMode={pageState.saveMode}
                setSaveMode={pageState.setSaveMode}
                dirty={pageState.dirty}
                saving={pageState.saving}
                onCommit={() => void pageState.commit()}
                onDiscard={pageState.discard}
                canUndo={pageState.canUndo}
                canRedo={pageState.canRedo}
                onUndo={pageState.undo}
                onRedo={pageState.redo}
                allLangs={allLangs}
              />
            ) : (
              <CompareTab
                doc={doc}
                page={page}
                mutate={pageState.mutate}
                reload={pageState.reload}
                selected={selected}
                setSelected={setSelected}
                langs={langs}
                setLangs={setLangs}
                allLangs={allLangs}
                overlay={overlay}
                setOverlay={setOverlay}
                canUndo={pageState.canUndo}
                canRedo={pageState.canRedo}
                onUndo={pageState.undo}
                onRedo={pageState.redo}
              />
            )
          ) : (
            !pageState.error && <div className="stage-loading">{t('app.noContent')}</div>
          )}
        </main>

        <NotesPanel
          doc={doc}
          panel={primaryPanel}
          panelLabel={panelLabel}
          mutate={pageState.mutate}
          tagStats={tagStats}
          library={library}
          onJump={jumpTo}
          onClose={() => setNotesOpen(false)}
        />
      </div>

      <ExportDialog
        open={exportOpen}
        onClose={() => {
          setExportOpen(false);
          loadTags();
        }}
        doc={doc}
        page={page}
        panel={primaryPanel}
        library={library}
        sel={sel}
        langs={langs}
        allLangs={allLangs}
        tagStats={tagStats}
        rootPath={rootPath}
      />

      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {projectOpen && (
        <ProjectDialog dirty={pageState.dirty} onClose={() => setProjectOpen(false)} onImported={reloadWorkspace} />
      )}

      {pwa.updateReady && (
        <div className="banner info floating pwa-update" role="status">
          <span>{t('pwa.updateReady')}</span>
          <button type="button" className="btn tiny" onClick={pwa.applyUpdate}>
            {t('pwa.reload')}
          </button>
        </div>
      )}

      {sel && availableLangs.length === 0 && <div className="banner error floating">{t('app.noImages')}</div>}

      {availableLangs.length > 0 && missingLangs.length > 0 && sel && (
        <div className="banner info floating">
          {t('app.missingLangs', {
            langs: missingLangs.map((l) => langLabel(l)).join(' / '),
          })}
        </div>
      )}
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd>{children}</kbd>;
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal help-modal">
        <header className="modal-head">
          <div>
            <h2>{t('app.help.heading')}</h2>
            <p>{t('app.help.subtitle')}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="help-body">
          <section>
            <h3>{t('app.help.global')}</h3>
            <dl>
              <dt>
                <Kbd>[</Kbd> <Kbd>]</Kbd>
              </dt>
              <dd>{t('app.help.prevNext')}</dd>
              <dt>
                <Kbd>←</Kbd> <Kbd>→</Kbd> / <Kbd>↑</Kbd> <Kbd>↓</Kbd>
              </dt>
              <dd>{t('app.help.arrowNav')}</dd>
              <dt>
                <Kbd>P</Kbd> <Kbd>C</Kbd>
              </dt>
              <dd>{t('app.help.switchViews')}</dd>
              <dt>
                <Kbd>S</Kbd>
              </dt>
              <dd>{t('app.help.toggleSidebar')}</dd>
              <dt>
                <Kbd>N</Kbd>
              </dt>
              <dd>{t('app.help.toggleNotes')}</dd>
              <dt>
                <Kbd>E</Kbd>
              </dt>
              <dd>{t('app.help.openExport')}</dd>
              <dt>
                <Kbd>?</Kbd>
              </dt>
              <dd>{t('app.help.openHelp')}</dd>
            </dl>
          </section>

          <section>
            <h3>{t('app.help.panels')}</h3>
            <dl>
              <dt>{t('app.help.dragTitle')}</dt>
              <dd>{t('app.help.dragDesc')}</dd>
              <dt>{t('app.help.dblclickTitle')}</dt>
              <dd>{t('app.help.dblclickDesc')}</dd>
              <dt>
                <Kbd>Ctrl</Kbd>/<Kbd>Shift</Kbd> {t('app.help.multiSelect')}
              </dt>
              <dd>
                {t('app.help.mergePrefix')}
                <Kbd>Delete</Kbd>
                {t('app.help.mergeSuffix')}
              </dd>
              <dt>{t('app.help.numericTitle')}</dt>
              <dd>{t('app.help.numericDesc')}</dd>
            </dl>
          </section>

          <section>
            <h3>{t('app.help.compare')}</h3>
            <dl>
              <dt>{t('app.help.panTitle')}</dt>
              <dd>{t('app.help.panDesc')}</dd>
              <dt>{t('app.help.alignTitle')}</dt>
              <dd>{t('app.help.alignDesc')}</dd>
              <dt>{t('app.help.anchorTitle')}</dt>
              <dd>{t('app.help.anchorDesc')}</dd>
            </dl>
          </section>

          <section>
            <h3>{t('app.help.export')}</h3>
            <dl>
              <dt>{t('app.help.exportDefaultTitle')}</dt>
              <dd>{t('app.help.exportDefaultDesc')}</dd>
              <dt>{t('app.help.exportSingleTitle')}</dt>
              <dd>{t('app.help.exportSingleDesc')}</dd>
              <dt>{t('app.help.exportPngTitle')}</dt>
              <dd>{t('app.help.exportPngDesc')}</dd>
            </dl>
          </section>
        </div>
        <footer className="modal-foot">
          <span className="muted tiny">{t('app.help.footer')}</span>
          <button type="button" className="btn primary" onClick={onClose}>
            {t('app.help.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Welcome({
  library,
  onOpen,
  onOpenProject,
  onLoadSample,
  sampleBusy,
}: {
  library: Library | null;
  onOpen: (sel: Selection) => void;
  onOpenProject: () => void;
  onLoadSample: () => void;
  sampleBusy: boolean;
}) {
  const { t } = useI18n();
  const first = library?.volumes[0]?.chapters[0];
  return (
    <div className="welcome">
      <div className="welcome-hero">
        <h1>{t('online.welcomeTitle')}</h1>
        <p>{t('online.welcomeDesc')}</p>
        <div className="welcome-actions">
          {first && (
            <button
              type="button"
              className="btn primary large"
              onClick={() => onOpen({ volume: first.volume, chapter: first.chapter, pageIndex: 0 })}
            >
              {t('app.welcome.start', {
                volume: first.volume,
                chapter: t('format.chapter', { chapter: first.chapter }),
              })}
            </button>
          )}
          <button type="button" className={`btn large ${first ? '' : 'primary'}`} onClick={onOpenProject}>
            {t('online.openProjectButton')}
          </button>
          <button type="button" className="btn large" onClick={onLoadSample} disabled={sampleBusy}>
            {sampleBusy ? t('online.loadingSample') : t('online.exampleProject')}
          </button>
        </div>
      </div>
      <div className="welcome-steps">
        <div>
          <b>1</b>
          <h3>{t('online.step1Title')}</h3>
          <p>{t('online.step1Desc')}</p>
        </div>
        <div>
          <b>2</b>
          <h3>{t('online.step2Title')}</h3>
          <p>{t('online.step2Desc')}</p>
        </div>
        <div>
          <b>3</b>
          <h3>{t('online.step3Title')}</h3>
          <p>{t('online.step3Desc')}</p>
        </div>
        <div>
          <b>4</b>
          <h3>{t('online.step4Title')}</h3>
          <p>{t('online.step4Desc')}</p>
        </div>
      </div>
      <p className="welcome-foot muted">{t('online.limitsBody')}</p>
    </div>
  );
}
