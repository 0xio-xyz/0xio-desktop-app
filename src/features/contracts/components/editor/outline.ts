interface OutlineItem {
  name: string;
  detail: string;
  line: number;
}

interface ProgramOutline {
  program: string;
  state: OutlineItem[];
  events: OutlineItem[];
  writes: OutlineItem[];
  views: OutlineItem[];
}

const PROGRAM = /^\s*(?:Program|program|contract|Contract)\s+([A-Za-z_]\w*)/;
const STATE_OPEN = /^\s*state\s*\{\s*$/;
const FIELD = /^\s*([A-Za-z_]\w*)\s*:\s*(.+?)\s*$/;
const EVENT = /^\s*event\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;
const FN = /^\s*(view\s+)?fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?::\s*([^{\s]+))?/;

function argNames(args: string): string {
  return args
    .split(",")
    .map((a) => a.split(":")[0].trim())
    .filter(Boolean)
    .join(", ");
}

function argTypes(args: string): string {
  return args
    .split(",")
    .map((a) => a.trim().replace(/\s*:\s*/, " "))
    .filter(Boolean)
    .join(", ");
}

export function parseOutline(source: string): ProgramOutline {
  const out: ProgramOutline = { program: "", state: [], events: [], writes: [], views: [] };
  let inState = false;
  source.split("\n").forEach((text, i) => {
    const line = i + 1;
    const code = text.replace(/\/\/.*$/, "");
    if (!out.program) {
      const p = code.match(PROGRAM);
      if (p) out.program = p[1];
    }
    if (inState) {
      if (/^\s*\}/.test(code)) {
        inState = false;
        return;
      }
      const f = code.match(FIELD);
      if (f) out.state.push({ name: f[1], detail: f[2], line });
      return;
    }
    if (STATE_OPEN.test(code)) {
      inState = true;
      return;
    }
    const e = code.match(EVENT);
    if (e) {
      out.events.push({ name: e[1], detail: `(${argNames(e[2])})`, line });
      return;
    }
    const fn = code.match(FN);
    if (fn) {
      const detail = `(${argTypes(fn[3])})${fn[4] ? ` ${fn[4]}` : ""}`;
      (fn[1] ? out.views : out.writes).push({ name: fn[2], detail, line });
    }
  });
  return out;
}
