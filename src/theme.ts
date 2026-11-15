/**
 * Theme preference: system / light / dark.
 *
 * The visual palette lives entirely in CSS custom properties (`styles.css`), so this
 * module only decides which palette applies. Keeping the decision out of React means
 * the inline bootstrap script in `index.html` can apply the same rule before first
 * paint, avoiding a white flash when a dark-theme user opens the app.
 */
export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'komayomi.theme';

export function readThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    /* storage may be unavailable in hardened contexts */
  }
  return 'system';
}

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Apply the resolved theme; safe to call before React mounts. */
export function applyTheme(mode: ThemeMode): void {
  const dark = mode === 'dark' || (mode === 'system' && prefersDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // Native form controls and scrollbars should follow the palette too.
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore quota/privacy errors */
  }
  applyTheme(mode);
}

/** Re-apply when the OS theme flips while the app is in "system" mode. */
export function watchSystemTheme(mode: ThemeMode): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (mode === 'system') applyTheme('system');
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
