import { describe, expect, it } from "vitest";
import {
  FRAME_MS,
  OPEN,
  REST,
  RING_PITCH,
  createTumbler,
  createTumblerScene,
  idlePlan,
  type TumblerScene,
  type TumblerState,
} from "src/features/security/services/tumblerEngine";
import {
  TUMBLER_TONES,
  parseColor,
  priceLevels,
  shapeTone,
  tumblerPalette,
  tumblerReading,
  tumblerScale,
  tumblerShapes,
} from "src/features/security/services/tumblerDraw";

const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

const wrap = (a: number) => {
  const m = ((a % 360) + 360) % 360;
  return Math.min(m, 360 - m);
};

const expectAt = (s: TumblerState, target: TumblerState) => {
  for (let k = 0; k < 3; k++) expect(wrap(s[k] - target[k])).toBeLessThan(1e-6);
  expect(Math.abs(s[3] - target[3])).toBeLessThan(1e-6);
};

type Event = [number, (scene: TumblerScene, t: number) => void];

function worstStep(scene: TumblerScene, until: number, events: Event[] = [], offset = 0) {
  const queue = [...events].sort((a, b) => a[0] - b[0]);
  const worst = [0, 0, 0];
  let prev = scene.state(offset);
  for (let t = offset + FRAME_MS; t <= until; t += FRAME_MS) {
    while (queue.length && queue[0][0] <= t) {
      const [at, run] = queue.shift()!;
      run(scene, at);
    }
    const s = scene.state(t);
    for (let k = 0; k < 3; k++) {
      worst[k] = Math.max(worst[k], Math.abs(s[k] - prev[k]) / RING_PITCH[k]);
    }
    prev = s;
  }
  return Math.max(...worst);
}

const typing = (start: number, lengths: number[], gap: number): Event[] =>
  lengths.map((n, i) => [
    start + i * gap,
    (scene: TumblerScene, t: number) => scene.type(t, i ? lengths[i - 1] : 0, n),
  ]);

describe("tumbler engine", () => {
  it("rests between idle ticks for 7 to 9 seconds and loops back to where it started", () => {
    const plan = idlePlan(seeded(7));
    expectAt(plan.state(0), REST);
    expectAt(plan.state(plan.t), REST);
    const starts = [0, 1, 2].flatMap((k) => plan.segs[k].map((s) => s.t0)).sort((a, b) => a - b);
    expect(starts[0]).toBeGreaterThanOrEqual(7000);
    expect(starts[0]).toBeLessThan(9000);
  });

  it("draws nothing between idle ticks and wakes for the next one", () => {
    const scene = createTumblerScene(seeded(3));
    expect(scene.nextMotion(100)).toBeGreaterThanOrEqual(7000);
    const first = scene.nextMotion(100);
    expect(scene.nextMotion(first + 50)).toBe(first + 50);
  });

  it("opens onto the aligned notches with the bolt back, from rest or after typing", () => {
    const rest = createTumblerScene(seeded(1));
    rest.unlock(500);
    expectAt(rest.state(60_000), OPEN);

    const typed = createTumblerScene(seeded(1));
    for (let n = 1; n <= 13; n++) typed.type(400 + n * 200, n - 1, n);
    typed.unlock(4000);
    expectAt(typed.state(90_000), OPEN);
  });

  it("spins back to rest quickly on a wrong password, then idles from there", () => {
    const scene = createTumblerScene(seeded(2));
    scene.unlock(1000);
    scene.fail(2600);
    expect(scene.opening).toBe(false);
    const back = scene.nextMotion(2600);
    expect(back).toBe(2600);
    let end = 2600;
    while (scene.nextMotion(end) === end) end += 10;
    expect(end - 2600).toBeLessThanOrEqual(1200);
    expectAt(scene.state(end), REST);
  });

  it("keeps every ring under 0.45 of a notch per frame", () => {
    for (const offset of [0, 7, 19, 29]) {
      expect(worstStep(createTumblerScene(seeded(4)), 80_000, [], offset)).toBeLessThan(0.45);

      const fast = typing(500, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 45);
      expect(worstStep(createTumblerScene(seeded(4)), 20_000, fast, offset)).toBeLessThan(0.45);

      const paste: Event[] = [
        [300, (s, t) => s.type(t, 0, 24)],
        [700, (s, t) => s.type(t, 24, 3)],
        [1200, (s, t) => s.type(t, 3, 0)],
        [2000, (s, t) => s.type(t, 0, 1)],
      ];
      expect(worstStep(createTumblerScene(seeded(4)), 20_000, paste, offset)).toBeLessThan(0.45);

      for (const failAt of [900, 2300, 3700, 5200, 7000]) {
        const run: Event[] = [
          ...typing(200, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 90),
          [1500, (s, t) => s.unlock(t)],
          [1500 + failAt, (s, t) => s.fail(t)],
        ];
        expect(worstStep(createTumblerScene(seeded(5)), 30_000, run, offset)).toBeLessThan(0.45);
      }
    }
  });

  it("turns the inner or middle ring one notch per character and back on delete", () => {
    let now = 0;
    const tumbler = createTumbler(() => now, seeded(9));
    const settle = (ms = 400) => {
      now += ms;
      return tumbler.scene.state(now);
    };
    now = 100;
    tumbler.type(1);
    let s = settle();
    expect(s[2]).toBeCloseTo(REST[2] - RING_PITCH[2]);
    expect(s[1]).toBeCloseTo(REST[1]);
    tumbler.type(2);
    s = settle();
    expect(s[1]).toBeCloseTo(REST[1] + RING_PITCH[1]);
    tumbler.type(2);
    expect(settle()).toEqual(s);
    tumbler.type(1);
    s = settle();
    expect(s[1]).toBeCloseTo(REST[1]);
    expect(s[2]).toBeCloseTo(REST[2] - RING_PITCH[2]);
    tumbler.type(0);
    expectAt(settle(5000), REST);
  });

  it("ignores typing while it opens", () => {
    let now = 100;
    const tumbler = createTumbler(() => now, seeded(9));
    tumbler.unlock();
    tumbler.type(5);
    now = 60_000;
    expectAt(tumbler.scene.state(now), OPEN);
  });
});

