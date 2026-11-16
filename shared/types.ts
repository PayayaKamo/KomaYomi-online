/** Built-in languages shipped with the app; a library may detect more at runtime. */
export const LANGUAGES = ['ja', 'zh', 'en'] as const;
export const DEFAULT_LANGUAGES: readonly Lang[] = LANGUAGES;
/** Language id: a built-in code, or the normalized folder name for other languages. */
export type Lang = string;

/** Built-in note categories; custom ids are free-form and `lang:<code>` marks language notes. */
export const BUILTIN_NOTE_TYPES = ['background', 'vocab', 'rant'] as const;
export type BuiltinNoteType = (typeof BUILTIN_NOTE_TYPES)[number];
export const DEFAULT_NOTE_TYPE: BuiltinNoteType = 'background';

/** User-defined note category (custom categories travel with the library, not the page). */
export type NoteTypeDef = {
  id: string;
  name: string;
  /** `#rrggbb`; used by the type chips and the compare-view markers. */
  color: string;
};

/** The single source of truth for built-in note colours. */
export const NOTE_TYPE_COLORS: Record<BuiltinNoteType, string> = {
  background: '#4c7dd8',
  vocab: '#d9942c',
  rant: '#d2574a',
};

/** Language categories follow the enabled languages and are never persisted as custom types. */
export const LANGUAGE_NOTE_TYPE_PREFIX = 'lang:';
export function languageNoteTypeId(lang: Lang): string {
  return `${LANGUAGE_NOTE_TYPE_PREFIX}${lang}`;
}
export function isLanguageNoteType(id: string | undefined): boolean {
  return Boolean(id && id.startsWith(LANGUAGE_NOTE_TYPE_PREFIX));
}

/** Palette offered when resolving custom categories. */
export const NOTE_TYPE_PALETTE = ['#4c7dd8', '#d9942c', '#d2574a', '#3f9e7a', '#8a63c9', '#c05a9a', '#6b7a8f'];


/** Chapter name used when a rule has no {chapter} placeholder (single-chapter volumes). */
export const SINGLE_CHAPTER = '全一话';

export const LANG_LABEL: Record<string, string> = {
  ja: '日本語',
  zh: '中文',
  en: 'English',
};

export const LANG_SHORT: Record<string, string> = {
  ja: 'JA',
  zh: 'ZH',
  en: 'EN',
};

/** Badge text for any language id; unknown languages fall back to the id itself. */
export function langShort(lang: Lang): string {
  return LANG_SHORT[lang] ?? (lang || '?').slice(0, 3).toUpperCase();
}

/** Native display name for known languages; unknown ids are shown as-is. */
export function langName(lang: Lang): string {
  return LANG_LABEL[lang] ?? (lang || '?');
}

/** Rectangle normalized to 0..1 relative to the full page. */
export type PanelRect = { x: number; y: number; w: number; h: number };

export type Panel = {
  id: string;
  rect: PanelRect;
  /** Auto-detected, hand-drawn or merged from neighbouring panels. */
  source?: 'auto' | 'manual' | 'merged';
  /** Explicitly assigned number; when omitted, numbering follows reading order. */
  number?: number;
};

export type NoteSource = {
  /** Optional page title. */
  title?: string;
  url?: string;
  /** Free-form source label, e.g. "LLM chat 2026-05-01". */
  text?: string;
};

/** Pin that ties a note to a spot on the page, in whole-page fractions. */
export type NoteAnchor = { x: number; y: number; lang: Lang };

export type Note = {
  id: string;
  /** page = note on the whole page; panel = note on a single panel. */
  scope: 'page' | 'panel';
  panelId: string | null;
  /** Category id: a built-in id, `lang:<code>`, or a custom type id. Missing means legacy. */
  type?: string;
  /** Where the note is pinned on the page; absent when the note has no anchor. */
  anchor?: NoteAnchor;
  text: string;
  tags: string[];
  /** Where the material came from: link, title or free-form text. */
  source?: NoteSource;
  /** Images pasted into the note (screenshots), stored as data URLs in the page JSON. */
  images?: NoteImage[];
  createdAt: string;
  updatedAt: string;
};

/**
 * How panels/pages are read.
 * - `horizontal-rl` / legacy `rtl`: rows top-to-bottom, right-to-left within a row
 * - `horizontal-lr` / legacy `ltr`: rows top-to-bottom, left-to-right within a row
 * - `vertical-rl` / legacy `ttb`: columns right-to-left, top-to-bottom within a column
 * - `vertical-lr`: columns left-to-right, top-to-bottom within a column
 */
export type ReadingDirection =
  'rtl' | 'ltr' | 'ttb' | 'horizontal-rl' | 'horizontal-lr' | 'vertical-rl' | 'vertical-lr';

