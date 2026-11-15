import type { ExportTemplate, LayoutTemplate, PageDoc, ReadingDirection } from './types.ts';
import { READING_DIRECTIONS } from './types.ts';
import { migrateExportTemplateV0, migrateLayoutTemplateV0, migrateManifestV0, migratePageV0 } from './migrations.ts';

/**
 * Unified exchange format: a `$schema` + `schemaVersion` envelope, see shared/schemas/*.json.
 * This small validator has no npm dependencies and only checks fields required at runtime;
 * errors carry exact paths, e.g. `manifest.volumes[2].chapters: required`.
 */

export const SCHEMA_BASE = 'https://manga-memo.dev/schemas/';

export const SCHEMA_URLS = {
  mnproj: `${SCHEMA_BASE}mnproj.schema.json`,
  mntpl: `${SCHEMA_BASE}mntpl.schema.json`,
  mnexp: `${SCHEMA_BASE}mnexp.schema.json`,
  page: `${SCHEMA_BASE}page.schema.json`,
  /* Stored-only formats: same envelope rules, never imported from disk by the user. */
  mntp: `${SCHEMA_BASE}mntp.schema.json`,
  mnalign: `${SCHEMA_BASE}mnalign.schema.json`,
  mnlayout: `${SCHEMA_BASE}mnlayout.schema.json`,
  mnconfig: `${SCHEMA_BASE}mnconfig.schema.json`,
  mnstorage: `${SCHEMA_BASE}mnstorage.schema.json`,
  mnhistory: `${SCHEMA_BASE}mnhistory.schema.json`,
} as const;

export type ExchangeKind = keyof typeof SCHEMA_URLS;

export const FORMAT_LABEL: Record<ExchangeKind, string> = {
  mnproj: '工程文件',
  mntpl: '版式模板',
  mnexp: '导出模板',
  page: '页面 JSON',
  mntp: '分格模板',
  mnalign: '对齐预设',
  mnlayout: '版式模板',
  mnconfig: '目录配置',
  mnstorage: '存储配置',
  mnhistory: '页面版本历史',
};

export const CURRENT_SCHEMA_VERSION: Record<ExchangeKind, number> = {
  mnproj: 1,
  mntpl: 1,
  mnexp: 1,
  page: 1,
  mntp: 1,
  mnalign: 1,
  mnlayout: 1,
  mnconfig: 1,
  mnstorage: 1,
  mnhistory: 1,
};

export const FORMAT_EXTENSION: Record<ExchangeKind, string> = {
  mnproj: '.mnproj',
  mntpl: '.mntpl',
  mnexp: '.mnexp',
  page: '.mnpage.json',
  /* Stored files keep their own on-disk names; no user-facing extension. */
  mntp: '',
  mnalign: '',
  mnlayout: '',
  mnconfig: '',
  mnstorage: '',
  mnhistory: '',
};

export type LayoutTemplateExchange = Omit<LayoutTemplate, 'scope' | 'volume' | 'chapter' | 'pageIndex'> & {
  scope: 'template';
};

export type ExportTemplateExchange = ExportTemplate & {
  $schema: string;
  schemaVersion: number;
  kind: 'mnexp';
};

export type PageExchange = PageDoc & {
  $schema: string;
  schemaVersion: number;
  kind: 'page';
};

export type ValidationResult = { ok: boolean; errors: string[] };

export type PreparedExchange = {
  kind: ExchangeKind;
  value: Record<string, unknown>;
  version: number;
  migratedFrom?: number;
  warnings: string[];
};

type Spec =
  | { kind: 'object'; fields: Record<string, Spec>; required: readonly string[]; allowUnknown: boolean }
  | { kind: 'array'; items: Spec; minItems?: number }
  | { kind: 'record'; values: Spec }
  | { kind: 'string'; enum?: readonly string[]; minLength?: number }
  | { kind: 'number'; integer?: boolean; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'nullable'; inner: Spec }
  | { kind: 'any' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const object = (
  fields: Record<string, Spec>,
  required: readonly string[] = Object.keys(fields),
  allowUnknown = true,
): Spec => ({ kind: 'object', fields, required, allowUnknown });

const array = (items: Spec, minItems?: number): Spec => ({ kind: 'array', items, minItems });
const record = (values: Spec): Spec => ({ kind: 'record', values });
const str = (opts: { enum?: readonly string[]; minLength?: number } = {}): Spec => ({
  kind: 'string',
  ...opts,
});
const num = (opts: { min?: number; max?: number } = {}): Spec => ({ kind: 'number', ...opts });
const int = (opts: { min?: number; max?: number } = {}): Spec => ({
  kind: 'number',
  integer: true,
  ...opts,
});
const bool = (): Spec => ({ kind: 'boolean' });
const nullable = (inner: Spec): Spec => ({ kind: 'nullable', inner });

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);
const where = (path: string) => path || '(root)';

