import type { Annotation, Lang, Panel, PanelRect } from '../types';
import { annotationLeader, annotationMatchesLang } from '../../shared/annotations.ts';

const PAGE_RECT: PanelRect = { x: 0, y: 0, w: 1, h: 1 };

type Props = {
  annotations: Annotation[];
  panels: Panel[];
  /** Visible crop of the page in normalized page coordinates. */
  rect: PanelRect;
  visible?: boolean;
  /** Language lane of this pane; marks drawn in other lanes are hidden. */
  lang?: Lang;
};

const num = (n: number) => Math.round(n * 100) / 100;

/**
 * Read-only annotation overlay for the compare view.
 * Rendering rules mirror the editable layer (page/panel scope, width as a fraction of the
 * page width, font size as a fraction of the page height) so both views agree.
 */
export function AnnotationOverlay({ annotations, panels, rect, visible = true, lang }: Props) {
  if (!visible || !annotations.length) return null;
  const shown = lang ? annotations.filter((a) => annotationMatchesLang(a, lang)) : annotations;
  if (!shown.length) return null;

  const vw = 1000;
  // Keep the viewBox aspect equal to the crop so strokes and text are not distorted.
  const vh = Math.max(1, Math.round((vw * rect.h) / Math.max(0.001, rect.w)));
  const toView = (p: { x: number; y: number }, scope: PanelRect) => ({
    x: ((scope.x + p.x * scope.w - rect.x) / rect.w) * vw,
    y: ((scope.y + p.y * scope.h - rect.y) / rect.h) * vh,
  });
  const sw = (fraction: number) => Math.max(0.5, (fraction * vw) / rect.w);
  const fs = (fraction: number) => Math.max(3, (fraction * vh) / rect.h);
  const mosaicId = 'ann-readonly-mosaic';

  const shapes = shown.map((a) => {
    const scope = a.scope === 'panel' ? (panels.find((p) => p.id === a.panelId)?.rect ?? PAGE_RECT) : PAGE_RECT;
    const pts = a.points.map((p) => toView(p, scope));
    if (!pts.length) return null;
    const color = a.color || '#e0453a';
    const width = sw(a.width ?? 0.0035);
    const font = fs(a.fontSize ?? 0.035);
    const first = pts[0];
    const last = pts[pts.length - 1];

    switch (a.kind) {
      case 'arrow': {
        if (pts.length < 2) return null;
        const angle = Math.atan2(last.y - first.y, last.x - first.x);
        const size = Math.max(8, width * 4);
        const spread = Math.PI / 7;
        const p1 = { x: last.x - size * Math.cos(angle - spread), y: last.y - size * Math.sin(angle - spread) };
        const p2 = { x: last.x - size * Math.cos(angle + spread), y: last.y - size * Math.sin(angle + spread) };
        return (
          <g key={a.id} stroke={color} fill="none" strokeWidth={num(width)} strokeLinecap="round">
            <line x1={num(first.x)} y1={num(first.y)} x2={num(last.x)} y2={num(last.y)} />
            <polygon
              points={`${num(last.x)},${num(last.y)} ${num(p1.x)},${num(p1.y)} ${num(p2.x)},${num(p2.y)}`}
              fill={color}
              stroke="none"
            />
          </g>
        );
      }
      case 'rect':
        return (
          <rect
            key={a.id}
            x={num(Math.min(first.x, last.x))}
            y={num(Math.min(first.y, last.y))}
            width={num(Math.abs(last.x - first.x))}
            height={num(Math.abs(last.y - first.y))}
            fill="none"
            stroke={color}
            strokeWidth={num(width)}
          />
        );
      case 'ellipse':
        return (
          <ellipse
            key={a.id}
            cx={num((first.x + last.x) / 2)}
            cy={num((first.y + last.y) / 2)}
            rx={num(Math.abs(last.x - first.x) / 2)}
            ry={num(Math.abs(last.y - first.y) / 2)}
            fill="none"
            stroke={color}
            strokeWidth={num(width)}
          />
        );
      case 'highlight':
        if (pts.length < 2) return null;
        return (
          <line
            key={a.id}
            x1={num(first.x)}
            y1={num(first.y)}
            x2={num(last.x)}
            y2={num(last.y)}
            stroke={color}
            strokeWidth={num(Math.max(6, width * 4))}
            strokeOpacity={0.35}
            strokeLinecap="round"
          />
        );
      case 'pen':
        return (
          <polyline
            key={a.id}
            points={pts.map((p) => `${num(p.x)},${num(p.y)}`).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={num(width)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      case 'text':
        return (
          <text
            key={a.id}
            x={num(first.x)}
            y={num(first.y)}
            fill={color}
            fontSize={num(font)}
            fontWeight={600}
            paintOrder="stroke"
            stroke="rgba(255,255,255,0.9)"
            strokeWidth={num(Math.max(2, font / 8))}
            strokeLinejoin="round"
          >
            {a.text ?? ''}
          </text>
        );
      case 'badge':
        return (
          <g key={a.id}>
            <circle cx={num(first.x)} cy={num(first.y)} r={num(font * 0.62)} fill={color} />
            <text
              x={num(first.x)}
              y={num(first.y)}
              fill="#fff"
              fontSize={num(font)}
              fontWeight={700}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {a.text ?? '1'}
            </text>
          </g>
        );
      case 'mosaic':
        return (
          <rect
            key={a.id}
            x={num(Math.min(first.x, last.x))}
            y={num(Math.min(first.y, last.y))}
            width={num(Math.abs(last.x - first.x))}
            height={num(Math.abs(last.y - first.y))}
            fill={`url(#${mosaicId})`}
          />
        );
      default:
        return null;
    }
  });

  const leaders = shown.map((a) => {
    const scope = a.scope === 'panel' ? (panels.find((p) => p.id === a.panelId)?.rect ?? PAGE_RECT) : PAGE_RECT;
    const leader = annotationLeader(a, scope);
    if (!leader) return null;
    const from = toView(leader.from, PAGE_RECT);
    const to = toView(leader.to, PAGE_RECT);
    const color = a.color || '#e0453a';
    return (
      <g key={`leader-${a.id}`} stroke={color} fill="none" opacity={0.9}>
        <line
          x1={num(from.x)}
          y1={num(from.y)}
          x2={num(to.x)}
          y2={num(to.y)}
          strokeWidth={num(sw(0.0015))}
          strokeDasharray="4 3"
        />
        <circle cx={num(to.x)} cy={num(to.y)} r={num(sw(0.004))} fill={color} stroke="none" />
      </g>
    );
  });

  return (
    <svg className="ann-crop" viewBox={`0 0 ${vw} ${vh}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <pattern id={mosaicId} width="10" height="10" patternUnits="userSpaceOnUse">
          <rect width="10" height="10" fill="#9aa0a6" />
          <rect width="5" height="5" fill="#6b7280" />
          <rect x="5" y="5" width="5" height="5" fill="#6b7280" />
        </pattern>
      </defs>
      {leaders}
      {shapes}
    </svg>
  );
}