describe("tumbler drawing", () => {
  const angleOf = (x: number, y: number) => ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;

  it("holds one still frame with the notches aligned, today lit and the bolt back", () => {
    expect(OPEN).toEqual([0, 0, 0, 1]);
    const { pills } = tumblerShapes(OPEN, [0, 1, 2, 3, 2, 1, 0, 3]);
    const onDiagonal = (r: number) =>
      pills.filter(
        (p) =>
          Math.abs(Math.hypot(p.x1, p.y1) - r) < 0.5 && Math.abs(angleOf(p.x1, p.y1) - 135) < 1,
      );
    expect(onDiagonal(330)).toHaveLength(0);
    expect(onDiagonal(250)).toHaveLength(0);
    const today = onDiagonal(410);
    expect(today).toHaveLength(1);
    expect(today[0].lit).toBe(true);
    expect(Math.hypot(today[0].x2 - today[0].x1, today[0].y2 - today[0].y1)).toBeCloseTo(48);
    const bolt = pills[pills.length - 1];
    expect(Math.hypot(bolt.x2, bolt.y2)).toBeCloseTo(196);
    expect(pills.filter((p) => p.lit)).toHaveLength(1);
  });

  it("draws at the design size on 1280 by 800 and shrinks clear of the column on small windows", () => {
    expect(tumblerScale(1280, 800)).toBe(1);
    expect(tumblerScale(960, 680)).toBeCloseTo(0.75);
    expect(400 * tumblerScale(800, 600)).toBeLessThan(800 / 2 - 160);
  });

  it("keeps the notches off the diagonal at rest", () => {
    const { pills } = tumblerShapes(REST, []);
    const near = pills.filter((p) => Math.abs(angleOf(p.x1, p.y1) - 135) < 1);
    expect(near.length).toBe(4);
  });

  it("steps the price into eight teeth with today last", () => {
    const levels = priceLevels([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(levels).toHaveLength(8);
    expect(levels[0]).toBe(0);
    expect(levels[7]).toBe(3);
    expect(levels.every((l) => l >= 0 && l <= 3)).toBe(true);
    const reading = tumblerReading({
      value: 0.045,
      change: 8.6,
      label: "24h",
      history: [
        { time: 1, value: 0.04 },
        { time: 2, value: 0.045 },
      ],
    });
    expect(reading?.price).toBe("$0.0450");
    expect(reading?.change).toBe("+8.6% 24h");
    expect(tumblerReading(null)).toBeNull();
  });

  it("uses the exact Dim and Day tones and derives the rest from the theme", () => {
    const vars = { bg: "#0000db", text: "#ffffff", secondary: "#99ccff", muted: "#6699cc" };
    expect(tumblerPalette("dim", vars)).toEqual(TUMBLER_TONES.dim);
    expect(tumblerPalette("light", vars)).toEqual(TUMBLER_TONES.light);
    const octra = tumblerPalette("octra", vars);
    expect(octra.bg).toBe("#0000db");
    expect(octra.lit).toBe("#ffffff");
    expect(octra.label).toBe("#99ccff");
    expect(octra.shape).not.toBe(octra.bg);

    const dim = parseColor(shapeTone("#090909", "#f5f5f5"))!;
    expect(Math.abs(dim[0] - 0x17)).toBeLessThanOrEqual(3);
    const day = parseColor(shapeTone("#f6f6f6", "#141414"))!;
    expect(Math.abs(day[0] - 0xe8)).toBeLessThanOrEqual(3);
  });
});