/** Narrow an unknown persisted value to a supported reading direction. */
export function readReadingDirection(value: unknown): ReadingDirection | undefined {
  return typeof value === 'string' && (READING_DIRECTIONS as readonly string[]).includes(value)
    ? (value as ReadingDirection)
    : undefined;
}

function validateSpec(value: unknown, spec: Spec, path: string, errors: string[]): void {
  if (spec.kind === 'any') return;
  if (spec.kind === 'nullable') {
    if (value === null) return;
    validateSpec(value, spec.inner, path, errors);
    return;
  }
  if (path && value === undefined) {
    errors.push(`${path}: required`);
    return;
  }

  if (spec.kind === 'object') {
    if (!isRecord(value)) {
      errors.push(`${where(path)}: expected object`);
      return;
    }
    for (const key of spec.required) {
      if (!(key in value) || value[key] === undefined) errors.push(`${join(path, key)}: required`);
    }
    for (const [key, child] of Object.entries(spec.fields)) {
      if (!(key in value) || value[key] === undefined) continue;
      validateSpec(value[key], child, join(path, key), errors);
    }
    if (!spec.allowUnknown) {
      for (const key of Object.keys(value)) {
        if (!(key in spec.fields)) errors.push(`${join(path, key)}: unknown field`);
      }
    }
    return;
  }

  if (spec.kind === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${where(path)}: expected array`);
      return;
    }
    if (spec.minItems !== undefined && value.length < spec.minItems) {
      errors.push(`${where(path)}: expected at least ${spec.minItems} item(s)`);
    }
    value.forEach((item, index) => validateSpec(item, spec.items, `${path}[${index}]`, errors));
    return;
  }

  if (spec.kind === 'record') {
    if (!isRecord(value)) {
      errors.push(`${where(path)}: expected object`);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      validateSpec(child, spec.values, join(path, key), errors);
    }
    return;
  }

  if (spec.kind === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${where(path)}: expected string`);
      return;
    }
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      errors.push(`${where(path)}: must not be empty`);
    }
    if (spec.enum && !spec.enum.includes(value)) {
      errors.push(`${where(path)}: expected one of ${spec.enum.join(', ')}`);
    }
    return;
  }

  if (spec.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${where(path)}: expected number`);
      return;
    }
    if (spec.integer && !Number.isInteger(value)) {
      errors.push(`${where(path)}: expected integer`);
      return;
    }
    if (spec.min !== undefined && value < spec.min) errors.push(`${where(path)}: must be >= ${spec.min}`);
    if (spec.max !== undefined && value > spec.max) errors.push(`${where(path)}: must be <= ${spec.max}`);
    return;
  }

  if (spec.kind === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${where(path)}: expected boolean`);
  }
}

/* ---------------- Field tables per format ---------------- */

const offsetSpec = object({ x: num(), y: num(), scale: num() });
const rectSpec = object({ x: num(), y: num(), w: num(), h: num() });
const marginSpec = object({ top: num(), right: num(), bottom: num(), left: num() }, []);

const layoutCellSpec = object({ span: int({ min: 1 }) }, []);
const layoutRowSpec = object({ height: num(), cells: array(layoutCellSpec, 1) }, ['cells']);
const gridSpec = object({ cols: int({ min: 1, max: 12 }), rows: array(layoutRowSpec, 1) }, ['cols', 'rows']);
const pageOverrideSpec = object({ grid: gridSpec, margin: marginSpec, gap: num(), colWeights: array(num()) }, []);

const panelSpec = object(
  {
    id: str({ minLength: 1 }),
    rect: rectSpec,
    source: str({ enum: ['auto', 'manual', 'merged'] }),
    number: int({ min: 1 }),
  },
  ['id', 'rect'],
);

const noteSourceSpec = object({ title: str(), url: str(), text: str() }, []);
const noteImageSpec = object({ id: str({ minLength: 1 }), name: str(), dataUrl: str() });
const noteSpec = object(
  {
    id: str({ minLength: 1 }),
    scope: str({ enum: ['page', 'panel'] }),
    panelId: nullable(str()),
    text: str(),
    tags: array(str()),
    source: noteSourceSpec,
    images: array(noteImageSpec),
    createdAt: str(),
    updatedAt: str(),
  },
  ['id', 'scope', 'text', 'createdAt', 'updatedAt'],
);

