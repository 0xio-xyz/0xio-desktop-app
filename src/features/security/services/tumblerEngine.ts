export type TumblerState = [outer: number, middle: number, inner: number, bolt: number];

export const RING_RADII = [410, 330, 250] as const;
export const RING_PITCH = [6, 7.5, 9] as const;
export const BOLT_PX = 24;
export const REST: TumblerState = [0, 30, -36, 0];
export const OPEN: TumblerState = [0, 0, 0, 1];
export const FRAME_MS = 1000 / 30;

const OVERSHOOT_PX = 2.5;
const TYPE_TICK_MS = 300;
const TYPE_GAP_MS = 180;
const TYPE_STAGGER_MS = 90;
const TYPE_BURST = 6;
const HOME_AFTER_MS = 1500;
const HOME_MS = 1600;
const RETURN_MIN_MS = 600;
const MS_PER_NOTCH = 130;

type Ease = (x: number) => number;

interface Segment {
  t0: number;
  d: number;
  a: number;
  b: number;
  f: Ease;
  ov: number;
  sp: number;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
const near = (cur: number, target: number) => target + 360 * Math.round((cur - target) / 360);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function bezier(x1: number, y1: number, x2: number, y2: number): Ease {
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let s = x;
    for (let i = 0; i < 28; i++) {
      s = (lo + hi) / 2;
      const bx = 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
      if (bx < x) lo = s;
      else hi = s;
    }
    return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  };
}

const TICK = bezier(0.25, 0, 0.25, 1);
const TURN = bezier(0.45, 0, 0.2, 1);
const SINE: Ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x));

function segmentValue(s: Segment, t: number): number {
  const x = (t - s.t0) / s.d;
  if (x >= 1) return s.b;
  if (x <= 0) return s.a;
  if (!s.ov) return s.a + (s.b - s.a) * s.f(x);
  if (x < s.sp) return s.a + (s.b + s.ov - s.a) * s.f(x / s.sp);
  return s.b + s.ov * (1 - SINE((x - s.sp) / (1 - s.sp)));
}

interface MoveOptions {
  t0?: number;
  from?: number;
  overshoot?: number;
  split?: number;
}

class Plan {
  s0: TumblerState;
  v: TumblerState;
  t: number;
  segs: Segment[][] = [[], [], [], []];

  constructor(start: TumblerState, t = 0) {
    this.s0 = [...start];
    this.v = [...start];
    this.t = t;
  }

  last(k: number, t: number): Segment | null {
    let found: Segment | null = null;
    for (const s of this.segs[k]) {
      if (s.t0 > t) break;
      found = s;
    }
    return found;
  }

  end(k: number): number {
    const S = this.segs[k];
    return S.length ? S[S.length - 1].t0 + S[S.length - 1].d : 0;
  }

  endAll(): number {
    return Math.max(this.end(0), this.end(1), this.end(2), this.end(3));
  }

  at(k: number, t: number): number {
    const s = this.last(k, t);
    return s ? segmentValue(s, t) : this.s0[k];
  }

  state(t: number): TumblerState {
    return [this.at(0, t), this.at(1, t), this.at(2, t), this.at(3, t)];
  }

  move(k: number, to: number, d: number, f: Ease, o: MoveOptions = {}): number {
    const t0 = o.t0 ?? this.t;
    const a = o.from ?? this.v[k];
    const px = o.overshoot ?? 0;
    const ov = px
      ? (k < 3 ? (px / RING_RADII[k]) * (180 / Math.PI) : px / BOLT_PX) * (to >= a ? 1 : -1)
      : 0;
    this.segs[k].push({ t0, d, a, b: to, f, ov, sp: o.split ?? 0.6 });
    this.v[k] = to;
    return t0 + d;
  }

  wait(ms: number): this {
    this.t += ms;
    return this;
  }

