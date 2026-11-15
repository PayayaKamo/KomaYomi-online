import { strToU8, unzip, zipSync } from 'fflate';
import type { PageDoc, Lang, Library, PageEntry, ReadingDirection, VolumeEntry, PageKind } from '../../shared/types.ts';
import { PAGE_KINDS } from '../../shared/types.ts';
import { migrateManifestV0, migratePageV0 } from '../../shared/migrations.ts';
import { readReadingDirection } from '../../shared/format.ts';
import {
  allImageIndex,
  allPageKeys,
  clearAll,
  getImage,
  getPage,
  kvDel,
  kvGet,
  kvSet,
  putImage,
  putPage,
  type ImageIndexEntry,
  type ImageRecord,
  type ProjectMeta,
} from './db.ts';

const ALL_LANGS: Lang[] = ['ja', 'zh', 'en'];

/** Keys used in the IndexedDB `kv` store. */
const KEY_PROJECT = 'project';
const KEY_LANG_ORDER = 'langOrder';
const KEY_LIBRARY = 'library-cache';

export type LibraryConfig = {
  volumes?: Record<
    string,
    {
      title?: string;
      dirs?: Partial<Record<Lang, string>>;
      defaultDirection?: ReadingDirection;
      chapters?: Record<
        string,
        { title?: string; order?: number[]; excluded?: number[]; kinds?: Record<string, string> }
      >;
    }
  >;
  langOrder?: Lang[];
};

type ManifestImage = {
  volume: string;
  chapter: string;
  pageIndex: number;
  lang: string;
  name: string;
  sha1?: string;
  size?: number;
  path?: string;
  asset?: string;
};

type ManifestInventoryVolume = {
  volume: string;
  languages?: string[];
  langDirs?: Record<string, string>;
  chapters?: { chapter: string; pages?: number; images?: number }[];
};

export type ProjectManifest = {
  schemaVersion: number;
  storageMode: 'reference' | 'packaged';
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  appVersion?: string;
  language?: { volumes?: Record<string, Record<string, string>>; resolved?: Record<string, Record<string, string>> };
  inventory: { volumes: ManifestInventoryVolume[]; images: ManifestImage[]; pageCount?: number };
};

export type ImportProgress = (phase: 'read' | 'pages' | 'images', done: number, total: number) => void;

export type ImportResult = {
  meta: ProjectMeta;
  library: Library;
  warnings: string[];
  pages: number;
  images: number;
  missingImages: number;
};

export type ImportOptions = {
  /** Extra image files picked from disk, used to fill in reference-mode projects. */
  imageFiles?: File[];
  onProgress?: ImportProgress;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

const extOf = (name: string) => {
  const match = name.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : 'bin';
};

const mimeOf = (name: string) => {
  switch (extOf(name)) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
};

export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const ax = a.match(re) ?? [];
  const bx = b.match(re) ?? [];
  const len = Math.min(ax.length, bx.length);
  for (let i = 0; i < len; i += 1) {
    const av = ax[i];
    const bv = bx[i];
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) {
      const d = parseInt(av, 10) - parseInt(bv, 10);
      if (d !== 0) return d;
    } else if (av !== bv) {
      return av.localeCompare(bv, 'zh-Hans-CN');
    }
  }
  return ax.length - bx.length;
}

export function normalizeLangOrder(value: Lang[] | undefined, discovered: readonly Lang[] = ALL_LANGS): Lang[] {
  const known = new Set(discovered);
  const out: Lang[] = [];
  for (const lang of value ?? []) {
    if (typeof lang === 'string' && known.has(lang) && !out.includes(lang)) out.push(lang);
  }
  for (const lang of discovered) if (!out.includes(lang)) out.push(lang);
  return out;
}

export type PageKeyParts = { volume: string; chapter: string; pageIndex: number };

export function parsePageKey(key: string): PageKeyParts | null {
  const parts = key.split('/');
  if (parts.length < 3) return null;
  const pageIndex = Number(parts[parts.length - 1]);
  if (!Number.isFinite(pageIndex)) return null;
  return {
    volume: parts.slice(0, -2).join('/'),
    chapter: parts[parts.length - 2],
    pageIndex,
  };
}

export function pageKey(volume: string, chapter: string, pageIndex: number): string {
  return `${volume}/${chapter}/${pageIndex}`;
}

