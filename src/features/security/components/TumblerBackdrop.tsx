import { useMemo, useRef } from "react";
import type { Tumbler } from "src/features/security/services/tumblerEngine";
import { tumblerReading, type LockPrice } from "src/features/security/services/tumblerDraw";
import { useTumblerCanvas, useTumblerPalette } from "src/features/security/hooks/useTumbler";

export default function TumblerBackdrop({
  tumbler,
  price,
}: {
  tumbler: Tumbler;
  price: LockPrice | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const palette = useTumblerPalette();
  const reading = useMemo(() => tumblerReading(price), [price]);
  useTumblerCanvas(canvasRef, tumbler, palette, reading);
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ background: palette.bg }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </div>
  );
}
