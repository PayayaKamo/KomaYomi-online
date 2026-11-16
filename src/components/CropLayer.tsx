import type { AlignOffset, Panel } from '../types';

/** One language image cropped to a panel rect, with the page/panel alignment offset applied. */
export function CropLayer({
  url,
  rect,
  offset,
  opacity,
  blend,
}: {
  url: string;
  rect: Panel['rect'];
  offset: AlignOffset;
  opacity: number;
  blend: boolean;
}) {
  return (
    <div
      className={`crop-inner ${blend ? 'blend' : ''}`}
      style={{
        transform: `translate(${offset.x * 100}%, ${offset.y * 100}%) scale(${offset.scale})`,
        opacity,
      }}
    >
      <img
        src={url}
        alt=""
        draggable={false}
        style={{
          width: `${100 / rect.w}%`,
          height: `${100 / rect.h}%`,
          left: `${-(rect.x / rect.w) * 100}%`,
          top: `${-(rect.y / rect.h) * 100}%`,
        }}
      />
    </div>
  );
}
