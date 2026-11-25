import type { Diagnostic } from "@codemirror/lint";

// Every rule maps to a documented constraint of the language, not a style opinion.

const MAX_LOCALS = 31;

interface LineSpan {
  from: number;
  to: number;
}

function lineSpans(source: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let pos = 0;
  for (const line of source.split("\n")) {
    spans.push({ from: pos, to: pos + line.length });
    pos += line.length + 1;
  }
  return spans;
}

export function amlDiagnostics(source: string): Diagnostic[] {
  if (!source.trim()) return [];
  const out: Diagnostic[] = [];
  const spans = lineSpans(source);
  const lines = source.split("\n");

  const firstCodeLine = lines.findIndex((l) => l.trim() && !l.trim().startsWith("//"));

  if (firstCodeLine >= 0 && !/\b(Program|Contract)\s+\w+/.test(source)) {
    out.push({
      from: spans[firstCodeLine].from,
      to: spans[firstCodeLine].to,
      severity: "error",
      message: "AML code must live inside a Program block: Program MyProgram { ... }",
    });
  }

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) return;

    const callArr = line.match(/call\s*\(\s*[^)]*\[/);
    if (callArr && callArr.index != null) {
      out.push({
        from: spans[i].from + callArr.index,
        to: spans[i].from + callArr.index + callArr[0].length,
        severity: "error",
        message: 'call() uses flat args: call(contract, "method", a, b) - not an array.',
      });
    }

    if (/^transfer\s*\(/.test(trimmed) && !/^(let|if|return|require)\b/.test(trimmed)) {
      const idx = line.indexOf("transfer");
      out.push({
        from: spans[i].from + idx,
        to: spans[i].from + idx + "transfer".length,
        severity: "warning",
        message:
          "transfer() returns bool - check the result (let ok = transfer(...); require(ok, ...)) or a failed send passes silently.",
      });
    }
  });

  // Register cap: at most 31 locals in one function body.
  const fnRe = /\bfn\s+(\w+)\s*\([^)]*\)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(source))) {
    const bodyStart = source.indexOf("{", m.index);
    if (bodyStart < 0) continue;
    let depth = 0;
    let end = bodyStart;
    for (let i = bodyStart; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = source.slice(bodyStart, end);
    const locals = (body.match(/\blet\s+\w+/g) || []).length;
    if (locals > MAX_LOCALS) {
      out.push({
        from: m.index,
        to: m.index + m[0].length - 1,
        severity: "error",
        message: `fn ${m[1]} declares ${locals} locals - the register cap is ${MAX_LOCALS}. Hoist and reuse variables.`,
      });
    }
  }

  return out;
}

export function maxLocalsUsed(source: string): number {
  let max = 0;
  const fnRe = /\bfn\s+\w+\s*\([^)]*\)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(source))) {
    const bodyStart = source.indexOf("{", m.index);
    if (bodyStart < 0) continue;
    let depth = 0;
    let end = source.length;
    for (let i = bodyStart; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const locals = (source.slice(bodyStart, end).match(/\blet\s+\w+/g) || []).length;
    if (locals > max) max = locals;
  }
  return max;
}
