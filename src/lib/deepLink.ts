/**
 * Hash deep links: `#/<volume>/<chapter>/<page>/<view>[/panel/<panelId>]`.
 *
 * The panel segment only exists while the panel detail view is open, so sharing or
 * refreshing the URL restores the same page and panel position.
 */

export type AppView = 'panels' | 'compare' | 'original';

export type DeepLink = {
  volume: string;
  chapter: string;
  /** Zero-based page index. */
  pageIndex: number;
  /** View encoded in the link, or null when the link only names a page. */
  view: AppView | null;
  /** Panel detail target, or null for the normal compare view. */
  panelId: string | null;
};

export function parseDeepLink(hash: string): DeepLink | null {
  const raw = decodeURIComponent(hash.replace(/^#\/?/, ''));
  if (!raw) return null;
  const [volume, chapter, pageNo, mode, sub, panelId] = raw.split('/');
  if (!volume || !chapter) return null;
  const view: AppView | null = mode === 'compare' || mode === 'panels' || mode === 'original' ? mode : null;
  return {
    volume,
    chapter,
    pageIndex: Math.max(1, Number.parseInt(pageNo ?? '1', 10) || 1) - 1,
    view,
    panelId: view === 'compare' && sub === 'panel' && panelId ? panelId : null,
  };
}

export function buildHash(
  volume: string,
  chapter: string,
  pageIndex: number,
  view: AppView,
  panelId?: string | null,
): string {
  const base = `#/${encodeURIComponent(volume)}/${encodeURIComponent(chapter)}/${pageIndex + 1}/${view}`;
  return panelId ? `${base}/panel/${encodeURIComponent(panelId)}` : base;
}
