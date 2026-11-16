/**
 * Bundled demo project: a packaged .mnproj shipped with the site under public/demo/.
 *
 * The static edition has no filesystem, so the landing page can offer this project without
 * asking the user to pick a file. It is fetched once, then kept by the browser's HTTP cache
 * (GitHub Pages serves it with a stable ETag), and imported into IndexedDB like any other
 * .mnproj so notes, annotations and anchors stay editable.
 */

export const DEMO_PROJECT_NAME = 'demo-template-project.mnproj';

/**
 * Bump when replacing the bundled file. The query string gives the new copy a fresh cache
 * entry while repeat visits keep reusing the HTTP cache of the old one until it changes.
 */
const DEMO_PROJECT_VERSION = '2';

/** Resolves against Vite's base so the file also works when the site is hosted under a sub-path. */
export const DEMO_PROJECT_URL = `${import.meta.env.BASE_URL}demo/${DEMO_PROJECT_NAME}?v=${DEMO_PROJECT_VERSION}`;

export type DemoDownloadProgress = (received: number, total: number) => void;

/**
 * Fetch the demo archive with byte progress.
 * `Content-Length` is present on static hosts; when it is missing `total` is 0 and the UI
 * falls back to an indeterminate label instead of inventing a percentage.
 */
export async function fetchDemoProject(
  onProgress?: DemoDownloadProgress,
  signal?: AbortSignal,
): Promise<File> {
  const response = await fetch(DEMO_PROJECT_URL, { signal });
  if (!response.ok) {
    throw new Error(`Could not download the demo project (HTTP ${response.status}).`);
  }
  const total = Number(response.headers.get('content-length')) || 0;

  if (!response.body) {
    const blob = await response.blob();
    onProgress?.(blob.size, total || blob.size);
    return new File([blob], DEMO_PROJECT_NAME, { type: 'application/zip' });
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value as unknown as BlobPart);
    received += value.byteLength;
    onProgress?.(received, total);
  }
  return new File(chunks, DEMO_PROJECT_NAME, { type: 'application/zip' });
}
