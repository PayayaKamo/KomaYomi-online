import type {
  AlignPreset,
  DetectResult,
  DirPreview,
  DirRule,
  ChapterOverride,
  ExportConfig,
  ExportTemplate,
  Lang,
  LayoutScope,
  LayoutTemplate,
  Library,
  PageDoc,
  PageResponse,
  PanelTemplate,
  PanelRect,
  ReadingDirection,
  CacheStats,
  StorageConfig,
  StorageStatus,
} from './types';
import { DEFAULT_EXPORT_CONFIG, PAGE_KINDS } from './types';
import { CURRENT_SCHEMA_VERSION } from '../shared/format.ts';
import { t } from './i18n';
import { sortPanels } from './lib/geometry';
import { isReadOnly } from './lib/appMode';
import { kvGet, kvSet, allPageDocs, getPage, type ProjectMeta } from './static/db';
import {
  buildProjectArchive,
  createDefaultDoc,
  downloadBlob,
  getWorkspaceSummary,
  importProjectFile,
  loadLibrary,
  normalizeLangOrder,
  pageKey,
  readMeta,
  readPageDoc,
  releaseImageUrls,
  saveLangOrder,
  writePageDoc,
  type ImportOptions,
  type ImportResult,
} from './static/projectStore';
import { exportHtml } from './static/exportHtml';

/* ---- page version history (cross-session) ---- */
export type HistorySource =
  'auto' | 'manual' | 'batch' | 'template' | 'align' | 'annotation' | 'import' | 'restore' | 'detect';

export type HistoryDiff = {
  panels: number;
  panelsDelta: number;
  added: number;
  removed: number;
  moved: number;
  resized: number;
  annotations: number;
  annotationsDelta: number;
  notes: number;
  notesDelta: number;
};

export type PageVersion = {
  id: string;
  at: string;
  source: HistorySource;
  summary: string;
  diff: HistoryDiff;
  editCount: number;
  panelCount: number;
  annotationCount: number;
  noteCount: number;
  panels: { id: string; rect: PanelRect }[];
};

export type PageVersionList = { entries: PageVersion[]; limit: number };

export type NotesIndex = {
  total: number;
  notes: {
    volume: string;
    chapter: string;
    pageIndex: number;
    id: string;
    scope: 'page' | 'panel';
    panelId: string | null;
    panelNo: number | null;
    text: string;
    excerpt: string;
    tags: string[];
    source?: { title?: string; url?: string; text?: string };
    domain: string;
    createdAt: string;
    updatedAt: string;
  }[];
  chapters: { volume: string; chapter: string; count: number }[];
  tags: { tag: string; count: number }[];
  sources: { domain: string; count: number }[];
  pages: number;
};

/* ---- Project file .mnproj ---- */
export type ProjectMode = 'reference' | 'packaged';
export type ProjectConflict = 'overwrite' | 'merge' | 'skip';

export type ProjectInspect = {
  name?: string;
  schemaVersion: number;
  migratedFrom?: number;
  appVersion: string;
  storageMode: ProjectMode;
  createdAt: string;
  updatedAt: string;
  size: number;
  pages: number;
  notes: number;
  annotations: number;
  volumes: string[];
  chapters: number;
  images: number;
  templates: number;
  presets: number;
  conflicts: { name: string; kind: 'page' | 'template' | 'preset' | 'config' }[];
  conflictCount: number;
  missingAssets: { volume: string; chapter: string; pageIndex: number; lang: Lang; name: string }[];
  warnings: string[];
};

export type ProjectImport = {
  storageMode: ProjectMode;
  restored: number;
  merged: number;
  skipped: number;
  conflicts: number;
  imagesWritten: number;
  imagesPresent: number;
  relinked: number;
  missing: { volume: string; chapter: string; pageIndex: number; lang: Lang; name: string; reason: string }[];
  snapshot: string | null;
  projectBackup: string;
  migratedFrom?: number;
  warnings: string[];
  library: Library;
};

/* ---- Scheduled local backups ---- */
export type AutoBackupConfig = { enabled: boolean; intervalHours: number; keep: number };
export type AutoBackupState = { lastRunAt?: string; lastFile?: string; lastSize?: number; lastError?: string };
export type AutoBackupFile = { name: string; size: number; at: string };
export type BackupSchedule = { config: AutoBackupConfig; state: AutoBackupState; files: AutoBackupFile[] };

export const ONLINE_EDITION = true;

