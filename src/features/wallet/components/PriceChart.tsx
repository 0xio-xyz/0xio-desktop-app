import { useCallback, useMemo, useRef, useState } from "react";
import type { PricePoint } from "src/hooks/wallet/useTokenPrice";

const W = 1000;
const H = 400;
const PAD = 12;
const MAX_POINTS = 300;

function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

export function samplePoints(points: PricePoint[]): PricePoint[] {
  if (points.length <= MAX_POINTS) return points;
  const step = (points.length - 1) / (MAX_POINTS - 1);
  return Array.from({ length: MAX_POINTS }, (_, i) => points[Math.round(i * step)]);
}

export default function PriceChart({
  points,
  color,
  label,
  format,
  onScrub,
}: {
  points: PricePoint[];
  color: string;
  label: string;
  format: (value: number) => string;
  onScrub: (point: PricePoint | null) => void;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ index: number; of: PricePoint[] } | null>(null);

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const values = points.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => ({
      x: (i / (values.length - 1)) * W,
      y: H - PAD - ((v - min) / span) * (H - PAD * 2),
    }));
    return { min, max, pts, line: smoothPath(pts) };
  }, [points]);

  const pick = useCallback(
    (index: number | null) => {
      setAt(index == null ? null : { index, of: points });
      onScrub(index == null ? null : points[index]);
    },
    [points, onScrub],
  );

  const move = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || points.length < 2) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    pick(Math.round(ratio * (points.length - 1)));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (points.length < 2) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const from = at?.of === points ? at.index : points.length - 1;
      pick(Math.max(0, Math.min(points.length - 1, from + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Escape") {
      pick(null);
    }
  };

  if (!geom) return <div className="h-full" />;

  const hover = at?.of === points ? geom.pts[at.index] : null;

  return (
    <div className="relative h-full">
      <div
        ref={plotRef}
        role="img"
        tabIndex={0}
        aria-label={label}
        data-testid="price-chart"
        onMouseMove={(e) => move(e.clientX)}
        onMouseLeave={() => pick(null)}
        onKeyDown={onKeyDown}
        onBlur={() => pick(null)}
        className="absolute inset-y-0 right-17.5 left-0 cursor-crosshair outline-none select-none"
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          className="block"
        >
          <path
            d={geom.line}
            fill="none"
            stroke={color}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {hover && (
          <>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px bg-content-muted opacity-70"
              style={{ left: `${(hover.x / W) * 100}%` }}
            />
            <span
              aria-hidden="true"
              data-testid="price-chart-dot"
              className="pointer-events-none absolute size-2.75 -translate-1/2 rounded-full bg-content shadow-[0_0_0_3px_var(--bg)]"
              style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%` }}
            />
          </>
        )}
      </div>
      <span className="pointer-events-none absolute top-0.5 right-0 text-micro text-content-muted tabular-nums">
        {format(geom.max)}
      </span>
      <span className="pointer-events-none absolute right-0 bottom-0.5 text-micro text-content-muted tabular-nums">
        {format(geom.min)}
      </span>
    </div>
  );
}
