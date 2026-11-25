import { useId, useMemo } from "react";
import { useTranslation } from "src/i18n/react";
import { NAV_LABEL_KEYS } from "src/shared/layout/navCatalog";
import i18n from "src/i18n";
import { PanelCaption, StatusPanel } from "src/features/settings/components/parts";
import { useTumblerPalette } from "src/features/security/hooks/useTumbler";
import { REST } from "src/features/security/services/tumblerEngine";
import { TOOTH_W, tumblerShapes } from "src/features/security/services/tumblerDraw";
import {
  DEFAULT_SIZES,
  resolveTrayTheme,
  type AppearanceSettings,
  type LockPriceRange,
  type TrayTheme,
} from "src/features/settings/services/appearance";

const EASE = { transition: "fill 250ms ease-out, stroke 250ms ease-out" };

type Resolved = Exclude<TrayTheme, "auto">;

interface TrayInk {
  from: string;
  to: string;
  fg: string;
  muted: string;
  key: string;
  lens: string;
  mono?: boolean;
}

const TRAY_INK: Record<Resolved, TrayInk> = {
  smoke: {
    from: "#22252e",
    to: "#15171d",
    fg: "#f2f2f5",
    muted: "rgba(242,242,245,0.56)",
    key: "rgba(122,162,255,0.22)",
    lens: "rgba(255,255,255,0.08)",
  },
  frost: {
    from: "#f6f7fa",
    to: "#dfe2ea",
    fg: "#14142b",
    muted: "rgba(20,20,43,0.56)",
    key: "rgba(0,0,219,0.12)",
    lens: "rgba(255,255,255,0.75)",
  },
  octra: {
    from: "#1515c8",
    to: "#000096",
    fg: "#ffffff",
    muted: "rgba(255,255,255,0.6)",
    key: "rgba(0,212,255,0.22)",
    lens: "rgba(255,255,255,0.12)",
  },
  clear: {
    from: "#3d4049",
    to: "#2a2c33",
    fg: "#ffffff",
    muted: "rgba(255,255,255,0.66)",
    key: "rgba(255,255,255,0.22)",
    lens: "rgba(255,255,255,0.14)",
  },
  phosphor: {
    from: "#07140d",
    to: "#020604",
    fg: "#d8ffe9",
    muted: "rgba(216,255,233,0.54)",
    key: "rgba(93,211,158,0.18)",
    lens: "rgba(93,211,158,0.08)",
    mono: true,
  },
  ember: {
    from: "#2a1a0e",
    to: "#160c06",
    fg: "#fff4ea",
    muted: "rgba(255,244,234,0.56)",
    key: "rgba(255,176,103,0.2)",
    lens: "rgba(255,236,220,0.08)",
  },
  cli: {
    from: "#0e0e10",
    to: "#0a0a0c",
    fg: "#e8e8e8",
    muted: "rgba(232,232,232,0.5)",
    key: "rgba(93,211,158,0.2)",
    lens: "rgba(255,255,255,0.06)",
    mono: true,
  },
  original: {
    from: "var(--bg-1)",
    to: "var(--bg-1)",
    fg: "var(--fg)",
    muted: "var(--fg-3)",
    key: "var(--accent)",
    lens: "var(--bg-2)",
  },
};

export const TRAY_NAMES: Record<Resolved, string> = {
  original: "Original",
  smoke: "Smoke",
  frost: "Frost",
  octra: "Octra",
  clear: "Clear",
  phosphor: "Phosphor",
  ember: "Ember",
  cli: "CLI",
};

const CHART =
  "0,40 14,36 28,38 42,30 56,33 70,24 84,27 98,19 112,22 126,14 140,17 154,9 168,12 182,6";

function MiniApp({ settings }: { settings: AppearanceSettings }) {
  const clip = `${useId()}side`;
  const scale = settings.sizes.itemLabelPx / DEFAULT_SIZES.itemLabelPx;
  const capScale = settings.sizes.categoryPx / DEFAULT_SIZES.categoryPx;
  const rows: { y: number; w: number; tone: string; h: number; on?: boolean }[] = [];
  let y = 40;
  settings.groups.forEach((g, gi) => {
    if (gi > 0) {
      y += 6 * capScale;
      rows.push({ y, w: Math.min(30, g.title.length * 2.4), tone: "var(--fg-3)", h: 3 * capScale });
      y += 8 * capScale;
    }
    g.paths.forEach((p) => {
      const w = Math.min(46, 8 + (NAV_LABEL_KEYS[p] ? i18n.t(NAV_LABEL_KEYS[p]) : p).length * 2.4);
      rows.push({ y, w, tone: "var(--fg-3)", h: 4.5 * scale, on: p === "/" });
      y += 9 * scale;
    });
  });
  const accent = settings.accentHex ?? "var(--fg)";
  return (
    <svg viewBox="0 0 316 198" className="block h-auto w-full rounded-[14px]" aria-hidden="true">
      <rect width="316" height="198" style={{ fill: "var(--bg)", ...EASE }} />
      <rect
        x="10"
        y="12"
        width="12"
        height="12"
        rx="3.5"
        style={{ fill: "var(--bg-3)", ...EASE }}
      />
      <rect
        x="27"
        y="15.5"
        width="30"
        height="5"
        rx="2.5"
        style={{ fill: "var(--fg-2)", ...EASE }}
      />
      <clipPath id={clip}>
        <rect x="0" y="30" width="80" height="160" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        {rows.map((r, i) =>
          r.on ? (
            <g key={i}>
              <rect
                x="5"
                y={r.y - 4}
                width="68"
                height={r.h + 8}
                rx="5"
                style={{ fill: "var(--bg-1)", ...EASE }}
              />
              <rect
                x="10"
                y={r.y}
                width={r.w}
                height={r.h}
                rx={r.h / 2}
                style={{ fill: "var(--fg)", ...EASE }}
              />
            </g>
          ) : (
            <rect
              key={i}
              x="10"
              y={r.y}
              width={r.w}
              height={r.h}
              rx={r.h / 2}
              style={{ fill: r.tone, ...EASE }}
            />
          ),
        )}
      </g>
      <text x="96" y="30" fontSize="7" letterSpacing="1.1" style={{ fill: "var(--fg-3)" }}>
        BALANCE
      </text>
      <text
        x="95"
        y="62"
        fontSize="26"
        fontWeight="300"
        letterSpacing="-1"
        style={{ fill: "var(--fg)" }}
      >
        12,480
        <tspan style={{ fill: "var(--fg-3)" }}>.52</tspan>
      </text>
      <polyline
        points={CHART}
        transform="translate(96 74)"
        fill="none"
        strokeWidth="1.6"
        strokeLinejoin="round"
        style={{ stroke: "var(--pos)", ...EASE }}
      />
      <rect x="96" y="170" width="44" height="16" rx="8" style={{ fill: accent, ...EASE }} />
      <rect
        x="145"
        y="170"
        width="44"
        height="16"
        rx="8"
        style={{ fill: "var(--bg-2)", ...EASE }}
      />
      <rect
        x="194"
        y="170"
        width="44"
        height="16"
        rx="8"
        style={{ fill: "var(--bg-2)", ...EASE }}
      />
    </svg>
  );
}