/** Canonical order used by the selectors; legacy values stay first for familiarity. */
export const READING_DIRECTIONS: readonly ReadingDirection[] = [
  'rtl',
  'ltr',
  'ttb',
  'horizontal-rl',
  'horizontal-lr',
  'vertical-rl',
  'vertical-lr',
];

export const READING_LABEL: Record<ReadingDirection, string> = {
  rtl: '从右到左 · 从上到下',
  ltr: '从左到右 · 从上到下',
  ttb: '从右到左 · 竖排',
  'horizontal-rl': '从右到左 · 横排',
  'horizontal-lr': '从左到右 · 横排',
  'vertical-rl': '从右到左 · 竖排',
  'vertical-lr': '从左到右 · 竖排',
};

/** True when rows/columns progress right-to-left. */
export function isRightToLeft(direction: ReadingDirection): boolean {
  return direction === 'rtl' || direction === 'ttb' || direction === 'horizontal-rl' || direction === 'vertical-rl';
}

/** True when the strip is read downwards (vertical columns). */
export function isVerticalReading(direction: ReadingDirection): boolean {
  return direction === 'ttb' || direction === 'vertical-rl' || direction === 'vertical-lr';
}

/**
 * Put requested page indices into the chapter's reading order, so exports list pages
 * (and number their image files) the same way the reader shows them. Indices that the
 * chapter does not know keep their original place at the end.
 */
export function orderPageIndices(requested: readonly number[], pages: readonly { index: number }[]): number[] {
  const wanted = new Set(requested);
  const ordered = pages.map((page) => page.index).filter((index) => wanted.has(index));
  const seen = new Set(ordered);
  return [...ordered, ...[...new Set(requested)].filter((index) => !seen.has(index))];
}

/**
 * Per-language alignment offset. x/y are fractions of the container width/height
 * and scale is a zoom factor; together they line up the same panel in compare view.
 */
export type AlignOffset = { x: number; y: number; scale: number };

export const DEFAULT_OFFSET: AlignOffset = { x: 0, y: 0, scale: 1 };

/** Alignment modes: whole-page offset, per-panel offset, anchor picking, grid snapping. */
export type AlignMode = 'page' | 'panel' | 'anchors' | 'grid';

export const ALIGN_MODE_LABEL: Record<AlignMode, string> = {
  page: '整页偏移',
  panel: '逐格偏移',
  anchors: '锚点对齐',
  grid: '网格吸附',
};

export const ALIGN_MODE_HINT: Record<AlignMode, string> = {
  page: '拖动任一格都会平移整页，适合同一版本扫描件整体错位',
  panel: '每一格单独拖动对齐，适合电子版与纸质版版面有差异',
  anchors: '先在参考语言上点一个特征点，再在目标语言上点同一位置，自动算偏移',
  grid: '拖动时按网格步长吸附，适合需要整齐数值的场景',
};

/* ---------------- Declarative layout templates ---------------- */

export type LayoutScope = 'volume' | 'chapter' | 'page';

export type LayoutMargin = { top: number; right: number; bottom: number; left: number };

/** A cell in a row; span is the horizontal column span and defaults to 1. */
export type LayoutCell = { span?: number };

export type LayoutRow = { height?: number; cells: LayoutCell[] };

/**
 * Describes a layout as rows plus per-row cell spans, which suits fixed manga
 * layouts better than storing raw coordinates.
 * Example: two columns, three rows = { cols: 2, rows: [{cells:[{},{ }]}, ...] }
 */
export type LayoutGrid = { cols: number; rows: LayoutRow[] };

export type LayoutTemplate = {
  id: string;
  name: string;
  /** Binding scope, most specific first: page > chapter > volume. */
  scope: LayoutScope;
  volume: string;
  chapter?: string;
  /** Zero-based page index; only used when scope is 'page'. */
  pageIndex?: number;
  readingDirection?: ReadingDirection;
  margin?: Partial<LayoutMargin>;
  /** Gap between panels as a fraction of page width/height. */
  gap?: number;
  /** Column width weights; equal widths when omitted. */
  colWeights?: number[];
  grid: LayoutGrid;
  /** Per-page overrides for grid/margin/gap (keyed by 1-based page number). */
  pageOverrides?: Record<string, Partial<Pick<LayoutTemplate, 'grid' | 'margin' | 'gap' | 'colWeights'>>>;
  createdAt?: string;
  notes?: string;
};

/** Provenance of a panel-detection hit from a plugin. */
export type DetectSource = 'auto' | 'template' | 'plugin' | 'manual';

/* ---------------- Annotation layers and groups ---------------- */

export type PanelGroup = {
  id: string;
  name: string;
  panelIds: string[];
  /** Optional standalone number for the group. */
  number?: number;
  /** Optional accent colour (#rrggbb) used on the canvas and in group lists. */
  color?: string;
};