/* ------------------------------------------------------------------ */
/* Object URLs                                                          */
/* ------------------------------------------------------------------ */

const urlCache = new Map<string, string>();

function imageKey(entry: { volume: string; chapter: string; pageIndex: number; lang: string }): string {
  return `${entry.volume}/${entry.chapter}/${entry.pageIndex}/${entry.lang}`;
}

async function imageUrl(entry: ImageIndexEntry): Promise<string | undefined> {
  const key = imageKey(entry);
  const cached = urlCache.get(key);
  if (cached) return cached;
  const record = await getImage(key);
  if (!record) return undefined;
  const url = URL.createObjectURL(record.blob);
  urlCache.set(key, url);
  return url;
}

export function releaseImageUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

/* ------------------------------------------------------------------ */
/* Workspace state                                                      */
/* ------------------------------------------------------------------ */

let cachedMeta: ProjectMeta | null = null;
let cachedLibrary: Library | null = null;

export async function readMeta(): Promise<ProjectMeta | null> {
  if (cachedMeta) return cachedMeta;
  cachedMeta = (await kvGet<ProjectMeta>(KEY_PROJECT)) ?? null;
  return cachedMeta;
}

export async function loadLibrary(): Promise<Library | null> {
  if (cachedLibrary) return cachedLibrary;
  const meta = await readMeta();
  if (!meta) return null;
  const raw = await kvGet<{ library: Library }>(KEY_LIBRARY);
  if (!raw) return null;
  const [imageIndex, annotatedKeys] = await Promise.all([allImageIndex(), allPageKeys()]);
  const annotated = new Set(annotatedKeys);
  const langOrder = normalizeLangOrder((await kvGet<Lang[]>(KEY_LANG_ORDER)) ?? raw.library.langOrder);
  const byPage = new Map<string, ImageIndexEntry[]>();
  for (const entry of imageIndex) {
    const id = `${entry.volume}/${entry.chapter}/${entry.pageIndex}`;
    const list = byPage.get(id) ?? [];
    list.push(entry);
    byPage.set(id, list);
  }

  const volumes: VolumeEntry[] = [];
  for (const volume of raw.library.volumes) {
    const chapters = [];
    for (const chapter of volume.chapters) {
      const pages: PageEntry[] = [];
      for (const page of chapter.pages) {
        const files: Partial<Record<Lang, string>> = {};
        const filenames: Partial<Record<Lang, string>> = {};
        const entries = byPage.get(pageKey(volume.id, chapter.chapter, page.index)) ?? [];
        for (const entry of entries) {
          const lang = entry.lang as Lang;
          const url = await imageUrl(entry);
          if (url) {
            files[lang] = url;
            filenames[lang] = entry.name;
          }
        }
        const warnings: string[] = [];
        for (const lang of volume.languages) {
          if (files[lang]) continue;
          if (entries.some((entry) => entry.lang === lang)) {
            warnings.push(`Page ${page.index + 1} has no image for language "${lang}".`);
          }
        }
        pages.push({
          ...page,
          files,
          filenames,
          warnings,
          annotated: annotated.has(pageKey(volume.id, chapter.chapter, page.index)),
        });
      }
      chapters.push({ ...chapter, pages });
    }
    volumes.push({ ...volume, chapters });
  }

  cachedLibrary = { ...raw.library, root: meta.projectName, langOrder, volumes };
  return cachedLibrary;
}

export function invalidateWorkspace(): void {
  cachedMeta = null;
  cachedLibrary = null;
  releaseImageUrls();
}

export async function getWorkspaceSummary(): Promise<{
  meta: ProjectMeta;
  volumes: number;
  chapters: number;
  pages: number;
  images: number;
  annotated: number;
} | null> {
  const meta = await readMeta();
  if (!meta) return null;
  const library = await loadLibrary();
  if (!library) return null;
  const [images, annotated] = await Promise.all([allImageIndex(), allPageKeys()]);
  return {
    meta,
    volumes: library.volumes.length,
    chapters: library.volumes.reduce((sum, vol) => sum + vol.chapters.length, 0),
    pages: library.volumes.reduce(
      (sum, vol) => sum + vol.chapters.reduce((inner, chapter) => inner + chapter.pages.length, 0),
      0,
    ),
    images: images.length,
    annotated: annotated.length,
  };
}

/* ------------------------------------------------------------------ */
/* Library configuration                                                */
/* ------------------------------------------------------------------ */

