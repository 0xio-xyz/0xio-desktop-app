import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { Btn, Caps, KV } from "src/shared/ui/look";
import type { CipherStructure, CipherLayer } from "src/services/pvac/pvacBridge";

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface Pt {
  x: number;
  y: number;
}

interface Pt3 extends Pt {
  z: number;
  k: number;
  t: number;
}

const TILT = (58 * Math.PI) / 180;
const SIN_T = Math.sin(TILT);
const COS_T = Math.cos(TILT);
const FOCAL = 1150;

function project(x3: number, y3: number, z3: number): Omit<Pt3, "t"> {
  const k = FOCAL / (FOCAL + z3);
  return { x: CENTER.x + x3 * k, y: CENTER.y + y3 * k, z: z3, k };
}

function depthAlpha(t: number, near = 1, far = 0.24): number {
  return near + (far - near) * Math.min(1, Math.max(0, t));
}

const GRAPH_LAYER_CAP = 96;
const INDEX_CAP = 96;
const CENTER: Pt = { x: 560, y: 330 };

const fmtInt = (v: number) => new Intl.NumberFormat("en-US").format(v);
const fmtPct = (ones: number, bits: number) =>
  bits > 0 ? `${Math.round((ones / bits) * 100)}%` : "0%";

export function parentsLabel(layer: CipherLayer, t: Translate): string {
  return layer.is_base
    ? t("cipherMap.none")
    : t("cipherMap.parentsOf", { a: `L${layer.pa}`, b: `L${layer.pb}` });
}

export function ancestorsOf(layers: CipherLayer[], idx: number): Set<number> {
  const byIdx = new Map(layers.map((l) => [l.idx, l]));
  const out = new Set<number>();
  const walk = (i: number) => {
    const l = byIdx.get(i);
    if (!l || l.is_base) return;
    for (const p of [l.pa, l.pb]) {
      if (out.has(p) || p === idx) continue;
      out.add(p);
      walk(p);
    }
  };
  walk(idx);
  return out;
}

export function deepestLayer(layers: CipherLayer[]): number {
  if (layers.length === 0) return 0;
  return layers.reduce((s, l) => (l.depth >= s.depth ? l : s)).idx;
}

// Radial layout: layers on per-depth ellipses, ported from webcli cipher.js buildPositions.
function buildPositions(layers: CipherLayer[]): {
  positions: Map<number, Pt3>;
  groups: Map<number, CipherLayer[]>;
  maxDepth: number;
} {
  const groups = new Map<number, CipherLayer[]>();
  let maxDepth = 0;
  for (const l of layers) {
    (groups.get(l.depth) ?? groups.set(l.depth, []).get(l.depth)!).push(l);
    if (l.depth > maxDepth) maxDepth = l.depth;
  }
  const raw = new Map<number, Omit<Pt3, "t">>();
  let zMin = Infinity;
  let zMax = -Infinity;
  groups.forEach((group, depth) => {
    const baseRadius = Math.min(140, 64 + group.length * 13);
    const radius =
      depth === 0 ? baseRadius : 140 + (maxDepth === 1 ? 55 : ((depth - 1) * 95) / (maxDepth - 1));
    const phase = -Math.PI / 2 + depth * 0.47;
    const lift = depth * 20;
    group.forEach((layer, i) => {
      const a = phase + (i * Math.PI * 2) / group.length;
      const x3 = Math.cos(a) * radius;
      const y3 = -SIN_T * Math.sin(a) * radius + lift;
      const z3 = COS_T * Math.sin(a) * radius + depth * 40;
      const p = project(x3, y3, z3);
      raw.set(layer.idx, p);
      if (z3 < zMin) zMin = z3;
      if (z3 > zMax) zMax = z3;
    });
  });
  const span = Math.max(1, zMax - zMin);
  const positions = new Map<number, Pt3>();
  raw.forEach((p, idx) => positions.set(idx, { ...p, t: (p.z - zMin) / span }));
  return { positions, groups, maxDepth };
}

function buildIndexPositions(idxs: number[]): Map<number, Pt3> {
  const unique = [...new Set(idxs)].slice(0, INDEX_CAP);
  const positions = new Map<number, Pt3>();
  const R = 400;
  unique.forEach((idx, i) => {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / unique.length;
    const p = project(Math.cos(a) * R, -SIN_T * Math.sin(a) * R, COS_T * Math.sin(a) * R);
    positions.set(idx, { ...p, t: (Math.sin(a) + 1) / 2 });
  });
  return positions;
}