const groupSpec = object(
  {
    id: str({ minLength: 1 }),
    name: str(),
    panelIds: array(str()),
    number: int({ min: 1 }),
    color: str(),
  },
  ['id', 'panelIds'],
);

const annotationSpec = object(
  {
    id: str({ minLength: 1 }),
    kind: str({ enum: ['arrow', 'rect', 'ellipse', 'highlight', 'text', 'badge', 'mosaic', 'pen'] }),
    scope: str({ enum: ['page', 'panel'] }),
    panelId: nullable(str()),
    points: array(object({ x: num(), y: num() }), 1),
    color: str(),
    width: num(),
    opacity: num(),
    text: str(),
    fontSize: num(),
    createdAt: str(),
    updatedAt: str(),
  },
  ['id', 'kind', 'scope', 'points', 'createdAt', 'updatedAt'],
);

const pageSpec = object(
  {
    $schema: str(),
    schemaVersion: int({ min: 0 }),
    kind: str({ enum: ['page'] }),
    appVersion: str(),
    volume: str({ minLength: 1 }),
    chapter: str({ minLength: 1 }),
    pageIndex: int({ min: 0 }),
    panels: array(panelSpec),
    notes: array(noteSpec),
    offsets: record(offsetSpec),
    alignMode: str({ enum: ['page', 'panel', 'anchors', 'grid'] }),
    panelOffsets: record(record(offsetSpec)),
    gridStep: num(),
    readingDirection: str({ enum: READING_DIRECTIONS }),
    updatedAt: str({ minLength: 1 }),
    detectorVersion: str(),
    detectedAt: str(),
    detectSource: str({ enum: ['auto', 'template', 'plugin', 'manual'] }),
    editCount: int({ min: 0 }),
    lastEditedAt: str(),
    lastEditSummary: str(),
    groups: array(groupSpec),
    annotations: array(annotationSpec),
    annotationsVisible: bool(),
  },
  [
    '$schema',
    'schemaVersion',
    'kind',
    'volume',
    'chapter',
    'pageIndex',
    'panels',
    'notes',
    'offsets',
    'alignMode',
    'panelOffsets',
    'readingDirection',
    'updatedAt',
  ],
);

const layoutSpec = object(
  {
    $schema: str(),
    schemaVersion: int({ min: 0 }),
    kind: str({ enum: ['mntpl'] }),
    id: str({ minLength: 1 }),
    name: str({ minLength: 1 }),
    scope: str({ enum: ['template'] }),
    readingDirection: str({ enum: READING_DIRECTIONS }),
    margin: marginSpec,
    gap: num(),
    colWeights: array(num()),
    grid: gridSpec,
    pageOverrides: record(pageOverrideSpec),
    createdAt: str(),
    notes: str(),
  },
  ['$schema', 'schemaVersion', 'kind', 'id', 'name', 'scope', 'grid'],
  false,
);

const exportConfigSpec = object(
  {
    template: str({ enum: ['two-column', 'stack', 'compare-wide'] }),
    title: str(),
    volume: str(),
    chapter: str(),
    pageIndices: array(int({ min: 0 })),
    languages: array(str({ minLength: 1 })),
    embedImages: bool(),
    offsets: record(offsetSpec),
    showPanelBoxes: bool(),
    includeNotes: bool(),
    onlyWithNotes: bool(),
    noteFilterTags: array(str()),
    pageWidthRatio: num(),
    columnGap: num(),
    fontScale: num(),
    columns: num(),
  },
  [],
);

const exportTemplateSpec = object(
  {
    $schema: str(),
    schemaVersion: int({ min: 0 }),
    kind: str({ enum: ['mnexp'] }),
    id: str({ minLength: 1 }),
    name: str({ minLength: 1 }),
    createdAt: str(),
    config: exportConfigSpec,
  },
  ['$schema', 'schemaVersion', 'kind', 'id', 'name', 'createdAt', 'config'],
  false,
);