export class OnlineUnsupportedError extends Error {
  code = 'ERR_ONLINE_UNSUPPORTED';
  constructor() {
    super(t('online.unsupported'));
    this.name = 'OnlineUnsupportedError';
  }
}

/** Reject with a message the UI can show; every caller already renders `error.message`. */
const unsupported = (): Promise<never> => Promise.reject(new OnlineUnsupportedError());

const isUnsupported = (error: unknown): boolean =>
  error instanceof OnlineUnsupportedError || (error as { code?: string } | null)?.code === 'ERR_ONLINE_UNSUPPORTED';

export { isUnsupported };

/* ------------------------------------------------------------------ */
/* Small local stores for templates and presets                         */
/* ------------------------------------------------------------------ */

const KEY_TEMPLATES = 'panelTemplates';
const KEY_PRESETS = 'alignPresets';
const KEY_LAYOUTS = 'layouts';
const KEY_EXPORT_TEMPLATES = 'exportTemplates';

/** Read mode is a viewer: reject project-data writes even if a UI path slips through. */
function assertWritable(): void {
  if (isReadOnly()) throw new Error(t('mode.readOnlyHint'));
}

async function listOf<T>(key: string): Promise<T[]> {
  return (await kvGet<T[]>(key)) ?? [];
}

async function saveList<T>(key: string, items: T[]): Promise<void> {
  assertWritable();
  await kvSet(key, items);
}

const nowIso = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ------------------------------------------------------------------ */
/* Page helpers                                                         */
/* ------------------------------------------------------------------ */

async function findPage(volume: string, chapter: string, index: number) {
  const library = await loadLibrary();
  const vol = library?.volumes.find((item) => item.id === volume);
  const chap = vol?.chapters.find((item) => item.chapter === chapter);
  return { library, vol, chap, page: chap?.pages.find((item) => item.index === index) };
}

async function ensureDoc(volume: string, chapter: string, index: number): Promise<PageDoc> {
  const existing = await readPageDoc({ volume, chapter, pageIndex: index });
  if (existing) return existing;
  const { vol } = await findPage(volume, chapter, index);
  return createDefaultDoc(volume, chapter, index, vol?.defaultDirection ?? 'rtl');
}

const sourceText = (source: { title?: string; url?: string; text?: string } | undefined): string =>
  [source?.title, source?.url, source?.text].filter(Boolean).join(' ');

function domainOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Static API                                                           */
/* ------------------------------------------------------------------ */

