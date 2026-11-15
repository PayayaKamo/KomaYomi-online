/**
 * Register the offline service worker for built apps only: the dev server serves
 * source modules, and caching them would keep stale code after an edit.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
