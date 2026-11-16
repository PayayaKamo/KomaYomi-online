import { DEFAULT_NOTE_TYPE, LANGUAGES } from './types.ts';

/**
 * Version migration chain for exchange files / project manifests.
 *
 * Each migration only turns the previous version's content into the next one; it does not
 * touch the disk or validate. Version numbers and `$schema` are filled in by shared/format.ts,
 * so migrations stay testable on their own and a v1 → v2 step can be appended later.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const APP_FALLBACK_VERSION = '0.1.0';

/** v0 (early experimental manifest): images at the top level, field named `file`, language dirs named `langDirs`. */
export function migrateManifestV0(raw: Record<string, unknown>): Record<string, unknown> {
  const topImages = Array.isArray(raw.images) ? raw.images : [];
  const inventoryImages = isRecord(raw.inventory) && Array.isArray(raw.inventory.images) ? raw.inventory.images : [];
  const images = (topImages.length ? topImages : inventoryImages).filter(isRecord).map((img) => {
    const file = typeof img.path === 'string' ? img.path : typeof img.file === 'string' ? img.file : undefined;
    const pathValue = file ? file.replace(/\\/g, '/').replace(/^\/+/, '') : undefined;
    return {
      volume: String(img.volume ?? ''),
      chapter: String(img.chapter ?? ''),
      pageIndex: Number(img.pageIndex) || 0,
      lang: typeof img.lang === 'string' && img.lang.trim() ? img.lang.trim() : 'ja',
      name: typeof img.name === 'string' && img.name ? img.name : pathValue ? (pathValue.split('/').pop() ?? '') : '',
      sha1: typeof img.sha1 === 'string' ? img.sha1 : '',
      size: Number(img.size) || 0,
      path: pathValue,
      asset: typeof img.asset === 'string' ? img.asset : undefined,
    };
  });

  const langDirs = isRecord(raw.langDirs) ? raw.langDirs : {};
  const volumes = new Map<string, { volume: string; chapters: Map<string, number> }>();
  for (const img of images) {
    if (!img.volume || !img.chapter) continue;
    const vol = volumes.get(img.volume) ?? { volume: img.volume, chapters: new Map<string, number>() };
    vol.chapters.set(img.chapter, Math.max(vol.chapters.get(img.chapter) ?? 0, img.pageIndex + 1));
    volumes.set(img.volume, vol);
  }

  const migrated: Record<string, unknown> = {
    // Unknown top-level fields survive a v0 → v1 round trip.
    ...raw,
    schemaVersion: 1,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : APP_FALLBACK_VERSION,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    storageMode: raw.storageMode === 'packaged' ? 'packaged' : 'reference',
    name: typeof raw.name === 'string' ? raw.name : undefined,
    language: { volumes: langDirs, resolved: langDirs },
    inventory: {
      volumes: [...volumes.values()].map((vol) => ({
        volume: vol.volume,
        languages: [...LANGUAGES],
        langDirs: (langDirs as Record<string, Record<string, string>>)[vol.volume] ?? {},
        chapters: [...vol.chapters.entries()].map(([chapter, pages]) => ({ chapter, pages, images: pages })),
      })),
      pageCount: Number(raw.pageCount) || 0,
      images,
    },
  };
  // Known v0 spellings are folded into `inventory`; anything else is kept as unknown.
  delete migrated.images;
  delete migrated.langDirs;
  delete migrated.pageCount;
  return migrated;
}

/** v0 layout template: a bare LayoutTemplate (possibly bound to volume/chapter/pageIndex). */
export function migrateLayoutTemplateV0(raw: Record<string, unknown>): Record<string, unknown> {
  const layout = isRecord(raw.layout) ? raw.layout : raw;
  const grid = isRecord(layout.grid) ? layout.grid : undefined;
  if (!grid) throw new Error('版式模板缺少 grid，无法迁移');
  return {
    ...layout,
    id: typeof layout.id === 'string' && layout.id ? layout.id : `tpl${Date.now().toString(36)}`,
    name: typeof layout.name === 'string' && layout.name.trim() ? layout.name : '导入的版式模板',
    scope: 'template',
    readingDirection: layout.readingDirection,
    margin: layout.margin,
    gap: layout.gap,
    colWeights: layout.colWeights,
    grid,
    pageOverrides: layout.pageOverrides,
    createdAt: typeof layout.createdAt === 'string' ? layout.createdAt : new Date().toISOString(),
    notes: typeof layout.notes === 'string' ? layout.notes : undefined,
  };
}

/** v0 export template: a bare ExportTemplate, an item of data/templates/export.json, or a bare ExportConfig. */
export function migrateExportTemplateV0(raw: Record<string, unknown>): Record<string, unknown> {
  const source = isRecord(raw.template) ? raw.template : raw;
  const config = isRecord(source.config)
    ? source.config
    : isRecord(source) && ('template' in source || 'pageWidthRatio' in source)
      ? source
      : {};
  return {
    ...source,
    id: typeof source.id === 'string' && source.id ? source.id : `ext${Date.now().toString(36)}`,
    name: typeof source.name === 'string' && source.name.trim() ? source.name : '导入的导出模板',
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
    config,
  };
}

/** v0 page JSON: a bare PageDoc from the old data/pages, missing only the envelope fields. */
export function migratePageV0(raw: Record<string, unknown>): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...raw, schemaVersion: 1 };
  // `version` was the pre-1.0 spelling; `schemaVersion` is now the single source.
  delete migrated.version;
  return migrated;
}

/**
 * v1 → v2: notes gained categories. Notes written before categories existed are marked as
 * the default background type so every note has a stable id for colouring and filtering.
 */
export function migratePageV1(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw, schemaVersion: 2 };
  if (Array.isArray(out.notes)) {
    out.notes = out.notes.map((note) => {
      if (!isRecord(note)) return note;
      const type = typeof note.type === 'string' && note.type.trim() ? note.type.trim() : DEFAULT_NOTE_TYPE;
      return { ...note, type };
    });
  }
  return out;
}

/**
 * v2 → v3: annotations became language-scoped. Files from before this version stored marks
 * in page coordinates without recording the lane they were drawn in, so there is no way to
 * infer one; they are marked as shared and keep showing in every language instead of vanishing.
 */
export function migratePageV2(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw, schemaVersion: 3 };
  if (Array.isArray(out.annotations)) {
    out.annotations = out.annotations.map((annotation) => {
      if (!isRecord(annotation)) return annotation;
      if (typeof annotation.lang === 'string' || annotation.allLangs === true) return annotation;
      return { ...annotation, allLangs: true };
    });
  }
  return out;
}

/**
 * v3 → v4: notes may carry an anchor (point on the artwork plus its language lane).
 * The field is optional, so existing notes stay valid without touching their content.
 */
export function migratePageV3(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, schemaVersion: 4 };
}

/** v1 → v2: the manifest envelope only; note categories live in config/library.json. */
export function migrateManifestV1(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, schemaVersion: 2 };
}
