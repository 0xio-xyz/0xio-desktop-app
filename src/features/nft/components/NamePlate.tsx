import type { CSSProperties } from "react";
import { ONS_SUFFIX } from "src/services/names/ons";

const STEPS = {
  tile: [
    [16, 9.5],
    [26, 8],
    [Infinity, 7],
  ],
  page: [
    [20, 6.5],
    [28, 5.5],
    [Infinity, 4.75],
  ],
} as const;

const PAD = { tile: "p-[8cqw]", page: "p-[5cqw]" } as const;

export default function NamePlate({
  name,
  inactive,
  size = "tile",
}: {
  name: string | null;
  inactive?: boolean;
  size?: "tile" | "page";
}) {
  const whole = name ?? "";
  const dotted = whole.endsWith(ONS_SUFFIX);
  const label = dotted ? whole.slice(0, -ONS_SUFFIX.length) : whole;
  const cqw = STEPS[size].find(([max]) => whole.length <= max)![1];
  return (
    <div data-name-plate={size} className="@container absolute inset-0">
      <div
        className={`flex size-full flex-col justify-between ${PAD[size]} ${inactive ? "look-plate-off" : "look-plate"}`}
      >
        <p
          className={`text-[max(var(--plate-type),0.6875rem)] leading-[1.2] font-semibold tracking-[-0.01em] wrap-anywhere ${
            inactive ? "text-content-muted" : "text-content"
          }`}
          style={{ "--plate-type": `${cqw}cqw` } as CSSProperties}
        >
          {label}
          {dotted && <span className="whitespace-nowrap">{ONS_SUFFIX}</span>}
        </p>
      </div>
    </div>
  );
}