  ticks(k: number, n: number): this {
    const step = RING_PITCH[k] * (n < 0 ? -1 : 1);
    let c = Math.abs(Math.round(n));
    if (c > 6) {
      const glide = c - 3;
      this.t = this.move(k, this.v[k] + step * glide, 400 + 170 * glide, TURN) + 70;
      c = 3;
    }
    for (let i = 0; i < c; i++) {
      const lastOne = i === c - 1;
      this.t = this.move(
        k,
        this.v[k] + step,
        lastOne ? 300 : 180,
        TICK,
        lastOne ? { overshoot: OVERSHOOT_PX } : {},
      );
      if (!lastOne) this.t += 40;
    }
    return this;
  }

  fork(lt: number, now: number): Plan {
    const p = new Plan([0, 0, 0, 0], now);
    for (let k = 0; k < 4; k++) {
      const s = this.last(k, lt);
      if (s && lt < s.t0 + s.d) {
        p.s0[k] = s.a;
        p.v[k] = s.b;
        p.segs[k].push({ ...s, t0: s.t0 + now - lt });
      } else {
        p.s0[k] = p.v[k] = this.at(k, lt);
      }
    }
    return p;
  }

  cut(now: number): void {
    for (let k = 0; k < 4; k++) {
      const S = this.segs[k];
      while (S.length && S[S.length - 1].t0 > now) S.pop();
      this.v[k] = S.length ? S[S.length - 1].b : this.s0[k];
    }
    this.t = now;
  }

  waitFrom(t: number): number {
    let wait = Infinity;
    for (const S of this.segs) {
      for (const s of S) {
        if (s.t0 <= t && t < s.t0 + s.d) return 0;
        if (s.t0 > t) wait = Math.min(wait, s.t0 - t);
      }
    }
    return wait;
  }

  firstStart(): number {
    return Math.min(...this.segs.map((S) => (S.length ? S[0].t0 : Infinity)));
  }
}

function returnMs(from: TumblerState, min: number): number {
  let d = min;
  for (let k = 0; k < 3; k++) {
    d = Math.max(d, (Math.abs(near(from[k], REST[k]) - from[k]) / RING_PITCH[k]) * MS_PER_NOTCH);
  }
  return d;
}

function keyTick(p: Plan, i: number, dir: number, t0: number): void {
  const k = i % 2 === 0 ? 2 : 1;
  const s = (k === 2 ? -1 : 1) * dir;
  p.move(k, p.v[k] + s * RING_PITCH[k], TYPE_TICK_MS, TICK, {
    overshoot: 2,
    t0,
    from: p.at(k, t0),
  });
}

function openSequence(p: Plan): void {
  const o0 = near(p.v[0], REST[0]);
  p.ticks(0, 4).wait(280);
  const n = Math.round(mod(p.v[1] + 2 * RING_PITCH[1], 360) / RING_PITCH[1]) % 48;
  if (n) p.ticks(1, -n).wait(220);
  p.ticks(1, 2).wait(280);
  const ni = Math.round(mod(-p.v[2], 360) / RING_PITCH[2]) % 40;
  if (ni) p.ticks(2, ni);
  p.wait(420);
  p.t =
    p.move(0, o0, Math.max(1250, Math.abs(o0 - p.v[0]) * 52), TURN, {
      overshoot: OVERSHOOT_PX,
      split: 0.72,
    }) + 100;
  p.t = p.move(3, 1, 520, TICK, { overshoot: OVERSHOOT_PX, split: 0.7 });
}

export function idlePlan(random: () => number): Plan {
  const rest = () => 7000 + Math.floor(random() * 2000);
  const p = new Plan(REST, 0);
  p.wait(rest()).ticks(2, 2).wait(rest()).ticks(1, -2).wait(rest()).ticks(2, -2);
  p.wait(rest()).ticks(1, 2);
  return p;
}

export interface TumblerScene {
  state(t: number): TumblerState;
  type(now: number, from: number, to: number): void;
  unlock(now: number): void;
  fail(now: number): void;
  nextMotion(t: number): number;
  readonly opening: boolean;
}

interface Manual {
  plan: Plan;
  until: number;
  homing: boolean;
}

