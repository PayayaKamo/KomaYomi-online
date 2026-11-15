import { useEffect, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { Locale } from '../i18n';

type Meta = { version: string; author: string; license: string };

/** Credits are dependency names only; versions stay in package.json. */
const CREDITS = ['React', 'Vite', 'TypeScript', 'Electron', 'pngjs', 'jpeg-js'];
const REPO_URL = 'https://github.com/PayayaKamo/KomaYomi';
const DOCS_BASE = 'https://payayakamo.github.io/KomaYomi-docs/';
/** The docs site mirrors the app locale: English at the root, Chinese and Japanese below it. */
const DOCS_PATHS: Record<Locale, string> = { en: '', zh: 'zh/', ja: 'ja/' };

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [meta, setMeta] = useState<Meta | null>(null);

  // The server reads package.json, so the version shown here never drifts from the build.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .health()
      .then((res) => {
        if (alive) setMeta({ version: res.version, author: res.author, license: res.license });
      })
      .catch(() => {
        if (alive) setMeta(null);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  const value = (text: string | undefined) => text || '—';

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <header className="modal-head">
          <div className="about-identity">
            <img className="about-logo" src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={44} height={44} />
            <div>
              <h2 id="about-title">KomaYomi</h2>
              <p>{t('app.tagline')}</p>
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('about.close')}>
            ×
          </button>
        </header>

        <div className="modal-body">
          <dl className="about-facts">
            <dt>{t('about.version')}</dt>
            <dd>{value(meta?.version)}</dd>
            <dt>{t('about.author')}</dt>
            <dd>{value(meta?.author)}</dd>
            <dt>{t('about.license')}</dt>
            <dd>{value(meta?.license)}</dd>
            <dt>{t('about.repository')}</dt>
            <dd>
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                {REPO_URL}
              </a>
            </dd>
            <dt>{t('about.documentation')}</dt>
            <dd>
              <a href={`${DOCS_BASE}${DOCS_PATHS[locale]}`} target="_blank" rel="noopener noreferrer">
                {DOCS_BASE}
              </a>
            </dd>
          </dl>

          <div className="field">
            <span>{t('about.credits')}</span>
            <div className="about-credits">
              {CREDITS.map((name) => (
                <span className="chip-mini" key={name}>
                  {name}
                </span>
              ))}
            </div>
            <p className="field-hint">{t('about.acknowledgements')}</p>
          </div>
        </div>

        <footer className="modal-foot">
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={onClose}>
            {t('about.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}
