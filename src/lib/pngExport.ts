import type { Annotation, Lang, PageEntry, Panel, PanelRect } from '../types';
import { langLabel, t } from '../i18n';

export type PngMode = 'page' | 'panel' | 'collage';

export type PngExportOptions = {
  page: PageEntry;
  /** Language used for single-page / single-panel export. */
  lang: Lang;
  /** Languages for the collage, in order. */
  langs: Lang[];
  /** Panel rect; when set, only that panel is cropped. */
  rect?: PanelRect | null;
  mode: PngMode;
  /** Filename prefix, e.g. `vol14-172-P1`. */
  filenameBase: string;
  /** Page-level vector annotations; panel-scoped ones are mapped back to the full page via the rect in panels. */
  annotations?: Annotation[];
  /** Whether to bake annotations into the PNG (off = original image). */
  includeAnnotations?: boolean;
  panels?: Panel[];
};

/** Collage layout constants (logical pixels before scaling). */
const PAD = 32;
const GAP = 32;
const LABEL_H = 48;
const PAGE_HEIGHT = 1600;
const PANEL_HEIGHT = 1200;
const MAX_WIDTH = 4200;

type CropRect = { sx: number; sy: number; sw: number; sh: number };

/** Load an image (same-origin URLs need no crossOrigin). */
function loadImage(src: string, lang: Lang): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t('png.loadImageFailed', { lang: langLabel(lang), src })));
    img.src = src;
  });
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Convert a normalized rect into source-pixel crop bounds, rounding and clamping to the image. */
function cropRect(img: HTMLImageElement, rect?: PanelRect | null): CropRect {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  if (!rect) return { sx: 0, sy: 0, sw: W, sh: H };
  const sx = clamp(Math.round(rect.x * W), 0, Math.max(0, W - 1));
  const sy = clamp(Math.round(rect.y * H), 0, Math.max(0, H - 1));
  const sw = clamp(Math.round(rect.w * W), 1, W - sx);
  const sh = clamp(Math.round(rect.h * H), 1, H - sy);
  return { sx, sy, sw, sh };
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('png.canvasContext'));
  return ctx;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error(t('png.canvasEmpty')));
    }, 'image/png');
  });
}

/** Trigger a download through a temporary anchor, removed right after. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Release after a delay; some browsers cancel the download if the URL is revoked immediately.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderPage(img: HTMLImageElement, draw?: AnnDraw): HTMLCanvasElement {
  const canvas = createCanvas(img.naturalWidth, img.naturalHeight);
  const ctx = get2d(canvas);
  ctx.drawImage(img, 0, 0);
  if (draw?.annotations.length) {
    drawAnnotations(ctx, draw, img, img.naturalWidth, img.naturalHeight);
  }
  return canvas;
}

function renderPanel(img: HTMLImageElement, rect: PanelRect, draw?: AnnDraw): HTMLCanvasElement {
  const crop = cropRect(img, rect);
  const canvas = createCanvas(crop.sw, crop.sh);
  const ctx = get2d(canvas);
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
  if (draw?.annotations.length) {
    // Annotations are authored in full-page pixels, so shift the origin to the crop.
    ctx.save();
    ctx.translate(-crop.sx, -crop.sy);
    drawAnnotations(ctx, draw, img, img.naturalWidth, img.naturalHeight);
    ctx.restore();
  }
  return canvas;
}

type AnnDraw = { annotations: Annotation[]; panels: Panel[] };

/** Panel rect that owns an annotation's normalized coordinates. */
function scopeRect(a: Annotation, panels: Panel[]): PanelRect {
  if (a.scope !== 'panel' || !a.panelId) return { x: 0, y: 0, w: 1, h: 1 };
  return panels.find((p) => p.id === a.panelId)?.rect ?? { x: 0, y: 0, w: 1, h: 1 };
}

/** Convert normalized annotation points to source-image pixels. */
function annotationPoints(a: Annotation, panels: Panel[], imageW: number, imageH: number) {
  const scope = scopeRect(a, panels);
  return a.points.map((p) => ({
    x: (scope.x + p.x * scope.w) * imageW,
    y: (scope.y + p.y * scope.h) * imageH,
  }));
}

/**
 * Redaction: sample the region at a reduced size and blow it back up with smoothing
 * off. This bakes real pixelation into the PNG instead of the live backdrop blur.
 */
function drawMosaic(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (w < 1 || h < 1) return;
  const block = Math.max(6, Math.round(Math.min(w, h) / 14));
  const small = createCanvas(Math.max(1, Math.floor(w / block)), Math.max(1, Math.floor(h / block)));
  get2d(small).drawImage(img, x, y, w, h, 0, 0, small.width, small.height);
  const previous = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  ctx.imageSmoothingEnabled = previous;
}

