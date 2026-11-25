type LineOp = { t: "eq"; a: number; b: number } | { t: "del"; a: number } | { t: "add"; b: number };

type Mark = "" | "add" | "mod";

interface SplitRow {
  left: { n: number | null; text: string; kind: "" | "del" | "pad" };
  right: { n: number | null; text: string; kind: "" | "add" | "pad" };
}

interface InlineRow {
  a: number | null;
  b: number | null;
  sign: " " | "-" | "+";
  text: string;
}

interface LineDiff {
  marks: Mark[];
  deletedAbove: number[];
  deletedAtEnd: boolean;
  split: SplitRow[];
  inline: InlineRow[];
  adds: number;
  dels: number;
}

// Past this many cells the middle is diffed as one replaced block instead of an exact LCS.
const MAX_CELLS = 4_000_000;

export function lineOps(a: string[], b: string[]): LineOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: LineOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ t: "eq", a: i, b: i });
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) {
    for (let i = start; i < endA; i++) ops.push({ t: "del", a: i });
    for (let j = start; j < endB; j++) ops.push({ t: "add", b: j });
  } else if (n > 0 || m > 0) {
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          a[start + i] === b[start + j]
            ? dp[(i + 1) * w + j + 1] + 1
            : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        ops.push({ t: "eq", a: start + i, b: start + j });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        ops.push({ t: "del", a: start + i++ });
      } else {
        ops.push({ t: "add", b: start + j++ });
      }
    }
    while (i < n) ops.push({ t: "del", a: start + i++ });
    while (j < m) ops.push({ t: "add", b: start + j++ });
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ t: "eq", a: i, b: j });
  return ops;
}

export function diffLines(saved: string, current: string): LineDiff {
  const a = saved.split("\n");
  const b = current.split("\n");
  const ops = lineOps(a, b);
  const marks: Mark[] = b.map(() => "");
  const deletedAbove: number[] = [];
  let deletedAtEnd = false;
  const split: SplitRow[] = [];
  const inline: InlineRow[] = [];
  let adds = 0;
  let dels = 0;
  let k = 0;
  while (k < ops.length) {
    const o = ops[k];
    if (o.t === "eq") {
      split.push({
        left: { n: o.a + 1, text: a[o.a], kind: "" },
        right: { n: o.b + 1, text: b[o.b], kind: "" },
      });
      inline.push({ a: o.a + 1, b: o.b + 1, sign: " ", text: b[o.b] });
      k++;
      continue;
    }
    const ds: number[] = [];
    const as: number[] = [];
    while (k < ops.length && ops[k].t !== "eq") {
      const x = ops[k];
      if (x.t === "del") ds.push(x.a);
      else if (x.t === "add") as.push(x.b);
      k++;
    }
    adds += as.length;
    dels += ds.length;
    as.forEach((bj, idx) => {
      marks[bj] = idx < ds.length ? "mod" : "add";
    });
    if (ds.length > as.length) {
      const next = k < ops.length ? (ops[k] as { b: number }).b : b.length;
      if (next < b.length) deletedAbove.push(next + 1);
      else deletedAtEnd = true;
    }
    const rows = Math.max(ds.length, as.length);
    for (let r = 0; r < rows; r++) {
      split.push({
        left:
          r < ds.length
            ? { n: ds[r] + 1, text: a[ds[r]], kind: "del" }
            : { n: null, text: "", kind: "pad" },
        right:
          r < as.length
            ? { n: as[r] + 1, text: b[as[r]], kind: "add" }
            : { n: null, text: "", kind: "pad" },
      });
    }
    for (const ai of ds) inline.push({ a: ai + 1, b: null, sign: "-", text: a[ai] });
    for (const bj of as) inline.push({ a: null, b: bj + 1, sign: "+", text: b[bj] });
  }
  return { marks, deletedAbove, deletedAtEnd, split, inline, adds, dels };
}