export async function saveLangOrder(langOrder: Lang[]): Promise<void> {
  await kvSet(KEY_LANG_ORDER, langOrder);
  if (cachedLibrary) cachedLibrary = { ...cachedLibrary, langOrder };
}

/* ------------------------------------------------------------------ */
/* Page documents                                                       */
/* ------------------------------------------------------------------ */

export function createDefaultDoc(
  volume: string,
  chapter: string,
  pageIndex: number,
  direction: ReadingDirection = 'rtl',
): PageDoc {
  return {
    schemaVersion: 1,
    volume,
    chapter,
    pageIndex,
    panels: [],
    notes: [],
    offsets: {},
    alignMode: 'page',
    panelOffsets: {},
    readingDirection: direction,
    updatedAt: new Date().toISOString(),
  };
}

export async function readPageDoc(parts: PageKeyParts): Promise<PageDoc | undefined> {
  return getPage<PageDoc>(pageKey(parts.volume, parts.chapter, parts.pageIndex));
}

export async function writePageDoc(doc: PageDoc): Promise<void> {
  await putPage(pageKey(doc.volume, doc.chapter, doc.pageIndex), doc);
  if (cachedLibrary) {
    for (const volume of cachedLibrary.volumes) {
      if (volume.id !== doc.volume) continue;
      for (const chapter of volume.chapters) {
        if (chapter.chapter !== doc.chapter) continue;
        for (const page of chapter.pages) {
          if (page.index === doc.pageIndex) page.annotated = true;
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Import                                                               */
/* ------------------------------------------------------------------ */

function normalizeManifest(raw: unknown): { manifest: ProjectManifest; migrated: boolean } {
  if (!isRecord(raw)) throw new Error('manifest.json is missing or not a JSON object.');
  const version = Number(raw.schemaVersion) || 0;
  const base = version < 1 ? migrateManifestV0(raw) : raw;
  if (!isRecord(base.inventory)) throw new Error('manifest.json has no inventory. This is not a KomaYomi project.');
  const manifest = base as unknown as ProjectManifest;
  manifest.storageMode = manifest.storageMode === 'packaged' ? 'packaged' : 'reference';
  manifest.schemaVersion = 1;
  manifest.inventory.images = Array.isArray(manifest.inventory.images) ? manifest.inventory.images : [];
  manifest.inventory.volumes = Array.isArray(manifest.inventory.volumes) ? manifest.inventory.volumes : [];
  manifest.language = isRecord(manifest.language) ? manifest.language : { volumes: {}, resolved: {} };
  for (const image of manifest.inventory.images) {
    image.volume = String(image.volume ?? '');
    image.chapter = String(image.chapter ?? '');
    image.pageIndex = Number(image.pageIndex) || 0;
    image.lang = String(image.lang ?? 'ja');
    image.name = String(image.name ?? '');
    if (image.path) image.path = normalizePath(String(image.path));
  }
  return { manifest, migrated: version < 1 };
}

function readConfig(files: Record<string, Uint8Array>): LibraryConfig {
  const entry = files['config/library.json'];
  if (!entry) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(entry));
    if (isRecord(parsed) && isRecord(parsed.data)) return parsed.data as LibraryConfig;
    return isRecord(parsed) ? (parsed as LibraryConfig) : {};
  } catch {
    return {};
  }
}

function pickImageFile(
  image: ManifestImage,
  byPath: Map<string, File>,
  byName: Map<string, File[]>,
): File | undefined {
  const wanted = image.path ? normalizePath(image.path) : '';
  if (wanted) {
    for (const [path, file] of byPath) {
      if (path === wanted || path.endsWith(`/${wanted}`)) return file;
    }
  }
  const candidates = byName.get(image.name.toLowerCase()) ?? [];
  if (candidates.length === 1) return candidates[0];
  if (image.size) {
    const sized = candidates.find((file) => file.size === image.size);
    if (sized) return sized;
  }
  return candidates[0];
}

export async function importProjectFile(file: File, options: ImportOptions = {}): Promise<ImportResult> {
  const progress = options.onProgress ?? (() => undefined);
  progress('read', 0, 1);
  const buffer = new Uint8Array(await file.arrayBuffer());
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(buffer, (error, data) => (error ? reject(new Error(`Could not read the project archive: ${error.message}`)) : resolve(data)));
  });
  const manifestEntry = files['manifest.json'];
  if (!manifestEntry) throw new Error('manifest.json is missing. This file is not a KomaYomi project (.mnproj).');
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(new TextDecoder().decode(manifestEntry));
  } catch {
    throw new Error('manifest.json is not valid JSON.');
  }
  const { manifest } = normalizeManifest(manifestRaw);
  const config = readConfig(files);
  const warnings: string[] = [];
  if (manifest.storageMode === 'reference') {
    warnings.push(
      'This is a reference project: images live in the original folder. Pick that folder during import to attach them.',
    );
  }

  const pageEntries = Object.keys(files).filter((name) => name.startsWith('pages/') && name.endsWith('.json'));
  const pageDocs: PageDoc[] = [];
  for (const name of pageEntries) {
    const rel = name.slice('pages/'.length, -'.json'.length);
    const parts = rel.split('/');
    const pageIndex = Number(parts[parts.length - 1]);
    if (!Number.isFinite(pageIndex)) {
      warnings.push(`Skipped page JSON with an invalid index: ${name}`);
      continue;
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(files[name])) as Record<string, unknown>;
      const normalized = Number(parsed.schemaVersion) >= 1 ? parsed : migratePageV0(parsed);
      const doc = normalized as unknown as PageDoc;
      doc.schemaVersion = 1;
      doc.volume = doc.volume || parts.slice(0, -2).join('/');
      doc.chapter = doc.chapter || (parts.length >= 2 ? parts[parts.length - 2] : '');
      doc.pageIndex = pageIndex;
      doc.panels = Array.isArray(doc.panels) ? doc.panels : [];
      doc.notes = Array.isArray(doc.notes) ? doc.notes : [];
      pageDocs.push(doc);
    } catch {
      warnings.push(`Skipped invalid page JSON: ${name}`);
    }
  }

  const imageFiles = options.imageFiles ?? [];
  const byPath = new Map<string, File>();
  const byName = new Map<string, File[]>();
  for (const picked of imageFiles) {
    const rel = normalizePath((picked as File & { webkitRelativePath?: string }).webkitRelativePath || picked.name);
    byPath.set(rel, picked);
    const list = byName.get(picked.name.toLowerCase()) ?? [];
    list.push(picked);
    byName.set(picked.name.toLowerCase(), list);
  }

  const records: ImageRecord[] = [];
  const missing: string[] = [];
  let done = 0;
  for (const image of manifest.inventory.images) {
    const key = `${image.volume}/${image.chapter}/${image.pageIndex}/${image.lang}`;
    let blob: Blob | undefined;
    if (manifest.storageMode === 'packaged' && image.asset) {
      const asset = files[image.asset] ?? files[`assets/${image.asset}`];
      if (asset) blob = new Blob([asset as BlobPart], { type: mimeOf(image.asset) });
    }
    if (!blob) {
      const picked = pickImageFile(image, byPath, byName);
      if (picked) {
        const type = picked.type || mimeOf(picked.name);
        blob = picked.type === type ? picked : picked.slice(0, picked.size, type);
      }
    }
    if (!blob) {
      missing.push(`${image.volume}/${image.chapter}/${image.name}`);
      continue;
    }
    records.push({
      key,
      volume: image.volume,
      chapter: image.chapter,
      pageIndex: image.pageIndex,
      lang: image.lang,
      name: image.name,
      mime: blob.type || mimeOf(image.name),
      size: blob.size,
      blob,
    });
    done += 1;
    if (done % 8 === 0) progress('images', done, manifest.inventory.images.length);
  }
  if (missing.length) {
    warnings.push(
      `${missing.length} image${missing.length === 1 ? '' : 's'} could not be found. Affected pages show a missing-image placeholder.`,
    );
  }

  // Rebuilding from scratch keeps the workspace consistent with the opened project.
  await clearAll();
  for (const doc of pageDocs) await putPage(pageKey(doc.volume, doc.chapter, doc.pageIndex), doc);
  for (const record of records) await putImage(record);
  progress('images', records.length, manifest.inventory.images.length);

  const meta: ProjectMeta = {
    projectName: manifest.name?.trim() || file.name.replace(/\.mnproj$/i, ''),
    storageMode: manifest.storageMode,
    importedAt: new Date().toISOString(),
    sourceFile: file.name,
    note: manifest.createdAt ? `Project created ${manifest.createdAt.slice(0, 10)}` : undefined,
  };

  const library = buildLibrary(manifest, config, records);
  await kvSet(KEY_PROJECT, meta);
  await kvSet(KEY_LIBRARY, { library });
  await kvDel(KEY_LANG_ORDER);
  cachedMeta = meta;
  // `buildLibrary` already created the object URLs, so keep its cache warm.
  cachedLibrary = null;

  return {
    meta,
    library,
    warnings,
    pages: pageDocs.length,
    images: records.length,
    missingImages: missing.length,
  };
}