export function createTumblerScene(random: () => number = Math.random): TumblerScene {
  const idle = idlePlan(random);
  const period = idle.t;
  let man: Manual | null = null;
  let opening = false;
  let keyAt = [-Infinity, -Infinity, -Infinity];

  const current = (t: number) =>
    man && t < man.until
      ? { plan: man.plan, lt: t, loop: false }
      : { plan: idle, lt: mod(t - (man ? man.until : 0), period), loop: true };

  const manual = (now: number): Plan => {
    const c = current(now);
    if (!c.loop) {
      c.plan.cut(now);
      return c.plan;
    }
    keyAt = [-Infinity, -Infinity, -Infinity];
    man = { plan: c.plan.fork(c.lt, now), until: Infinity, homing: false };
    return man.plan;
  };

  return {
    get opening() {
      return opening;
    },
    state(t) {
      const c = current(t);
      return c.plan.state(c.lt);
    },
    type(now, from, to) {
      if (opening || from === to) return;
      const p = man && now < man.until && !man.homing ? man.plan : manual(now);
      const m = man as Manual;
      const dir = to > from ? 1 : -1;
      const count = Math.min(Math.abs(to - from), TYPE_BURST);
      for (let j = 0; j < count; j++) {
        const i = dir > 0 ? from + j : from - 1 - j;
        const k = i % 2 === 0 ? 2 : 1;
        const t0 = Math.max(now + j * TYPE_STAGGER_MS, keyAt[k] + TYPE_GAP_MS);
        keyAt[k] = t0;
        keyTick(p, i, dir, t0);
      }
      m.until = Infinity;
      m.homing = false;
      if (to === 0) {
        p.t = Math.max(now + HOME_AFTER_MS, p.endAll());
        const d = returnMs(p.v, HOME_MS);
        for (let k = 0; k < 3; k++) p.move(k, near(p.v[k], REST[k]), d, SINE);
        p.t = p.move(3, REST[3], d, SINE);
        m.until = p.t;
        m.homing = true;
      }
    },
    unlock(now) {
      if (opening) return;
      opening = true;
      const p = manual(now);
      p.t = Math.max(now, p.endAll());
      openSequence(p);
      (man as Manual).until = Infinity;
      (man as Manual).homing = false;
    },
    fail(now) {
      if (!opening) return;
      opening = false;
      const p = manual(now);
      const from = p.state(now);
      const d = returnMs(from, RETURN_MIN_MS);
      for (let k = 0; k < 3; k++) {
        p.move(k, near(from[k], REST[k]), d, SINE, { t0: now, from: from[k] });
      }
      p.t = p.move(3, REST[3], d, SINE, { t0: now, from: from[3] });
      (man as Manual).until = p.t;
      (man as Manual).homing = false;
    },
    nextMotion(t) {
      const c = current(t);
      let wait = c.plan.waitFrom(c.lt);
      if (wait === Infinity) {
        wait = c.loop ? period - c.lt + idle.firstStart() : (man as Manual).until - t;
      }
      return t + wait;
    },
  };
}

export interface Tumbler {
  readonly scene: TumblerScene;
  time(): number;
  onWake(fn: () => void): () => void;
  type(length: number): void;
  unlock(): void;
  fail(length?: number): void;
}

/** Typing turns the dial by the change in length only, never reading the text. */
export function createTumbler(
  clock: () => number = () => performance.now(),
  random: () => number = Math.random,
): Tumbler {
  const origin = clock();
  const scene = createTumblerScene(random);
  const time = () => clock() - origin;
  let length = 0;
  let wake = () => {};
  return {
    scene,
    time,
    onWake(fn) {
      wake = fn;
      return () => {
        if (wake === fn) wake = () => {};
      };
    },
    type(next) {
      if (next === length) return;
      scene.type(time(), length, next);
      length = next;
      wake();
    },
    unlock() {
      scene.unlock(time());
      wake();
    },
    fail(next) {
      scene.fail(time());
      if (next !== undefined) length = next;
      wake();
    },
  };
}
