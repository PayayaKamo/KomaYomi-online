import type { Lang, NoteTypeDef } from './types';
import {
  BUILTIN_NOTE_TYPES,
  DEFAULT_NOTE_TYPE,
  LANGUAGE_NOTE_TYPE_PREFIX,
  NOTE_TYPE_COLORS,
  NOTE_TYPE_PALETTE,
  isLanguageNoteType,
} from './types';

/**
 * Note category colour resolution.
 *
 * Colours themselves live only in `shared/types.ts`; every component goes through
 * `noteTypeColor` so a category keeps the same hue in the sidebar, the compare view
 * and the anchor markers.
 */

/** Stable small hash so custom ids always map to the same palette slot. */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** Language categories follow the library order; unknown codes fall back to a stable slot. */
function languageColor(lang: Lang, languages: readonly Lang[]): string {
  const index = languages.indexOf(lang);
  const slot = index >= 0 ? (index + 3) % NOTE_TYPE_PALETTE.length : hashId(lang) % NOTE_TYPE_PALETTE.length;
  return NOTE_TYPE_PALETTE[slot];
}

export function noteTypeColor(
  id: string | undefined,
  languages: readonly Lang[] = [],
  customTypes: readonly NoteTypeDef[] = [],
): string {
  if (!id) return NOTE_TYPE_COLORS[DEFAULT_NOTE_TYPE];
  if (isLanguageNoteType(id)) return languageColor(id.slice(LANGUAGE_NOTE_TYPE_PREFIX.length), languages);
  if ((BUILTIN_NOTE_TYPES as readonly string[]).includes(id)) return NOTE_TYPE_COLORS[id as (typeof BUILTIN_NOTE_TYPES)[number]];
  const custom = customTypes.find((type) => type.id === id);
  if (custom?.color) return custom.color;
  // Unknown/deleted custom category: keep it distinguishable instead of losing the note.
  return NOTE_TYPE_PALETTE[hashId(id) % NOTE_TYPE_PALETTE.length];
}

/** Categories worth showing as filters: built-ins, languages, custom and any ids still in use. */
export function noteTypeIds(
  languages: readonly Lang[],
  customTypes: readonly NoteTypeDef[] = [],
  usedIds: Iterable<string> = [],
): string[] {
  const ids: string[] = [...BUILTIN_NOTE_TYPES, ...languages.map((lang) => `${LANGUAGE_NOTE_TYPE_PREFIX}${lang}`)];
  for (const type of customTypes) ids.push(type.id);
  for (const id of usedIds) if (id) ids.push(id);
  return [...new Set(ids)];
}
