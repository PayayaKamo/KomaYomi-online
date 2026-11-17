/**
 * Demo library, downloaded on demand instead of shipped with the site.
 *
 * The 68 MB archive lives outside the Pages artifact: the browser fetches it the first
 * time the landing page offers the demo, verifies size, ZIP signature and SHA-256, then
 * keeps the blob in its own IndexedDB database so later visits (including offline ones)
 * skip the network. The same scheme is used on mobile: one versioned archive, cached,
 * retryable.
 *
 * GitHub release assets do not send CORS headers, so a browser cannot fetch them.
 * The identical file (same SHA-256 as the `demo-library-v1` asset) is served from the
 * desktop repository's raw URL, pinned to a commit so its content cannot drift.
 */
export const DEMO_PROJECT_NAME = 'demo-project.mnproj';

/** Archives imported before the demo moved to a release are reopened as-is. */
const LEGACY_DEMO_NAMES = ['demo-template-project.mnproj'];

export function isDemoProjectSource(name: string | null | undefined): boolean {
  return Boolean(name && (name === DEMO_PROJECT_NAME || LEGACY_DEMO_NAMES.includes(name)));
}

/** Bump when the demo content changes, together with the URL, size and hash below. */
export const DEMO_PROJECT_VERSION = 'demo-library-v1';

const DEMO_PROJECT_COMMIT = 'a41512eee787f0e2edd622ebda49ff9a89eb3df9';
export const DEMO_PROJECT_URL = `https://raw.githubusercontent.com/PayayaKamo/KomaYomi/${DEMO_PROJECT_COMMIT}/resources/demo-project.mnproj`;
export const DEMO_PROJECT_BYTES = 68_598_075;
export const DEMO_PROJECT_SHA256 = 'a66f1986ac687150f7c1e5c19b30533971292abcec27373456aead1019808f83';

export type DemoFailureCode = 'offline' | 'network' | 'http' | 'integrity' | 'storage';

/** Failure with a code so the UI can show a localized, actionable message. */
export class DemoProjectError extends Error {
  code: DemoFailureCode;

  constructor(code: DemoFailureCode, message: string) {
    super(message);
    this.name = 'DemoProjectError';
    this.code = code;
  }
}

export type DemoDownloadProgress = (received: number, total: number) => void;

type CachedArchive = {
  version: string;
  bytes: number;
  sha256: string;
  savedAt: string;
  blob: Blob;
};

/**
 * A separate database keeps the cached archive alive when the workspace is replaced:
 * importing a project clears the `komayomi-online` stores, but must not force another
 * 68 MB demo download.
 */
const CACHE_DB = 'komayomi-demo-cache';
const CACHE_STORE = 'archives';
const CACHE_KEY = 'current';

let cacheDb: Promise<IDBDatabase> | null = null;

function openCacheDb(): Promise<IDBDatabase> {
  if (!cacheDb) {
    cacheDb = new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB is not available.'));
    });
  }
  return cacheDb;
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

/** A cached blob is only reused when it belongs to the current version and looks complete. */
async function readCachedArchive(): Promise<Blob | null> {
  try {
    const db = await openCacheDb();
    const record = await new Promise<CachedArchive | undefined>((resolve, reject) => {
      const request = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(CACHE_KEY) as IDBRequest<
        CachedArchive | undefined
      >;
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!record || record.version !== DEMO_PROJECT_VERSION) return null;
    if (!(record.blob instanceof Blob) || record.blob.size !== DEMO_PROJECT_BYTES) return null;
    return record.blob;
  } catch {
    return null;
  }
}

/** Caching is an optimization: a full quota must not stop a verified archive from importing. */
async function writeCachedArchive(blob: Blob): Promise<void> {
  try {
    const db = await openCacheDb();
    const record: CachedArchive = {
      version: DEMO_PROJECT_VERSION,
      bytes: blob.size,
      sha256: DEMO_PROJECT_SHA256,
      savedAt: new Date().toISOString(),
      blob,
    };
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    tx.objectStore(CACHE_STORE).put(record, CACHE_KEY);
    await transactionDone(tx);
  } catch {
    // The demo still works for this session; the next visit simply downloads again.
  }
}

function isZip(blob: Blob): Promise<boolean> {
  return blob.slice(0, 4).arrayBuffer().then((head) => {
    const bytes = new Uint8Array(head);
    return bytes.length === 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  });
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Uses SubtleCrypto when available (HTTPS/localhost); otherwise the size check stands alone. */
async function matchesHash(buffer: ArrayBuffer): Promise<boolean> {
  if (!globalThis.crypto?.subtle) return true;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return toHex(digest) === DEMO_PROJECT_SHA256;
}

async function downloadArchive(onProgress?: DemoDownloadProgress, signal?: AbortSignal): Promise<Blob> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new DemoProjectError('offline', 'The browser is offline and no demo archive is cached.');
  }

  let response: Response;
  try {
    response = await fetch(DEMO_PROJECT_URL, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DemoProjectError(
      'network',
      `Could not reach the demo project host: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new DemoProjectError('http', `The demo project download failed (HTTP ${response.status}).`);
  }

  const total = Number(response.headers.get('content-length')) || DEMO_PROJECT_BYTES;
  let blob: Blob;
  if (!response.body) {
    blob = await response.blob();
  } else {
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
    blob = new Blob(chunks, { type: 'application/zip' });
  }

  if (blob.size !== DEMO_PROJECT_BYTES || !(await isZip(blob))) {
    throw new DemoProjectError('integrity', 'The downloaded demo project is incomplete or not a .mnproj archive.');
  }

  const buffer = await blob.arrayBuffer();
  if (!(await matchesHash(buffer))) {
    throw new DemoProjectError('integrity', 'The downloaded demo project did not pass its checksum check.');
  }

  onProgress?.(blob.size, blob.size);
  await writeCachedArchive(blob);
  return blob;
}

/**
 * Fetch the demo archive: cached copy first, otherwise download and verify it.
 * Throws `DemoProjectError` for offline, network, HTTP and integrity failures.
 */
export async function fetchDemoProject(
  onProgress?: DemoDownloadProgress,
  signal?: AbortSignal,
): Promise<File> {
  const cached = await readCachedArchive();
  if (cached) {
    onProgress?.(cached.size, cached.size);
    return new File([cached], DEMO_PROJECT_NAME, { type: 'application/zip' });
  }

  const blob = await downloadArchive(onProgress, signal);
  return new File([blob], DEMO_PROJECT_NAME, { type: 'application/zip' });
}
