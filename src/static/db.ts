/**
 * Minimal IndexedDB layer for the static edition.
 *
 * The server edition keeps everything on disk; the online edition mirrors the same
 * shape (library metadata, page documents, page images) inside the browser so the
 * rest of the UI keeps working unchanged.
 */

const DB_NAME = 'komayomi-online';
const DB_VERSION = 1;

export const STORE_KV = 'kv';
export const STORE_PAGES = 'pages';
export const STORE_IMAGES = 'images';

export type ImageRecord = {
  /** `${volume}/${chapter}/${pageIndex}/${lang}` */
  key: string;
  volume: string;
  chapter: string;
  pageIndex: number;
  lang: string;
  name: string;
  mime: string;
  size: number;
  blob: Blob;
};

export type ImageIndexEntry = Omit<ImageRecord, 'blob'>;

export type ProjectMeta = {
  projectName: string;
  storageMode: 'reference' | 'packaged';
  importedAt: string;
  sourceFile?: string;
  note?: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_PAGES)) db.createObjectStore(STORE_PAGES);
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        const store = db.createObjectStore(STORE_IMAGES, { keyPath: 'key' });
        store.createIndex('byPage', ['volume', 'chapter', 'pageIndex']);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is not available in this browser.'));
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return wrap(db.transaction(STORE_KV, 'readonly').objectStore(STORE_KV).get(key) as IDBRequest<T | undefined>);
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_KV, 'readwrite');
  tx.objectStore(STORE_KV).put(value, key);
  await done(tx);
}

export async function kvDel(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_KV, 'readwrite');
  tx.objectStore(STORE_KV).delete(key);
  await done(tx);
}

export async function getPage<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return wrap(db.transaction(STORE_PAGES, 'readonly').objectStore(STORE_PAGES).get(key) as IDBRequest<T | undefined>);
}

export async function putPage<T>(key: string, doc: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_PAGES, 'readwrite');
  tx.objectStore(STORE_PAGES).put(doc, key);
  await done(tx);
}

export async function deletePage(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_PAGES, 'readwrite');
  tx.objectStore(STORE_PAGES).delete(key);
  await done(tx);
}

export async function allPageKeys(): Promise<string[]> {
  const db = await openDb();
  return (await wrap(db.transaction(STORE_PAGES, 'readonly').objectStore(STORE_PAGES).getAllKeys())) as string[];
}

export async function allPageDocs<T>(): Promise<T[]> {
  const db = await openDb();
  return wrap(db.transaction(STORE_PAGES, 'readonly').objectStore(STORE_PAGES).getAll() as IDBRequest<T[]>);
}

export async function putImage(record: ImageRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_IMAGES, 'readwrite');
  tx.objectStore(STORE_IMAGES).put(record);
  await done(tx);
}

export async function putImages(records: ImageRecord[]): Promise<void> {
  if (!records.length) return;
  const db = await openDb();
  const tx = db.transaction(STORE_IMAGES, 'readwrite');
  const store = tx.objectStore(STORE_IMAGES);
  for (const record of records) store.put(record);
  await done(tx);
}

export async function getImage(key: string): Promise<ImageRecord | undefined> {
  const db = await openDb();
  return wrap(db.transaction(STORE_IMAGES, 'readonly').objectStore(STORE_IMAGES).get(key) as IDBRequest<
    ImageRecord | undefined
  >);
}

export async function allImages(): Promise<ImageRecord[]> {
  const db = await openDb();
  return wrap(db.transaction(STORE_IMAGES, 'readonly').objectStore(STORE_IMAGES).getAll() as IDBRequest<ImageRecord[]>);
}

export async function allImageIndex(): Promise<ImageIndexEntry[]> {
  const db = await openDb();
  const records = await wrap(
    db.transaction(STORE_IMAGES, 'readonly').objectStore(STORE_IMAGES).getAll() as IDBRequest<ImageRecord[]>,
  );
  return records.map(({ blob: _blob, ...rest }) => rest);
}

export async function clearAll(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_KV, STORE_PAGES, STORE_IMAGES], 'readwrite');
  tx.objectStore(STORE_KV).clear();
  tx.objectStore(STORE_PAGES).clear();
  tx.objectStore(STORE_IMAGES).clear();
  await done(tx);
}

export async function hasWorkspace(): Promise<boolean> {
  return Boolean(await kvGet<ProjectMeta>('project'));
}