const langDirsSpec = record(str());
const inventoryChapterSpec = object({ chapter: str(), pages: int({ min: 0 }), images: int({ min: 0 }) }, ['chapter']);
const inventoryVolumeSpec = object(
  {
    volume: str({ minLength: 1 }),
    languages: array(str({ minLength: 1 })),
    langDirs: langDirsSpec,
    chapters: array(inventoryChapterSpec),
  },
  ['volume', 'chapters'],
);
const inventoryImageSpec = object(
  {
    volume: str({ minLength: 1 }),
    chapter: str({ minLength: 1 }),
    pageIndex: int({ min: 0 }),
    lang: str({ minLength: 1 }),
    name: str({ minLength: 1 }),
    sha1: str(),
    size: int({ min: 0 }),
    path: str(),
    asset: str(),
  },
  ['volume', 'chapter', 'pageIndex', 'lang', 'name'],
);
const inventorySpec = object(
  { volumes: array(inventoryVolumeSpec), pageCount: int({ min: 0 }), images: array(inventoryImageSpec) },
  ['volumes', 'images'],
);
const manifestNotesSpec = object(
  { pages: int({ min: 0 }), noteCount: int({ min: 0 }), annotationCount: int({ min: 0 }), text: str() },
  [],
);

const manifestSpec = object(
  {
    $schema: str(),
    schemaVersion: int({ min: 0 }),
    appVersion: str(),
    createdAt: str(),
    updatedAt: str(),
    storageMode: str({ enum: ['reference', 'packaged'] }),
    name: str(),
    language: object({ volumes: record(langDirsSpec), resolved: record(langDirsSpec) }, ['volumes', 'resolved']),
    inventory: inventorySpec,
    notes: manifestNotesSpec,
  },
  ['schemaVersion', 'storageMode', 'language', 'inventory'],
);

/* ---------- stored-only formats (data/*.json, no user-facing extension) ---------- */

const envelopeFields = {
  $schema: str(),
  schemaVersion: int({ min: 0 }),
  appVersion: str(),
};

const panelTemplateSpec = object(
  {
    ...envelopeFields,
    kind: str({ enum: ['mntp'] }),
    id: str({ minLength: 1 }),
    name: str({ minLength: 1 }),
    panels: array(rectSpec),
    readingDirection: str({ enum: READING_DIRECTIONS }),
    createdAt: str(),
  },
  ['$schema', 'schemaVersion', 'kind', 'id', 'panels'],
);

const alignPresetSpec = object(
  {
    ...envelopeFields,
    kind: str({ enum: ['mnalign'] }),
    id: str({ minLength: 1 }),
    name: str({ minLength: 1 }),
    scope: str({ enum: ['page', 'chapter'] }),
    mode: str({ enum: ['page', 'panel', 'anchors', 'grid'] }),
    offsets: record(offsetSpec),
    panelOffsets: record(record(offsetSpec)),
    gridStep: num(),
    createdAt: str(),
  },
  ['$schema', 'schemaVersion', 'kind', 'id', 'offsets'],
);

const storedLayoutSpec = object(
  {
    ...envelopeFields,
    kind: str({ enum: ['mnlayout'] }),
    id: str({ minLength: 1 }),
    name: str({ minLength: 1 }),
    scope: str({ enum: ['volume', 'chapter', 'page'] }),
    volume: str(),
    chapter: str(),
    pageIndex: int({ min: 0 }),
    readingDirection: str({ enum: READING_DIRECTIONS }),
    margin: marginSpec,
    gap: num(),
    colWeights: array(num()),
    grid: gridSpec,
    pageOverrides: record(pageOverrideSpec),
    createdAt: str(),
    notes: str(),
  },
  ['$schema', 'schemaVersion', 'kind', 'id', 'grid'],
);

const dirRuleSpec = object(
  {
    id: str({ minLength: 1 }),
    name: str(),
    pattern: str({ minLength: 1 }),
    ignore: array(str()),
    extensions: array(str()),
    language: str({ minLength: 1 }),
    enabled: bool(),
  },
  ['id', 'pattern'],
);

const libraryConfigSpec = object(
  {
    ...envelopeFields,
    kind: str({ enum: ['mnconfig'] }),
    volumes: record(object({ dirs: record(str()) }, [])),
    rules: array(dirRuleSpec),
    langOrder: array(str({ minLength: 1 })),
  },
  ['$schema', 'schemaVersion', 'kind'],
);

const storageConfigSpec = object(
  {
    ...envelopeFields,
    kind: str({ enum: ['mnstorage'] }),
  },
  ['$schema', 'schemaVersion', 'kind'],
);

/** Why a page version was snapshotted. Kept in the file so the UI can label each entry. */
export const HISTORY_SOURCES = [
  'auto',
  'manual',
  'batch',
  'template',
  'align',
  'annotation',
  'import',
  'restore',
  'detect',
] as const;