export const api = {
  library: async (): Promise<{ library: Library; root: string }> => {
    const library = await loadLibrary();
    if (library) return { library, root: library.root };
    return {
      library: { root: '', languages: ['ja', 'zh', 'en'], langOrder: ['ja', 'zh', 'en'], volumes: [] },
      root: '',
    };
  },

  health: async () => ({
    ok: true,
    app: 'KomaYomi Online',
    version: '0.1.0-online',
    author: 'KomaYomi contributors',
    license: 'MIT',
  }),

  /* ---- Library editing: needs the folder-scanning local edition ---- */
  addVolume: (_input: { sourcePath?: string; name?: string }) => unsupported(),
  removeVolume: (_volume: string) => unsupported(),
  saveVolumeDirs: (_volume: string, _dirs: Partial<Record<Lang, string | null>>) => unsupported(),

  saveLangOrder: async (order: Lang[] | null): Promise<{ langOrder: Lang[] }> => {
    assertWritable();
    const library = await loadLibrary();
    const discovered = library?.languages ?? ['ja', 'zh', 'en'];
    const langOrder = normalizeLangOrder(order ?? discovered, discovered);
    await saveLangOrder(langOrder);
    return { langOrder };
  },

  /* ---- Preprocessing wizard ---- */
  preprocessBackup: () => unsupported(),
  applyPreprocess: (_input: {
    volume: string;
    title?: string;
    chapters?: Record<string, ChapterOverride>;
    dirs?: Partial<Record<Lang, string | null>>;
  }) => unsupported(),
  restorePreprocess: (_volume: string) => unsupported(),

  /* ---- Directory recognition rules ---- */
  dirRules: (): Promise<{ rules: DirRule[]; defaults: DirRule[]; customized: boolean; warning?: string }> =>
    unsupported(),
  saveDirRules: (_rules: DirRule[]) => unsupported(),
  previewLibrary: (_input: { dir?: string; rules?: DirRule[] }): Promise<DirPreview> => unsupported(),
  fetchLinkTitle: (_url: string): Promise<{ title: string; warning?: string }> => unsupported(),

  /* ---- Backup / restore ---- */
  createBackup: () => unsupported(),
  inspectBackup: (_data: string) => unsupported(),
  restoreBackup: (_data: string) => unsupported(),
  backupSchedule: (): Promise<BackupSchedule> => unsupported(),
  saveBackupSchedule: (_config: AutoBackupConfig): Promise<BackupSchedule> => unsupported(),
  runBackupSchedule: () => unsupported(),

  /* ---- Storage providers ---- */
  storage: (): Promise<{ config: StorageConfig; cache: CacheStats }> => unsupported(),
  saveStorage: (_config: StorageConfig, _secrets?: Record<string, string | null>) => unsupported(),
  testStorage: (_id?: string): Promise<{ statuses: StorageStatus[] }> => unsupported(),
  syncStorage: () => unsupported(),
  clearStorageCache: (): Promise<{ removed: number; cache: CacheStats }> => unsupported(),
  backupToStorage: (_targetId?: string) => unsupported(),

  /* ---- Project file .mnproj ---- */
  exportProject: async (input: { mode: ProjectMode; name?: string; notes?: string }) => {
    const { blob, name } = await buildProjectArchive({ name: input.name, storageMode: input.mode });
    downloadBlob(blob, name);
    const summary = await getWorkspaceSummary();
    return {
      file: name,
      url: '',
      size: blob.size,
      entries: 0,
      storageMode: input.mode,
      name,
      manifest: {
        schemaVersion: CURRENT_SCHEMA_VERSION.mnproj,
        appVersion: '0.1.0-online',
        storageMode: input.mode,
        pageCount: summary?.pages ?? 0,
        images: summary?.images ?? 0,
        volumes: [],
        notes: input.notes ? { pages: 0, noteCount: 0, annotationCount: 0, text: input.notes } : undefined,
      },
      warnings: [],
    };
  },

  inspectProject: (_data: ArrayBuffer): Promise<ProjectInspect> => unsupported(),
  importProject: (_input: { data: ArrayBuffer; conflict: ProjectConflict; relinkDir?: string }): Promise<ProjectImport> =>
    unsupported(),

  /* ---- Pages ---- */
  page: async (volume: string, chapter: string, index: number): Promise<PageResponse> => {
    const found = await findPage(volume, chapter, index);
    if (!found.page) throw new Error(`Page ${volume}/${chapter}/${index + 1} is not part of this project.`);
    const existing = await readPageDoc({ volume, chapter, pageIndex: index });
    const doc = existing ?? createDefaultDoc(volume, chapter, index, found.vol?.defaultDirection ?? 'rtl');
    return {
      doc,
      page: found.page,
      chapterId: `${volume}/${chapter}`,
      volume,
      chapter,
      exists: Boolean(existing),
    };
  },

  savePage: async (doc: PageDoc, _source: HistorySource = 'auto'): Promise<{ doc: PageDoc }> => {
    assertWritable();
    await writePageDoc(doc);
    return { doc };
  },

  pageHistory: async (_volume: string, _chapter: string, _pageIndex: number): Promise<PageVersionList> => ({
    entries: [],
    limit: 0,
  }),
  restorePageVersion: async (_input: { volume: string; chapter: string; pageIndex: number; id: string }) =>
    unsupported(),
  setHistoryLimit: async (limit: number) => ({ limit }),

  detect: async (
    _volume: string,
    _chapter: string,
    _pageIndex: number,
    _lang?: string,
  ): Promise<DetectResult & { lang?: string }> => unsupported(),

  tags: async (): Promise<{ tags: { tag: string; count: number }[] }> => {
    const docs = await allPageDocs<PageDoc>();
    const counts = new Map<string, number>();
    for (const doc of docs) {
      for (const note of doc.notes ?? []) {
        for (const tag of note.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return { tags: [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count) };
  },

  notes: async (filter: {
    q?: string;
    tag?: string;
    source?: string;
    volume?: string;
    chapter?: string;
    pageIndex?: number;
    limit?: number;
  }): Promise<NotesIndex> => {
    const docs = await allPageDocs<PageDoc>();
    const query = filter.q?.trim().toLowerCase();
    const rows: NotesIndex['notes'] = [];
    const chapterCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    const sourceCounts = new Map<string, number>();
    for (const doc of docs) {
      if (filter.volume && doc.volume !== filter.volume) continue;
      if (filter.chapter && doc.chapter !== filter.chapter) continue;
      if (filter.pageIndex !== undefined && doc.pageIndex !== filter.pageIndex) continue;
      const ordered = sortPanels(doc.panels ?? [], doc.readingDirection);
      for (const note of doc.notes ?? []) {
        if (filter.tag && !(note.tags ?? []).includes(filter.tag)) continue;
        if (filter.source && domainOf(note.source?.url) !== filter.source) continue;
        if (query) {
          const haystack = `${note.text} ${sourceText(note.source)} ${(note.tags ?? []).join(' ')}`.toLowerCase();
          if (!haystack.includes(query)) continue;
        }
        const panelIndex = note.panelId ? ordered.findIndex((panel) => panel.id === note.panelId) : -1;
        const domain = domainOf(note.source?.url);
        rows.push({
          volume: doc.volume,
          chapter: doc.chapter,
          pageIndex: doc.pageIndex,
          id: note.id,
          scope: note.scope,
          panelId: note.panelId,
          panelNo: panelIndex >= 0 ? panelIndex + 1 : null,
          text: note.text,
          excerpt: note.text.replace(/\s+/g, ' ').slice(0, 120),
          tags: note.tags ?? [],
          source: note.source,
          domain,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        });
        const chapterKey = `${doc.volume}/${doc.chapter}`;
        chapterCounts.set(chapterKey, (chapterCounts.get(chapterKey) ?? 0) + 1);
        for (const tag of note.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        if (domain) sourceCounts.set(domain, (sourceCounts.get(domain) ?? 0) + 1);
      }
    }
    const limit = filter.limit ?? 200;
    return {
      total: rows.length,
      notes: rows.slice(0, limit),
      chapters: [...chapterCounts.entries()].map(([key, count]) => {
        const [volume, chapter] = key.split('/');
        return { volume, chapter, count };
      }),
      tags: [...tagCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count),
      sources: [...sourceCounts.entries()].map(([domain, count]) => ({ domain, count })),
      pages: new Set(docs.map((doc) => pageKey(doc.volume, doc.chapter, doc.pageIndex))).size,
    };
  },

  exportHtml: async (
    config: ExportConfig,
  ): Promise<{
    file: string;
    url: string;
    pages: number;
    warnings: string[];
    imageMode: 'files' | 'embed';
    assetDir?: string;
  }> => {
    const result = await exportHtml(config);
    return {
      file: result.filename,
      url: URL.createObjectURL(result.blob),
      pages: result.pages,
      warnings: result.warnings,
      imageMode: 'embed',
    };
  },

  exportDocx: (_config: ExportConfig): Promise<{
    file: string;
    url: string;
    pages: number;
    warnings: string[];
    imageMode: 'embed';
  }> => unsupported(),

  /* ---- Panel templates ---- */
  panelTemplates: async (): Promise<{ templates: PanelTemplate[] }> => ({ templates: await listOf(KEY_TEMPLATES) }),
  savePanelTemplate: async (input: {
    name: string;
    volume: string;
    chapter: string;
    panels: PanelRect[];
    readingDirection: ReadingDirection;
  }): Promise<{ template: PanelTemplate }> => {
    const template: PanelTemplate = {
      id: uid('pt'),
      name: input.name,
      volume: input.volume,
      chapter: input.chapter,
      panels: input.panels,
      readingDirection: input.readingDirection,
      createdAt: nowIso(),
    };
    const items = await listOf<PanelTemplate>(KEY_TEMPLATES);
    await saveList(KEY_TEMPLATES, [template, ...items.filter((item) => item.id !== template.id)]);
    return { template };
  },
  deletePanelTemplate: async (id: string): Promise<{ removed: boolean }> => {
    const items = await listOf<PanelTemplate>(KEY_TEMPLATES);
    const next = items.filter((item) => item.id !== id);
    await saveList(KEY_TEMPLATES, next);
    return { removed: next.length !== items.length };
  },
  applyPanelTemplate: async (
    templateId: string,
    volume: string,
    chapter: string,
    pageIndices?: number[],
  ): Promise<{ applied: number; droppedNotes: number }> => {
    assertWritable();
    const template = (await listOf<PanelTemplate>(KEY_TEMPLATES)).find((item) => item.id === templateId);
    if (!template) throw new Error('Template not found.');
    const found = await findPage(volume, chapter, 0);
    const pages = found.chap?.pages ?? [];
    const targets = pageIndices?.length ? pages.filter((page) => pageIndices.includes(page.index)) : pages;
    let applied = 0;
    let droppedNotes = 0;
    for (const page of targets) {
      const doc = await ensureDoc(volume, chapter, page.index);
      const panelIds = template.panels.map((rect, i) => ({
        id: `p${i + 1}`,
        rect,
        source: 'manual' as const,
      }));
      const keep = new Set(panelIds.map((panel) => panel.id));
      droppedNotes += (doc.notes ?? []).filter((note) => note.scope === 'panel' && !keep.has(note.panelId ?? ''))
        .length;
      await writePageDoc({
        ...doc,
        panels: panelIds,
        notes: (doc.notes ?? []).filter((note) => note.scope === 'page' || keep.has(note.panelId ?? '')),
        readingDirection: template.readingDirection,
        detectSource: 'template',
        updatedAt: nowIso(),
      });
      applied += 1;
    }
    return { applied, droppedNotes };
  },

  /* ---- Alignment presets ---- */
  alignPresets: async (): Promise<{ presets: AlignPreset[] }> => ({ presets: await listOf(KEY_PRESETS) }),
  saveAlignPreset: async (
    preset: Partial<AlignPreset> & { name: string; volume: string; chapter: string },
  ): Promise<{ preset: AlignPreset }> => {
    const saved: AlignPreset = {
      id: preset.id || uid('ap'),
      name: preset.name,
      scope: preset.scope === 'page' ? 'page' : 'chapter',
      volume: preset.volume,
      chapter: preset.chapter,
      mode: preset.mode ?? 'page',
      offsets: preset.offsets ?? {},
      panelOffsets: preset.panelOffsets ?? {},
      gridStep: preset.gridStep,
      createdAt: preset.createdAt ?? nowIso(),
    };
    const items = await listOf<AlignPreset>(KEY_PRESETS);
    await saveList(KEY_PRESETS, [saved, ...items.filter((item) => item.id !== saved.id)]);
    return { preset: saved };
  },
  deleteAlignPreset: async (id: string): Promise<{ removed: boolean }> => {
    const items = await listOf<AlignPreset>(KEY_PRESETS);
    const next = items.filter((item) => item.id !== id);
    await saveList(KEY_PRESETS, next);
    return { removed: next.length !== items.length };
  },
  applyAlignPreset: async (
    presetId: string,
    volume: string,
    chapter: string,
    pageIndices?: number[],
  ): Promise<{ applied: number }> => {
    assertWritable();
    const preset = (await listOf<AlignPreset>(KEY_PRESETS)).find((item) => item.id === presetId);
    if (!preset) throw new Error('Preset not found.');
    const found = await findPage(volume, chapter, 0);
    const pages = found.chap?.pages ?? [];
    const targets = pageIndices?.length ? pages.filter((page) => pageIndices.includes(page.index)) : pages;
    for (const page of targets) {
      const doc = await ensureDoc(volume, chapter, page.index);
      await writePageDoc({
        ...doc,
        alignMode: preset.mode,
        offsets: preset.offsets,
        panelOffsets: preset.panelOffsets,
        gridStep: preset.gridStep,
        updatedAt: nowIso(),
      });
    }
    return { applied: targets.length };
  },

  /* ---- Declarative layouts ---- */
  layouts: async (): Promise<{ layouts: LayoutTemplate[] }> => ({ layouts: await listOf(KEY_LAYOUTS) }),
  saveLayout: async (layout: Partial<LayoutTemplate>): Promise<{ layout: LayoutTemplate }> => {
    if (!layout.grid) throw new Error('A layout needs a grid.');
    const saved: LayoutTemplate = {
      ...layout,
      id: layout.id || uid('lt'),
      name: layout.name?.trim() || 'Layout',
      scope: layout.scope ?? 'page',
      volume: layout.volume ?? '',
      grid: layout.grid,
      createdAt: layout.createdAt ?? nowIso(),
    };
    const items = await listOf<LayoutTemplate>(KEY_LAYOUTS);
    await saveList(KEY_LAYOUTS, [saved, ...items.filter((item) => item.id !== saved.id)]);
    return { layout: saved };
  },
  deleteLayout: async (id: string): Promise<{ removed: boolean }> => {
    const items = await listOf<LayoutTemplate>(KEY_LAYOUTS);
    const next = items.filter((item) => item.id !== id);
    await saveList(KEY_LAYOUTS, next);
    return { removed: next.length !== items.length };
  },
  captureLayout: async (input: {
    volume: string;
    chapter: string;
    pageIndex: number;
    name?: string;
    scope?: 'volume' | 'chapter' | 'page';
    cols?: number;
  }): Promise<{ layout: LayoutTemplate }> => {
    const doc = await ensureDoc(input.volume, input.chapter, input.pageIndex);
    const cols = input.cols ?? 1;
    const rowCount = Math.max(1, Math.ceil(doc.panels.length / cols));
    const layout: LayoutTemplate = {
      id: uid('lt'),
      name: input.name?.trim() || `Layout ${input.pageIndex + 1}`,
      scope: input.scope ?? 'page',
      volume: input.volume,
      chapter: input.chapter,
      pageIndex: input.pageIndex,
      readingDirection: doc.readingDirection,
      grid: {
        cols,
        rows: Array.from({ length: rowCount }, () => ({
          height: 1 / rowCount,
          cells: Array.from({ length: cols }, () => ({})),
        })),
      },
      createdAt: nowIso(),
    };
    const items = await listOf<LayoutTemplate>(KEY_LAYOUTS);
    await saveList(KEY_LAYOUTS, [layout, ...items]);
    return { layout };
  },
  applyLayout: async (
    _layoutId: string,
    _volume: string,
    _chapter?: string,
    _pageIndices?: number[],
  ): Promise<{ applied: number }> => unsupported(),

  /* ---- Exchange formats ---- */
  exportLayoutFile: (_layoutId: string) => unsupported(),
  importLayoutFile: (_input: {
    data: string;
    volume: string;
    chapter?: string;
    pageIndex?: number;
    scope?: LayoutScope;
    name?: string;
  }) => unsupported(),
  exportExportTemplateFile: (_templateId: string) => unsupported(),
  importExportTemplateFile: (_data: string) => unsupported(),
  exportPageFile: (_input: { volume: string; chapter: string; pageIndex: number }) => unsupported(),
  importPageFile: (_input: { data: string; volume?: string; chapter?: string; pageIndex?: number }) => unsupported(),
  plugins: () => unsupported(),

  /* ---- Export templates ---- */
  exportTemplates: async (): Promise<{ templates: ExportTemplate[] }> => ({
    templates: await listOf(KEY_EXPORT_TEMPLATES),
  }),
  saveExportTemplate: async (name: string, config: Partial<ExportConfig>): Promise<{ template: ExportTemplate }> => {
    const template: ExportTemplate = { id: uid('et'), name, createdAt: nowIso(), config };
    const items = await listOf<ExportTemplate>(KEY_EXPORT_TEMPLATES);
    await saveList(KEY_EXPORT_TEMPLATES, [template, ...items.filter((item) => item.id !== template.id)]);
    return { template };
  },
  deleteExportTemplate: async (id: string): Promise<{ removed: boolean }> => {
    const items = await listOf<ExportTemplate>(KEY_EXPORT_TEMPLATES);
    const next = items.filter((item) => item.id !== id);
    await saveList(KEY_EXPORT_TEMPLATES, next);
    return { removed: next.length !== items.length };
  },
};

/* ------------------------------------------------------------------ */
/* Online-only helpers used by the UI and the import dialog             */
/* ------------------------------------------------------------------ */

/** Object URLs already point at the stored blob, so thumbnails use the same URL. */
export function thumbUrl(rawUrl: string, _width = 200): string {
  return rawUrl;
}

export type OnlineWorkspace = {
  meta: ProjectMeta;
  volumes: number;
  chapters: number;
  pages: number;
  images: number;
  annotated: number;
};

export async function openProject(file: File, options: ImportOptions = {}): Promise<ImportResult> {
  const result = await importProjectFile(file, options);
  return result;
}

export async function currentWorkspace(): Promise<OnlineWorkspace | null> {
  const summary = await getWorkspaceSummary();
  return summary ?? null;
}

export async function reopenWorkspace(): Promise<void> {
  releaseImageUrls();
  await loadLibrary();
}

export async function workspaceMeta(): Promise<ProjectMeta | null> {
  return readMeta();
}

export async function downloadCurrentProject(): Promise<void> {
  const { blob, name } = await buildProjectArchive({});
  downloadBlob(blob, name);
}

export { DEFAULT_EXPORT_CONFIG, PAGE_KINDS, getPage, pageKey };
