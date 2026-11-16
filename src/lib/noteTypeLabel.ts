import type { BuiltinNoteType, NoteTypeDef } from '../../shared/types';
import { LANGUAGE_NOTE_TYPE_PREFIX, isLanguageNoteType } from '../../shared/types';
import type { MessageKey } from '../i18n';
import { langLabel } from '../i18n';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const BUILTIN_LABEL: Record<BuiltinNoteType, MessageKey> = {
  background: 'notes.type.background',
  vocab: 'notes.type.vocab',
  rant: 'notes.type.rant',
};

/** Human label for a note category, shared by the sidebar chips and the compare view. */
export function noteTypeLabel(id: string, translate: Translate, customTypes: readonly NoteTypeDef[] = []): string {
  if (isLanguageNoteType(id)) return translate('notes.typeLanguage', { lang: langLabel(id.slice(LANGUAGE_NOTE_TYPE_PREFIX.length)) });
  if (id in BUILTIN_LABEL) return translate(BUILTIN_LABEL[id as BuiltinNoteType]);
  return customTypes.find((type) => type.id === id)?.name ?? id;
}
