export type ClassValue = string | false | null | undefined | 0 | ClassValue[];

const SIZES =
  /^(xs|sm|base|lg|[2-9]?xl|micro|meta|body|lead|title|\[(\d|\.|calc|clamp|length:).*\])$/;
const ALIGN = /^(left|center|right|justify|start|end)$/;
const WRAP = /^(wrap|nowrap|balance|pretty|ellipsis|clip)$/;
const BG_OTHER =
  /^(none|fixed|local|scroll|clip-.*|origin-.*|repeat.*|no-repeat|cover|contain|auto|center|top|bottom|left|right|blend-.*|linear-.*|radial-.*|conic-.*|position-.*|size-.*)$/;
const SPACING: Record<string, string[]> = {
  p: ["p", "px", "py", "pt", "pr", "pb", "pl"],
  px: ["px", "pl", "pr"],
  py: ["py", "pt", "pb"],
  m: ["m", "mx", "my", "mt", "mr", "mb", "ml"],
  mx: ["mx", "ml", "mr"],
  my: ["my", "mt", "mb"],
};

function flatten(input: ClassValue[], out: string[]): string[] {
  for (const v of input) {
    if (!v) continue;
    if (Array.isArray(v)) flatten(v, out);
    else out.push(...v.split(/\s+/).filter(Boolean));
  }
  return out;
}

function variantOf(cls: string): [string, string] {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) cut = i;
  }
  return [cls.slice(0, cut + 1), cls.slice(cut + 1)];
}

function groupsOf(utility: string): { group: string; clears: string[] } | null {
  const base = utility.replace(/^!/, "").replace(/!$/, "").replace(/^-/, "");
  const dash = base.indexOf("-");
  const head = dash < 0 ? base : base.slice(0, dash);
  const rest = dash < 0 ? "" : base.slice(dash + 1);
  if (head in SPACING || /^[pm][trbl]$/.test(head)) {
    if (!rest) return null;
    return { group: head, clears: SPACING[head] ?? [head] };
  }
  if (head === "w" || head === "h" || head === "size") {
    if (!rest) return null;
    return { group: head, clears: head === "size" ? ["size", "w", "h"] : [head] };
  }
  if (head === "text" && rest) {
    if (SIZES.test(rest)) return { group: "text-size", clears: ["text-size"] };
    if (ALIGN.test(rest)) return { group: "text-align", clears: ["text-align"] };
    if (WRAP.test(rest)) return { group: "text-wrap", clears: ["text-wrap"] };
    return { group: "text-color", clears: ["text-color"] };
  }
  if (head === "bg" && rest && !BG_OTHER.test(rest))
    return { group: "bg-color", clears: ["bg-color"] };
  return null;
}

export function cn(...inputs: ClassValue[]): string {
  const list = flatten(inputs, []);
  const keep: boolean[] = list.map(() => true);
  const claimed = new Set<string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const [variant, utility] = variantOf(list[i]);
    const important = utility.startsWith("!") || utility.endsWith("!") ? "!" : "";
    const g = groupsOf(utility);
    if (!g) continue;
    const key = variant + important + g.group;
    if (claimed.has(key)) {
      keep[i] = false;
      continue;
    }
    for (const c of g.clears) claimed.add(variant + important + c);
  }
  const seen = new Set<string>();
  return list
    .filter((c, i) => {
      if (!keep[i] || seen.has(c)) return false;
      seen.add(c);
      return true;
    })
    .join(" ");
}
