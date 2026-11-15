import { useI18n } from '../i18n';
import { setAnnSurface, useAnnSurface } from '../lib/annotationSurface';
import type { AnnSurface } from '../lib/annotationSurface';

/** Minimal preferences dialog: annotation placement is the first setting it hosts. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const surface = useAnnSurface();

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal">
        <header className="modal-head">
          <div>
            <h2>{t('settings.title')}</h2>
            <p>{t('settings.subtitle')}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('settings.close')}>
            ×
          </button>
        </header>
        <div className="settings-body">
          <div className="settings-row">
            <div>
              <strong>{t('settings.annSurface')}</strong>
              <p className="muted tiny">{t('settings.annSurfaceHint')}</p>
            </div>
            <select
              className="tb-select"
              value={surface}
              onChange={(e) => setAnnSurface(e.target.value as AnnSurface)}
              title={t('settings.annSurface')}
              aria-label={t('settings.annSurface')}
            >
              <option value="read">{t('settings.annRead')}</option>
              <option value="panels">{t('settings.annPanels')}</option>
              <option value="both">{t('settings.annBoth')}</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
