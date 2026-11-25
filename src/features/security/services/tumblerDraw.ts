import {
  BOLT_PX,
  RING_RADII,
  type TumblerState,
} from "src/features/security/services/tumblerEngine";

export interface LockPrice {
  value: number;
  change?: number;
  label: string;
  history: { time: number; value: number }[];
}

export interface TumblerReading {
  levels: number[];
  price: string;
  change: string;
}

export interface TumblerPalette {
  bg: string;
  shape: string;
  lit: string;
  label: string;
  labelMuted: string;
}

interface Pill {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lit: boolean;
}

type RGB = [number, number, number];

const BOARD_W = 1280;
const BOARD_H = 800;
export const TOOTH_W = 12;
const HISTORY = 8;
const LEVELS = 3;
const BOLT_R = 196;
const LABEL_GAP = 18;
const DIAGONAL = 135;
const TILT = Math.atan2(18, 44);
const CT = Math.cos(TILT);
const ST = Math.sin(TILT);
const SHAPE_CONTRAST = 1.12;

export const TUMBLER_TONES: Record<"dim" | "light", TumblerPalette> = {
  dim: { bg: "#090909", shape: "#171717", lit: "#e8e8e8", label: "#bdbdbd", labelMuted: "#8f8f8f" },
  light: {
    bg: "#f6f6f6",
    shape: "#e8e8e8",
    lit: "#1f1f1f",
    label: "#4d4d4d",
    labelMuted: "#666666",
  },
};

export function parseColor(value: string): RGB | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  return rgb ? [+rgb[1], +rgb[2], +rgb[3]] : null;
}

const toHex = (c: RGB) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

function luminance(c: RGB): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: RGB, b: RGB) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

export function shapeTone(bg: string, text: string): string {
  const b = parseColor(bg);
  const t = parseColor(text);
  if (!b || !t) return bg;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const m = (lo + hi) / 2;
    if (contrast(mix(b, t, m), b) < SHAPE_CONTRAST) lo = m;
    else hi = m;
  }
  return toHex(mix(b, t, hi));
}

interface ThemeColors {
  bg: string;
  text: string;
  secondary: string;
  muted: string;
}

export function tumblerPalette(theme: string | null, colors: ThemeColors): TumblerPalette {
  if (theme === "light") return TUMBLER_TONES.light;
  if (!theme || theme === "dim") return TUMBLER_TONES.dim;
  const bg = parseColor(colors.bg);
  const text = parseColor(colors.text);
  if (!bg || !text) return TUMBLER_TONES.dim;
  return {
    bg: toHex(bg),
    shape: shapeTone(colors.bg, colors.text),
    lit: toHex(text),
    label: colors.secondary.trim() || toHex(text),
    labelMuted: colors.muted.trim() || toHex(text),
  };
}

