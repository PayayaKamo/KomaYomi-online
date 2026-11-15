import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Connectivity plus an installed-app upgrade hint. A new service worker is never
 * activated behind the user's back: reloading would drop unsaved annotations, so the
 * banner asks first and only then posts SKIP_WAITING.
 */
export function usePwaStatus() {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [updateReady, setUpdateReady] = useState(false);
  const reloading = useRef(false);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let alive = true;
    void navigator.serviceWorker.ready.then((reg) => {
      if (!alive) return;
      // A worker already waiting means the previous visit left an upgrade on the shelf.
      if (reg.waiting && navigator.serviceWorker.controller) setUpdateReady(true);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) setUpdateReady(true);
        });
      });
    });
    const onController = () => {
      if (reloading.current) location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onController);
    return () => {
      alive = false;
      navigator.serviceWorker.removeEventListener('controllerchange', onController);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (!('serviceWorker' in navigator)) return;
    reloading.current = true;
    void navigator.serviceWorker.ready
      .then((reg) => {
        if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
        else location.reload();
      })
      .catch(() => {
        reloading.current = false;
      });
  }, []);

  return { online, updateReady, applyUpdate };
}