function incidencePath(from: Pt, to: Pt, offset: number): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const bend = ((offset % 7) - 3) * 3;
  const cx = (from.x + to.x) / 2 - (dy / length) * bend;
  const cy = (from.y + to.y) / 2 + (dx / length) * bend;
  return `M ${from.x} ${from.y} Q ${cx} ${cy}, ${to.x} ${to.y}`;
}

interface Tip {
  x: number;
  y: number;
  text: string;
}

function StripFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="shrink-0">
      <div className="text-meta text-content-muted">{label}</div>
      <div className="mt-0.5 text-body font-medium text-content tabular-nums">{value}</div>
    </div>
  );
}

export default function CipherGraph({ structure }: { structure: CipherStructure }) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportRef = useRef<SVGGElement | null>(null);
  const mapRef = useRef<HTMLDivElement | null>(null);
  const view = useRef({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ id: number; sx: number; sy: number; vx: number; vy: number } | null>(null);
  const [selected, setSelected] = useState<number>(() => deepestLayer(structure.layers));
  const [hovered, setHovered] = useState<number | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  // A stale native binary may omit edge_samples; degrade to an empty incidence set, never crash.
  const edges = structure.edge_samples ?? [];

  const layout = useMemo(() => {
    const list = structure.edge_samples ?? [];
    const visible = structure.layers.slice(0, GRAPH_LAYER_CAP);
    const { positions, groups, maxDepth } = buildPositions(visible);
    const idxPos = buildIndexPositions(list.map((e) => e.idx));
    return { visible, positions, groups, maxDepth, idxPos };
  }, [structure]);

  const applyTransform = () => {
    const v = view.current;
    viewportRef.current?.setAttribute("transform", `translate(${v.x} ${v.y}) scale(${v.scale})`);
  };

  const fitView = () => {
    const pts: Pt[] = [...[...layout.positions.values()], ...[...layout.idxPos.values()]];
    if (pts.length === 0) {
      view.current = { x: 0, y: 0, scale: 1 };
      applyTransform();
      return;
    }
    const pad = 30;
    const minX = Math.min(...pts.map((q) => q.x)) - pad;
    const maxX = Math.max(...pts.map((q) => q.x)) + pad;
    const minY = Math.min(...pts.map((q) => q.y)) - pad;
    const maxY = Math.max(...pts.map((q) => q.y)) + pad;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const scale = Math.min(1.25, 1200 / w, 660 / h);
    view.current = {
      x: (1200 - w * scale) / 2 - minX * scale,
      y: (660 - h * scale) / 2 - minY * scale,
      scale,
    };
    applyTransform();
  };

  // effect:audited - fit and pick the deepest layer when a new structure is mapped.
  useEffect(() => {
    setSelected(deepestLayer(structure.layers));
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, layout]);

  // Screen point to view box point, through the SVG's own transform so letterboxing is honoured.
  const svgPoint = (e: { clientX: number; clientY: number }): Pt => {
    const ctm = svgRef.current?.getScreenCTM?.();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest(".layer-node")) return;
    const p = svgPoint(e);
    drag.current = { id: e.pointerId, sx: p.x, sy: p.y, vx: view.current.x, vy: view.current.y };
    svgRef.current?.setPointerCapture(e.pointerId);
    svgRef.current?.classList.add("cursor-grabbing");
    setTip(null);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    const p = svgPoint(e);
    view.current = {
      ...view.current,
      x: drag.current.vx + p.x - drag.current.sx,
      y: drag.current.vy + p.y - drag.current.sy,
    };
    applyTransform();
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
    svgRef.current?.classList.remove("cursor-grabbing");
  };

  // effect:audited - native non-passive wheel zoom so the page does not scroll under it.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const p = svgPoint(e);
      const next = Math.max(0.18, Math.min(2.8, view.current.scale * (e.deltaY < 0 ? 1.12 : 0.89)));
      const ratio = next / view.current.scale;
      view.current = {
        x: p.x - (p.x - view.current.x) * ratio,
        y: p.y - (p.y - view.current.y) * ratio,
        scale: next,
      };
      applyTransform();
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusLayer = (id: number) => {
    const p = layout.positions.get(id);
    if (!p) return;
    const scale = Math.max(0.85, Math.min(1.35, view.current.scale));
    view.current = { x: 600 - p.x * scale, y: 330 - p.y * scale, scale };
    applyTransform();
  };
  const pick = (id: number) => setSelected(id);
  const focusDeepest = () => {
    const id = deepestLayer(layout.visible);
    setSelected(id);
    focusLayer(id);
  };

  const sel = structure.layers.find((l) => l.idx === selected) ?? structure.layers[0];
  const hl = hovered ?? selected;
  const lineage = useMemo(() => ancestorsOf(structure.layers, hl), [structure, hl]);
  const activeIdx = useMemo(() => {
    const s = new Set<number>();
    for (const e of edges) if (e.layer_id === hl) s.add(e.idx);
    return s;
  }, [edges, hl]);

  const depthOrbits = useMemo(() => {
    const arr: { rx: number; ry: number }[] = [];
    layout.groups.forEach((group) => {
      const pts = group.map((l) => layout.positions.get(l.idx)).filter(Boolean) as Pt[];
      if (pts.length === 0) return;
      const rx = Math.max(58, ...pts.map((p) => Math.abs(p.x - CENTER.x)));
      const ry = Math.max(42, ...pts.map((p) => Math.abs(p.y - CENTER.y)));
      arr.push({ rx, ry });
    });
    return arr;
  }, [layout]);

  const showTip = (e: React.PointerEvent, layer: number, idx: number) => {
    const box = mapRef.current?.getBoundingClientRect();
    if (!box) return;
    setTip({
      x: e.clientX - box.left,
      y: e.clientY - box.top,
      text: t("cipherMap.edgeTip", { layer: `L${layer}`, index: fmtInt(idx) }),
    });
  };

  const facts: [string, string][] = sel
    ? [
        [t("cipherMap.rule"), t(sel.is_base ? "cipherMap.base" : "cipherMap.product")],
        [t("cipherMap.depth"), String(sel.depth)],
        [t("cipherMap.parents"), parentsLabel(sel, t)],
        [t("cipherMap.edges"), fmtInt(sel.edges ?? 0)],
        [t("cipherMap.sigmaDensity"), fmtPct(sel.sigma_ones, sel.sigma_bits)],
        [t("cipherMap.rCommitment"), t(sel.has_r_com ? "cipherMap.present" : "cipherMap.absent")],
        [t("cipherMap.slotBindings"), `${sel.pc_count ?? 0} PC ${sel.r_pc_count ?? 0} R_PC`],
      ]
    : [];

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 gap-8">
        <div ref={mapRef} className="relative min-h-0 min-w-0 flex-1">
          <svg
            ref={svgRef}
            viewBox="0 0 1200 660"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={(e) => {
              onPointerUp(e);
              setTip(null);
            }}
            className="absolute inset-0 block h-full w-full cursor-grab"
            style={{ touchAction: "none" }}
          >
            <g ref={viewportRef}>
              {depthOrbits.map((o, i) => (
                <ellipse
                  key={i}
                  cx={CENTER.x}
                  cy={CENTER.y}
                  rx={o.rx}
                  ry={o.ry}
                  fill="none"
                  style={{ stroke: "var(--line-2)" }}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              ))}

              {layout.visible
                .filter((l) => !l.is_base)
                .flatMap((l) =>
                  [l.pa, l.pb].map((parent) => {
                    const p = layout.positions.get(l.idx);
                    const q = layout.positions.get(parent);
                    if (!p || !q) return null;
                    const lit = (l.idx === hl || lineage.has(l.idx)) && lineage.has(parent);
                    return (
                      <line
                        key={`par-${l.idx}-${parent}`}
                        x1={p.x}
                        y1={p.y}
                        x2={q.x}
                        y2={q.y}
                        style={{ stroke: lit ? "var(--fg)" : "var(--fg-3)" }}
                        strokeOpacity={lit ? 1 : 0.35}
                        strokeWidth={lit ? 1.6 : 0.8}
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  }),
                )}

              {edges.map((e, i) => {
                const lp = layout.positions.get(e.layer_id);
                const ip = layout.idxPos.get(e.idx);
                if (!lp || !ip) return null;
                const lit = e.layer_id === hl;
                return (
                  <path
                    key={`inc-${i}`}
                    d={incidencePath(lp, ip, i)}
                    fill="none"
                    style={{ stroke: lit ? "var(--fg)" : "var(--fg-3)" }}
                    strokeOpacity={lit ? 0.95 : depthAlpha((lp.t + ip.t) / 2, 0.22, 0.08)}
                    strokeWidth={lit ? 1.1 : 0.6}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}

              {edges.map((e, i) => {
                if (e.layer_id !== hl) return null;
                const lp = layout.positions.get(e.layer_id);
                const ip = layout.idxPos.get(e.idx);
                if (!lp || !ip) return null;
                return (
                  <path
                    key={`hit-${i}`}
                    d={incidencePath(lp, ip, i)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={10}
                    vectorEffect="non-scaling-stroke"
                    onPointerMove={(ev) => showTip(ev, e.layer_id, e.idx)}
                    onPointerLeave={() => setTip(null)}
                  />
                );
              })}

              {[...layout.idxPos.entries()].map(([idx, p]) => {
                const lit = activeIdx.has(idx);
                return (
                  <circle
                    key={`ix-${idx}`}
                    cx={p.x}
                    cy={p.y}
                    r={(lit ? 4.5 : 3) * p.k}
                    style={{ fill: lit ? "var(--fg)" : "var(--fg-3)" }}
                    fillOpacity={lit ? 1 : depthAlpha(p.t, 0.7, 0.3)}
                  />
                );
              })}

              {/* Nodes far first, so near ones sit over far ones where they overlap. */}
              {[...layout.visible]
                .sort(
                  (a, b) =>
                    (layout.positions.get(b.idx)?.z ?? 0) - (layout.positions.get(a.idx)?.z ?? 0),
                )
                .map((l) => {
                  const p = layout.positions.get(l.idx);
                  if (!p) return null;
                  const isHl = l.idx === hl;
                  const isLine = lineage.has(l.idx);
                  const r = (isHl ? 38 : 27) * p.k;
                  return (
                    <g
                      key={`node-${l.idx}`}
                      className="layer-node"
                      transform={`translate(${p.x} ${p.y})`}
                      style={{ cursor: "pointer" }}
                      onClick={() => pick(l.idx)}
                      onPointerEnter={() => setHovered(l.idx)}
                      onPointerLeave={() => setHovered((h) => (h === l.idx ? null : h))}
                    >
                      <circle
                        r={r}
                        style={{
                          fill: isHl ? "var(--fg)" : isLine ? "var(--fg-2)" : "var(--bg-2)",
                        }}
                      />
                      <text
                        x={0}
                        y={6.5 * p.k}
                        fontSize={19 * p.k}
                        fontWeight={600}
                        textAnchor="middle"
                        style={{
                          fill: isHl || isLine ? "var(--bg)" : "var(--fg-2)",
                          fontFamily: "var(--font-mono, ui-monospace, monospace)",
                        }}
                      >
                        L{l.idx}
                      </text>
                    </g>
                  );
                })}
            </g>
          </svg>

          <div className="absolute top-0 right-0 flex gap-1">
            <Btn size="sm" weight="text" onClick={focusDeepest}>
              {t("cipherMap.focusDeepest")}
            </Btn>
            <Btn size="sm" weight="text" onClick={fitView}>
              {t("cipherMap.resetView")}
            </Btn>
          </div>

          {tip && (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-lg bg-surface-highlight px-2.5 py-1.5 text-meta whitespace-nowrap text-content"
              style={{ left: tip.x, top: tip.y }}
            >
              {tip.text}
            </div>
          )}
        </div>

        <aside className="hidden w-75 shrink-0 flex-col @4xl:flex">
          <Caps>{sel ? `L${sel.idx}` : ""}</Caps>
          <div className="mt-1.5">
            {facts.map(([label, value]) => (
              <KV key={label} label={label}>
                <span className="tabular-nums">{value}</span>
              </KV>
            ))}
          </div>
          <Caps className="mt-5" right={fmtInt(structure.layers.length)}>
            {t("cipherMap.layers")}
          </Caps>
          <div className="mt-1.5 min-h-0 flex-1 overflow-y-auto scrollbar-hide">
            {structure.layers.map((l) => (
              <button
                key={l.idx}
                type="button"
                onClick={() => pick(l.idx)}
                aria-current={l.idx === selected ? "true" : undefined}
                className={`grid h-9 w-full cursor-pointer grid-cols-[3rem_1fr_auto] items-center rounded-xl px-3 text-left text-body tabular-nums transition-colors duration-200 ease-out ${
                  l.idx === selected
                    ? "bg-surface-highlight text-content"
                    : "text-content-secondary hover:bg-surface-highlight"
                }`}
              >
                <span className="font-mono">L{l.idx}</span>
                <span>{t(l.is_base ? "cipherMap.base" : "cipherMap.product")}</span>
                <span>{fmtInt(l.edges ?? 0)}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>

      {sel && (
        <div className="mt-4 flex h-12 shrink-0 items-center gap-5 overflow-x-auto scrollbar-hide @4xl:hidden">
          <span className="shrink-0 font-mono text-body font-semibold text-content">
            L{sel.idx}
          </span>
          {facts.map(([label, value]) => (
            <StripFact key={label} label={label} value={value} />
          ))}
        </div>
      )}
    </div>
  );
}