function buildLibrary(manifest: ProjectManifest, config: LibraryConfig, records: ImageRecord[]): Library {
  const imageMap = new Map<string, ImageRecord>();
  for (const record of records) imageMap.set(record.key, record);

  const discovered = new Set<Lang>();
  const manifestVolumes = new Map(manifest.inventory.volumes.map((volume) => [volume.volume, volume]));
  const imagesByVolume = new Map<string, ManifestImage[]>();
  for (const image of manifest.inventory.images) {
    const list = imagesByVolume.get(image.volume) ?? [];
    list.push(image);
    imagesByVolume.set(image.volume, list);
    discovered.add(image.lang as Lang);
  }

  const volumeIds = [...new Set([...manifestVolumes.keys(), ...imagesByVolume.keys()])].sort(naturalCompare);
  const volumes: VolumeEntry[] = [];

  for (const volumeId of volumeIds) {
    const inventoryVolume = manifestVolumes.get(volumeId);
    const override = config.volumes?.[volumeId] ?? {};
    const images = imagesByVolume.get(volumeId) ?? [];
    const langDirs: Partial<Record<Lang, string>> = {
      ...(inventoryVolume?.langDirs as Partial<Record<Lang, string>> | undefined),
      ...(manifest.language?.volumes?.[volumeId] as Partial<Record<Lang, string>> | undefined),
      ...(override.dirs ?? {}),
    };
    const langs = new Set<Lang>();
    for (const lang of inventoryVolume?.languages ?? []) langs.add(lang as Lang);
    for (const lang of Object.keys(langDirs)) langs.add(lang as Lang);
    for (const image of images) langs.add(image.lang as Lang);
    const languages = [...langs].sort((a, b) => {
      const ia = ALL_LANGS.indexOf(a);
      const ib = ALL_LANGS.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return naturalCompare(a, b);
    });
    for (const lang of languages) discovered.add(lang);

    const chapterIds = new Set<string>();
    for (const chapter of inventoryVolume?.chapters ?? []) chapterIds.add(chapter.chapter);
    for (const image of images) chapterIds.add(image.chapter);

    const chapters = [...chapterIds].sort(naturalCompare).map((chapterId) => {
      const chapterOverride = override.chapters?.[chapterId] ?? {};
      const chapterImages = images.filter((image) => image.chapter === chapterId);
      const declaredPages = inventoryVolume?.chapters?.find((item) => item.chapter === chapterId)?.pages ?? 0;
      const maxPage = Math.max(
        declaredPages - 1,
        chapterImages.reduce((max, image) => Math.max(max, image.pageIndex), -1),
      );
      const pages: PageEntry[] = [];
      for (let index = 0; index <= maxPage; index += 1) {
        const files: Partial<Record<Lang, string>> = {};
        const filenames: Partial<Record<Lang, string>> = {};
        const warnings: string[] = [];
        for (const lang of languages) {
          const record = imageMap.get(`${volumeId}/${chapterId}/${index}/${lang}`);
          if (!record) {
            if (chapterImages.some((image) => image.lang === lang)) {
              warnings.push(`Page ${index + 1} has no image for language "${lang}".`);
            }
            continue;
          }
          files[lang] = URL.createObjectURL(record.blob);
          urlCache.set(record.key, files[lang]!);
          filenames[lang] = record.name;
        }
        pages.push({ index, files, filenames, warnings, annotated: false });
      }
      const excluded = new Set(chapterOverride.excluded ?? []);
      const ordered = chapterOverride.order?.length
        ? [
            ...chapterOverride.order
              .map((index) => pages.find((page) => page.index === index))
              .filter((page): page is PageEntry => Boolean(page)),
            ...pages.filter((page) => !chapterOverride.order!.includes(page.index)),
          ]
        : pages;
      return {
        id: `${volumeId}/${chapterId}`,
        volume: volumeId,
        chapter: chapterId,
        title: chapterOverride.title?.trim() || undefined,
        pages: ordered.map((page) => {
          const kind = chapterOverride.kinds?.[String(page.index)];
          return {
            ...page,
            excluded: excluded.has(page.index) || undefined,
            kind: kind && (PAGE_KINDS as readonly string[]).includes(kind) ? (kind as PageKind) : undefined,
          };
        }),
        warnings: [],
      };
    });

    volumes.push({
      id: volumeId,
      title: override.title?.trim() || volumeId,
      chapters,
      warnings: [],
      langDirs,
      languages,
      dirs: [...new Set(Object.values(langDirs).filter((dir): dir is string => Boolean(dir)))],
      defaultDirection: readReadingDirection(override.defaultDirection),
    });
  }

  const langOrder = normalizeLangOrder(config.langOrder, [...discovered]);
  return { root: 'browser', languages: langOrder, langOrder, volumes };
}