export type HistorySource = (typeof HISTORY_SOURCES)[number];

const historyDiffSpec = object(
  {
    panels: int({ min: 0 }),
    panelsDelta: int(),
    added: int({ min: 0 }),
    removed: int({ min: 0 }),
    moved: int({ min: 0 }),
    resized: int({ min: 0 }),
    annotations: int({ min: 0 }),
    annotationsDelta: int(),
    notes: int({ min: 0 }),
    notesDelta: int(),
  },
  [],
);

const historyEntrySpec = object(
  {
    id: str({ minLength: 1 }),
    at: str({ minLength: 1 }),
    source: str({ enum: HISTORY_SOURCES }),
    summary: str(),
    diff: historyDiffSpec,
    editCount: int({ min: 0 }),
    doc: { kind: 'any' },
  },
  ['id', 'at', 'source', 'doc'],
);

const historySpec = object(
  {
    ...envelopeFields,
    kind: str({ enum: ['mnhistory'] }),
    volume: str({ minLength: 1 }),
    chapter: str({ minLength: 1 }),
    pageIndex: int({ min: 0 }),
    entries: array(historyEntrySpec),
  },
  ['$schema', 'schemaVersion', 'kind', 'volume', 'chapter', 'pageIndex', 'entries'],
);

const SPECS: Record<ExchangeKind, Spec> = {
  mnproj: manifestSpec,
  mntpl: layoutSpec,
  mnexp: exportTemplateSpec,
  page: pageSpec,
  mntp: panelTemplateSpec,
  mnalign: alignPresetSpec,
  mnlayout: storedLayoutSpec,
  mnconfig: libraryConfigSpec,
  mnstorage: storageConfigSpec,
  mnhistory: historySpec,
};

/** Validation only, no migration. Errors carry field paths. */
export function validateExchange(kind: ExchangeKind, value: unknown): ValidationResult {
  const errors: string[] = [];
  validateSpec(value, SPECS[kind], kind === 'mnproj' ? 'manifest' : '', errors);
  return { ok: errors.length === 0, errors };
}

export function assertExchange(kind: ExchangeKind, value: unknown, label = FORMAT_LABEL[kind]): void {
  const result = validateExchange(kind, value);
  if (!result.ok) throw new Error(`${label}格式不正确：${result.errors.join('；')}`);
}

/** Reject future versions outright; a missing version is treated as v0 (legacy file). */
export function checkSchemaVersion(kind: ExchangeKind, declared: unknown): number {
  if (declared === undefined || declared === null) return 0;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 0) {
    throw new Error(`${FORMAT_LABEL[kind]}：schemaVersion: expected non-negative integer`);
  }
  if (declared > CURRENT_SCHEMA_VERSION[kind]) {
    throw new Error(
      `${FORMAT_LABEL[kind]}版本过高（schemaVersion ${declared}，当前支持 ${CURRENT_SCHEMA_VERSION[kind]}），请升级应用后再打开`,
    );
  }
  return declared;
}

const MIGRATIONS: Record<ExchangeKind, Record<number, (value: Record<string, unknown>) => Record<string, unknown>>> = {
  mnproj: { 0: migrateManifestV0 },
  mntpl: { 0: migrateLayoutTemplateV0 },
  mnexp: { 0: migrateExportTemplateV0 },
  page: { 0: migratePageV0 },
  /* Stored formats had no envelope before v1, so v0 only needs the fields added. */
  mntp: { 0: (value) => ({ ...value }) },
  mnalign: { 0: (value) => ({ ...value }) },
  mnlayout: { 0: (value) => ({ ...value }) },
  mnconfig: { 0: (value) => ({ ...value }) },
  mnstorage: {
    0: (value) => {
      const out: Record<string, unknown> = { ...value };
      // `version` was the pre-1.0 spelling of the envelope field.
      delete out.version;
      return out;
    },
  },
  mnhistory: {
    0: (value) => {
      const out: Record<string, unknown> = { ...value };
      delete out.version;
      return out;
    },
  },
};

let exportAppVersion = '';

/** The server sets this once, so every file it writes records the producing app version. */
export function setFormatAppVersion(version: string): void {
  exportAppVersion = version;
}

function finalizeEnvelope(kind: ExchangeKind, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  out.$schema = SCHEMA_URLS[kind];
  out.schemaVersion = CURRENT_SCHEMA_VERSION[kind];
  if (exportAppVersion) out.appVersion = exportAppVersion;
  if (kind !== 'mnproj') out.kind = kind;
  if (kind === 'mntpl') {
    delete out.volume;
    delete out.chapter;
    delete out.pageIndex;
    out.scope = 'template';
  }
  return out;
}

