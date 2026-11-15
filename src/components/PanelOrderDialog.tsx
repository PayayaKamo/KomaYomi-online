import { useEffect, useRef, useState } from 'react';
import type { Panel } from '../types';
import { useI18n } from '../i18n';

type Props = {
  /** Panels in their current reading order (numbers are applied on save). */
  panels: Panel[];
  selectedId: string | null;
  onClose: () => void;
  onApply: (order: string[]) => void;
};

function moveTo(list: Panel[], from: number, to: number): Panel[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.min(Math.max(0, to), next.length), 0, item);
  return next;
}

/** Drag handle plus number input, so the order is editable with mouse, keyboard and touch. */
export function PanelOrderDialog({ panels, selectedId, onClose, onApply }: Props) {
  const { t, formatNumber: fmt } = useI18n();
  const [draft, setDraft] = useState<Panel[]>(panels);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const dragBackup = useRef<Panel[] | null>(null);
  const selectedIndex = draft.findIndex((p) => p.id === selectedId);
  const [pos, setPos] = useState(selectedIndex >= 0 ? selectedIndex + 1 : 1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (dragBackup.current) {
        setDraft(dragBackup.current);
        dragBackup.current = null;
        setDragId(null);
        setOver(null);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const commitPosition = () => {
    if (selectedIndex < 0) return;
    const target = Math.min(Math.max(1, pos), draft.length) - 1;
    setDraft((list) => moveTo(list, selectedIndex, target));
    setPos(target + 1);
  };

  const row = (panel: Panel, index: number) => (
    <li
      key={panel.id}
      className={[
        'order-row',
        panel.id === selectedId ? 'active' : '',
        dragId === panel.id ? 'dragging' : '',
        over === index && dragId && dragId !== panel.id ? 'drop-target' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      draggable
      onDragStart={(e) => {
        dragBackup.current = draft;
        setDragId(panel.id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', panel.id);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(index);
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (dragId) {
          const from = draft.findIndex((p) => p.id === dragId);
          setDraft(moveTo(draft, from, index));
        }
        setDragId(null);
        setOver(null);
        dragBackup.current = null;
      }}
      onDragEnd={() => {
        setDragId(null);
        setOver(null);
        dragBackup.current = null;
      }}
    >
      <span className="order-handle" aria-hidden="true">
        ⠿
      </span>
      <span className="order-no">{fmt(index + 1)}</span>
      <span className="order-meta">
        {t('order.coords', {
          x: Math.round(panel.rect.x * 100),
          y: Math.round(panel.rect.y * 100),
          w: Math.round(panel.rect.w * 100),
          h: Math.round(panel.rect.h * 100),
        })}
      </span>
      <button
        type="button"
        className="btn icon"
        disabled={index === 0}
        title={t('order.moveUp')}
        aria-label={t('order.moveUp')}
        onClick={() => setDraft((list) => moveTo(list, index, index - 1))}
      >
        ↑
      </button>
      <button
        type="button"
        className="btn icon"
        disabled={index === draft.length - 1}
        title={t('order.moveDown')}
        aria-label={t('order.moveDown')}
        onClick={() => setDraft((list) => moveTo(list, index, index + 1))}
      >
        ↓
      </button>
    </li>
  );

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal order-modal" role="dialog" aria-modal="true" aria-labelledby="order-title">
        <header className="modal-head">
          <h2 id="order-title">{t('order.title')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </header>
        <div className="modal-body">
          <div className="order-set">
            <label htmlFor="order-position">{t('order.setPosition')}</label>
            <input
              id="order-position"
              className="order-pos"
              type="number"
              min={1}
              max={draft.length}
              value={pos}
              disabled={selectedIndex < 0}
              onChange={(e) => setPos(Number.parseInt(e.target.value, 10) || 1)}
              onKeyDown={(e) => e.key === 'Enter' && commitPosition()}
            />
            <button type="button" className="btn" onClick={commitPosition} disabled={selectedIndex < 0}>
              {t('order.move')}
            </button>
          </div>
          <p className="field-hint">{t('order.hint')}</p>
          <ol className="order-list">{draft.map(row)}</ol>
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={() => onApply(draft.map((p) => p.id))}>
            {t('common.save')}
          </button>
        </footer>
      </div>
    </div>
  );
}