function MiniTray({ theme, label }: { theme: Resolved; label: string }) {
  const id = useId();
  const ink = TRAY_INK[theme];
  const font = ink.mono ? "var(--font-mono)" : "inherit";
  return (
    <svg viewBox="0 0 150 118" className="block h-auto w-full" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}g`} cx="50%" cy="45%" r="75%">
          <stop offset="0%" style={{ stopColor: ink.from }} />
          <stop offset="100%" style={{ stopColor: ink.to }} />
        </radialGradient>
      </defs>
      <rect width="150" height="118" rx="16" fill={`url(#${id}g)`} />
      <text x="12" y="19" fontSize="7.5" fontFamily="var(--font-mono)" style={{ fill: ink.muted }}>
        {label}
      </text>
      <text
        x="75"
        y="56"
        textAnchor="middle"
        fontSize="19"
        fontWeight="300"
        letterSpacing="-0.5"
        fontFamily={font}
        style={{ fill: ink.fg }}
      >
        12,480
      </text>
      <rect x="12" y="88" width="38" height="18" rx="9" style={{ fill: ink.key }} />
      <rect x="56" y="88" width="38" height="18" rx="9" style={{ fill: ink.lens }} />
      <rect x="100" y="88" width="38" height="18" rx="9" style={{ fill: ink.lens }} />
    </svg>
  );
}

const MINI_LEVELS: Record<LockPriceRange, number[]> = {
  "24h": [0, 1, 1, 2, 1, 2, 3, 3],
  "7d": [2, 1, 2, 0, 1, 1, 2, 3],
  "30d": [1, 2, 1, 3, 2, 1, 0, 1],
};

function MiniLock({ range, label }: { range: LockPriceRange; label: string }) {
  const palette = useTumblerPalette();
  const { pills, anchor } = useMemo(() => tumblerShapes(REST, MINI_LEVELS[range]), [range]);
  return (
    <svg viewBox="0 0 760 598" className="block h-auto w-full" aria-hidden="true">
      <rect width="760" height="598" rx="81" style={{ fill: palette.bg, ...EASE }} />
      <g fill="none" strokeLinecap="round" strokeWidth={TOOTH_W * 1.25}>
        {pills.map((p, i) => (
          <line
            key={i}
            x1={p.x1}
            y1={p.y1}
            x2={p.x2 + (p.x1 === p.x2 && p.y1 === p.y2 ? 0.01 : 0)}
            y2={p.y2}
            style={{ stroke: p.lit ? palette.lit : palette.shape, ...EASE }}
          />
        ))}
      </g>
      <text
        x={anchor.x2 + 24}
        y={anchor.y2 + 64}
        fontSize="44"
        fontWeight="500"
        style={{ fill: palette.label, ...EASE }}
      >
        {label}
      </text>
    </svg>
  );
}

const THEME_LABEL: Record<string, string> = {
  dim: "preferences.dim",
  light: "preferences.light",
  octra: "preferences.octra",
};

const RANGE_LABEL: Record<LockPriceRange, string> = {
  "24h": "settings.octDaily",
  "7d": "settings.octWeekly",
  "30d": "settings.octMonthly",
};

export default function AppearancePanel({
  settings,
  theme,
}: {
  settings: AppearanceSettings;
  theme: string;
}) {
  const { t } = useTranslation();
  const tray = resolveTrayTheme(settings.trayTheme, theme);
  return (
    <StatusPanel>
      <PanelCaption right={t(THEME_LABEL[theme] ?? "preferences.dim")}>
        {t("settings.preview")}
      </PanelCaption>
      <div className="mt-4">
        <MiniApp settings={settings} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <MiniTray theme={tray} label={t("settings.privateProofsOn")} />
          <span className="truncate text-meta text-content-muted">
            {t("settings.menuBarNamed", { name: TRAY_NAMES[tray] })}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <MiniLock
            range={settings.lockPriceRange}
            label={t(RANGE_LABEL[settings.lockPriceRange])}
          />
          <span className="truncate text-meta text-content-muted">{t("settings.lockScreen")}</span>
        </div>
      </div>
    </StatusPanel>
  );
}