/* ------------------------------------------------------------------ */
/* Export                                                               */
/* ------------------------------------------------------------------ */

export type ExportProjectOptions = {
  name?: string;
  storageMode?: 'reference' | 'packaged';
  onProgress?: ImportProgress;
};

export async function buildProjectArchive(options: ExportProjectOptions = {}): Promise<{ blob: Blob; name: string }> {
  const meta = await readMeta();
  const library = await loadLibrary();
  if (!meta || !library) throw new Error('There is no project opened in this browser yet.');
  const images = await allImageIndex();
  const pageKeys = await allPageKeys();
  const name = options.name?.trim() || meta.projectName;
  const storageMode = options.storageMode ?? (images.length ? 'packaged' : 'reference');
  const entries: Record<string, Uint8Array> = {};

  const language: Record<string, Record<string, string>> = {};
  const inventoryVolumes: ManifestInventoryVolume[] = [];
  const inventoryImages: ManifestImage[] = [];

  for (const volume of library.volumes) {
    const langDirs = { ...(volume.langDirs as Record<string, string>) };
    for (const lang of volume.languages) {
      if (!langDirs[lang]) langDirs[lang] = lang;
    }
    language[volume.id] = langDirs;
    inventoryVolumes.push({
      volume: volume.id,
      languages: volume.languages,
      langDirs,
      chapters: volume.chapters.map((chapter) => ({
        chapter: chapter.chapter,
        pages: chapter.pages.reduce((max, page) => Math.max(max, page.index + 1), 0),
        images: chapter.pages.length,
      })),
    });
    for (const chapter of volume.chapters) {
      for (const page of chapter.pages) {
        for (const lang of volume.languages) {
          const filename = page.filenames[lang];
          if (!filename) continue;
          const index = images.find(
            (image) =>
              image.volume === volume.id &&
              image.chapter === chapter.chapter &&
              image.pageIndex === page.index &&
              image.lang === lang,
          );
          const image: ManifestImage = {
            volume: volume.id,
            chapter: chapter.chapter,
            pageIndex: page.index,
            lang,
            name: filename,
            sha1: '',
            size: index?.size ?? 0,
            path: `${volume.id}/${langDirs[lang] ?? lang}/${chapter.chapter}/${filename}`,
          };
          if (storageMode === 'packaged') {
            const record = await getImage(`${volume.id}/${chapter.chapter}/${page.index}/${lang}`);
            if (record) {
              const asset = `assets/${volume.id}-${chapter.chapter}-${page.index}-${lang}.${extOf(filename)}`;
              image.asset = asset;
              entries[asset] = new Uint8Array(await record.blob.arrayBuffer());
            }
          }
          inventoryImages.push(image);
        }
      }
    }
  }

  for (const key of pageKeys) {
    const doc = await getPage<PageDoc>(key);
    if (!doc) continue;
    entries[`pages/${key}.json`] = strToU8(JSON.stringify(doc, null, 2));
  }

  const manifest: ProjectManifest = {
    schemaVersion: 1,
    appVersion: '0.1.0-online',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    storageMode,
    name,
    language: { volumes: language, resolved: language },
    inventory: { volumes: inventoryVolumes, images: inventoryImages, pageCount: pageKeys.length },
  };
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  const zipped = zipSync(entries, { level: 6 });
  return { blob: new Blob([zipped as BlobPart], { type: 'application/zip' }), name: `${name}.mnproj` };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
