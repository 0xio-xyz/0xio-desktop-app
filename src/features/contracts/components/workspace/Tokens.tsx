const KW = new Set([
  "Program",
  "state",
  "event",
  "constructor",
  "fn",
  "view",
  "self",
  "caller",
  "value",
  "require",
  "emit",
  "return",
  "transfer",
  "true",
  "false",
  "let",
  "if",
  "else",
  "while",
  "for",
  "in",
  "const",
  "struct",
  "enum",
  "payable",
  "private",
  "import",
  "from",
  "implements",
]);
const TY = /^(address|int|u8|u16|u32|u64|u128|u256|bool|string|bytes|map|cipher|pubkey|list|void)$/;

interface Tok {
  c: string;
  x: string;
}

function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  const push = (c: string, x: string) => {
    const last = out[out.length - 1];
    if (last && last.c === c) last.x += x;
    else out.push({ c, x });
  };
  const ci = line.indexOf("//");
  const code = ci >= 0 ? line.slice(0, ci) : line;
  const re = /("[^"]*"?)|(\b\d+\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_"]+)/g;
  let m: RegExpExecArray | null;
  let prev = "";
  while ((m = re.exec(code))) {
    if (m[1]) {
      push("s", m[1]);
      prev = "";
    } else if (m[2]) {
      push("n", m[2]);
      prev = "";
    } else if (m[3]) {
      const w = m[3];
      const c = KW.has(w)
        ? "k"
        : TY.test(w) || prev === "Program"
          ? "t"
          : prev === "fn" || prev === "event"
            ? "f"
            : "";
      push(c, w);
      prev = w;
    } else if (m[4]) push("", m[4]);
    else {
      push("", m[5]);
      prev = "";
    }
  }
  if (ci >= 0) push("c", line.slice(ci));
  return out;
}

export function Line({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((t, i) => (
        <span key={i} className={t.c || undefined}>
          {t.x}
        </span>
      ))}
    </>
  );
}