export type AnnotationKind = 'arrow' | 'rect' | 'ellipse' | 'highlight' | 'text' | 'badge' | 'mosaic' | 'pen';

/** Optional locator attached to an annotation, in page coordinates (box when w/h are set). */
export type AnnotationAnchor = {
  x: number;
  y: number;
  w?: number;
  h?: number;
};

/** Vector annotation; coordinates are 0..1 relative to its scope box (page or panel). */
export type Annotation = {
  id: string;
  kind: AnnotationKind;
  scope: 'page' | 'panel';
  panelId?: string | null;
  /** Start/end points; freehand strokes store the whole polyline. */
  points: { x: number; y: number }[];
  color?: string;
  width?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  /** Optional locator this annotation points at; absent means "the whole owning panel". */
  anchor?: AnnotationAnchor;
  /** Draw the leader line between the annotation and its locator; defaults to true. */
  showLeader?: boolean;
  /**
   * Language lane the mark was drawn in. Marks are only rendered and exported for that
   * language; absent means "every language" (legacy data and explicitly shared marks).
   */
  lang?: Lang;
  /** Explicit "show in every language" choice; legacy marks without `lang` behave the same. */
  allLangs?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NoteImage = {
  id: string;
  name: string;
  /** data:image/...;base64,... */
  dataUrl: string;
};

export type PageDoc = {
  /** Current version is 4 (note anchors/categories, annotation language lanes). */
  schemaVersion: number;
  volume: string;
  chapter: string;
  pageIndex: number;
  panels: Panel[];
  notes: Note[];
  /** Whole-page offset (page/grid modes). */
  offsets: Partial<Record<Lang, AlignOffset>>;
  alignMode: AlignMode;
  /** Per-panel offsets (panel/anchors modes): panelId -> lang -> offset. */
  panelOffsets: Record<string, Partial<Record<Lang, AlignOffset>>>;
  /** Grid snap step in percent (1 means 1%). */
  gridStep?: number;
  readingDirection: ReadingDirection;
  updatedAt: string;
  /** Detection source and algorithm version: identifies stale results and whether they were edited by hand. */
  detectorVersion?: string;
  detectedAt?: string;
  detectSource?: 'auto' | 'template' | 'plugin' | 'manual';
  /** Lightweight edit history (not an audit log): count, last timestamp and a change summary. */
  editCount?: number;
  lastEditedAt?: string;
  lastEditSummary?: string;
  /** Groups such as a spread spanning several panels; persisted rather than only marked in the UI. */
  groups?: PanelGroup[];
  /** Separate annotation layer, kept apart from text notes. */
  annotations?: Annotation[];
  /** Master switch for the annotation layer; when off the data is kept but hidden in the UI and exports. */
  annotationsVisible?: boolean;
};

export type PanelTemplate = {
  id: string;
  name: string;
  volume: string;
  chapter: string;
  panels: PanelRect[];
  readingDirection: ReadingDirection;
  createdAt: string;
};

export type AlignPreset = {
  id: string;
  name: string;
  scope: 'page' | 'chapter';
  volume: string;
  chapter: string;
  mode: AlignMode;
  offsets: Partial<Record<Lang, AlignOffset>>;
  panelOffsets: Record<string, Partial<Record<Lang, AlignOffset>>>;
  gridStep?: number;
  createdAt: string;
};

/** Built-in page roles the preprocessing wizard can mark (the list stays open for future kinds). */
export type PageKind = 'cover' | 'toc' | 'author' | 'ad' | 'recruit';
export const PAGE_KINDS: readonly PageKind[] = ['cover', 'toc', 'author', 'ad', 'recruit'];

export type PageEntry = {
  index: number;
  files: Partial<Record<Lang, string>>;
  filenames: Partial<Record<Lang, string>>;
  /** Languages that exist in the volume but have no file for this page slot. */
  missing?: Lang[];
  warnings: string[];
  annotated: boolean;
  /** Hidden from the reading body and exports by the preprocessing wizard. */
  excluded?: boolean;
  /** Optional page role assigned by the preprocessing wizard. */
  kind?: PageKind;
};

export type ChapterEntry = {
  id: string;
  volume: string;
  chapter: string;
  /** Display name from the library config; falls back to the folder name. */
  title?: string;
  pages: PageEntry[];
  warnings: string[];
  /** Per-language page-number alignment applied when the chapter has no matching page numbers. */
  pageOffsets?: Partial<Record<Lang, PageOffset>>;
};

export type PageOffset = {
  /** First page (1-based, in the language's own filenames) that needs shifting. */
  from: number;
  /** Page number in the reference edition that `from` should align to. */
  to: number;
};

export type VolumeEntry = {
  id: string;
  title: string;
  /** Series name when the volume was imported from a series/volume/language layout. */
  series?: string;
  chapters: ChapterEntry[];
  warnings: string[];
  /** Language -> actual directory name under raw/ (a manga may ship only 1-3 languages). */
  langDirs: Partial<Record<Lang, string>>;
  /** Languages actually available in this volume. */
  languages: Lang[];
  /** All subdirectories under raw/<volume>, so users can re-map language folders in volume settings. */
  dirs: string[];
  /** Default direction for pages in this volume that have no explicit direction yet. */
  defaultDirection?: ReadingDirection;
  /** Chapters removed from the library (their folders and page data stay on disk). */
  hiddenChapters?: string[];
};

export type Library = {
  root: string;
  languages: Lang[];
  /** User-defined language order, shared by the compare view and exports. */
  langOrder?: Lang[];
  /** User-defined note categories; built-in and language categories are derived in the UI. */
  noteTypes?: NoteTypeDef[];
  volumes: VolumeEntry[];
};

/** Per-chapter display/order/exclusion overrides stored in data/library.json. */
export type ChapterOverride = {
  title?: string;
  /** Page document indices (`PageEntry.index`) in the desired reading order. */
  order?: number[];
  /** Page document indices hidden from the body and exports. */
  excluded?: number[];
  /** Page document index -> role, for covers, ads and similar front/back matter. */
  kinds?: Record<string, PageKind>;
  /** Hidden from the library without touching the chapter folder under raw/. */
  hidden?: boolean;
  /** Shift page numbers for one language when extra pages are inserted mid-chapter. */
  pageOffsets?: Partial<Record<Lang, PageOffset>>;
};

/** Per-volume overrides stored in data/library.json; folder names stay untouched on disk. */
export type VolumeOverride = {
  title?: string;
  /** Series name shown in the sidebar as "series · volume". */
  series?: string;
  dirs?: Partial<Record<Lang, string>>;
  chapters?: Record<string, ChapterOverride>;
  /** Reading direction inherited by pages in this volume before they are edited. */
  defaultDirection?: ReadingDirection;
};

export type DetectResult = {
  width: number;
  height: number;
  panels: PanelRect[];
  meta: { scale: number; threshold: number; ms: number };
  /** Algorithm version and source (template/plugin/auto). */
  version?: string;
  source?: 'auto' | 'template' | 'plugin';
  lang?: string;
  warnings?: string[];
  /** Code for a failed step (e.g. `ERR_PLUGIN_TIMEOUT`) so clients can display it next to the text. */
  errorCode?: string;
};

export type PageResponse = {
  doc: PageDoc;
  page: PageEntry;
  chapterId: string;
  volume: string;
  chapter: string;
  exists: boolean;
};

export type ExportBlock = { type: 'heading'; text: string } | { type: 'paragraph'; text: string };

export type ExportConfig = {
  template: 'two-column' | 'stack' | 'compare-wide';
  title: string;
  volume: string;
  chapter: string;
  pageIndices: number[];
  languages: Lang[];
  embedImages: boolean;
  /** Per-language translation (fraction of image width/height) used to align images during export. */
  offsets: Partial<Record<Lang, AlignOffset>>;
  showPanelBoxes: boolean;
  includeNotes: boolean;
  /** Export only pages that have notes. */
  onlyWithNotes?: boolean;
  /** Generate a print-ready page that opens the browser print dialog (Save as PDF). */
  print?: boolean;
  noteFilterTags: string[];
  pageWidthRatio: number;
  columnGap: number;
  fontScale: number;
  /** Panels per row in the panel-compare template. */
  columns: number;
  /**
   * Bake the annotation layer into the exported page images.
   * HTML/print use the vector layer; Word has no canvas on the server, so the client
   * composites page PNGs and uploads them under `annotationImages`.
   */
  includeAnnotations?: boolean;
  /** Staging id for browser-composited page PNGs, keyed `p{pageIndex}-{lang}`. */
  annotationImages?: string;
};

export const DEFAULT_EXPORT_CONFIG: Omit<ExportConfig, 'volume' | 'chapter' | 'pageIndices' | 'offsets'> = {
  template: 'two-column',
  title: '漫画对照批注',
  languages: ['ja', 'zh', 'en'],
  embedImages: false,
  showPanelBoxes: false,
  includeNotes: true,
  includeAnnotations: true,
  onlyWithNotes: false,
  noteFilterTags: [],
  pageWidthRatio: 46,
  columnGap: 28,
  fontScale: 1,
  columns: 1,
};

/** User-saved export template; stores layout only, scope/volume/chapter are chosen at export time. */
export type ExportTemplate = {
  id: string;
  name: string;
  createdAt: string;
  config: Partial<ExportConfig>;
};
