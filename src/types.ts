import type { Lang } from '../shared/types';

export type { Lang } from '../shared/types';
export {
  LANGUAGES,
  DEFAULT_LANGUAGES,
  LANG_LABEL,
  LANG_SHORT,
  langShort,
  langName,
  READING_LABEL,
  READING_DIRECTIONS,
  isRightToLeft,
  isVerticalReading,
  DEFAULT_OFFSET,
  DEFAULT_EXPORT_CONFIG,
  ALIGN_MODE_LABEL,
  ALIGN_MODE_HINT,
  SINGLE_CHAPTER,
  PAGE_KINDS,
  BUILTIN_NOTE_TYPES,
  DEFAULT_NOTE_TYPE,
} from '../shared/types';
export type {
  AlignMode,
  AlignOffset,
  AlignPreset,
  Annotation,
  AnnotationKind,
  ChapterEntry,
  ChapterOverride,
  DetectResult,
  ExportConfig,
  ExportTemplate,
  LayoutCell,
  LayoutGrid,
  LayoutMargin,
  LayoutRow,
  LayoutScope,
  LayoutTemplate,
  Library,
  Note,
  NoteImage,
  NoteSource,
  NoteTypeDef,
  PageDoc,
  PageEntry,
  PageKind,
  PageResponse,
  Panel,
  PanelGroup,
  PanelRect,
  PanelTemplate,
  ReadingDirection,
  VolumeEntry,
  VolumeOverride,
} from '../shared/types';

/* ---- Directory recognition rules (frontend view; the same-named server type is the source) ---- */

export type DirRule = {
  id: string;
  name?: string;
  pattern: string;
  ignore?: string[];
  extensions?: string[];
  /** Fallback language for flat structures without a {language} segment */
  language?: Lang;
  enabled?: boolean;
};

export type UnmatchedFile = { file: string; reason: string };

export type LibraryScanInfo = {
  rules: DirRule[];
  unmatchedCount: number;
  unmatched: UnmatchedFile[];
  truncated: boolean;
  warning?: string;
};

export type DirPreview = {
  dir: string;
  rules: DirRule[];
  hits: Record<string, number>;
  matched: number;
  unmatched: UnmatchedFile[];
  unmatchedCount: number;
  truncated: boolean;
  tree: {
    id: string;
    dir: string;
    languages: Lang[];
    chapters: { chapter: string; pages: number; langs: Partial<Record<Lang, number>> }[];
  }[];
};

/* ---- Storage providers (local / network drive / WebDAV) ---- */

export type StorageKind = 'local' | 'network' | 'webdav';

export type StorageTarget = {
  id: string;
  name: string;
  kind: StorageKind;
  path?: string;
  url?: string;
  username?: string;
  hasSecret?: boolean;
  enabled?: boolean;
  readOnly?: boolean;
};

export type StorageConfig = {
  schemaVersion: 1;
  rawSource?: StorageTarget;
  backups: StorageTarget[];
  cacheLimitMb: number;
};

export type StorageStatus = {
  id: string;
  kind: StorageKind;
  online: boolean;
  readOnly: boolean;
  message: string;
  checkedAt: string;
};

export type CacheStats = { bytes: number; files: number; limitMb: number };
