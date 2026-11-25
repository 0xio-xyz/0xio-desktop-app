import "src/css/mascot.css";

/** awake states: op opening (dial), up awake loop, zz dozing off, s0 asleep, ld working (dial loop), ok done, en layers pressing in, de layers lifting off */
export type MascotPhase = "op" | "up" | "zz" | "s0" | "ld" | "ok" | "en" | "de";

const CAP =
  "M 30 14 H 70 A 12 12 0 0 1 82 26 V 41 C 82 45.95 85.96 50 94 50 C 85.96 50 82 54.05 82 59 V 74 A 12 12 0 0 1 70 86 H 30 A 12 12 0 0 1 18 74 V 59 C 18 54.05 14.04 50 6 50 C 14.04 50 18 45.95 18 41 V 26 A 12 12 0 0 1 30 14 Z";

const ARM_L = "M 26 41 H 18 C 18 45.95 14.04 50 6 50 C 14.04 50 18 54.05 18 59 H 26 Z";
const ARM_R = "M 74 41 H 82 C 82 45.95 85.96 50 94 50 C 85.96 50 82 54.05 82 59 H 74 Z";
const Z = "M -3 -3 H 3 L -3 3 H 3";
const ZS: [number, number, number][] = [
  [80, 12, 0.8],
  [88, 4, 1],
  [97, -5, 1.25],
];

interface MascotProps {
  phase: MascotPhase;
  size?: number;
  /** Slash tilt toward the pointer, degrees, only while awake. */
  lookDeg?: number;
  /** Body lean toward the pointer, px on the 100 grid, only while awake. */
  leanX?: number;
  id: string;
}

export default function Mascot({ phase, size = 96, lookDeg = 0, leanX = 0, id }: MascotProps) {
  const awake = phase === "up";
  const layers = phase === "en" || phase === "de";
  return (
    <span className="oxio-mascot" style={{ display: "inline-flex", width: size, height: size }}>
      <svg
        className={`m ${phase} wB lp3`}
        width={size}
        height={size}
        viewBox="0 0 100 100"
        style={{ overflow: "visible" }}
        role="img"
        aria-label="0xio"
      >
        <defs>
          <clipPath id={`mascot-ledge-${id}`}>
            <rect x="-30" y="-40" width="160" height="128" />
          </clipPath>
        </defs>
        {layers && (
          <g>
            <path className="ly lyA" d={CAP} />
            <path className="ly lyB" d={CAP} />
          </g>
        )}
        <g clipPath={`url(#mascot-ledge-${id})`}>
          <g
            className="mlean"
            style={{
              transform: awake ? `translateX(${leanX}px) rotate(${leanX * 0.8}deg)` : "none",
            }}
          >
            <g className="wrap">
              <path className="arm-l body" d={ARM_L} />
              <path className="arm-r body" d={ARM_R} />
              <rect className="body" x="18" y="14" width="64" height="72" rx="12" />
              <g
                className="mfollow"
                style={{ transform: awake ? `rotate(${lookDeg}deg)` : "none" }}
              >
                <g className="dial">
                  <line
                    className="face"
                    x1="41"
                    y1="72"
                    x2="59"
                    y2="28"
                    strokeWidth="12"
                    strokeLinecap="round"
                  />
                </g>
              </g>
            </g>
          </g>
        </g>
        <g>
          {ZS.map(([x, y, k], i) => (
            <g key={i} transform={`translate(${x} ${y}) scale(${k})`}>
              <path
                className={`z z${i + 1}`}
                d={Z}
                fill="none"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          ))}
        </g>
      </svg>
    </span>
  );
}