/** Rasterize every mark in source-image pixel space; callers set the transform. */
function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  draw: AnnDraw,
  img: HTMLImageElement,
  imageW: number,
  imageH: number,
): void {
  for (const a of draw.annotations) {
    const pts = annotationPoints(a, draw.panels, imageW, imageH);
    if (pts.length === 0) continue;
    const color = a.color ?? '#e0453a';
    const lineWidth = Math.max(1, (a.width ?? 0.0035) * imageW);
    const first = pts[0];
    const last = pts[pts.length - 1];
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (a.kind) {
      case 'arrow': {
        if (pts.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(first.x, first.y);
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
        const angle = Math.atan2(last.y - first.y, last.x - first.x);
        const size = Math.max(10, lineWidth * 4);
        const spread = Math.PI / 7;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(last.x - size * Math.cos(angle - spread), last.y - size * Math.sin(angle - spread));
        ctx.lineTo(last.x - size * Math.cos(angle + spread), last.y - size * Math.sin(angle + spread));
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'rect':
        ctx.strokeRect(
          Math.min(first.x, last.x),
          Math.min(first.y, last.y),
          Math.abs(last.x - first.x),
          Math.abs(last.y - first.y),
        );
        break;
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse(
          (first.x + last.x) / 2,
          (first.y + last.y) / 2,
          Math.abs(last.x - first.x) / 2,
          Math.abs(last.y - first.y) / 2,
          0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
        break;
      case 'highlight':
        if (pts.length < 2) break;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = Math.max(6, lineWidth * 4);
        ctx.beginPath();
        ctx.moveTo(first.x, first.y);
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
        break;
      case 'pen':
        if (pts.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(first.x, first.y);
        for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
        break;
      case 'text': {
        const fontSize = Math.max(10, (a.fontSize ?? 0.035) * imageH);
        ctx.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.lineWidth = Math.max(2, fontSize / 8);
        // White halo keeps the text readable over dark screentones.
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeText(a.text ?? '', first.x, first.y);
        ctx.fillStyle = color;
        ctx.fillText(a.text ?? '', first.x, first.y);
        break;
      }
      case 'badge': {
        const fontSize = Math.max(10, (a.fontSize ?? 0.035) * imageH);
        const r = fontSize * 0.62;
        ctx.beginPath();
        ctx.arc(first.x, first.y, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `700 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(a.text ?? '1', first.x, first.y);
        break;
      }
      case 'mosaic':
        drawMosaic(
          ctx,
          img,
          Math.min(first.x, last.x),
          Math.min(first.y, last.y),
          Math.abs(last.x - first.x),
          Math.abs(last.y - first.y),
        );
        break;
      default:
        break;
    }
    ctx.restore();
  }
}

async function renderCollage(
  page: PageEntry,
  langs: Lang[],
  rect?: PanelRect | null,
  draw?: AnnDraw,
): Promise<HTMLCanvasElement> {
  const jobs = langs.flatMap((lang) => {
    const src = page.files[lang];
    return src ? [{ lang, src }] : [];
  });
  if (jobs.length === 0) throw new Error(t('png.noImages'));

  const items = await Promise.all(
    jobs.map(async ({ lang, src }) => {
      const img = await loadImage(src, lang);
      return { lang, img, crop: cropRect(img, rect) };
    }),
  );

  const targetH = rect ? PANEL_HEIGHT : PAGE_HEIGHT;
  const widths = items.map((it) => Math.max(1, Math.round((it.crop.sw / it.crop.sh) * targetH)));
  const contentW = widths.reduce((sum, w) => sum + w, 0) + GAP * (items.length - 1);
  const totalW = PAD * 2 + contentW;
  const totalH = PAD * 2 + targetH + LABEL_H;
  // Scale everything down proportionally when the total width exceeds the limit.
  const scale = totalW > MAX_WIDTH ? MAX_WIDTH / totalW : 1;

  const canvas = createCanvas(Math.round(totalW * scale), Math.round(totalH * scale));
  const ctx = get2d(canvas);
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, totalW, totalH);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '24px system-ui, sans-serif';

  let x = PAD;
  items.forEach((it, i) => {
    const w = widths[i];
    ctx.drawImage(it.img, it.crop.sx, it.crop.sy, it.crop.sw, it.crop.sh, x, PAD, w, targetH);
    if (draw?.annotations.length) {
      // Map full-page pixel coordinates into this language's slot, then clip so marks
      // never bleed into the neighbouring column.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, PAD, w, targetH);
      ctx.clip();
      ctx.translate(x, PAD);
      ctx.scale(w / it.crop.sw, targetH / it.crop.sh);
      ctx.translate(-it.crop.sx, -it.crop.sy);
      drawAnnotations(ctx, draw, it.img, it.img.naturalWidth, it.img.naturalHeight);
      ctx.restore();
    }
    // Label strip along the bottom.
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(x, PAD + targetH, w, LABEL_H);
    ctx.fillStyle = '#000';
    ctx.fillText(langLabel(it.lang), x + w / 2, PAD + targetH + LABEL_H / 2);
    x += w + GAP;
  });

  return canvas;
}

/** Export and trigger a browser download; rejects with Error on failure. */
export async function exportPng(opts: PngExportOptions): Promise<void> {
  const { page, lang, langs, rect, mode, filenameBase } = opts;
  // Callers pass annotations only when the user wants them baked in; an explicit
  // false still wins, so "original image" is one checkbox away.
  const draw =
    opts.includeAnnotations !== false && opts.annotations?.length
      ? { annotations: opts.annotations, panels: opts.panels ?? [] }
      : undefined;
  let canvas: HTMLCanvasElement;

  if (mode === 'collage') {
    canvas = await renderCollage(page, langs, rect, draw);
  } else {
    const src = page.files[lang];
    if (!src) throw new Error(t('png.missingImage', { lang: langLabel(lang) }));
    const img = await loadImage(src, lang);
    if (mode === 'panel') {
      if (!rect) throw new Error(t('png.panelRectRequired'));
      canvas = renderPanel(img, rect, draw);
    } else {
      canvas = renderPage(img, draw);
    }
  }

  try {
    const blob = await canvasToBlob(canvas);
    downloadBlob(blob, `${filenameBase}-${mode}.png`);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