function formatPrice(v: number): string {
  if (v < 0.01) return `$${v.toFixed(6)}`;
  if (v < 1) return `$${v.toFixed(4)}`;
  if (v < 100) return `$${v.toFixed(3)}`;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function priceLevels(values: number[]): number[] {
  if (values.length < 2) return new Array(HISTORY).fill(0);
  const buckets: number[] = [];
  for (let k = 0; k < HISTORY; k++) {
    const a = Math.floor((k * values.length) / HISTORY);
    const b = Math.max(a + 1, Math.floor(((k + 1) * values.length) / HISTORY));
    let sum = 0;
    for (let j = a; j < b; j++) sum += values[j];
    buckets.push(sum / (b - a));
  }
  buckets[HISTORY - 1] = values[values.length - 1];
  const min = Math.min(...buckets);
  const span = Math.max(...buckets) - min || 1;
  return buckets.map((v) => Math.round(Math.min(1, Math.max(0, (v - min) / span)) * LEVELS));
}

export function tumblerReading(price: LockPrice | null | undefined): TumblerReading | null {
  if (!price || price.history.length < 2) return null;
  const values = price.history.map((p) => p.value);
  const first = values[0];
  const change = price.change ?? (first ? ((price.value - first) / first) * 100 : 0);
  return {
    levels: priceLevels(values),
    price: formatPrice(price.value),
    change: `${change >= 0 ? "+" : ""}${change.toFixed(1)}% ${price.label}`,
  };
}

const visible = (deg: number) => {
  const d = ((deg % 360) + 360) % 360;
  return d > 84 && d < 186;
};

function tooth(r: number, deg: number, length: number, lit: boolean): Pill {
  const a = (deg * Math.PI) / 180;
  const ux = Math.sin(a);
  const uy = -Math.cos(a);
  const x = ux * r;
  const y = uy * r;
  const dx = ux * CT - uy * ST;
  const dy = uy * CT + ux * ST;
  return { x1: x, y1: y, x2: x + dx * length, y2: y + dy * length, lit };
}

/** In board units (1280 by 800, rings round the top left corner). */
export function tumblerShapes(
  state: TumblerState,
  levels: number[],
): { pills: Pill[]; anchor: Pill } {
  const pills: Pill[] = [];
  const level = (j: number) => levels[HISTORY - 1 + j] ?? 0;
  for (let a = 1; a < 40; a++) {
    const d = DIAGONAL + a * 9 + state[2];
    if (visible(d)) pills.push(tooth(RING_RADII[2], d, 0, false));
  }
  for (let a = 1; a < 48; a++) {
    const d = DIAGONAL + a * 7.5 + state[1];
    if (visible(d)) pills.push(tooth(RING_RADII[1], d, TOOTH_W, false));
  }
  for (let a = 0; a < 60; a++) {
    const d = DIAGONAL + a * 6 + state[0];
    if (!visible(d)) continue;
    const j = ((a + 10) % 20) - 10;
    const length = j <= 0 && j >= -7 ? TOOTH_W * (1 + level(j)) : 0;
    pills.push(tooth(RING_RADII[0], d, length, j === 0));
  }
  const ba = (DIAGONAL * Math.PI) / 180;
  const ux = Math.sin(ba);
  const uy = -Math.cos(ba);
  const dx = ux * CT - uy * ST;
  const dy = uy * CT + ux * ST;
  const bx = ux * BOLT_R - dx * state[3] * BOLT_PX;
  const by = uy * BOLT_R - dy * state[3] * BOLT_PX;
  pills.push({ x1: bx, y1: by, x2: bx + dx * BOLT_PX, y2: by + dy * BOLT_PX, lit: false });
  return { pills, anchor: tooth(RING_RADII[0], DIAGONAL, TOOTH_W * (1 + level(0)), true) };
}

export function tumblerScale(width: number, height: number): number {
  const fit = Math.min(width / BOARD_W, height / BOARD_H, (width / 2 - 190) / 380);
  return Math.min(1.5, Math.max(0.5, fit));
}

interface TumblerFrame {
  width: number;
  height: number;
  state: TumblerState;
  palette: TumblerPalette;
  reading: TumblerReading | null;
  font: string;
}

function drawLabel(g: CanvasRenderingContext2D, anchor: Pill, frame: TumblerFrame, k: number) {
  const { reading, palette, font } = frame;
  if (!reading) return;
  const lines = [
    { text: "OCT", font: `600 ${10.5 * k}px ${font}`, color: palette.labelMuted },
    { text: reading.price, font: `500 ${13 * k}px ${font}`, color: palette.label },
    { text: reading.change, font: `400 ${11 * k}px ${font}`, color: palette.labelMuted },
  ];
  const widths = lines.map((l) => {
    g.font = l.font;
    return g.measureText(l.text).width;
  });
  const w = Math.max(...widths);
  const a = (DIAGONAL * Math.PI) / 180;
  const ux = Math.sin(a);
  const uy = -Math.cos(a);
  const dist = LABEL_GAP + (Math.abs(ux) * w) / 2 + (Math.abs(uy) * 43 * k) / 2;
  const left = anchor.x2 + ux * dist - w / 2;
  const top = anchor.y2 + uy * dist - 12.5 * k;
  const align = Math.min(1, Math.max(0, 0.5 - ux * 0.8));
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  lines.forEach((l, i) => {
    g.font = l.font;
    g.fillStyle = l.color;
    g.fillText(l.text, left + (w - widths[i]) * align, top + [0, 16, 31][i] * k);
  });
}

export function drawTumbler(g: CanvasRenderingContext2D, frame: TumblerFrame): void {
  const s = tumblerScale(frame.width, frame.height);
  const { pills, anchor } = tumblerShapes(frame.state, frame.reading?.levels ?? []);
  g.clearRect(0, 0, frame.width, frame.height);
  g.save();
  g.scale(s, s);
  g.lineCap = "round";
  g.lineWidth = TOOTH_W;
  for (const p of pills) {
    g.strokeStyle = p.lit ? frame.palette.lit : frame.palette.shape;
    g.beginPath();
    g.moveTo(p.x1, p.y1);
    g.lineTo(p.x2 + (p.x1 === p.x2 && p.y1 === p.y2 ? 0.01 : 0), p.y2);
    g.stroke();
  }
  drawLabel(g, anchor, frame, Math.max(1, 0.8 / s));
  g.restore();
}