/**
 * Pass unknown fields through: fields we do not recognize yet survive a read/write round trip.
 * Arrays are merged by `id`; other arrays take the new value as-is (order and deletion follow the new data).
 */
export function preserveUnknown<T>(previous: unknown, next: T): T {
  if (!isRecord(previous) || !isRecord(next)) return next;
  const out: Record<string, unknown> = { ...next };
  for (const [key, prevValue] of Object.entries(previous)) {
    if (!(key in out)) {
      out[key] = prevValue;
      continue;
    }
    const nextValue = out[key];
    if (Array.isArray(prevValue) && Array.isArray(nextValue)) {
      out[key] = mergeById(prevValue, nextValue);
    } else if (isRecord(prevValue) && isRecord(nextValue)) {
      out[key] = preserveUnknown(prevValue, nextValue);
    }
  }
  return out as T;
}

function mergeById(prev: unknown[], next: unknown[]): unknown[] {
  const prevById = new Map<string, unknown>();
  for (const item of prev) if (isRecord(item) && typeof item.id === 'string') prevById.set(item.id, item);
  if (!prevById.size) return next;
  let matched = false;
  const merged = next.map((item) => {
    if (!isRecord(item)) return item;
    const old = typeof item.id === 'string' ? prevById.get(item.id) : undefined;
    if (!old) return item;
    matched = true;
    return preserveUnknown(old, item);
  });
  return matched ? merged : next;
}

/**
 * Parse → version check → migration chain → fill the envelope → full validation.
 * Any failed step throws instead of returning a partial result, so callers can validate before writing.
 * `strict: false` is for our own data files: migrate the version but don't reject a file over missing fields.
 */
export function prepareExchange(
  kind: ExchangeKind,
  input: unknown,
  options: { strict?: boolean } = {},
): PreparedExchange {
  if (!isRecord(input)) throw new Error(`${FORMAT_LABEL[kind]}不是 JSON 对象`);
  const declared = checkSchemaVersion(kind, input.schemaVersion);
  let value: Record<string, unknown> = input;
  let version = declared;
  while (version < CURRENT_SCHEMA_VERSION[kind]) {
    const migrate = MIGRATIONS[kind][version];
    if (!migrate) {
      throw new Error(`${FORMAT_LABEL[kind]}缺少 v${version}→v${version + 1} 的迁移规则`);
    }
    value = migrate(value);
    version++;
  }
  // The `continuous-vertical` direction was removed; older files read as the default rtl.
  if (value.readingDirection === 'continuous-vertical') value = { ...value, readingDirection: 'rtl' };
  value = finalizeEnvelope(kind, value);
  if (options.strict !== false) {
    const result = validateExchange(kind, value);
    if (!result.ok) throw new Error(`${FORMAT_LABEL[kind]}格式不正确：${result.errors.join('；')}`);
  }
  return {
    kind,
    value,
    version,
    migratedFrom: declared < CURRENT_SCHEMA_VERSION[kind] ? declared : undefined,
    warnings: [],
  };
}

/** Guess the format from `$schema` / `kind` / key fields to give a friendlier import hint. */
export function detectExchangeKind(value: unknown): ExchangeKind | null {
  if (!isRecord(value)) return null;
  const schema = typeof value.$schema === 'string' ? value.$schema : '';
  for (const kind of Object.keys(SCHEMA_URLS) as ExchangeKind[]) {
    if (schema === SCHEMA_URLS[kind] || schema.endsWith(`/${kind}.schema.json`)) return kind;
  }
  if (value.kind === 'mntpl' || value.kind === 'mnexp' || value.kind === 'page') return value.kind;
  if (isRecord(value.inventory) && typeof value.storageMode === 'string') return 'mnproj';
  if (isRecord(value.grid) && Array.isArray((value.grid as Record<string, unknown>).rows)) return 'mntpl';
  if (isRecord(value.config)) return 'mnexp';
  if (Array.isArray(value.panels) && Array.isArray(value.notes)) return 'page';
  return null;
}

/** Squash validation errors into one line for direct display in the UI. */
export function formatErrors(errors: string[], limit = 8): string {
  if (!errors.length) return '';
  const head = errors.slice(0, limit).join('；');
  return errors.length > limit ? `${head}；…共 ${errors.length} 处` : head;
}
