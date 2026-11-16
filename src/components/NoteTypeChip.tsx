import type { CSSProperties } from 'react';
import type { Lang, NoteTypeDef } from '../../shared/types';
import { noteTypeColor } from '../../shared/noteTypes';
import { useI18n } from '../i18n';
import { noteTypeLabel } from '../lib/noteTypeLabel';

type Props = {
  id: string;
  languages?: readonly Lang[];
  customTypes?: readonly NoteTypeDef[];
  /** Tinted with the category colour; use for the selected filter or an in-card badge. */
  selected?: boolean;
  count?: number;
  onClick?: () => void;
  title?: string;
};

/**
 * Category chip: colour dot + label. Renders a button when `onClick` is given and a
 * plain badge otherwise. The colour always comes from `noteTypeColor`.
 */
export function NoteTypeChip({ id, languages, customTypes, selected = false, count, onClick, title }: Props) {
  const { t } = useI18n();
  const color = noteTypeColor(id, languages, customTypes);
  const style = { '--type-color': color } as CSSProperties;
  const label = noteTypeLabel(id, t, customTypes);
  const body = (
    <>
      <i aria-hidden="true" />
      {label}
      {count !== undefined && <em>{count}</em>}
    </>
  );
  if (!onClick) {
    return (
      <span className={`note-type-chip${selected ? ' on' : ''}`} style={style} title={title}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`note-type-chip${selected ? ' on' : ''}`}
      style={style}
      aria-pressed={selected}
      title={title}
      onClick={onClick}
    >
      {body}
    </button>
  );
}
