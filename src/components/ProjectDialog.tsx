import { useEffect, useRef, useState } from 'react';
import type { Library } from '../types';
import { formatBytes, formatNumber, useI18n } from '../i18n';
import {
  buildProjectArchive,
  downloadBlob,
  getWorkspaceSummary,
  type ImportProgress,
} from '../static/projectStore';
import { openProject } from '../api';
import type { ProjectMeta } from '../static/db';

type Props = {
  onClose: () => void;
  onImported: (library: Library) => void;
  /** Whether the current page has unsaved edits (pending content in confirm mode). */
  dirty: boolean;
};

type ProgressState = { phase: string; done: number; total: number } | null;

/** Project file .mnproj for the static edition: open (with optional image folder) and save. */
export function ProjectDialog({ onClose, onImported, dirty }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'open' | 'save'>('open');
  const [file, setFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressState>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [mode, setMode] = useState<'packaged' | 'reference'>('packaged');
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void getWorkspaceSummary().then((summary) => {
      if (!alive || !summary) return;
      setMeta(summary.meta);
      setName(summary.meta.projectName);
    });
    return () => {
      alive = false;
    };
  }, []);

  const confirmDirty = (action: string) => {
    if (!dirty) return true;
    return window.confirm(t('project.dirtyConfirm', { action }));
  };

  const runImport = async () => {
    if (!file) return;
    if (meta && !window.confirm(t('online.replaceWarning'))) return;
    if (!confirmDirty(t('online.openTitle'))) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await openProject(file, {
        imageFiles: folderFiles,
        onProgress: (phase, doneCount, total) => setProgress({ phase, done: doneCount, total }),
      });
      setDone(
        t('online.imported', {
          name: result.meta.projectName,
          pages: formatNumber(result.pages),
          images: formatNumber(result.images),
        }) +
          (result.warnings.length ? `\n${result.warnings.join('\n')}` : ''),
      );
      onImported(result.library);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const runExport = async () => {
    if (!confirmDirty(t('online.saveTitle'))) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const archive = await buildProjectArchive({ name: name.trim() || undefined, storageMode: mode });
      downloadBlob(archive.blob, archive.name);
      setSaved(t('online.saved', { name: archive.name }));
    } catch (err) {
      setError(t('online.saveFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal project-modal">
        <header className="modal-head">
          <div>
            <h2>{t('project.title')}</h2>
            <p>{t('online.dataNote')}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="modal-body">
          <div className="seg">
            <button type="button" className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>
              {t('online.openTitle')}
            </button>
            <button type="button" className={tab === 'save' ? 'on' : ''} onClick={() => setTab('save')}>
              {t('online.saveTitle')}
            </button>
          </div>

          {error && <div className="banner error">{error}</div>}
          {done && <div className="banner info" style={{ whiteSpace: 'pre-line' }}>{done}</div>}
          {saved && <div className="banner info">{saved}</div>}

          {tab === 'open' ? (
            <>
              <section className="project-section">
                <h3>{t('online.openTitle')}</h3>
                <p className="muted">{t('online.openHint')}</p>
                {meta && (
                  <p className="muted">
                    {t('online.currentProject', { name: meta.projectName })} · {meta.storageMode}
                  </p>
                )}
                <div className="row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <label className="btn" style={{ cursor: 'pointer' }}>
                    {t('online.chooseFile')}
                    <input
                      type="file"
                      accept=".mnproj,.zip,application/zip"
                      hidden
                      onChange={(e) => {
                        setFile(e.target.files?.[0] ?? null);
                        setDone(null);
                        setError(null);
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => folderInputRef.current?.click()}
                    title={t('online.chooseFolder')}
                  >
                    {t('online.chooseFolder')}
                  </button>
                  <input
                    ref={folderInputRef}
                    type="file"
                    multiple
                    hidden
                    // Directory picking is supported by every current browser; the attribute is non-standard.
                    {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                    onChange={(e) => setFolderFiles(Array.from(e.target.files ?? []))}
                  />
                </div>
                {file && (
                  <p className="muted">
                    {file.name} · {formatBytes(file.size)}
                  </p>
                )}
                {folderFiles.length > 0 && (
                  <p className="muted">{t('online.attached', { count: formatNumber(folderFiles.length) })}</p>
                )}
                {progress && (
                  <p className="muted">
                    {t('online.importing')}
                    {progress.total ? ` ${formatNumber(progress.done)} / ${formatNumber(progress.total)}` : ''}
                  </p>
                )}
                <div className="row" style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" className="btn primary" disabled={!file || busy} onClick={() => void runImport()}>
                    {busy ? t('online.importing') : t('online.open')}
                  </button>
                </div>
              </section>

              <section className="project-section">
                <h3>{t('online.limitsTitle')}</h3>
                <p className="muted">{t('online.limitsBody')}</p>
              </section>
            </>
          ) : (
            <>
              <section className="project-section">
                <h3>{t('online.saveTitle')}</h3>
                <p className="muted">{t('online.saveHint')}</p>
                <label className="field" style={{ display: 'block', marginBottom: 8 }}>
                  <span className="muted tiny">{t('online.projectName')}</span>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="check" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={mode === 'packaged'} onChange={(e) => setMode(e.target.checked ? 'packaged' : 'reference')} />
                  <span>{t('online.packaged')}</span>
                </label>
                <div className="row" style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" className="btn primary" disabled={busy} onClick={() => void runExport()}>
                    {busy ? t('online.saving') : t('online.download')}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>

        <footer className="modal-foot">
          <span className="muted tiny">{t('online.dataNote')}</span>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}
