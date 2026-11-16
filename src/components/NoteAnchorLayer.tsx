import { useEffect, useRef, useState } from 'react';
import type { AlignOffset, Lang, Note, Panel } from '../types';
import { groupAnchoredNotes, pagePointToPane } from '../../shared/noteAnchors.ts';
import { renderMarkdown } from '../../shared/markdown.ts';
import { langLabel, useI18n } from '../i18n';

type Props = {
  notes: Note[];
  panel: Panel;
  lang: Lang;
  /** Alignment offset of this pane, so pins follow the artwork exactly like annotations. */
  offset: AlignOffset;
  zoom?: number;
};

/** Same palette as the desktop note categories, custom types get a neutral accent. */
const TYPE_COLORS: Record<string, string> = {
  background: '#4c7dd8',
  vocab: '#d9942c',
  rant: '#d2574a',
};

function colorFor(type?: string): string {
  if (!type) return '#6b7280';
  if (type.startsWith('lang:')) return '#2f9c8f';
  return TYPE_COLORS[type] ?? '#8a6dd8';
}

/**
 * Read-only layer of note pins for the online edition.
 * The desktop app can drag pins around; here the goal is to browse a demo project, so a pin
 * opens a small popover with the notes pinned at that spot instead of editing their position.
 */
export function NoteAnchorLayer({ notes, panel, lang, offset, zoom = 1 }: Props) {
  const { t } = useI18n();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const groups = groupAnchoredNotes(notes, panel, lang);

  useEffect(() => {
    if (!openKey) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpenKey(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [openKey]);

  useEffect(() => {
    // Stale popover if the page/panel/language changed under it.
    setOpenKey(null);
  }, [panel.id, lang, notes]);

  if (groups.length === 0) return null;

  return (
    <div className="note-anchor-layer" ref={rootRef}>
      {groups.map((group) => {
        const point = pagePointToPane(group, panel.rect, offset, zoom);
        const open = openKey === group.key;
        const shared = !group.notes[0]?.anchor?.lang;
        const label =
          group.notes.length > 1 ? t('notes.anchorDotCount', { count: group.notes.length }) : t('notes.anchorDot');
        return (
          <div
            key={group.key}
            className="note-anchor-spot"
            style={{ left: `${point.u * 100}%`, top: `${point.v * 100}%` }}
          >
            <button
              type="button"
              className="note-anchor-dot"
              style={{ background: colorFor(group.notes[0]?.type) }}
              title={label}
              aria-label={label}
              aria-expanded={open}
              onClick={() => setOpenKey(open ? null : group.key)}
            >
              {group.notes.length > 1 && <span>{group.notes.length}</span>}
            </button>
            {open && (
              <div
                className={`note-anchor-pop${point.v > 0.62 ? ' above' : ''}`}
                role="dialog"
                aria-label={t('notes.anchorGroup')}
              >
                <header>
                  <b>{t('notes.anchorGroup')}</b>
                  <span className="muted">
                    {shared ? t('notes.anchorShared') : t('notes.anchorLang', { lang: langLabel(group.lang) })}
                  </span>
                </header>
                {group.notes.map((note) => (
                  <div key={note.id} className="note-anchor-note">
                    <span className="note-anchor-swatch" style={{ background: colorFor(note.type) }} />
                    <div
                      className="note-anchor-text"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(note.text) }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
