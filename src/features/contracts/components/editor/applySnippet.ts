// Puts an assistant's code into the file: a whole program replaces it; a fragment goes where its
// first line already is, keeping matching lines, replacing a changed one and adding new ones.

const key = (line: string) => line.trim();

export function isWholeFile(code: string, source: string): boolean {
  return /\bProgram\s+\w+/.test(code) || code.length >= source.length * 0.6;
}

export function mergeSnippet(source: string, snippet: string, cursorLine: number): string {
  const file = source.split("\n");
  const lines = snippet.replace(/\n+$/, "").split("\n");
  const first = lines.findIndex((l) => key(l));
  if (first < 0) return source;
  const anchor = file.findIndex((l) => key(l) && key(l) === key(lines[first]));
  if (anchor < 0) {
    const at = Math.max(0, Math.min(file.length, cursorLine - 1));
    return [...file.slice(0, at), ...lines.slice(first), ...file.slice(at)].join("\n");
  }
  const out = file.slice(0, anchor);
  let k = anchor;
  for (let j = first; j < lines.length; j++) {
    const s = lines[j];
    if (k < file.length && key(file[k]) === key(s)) {
      out.push(file[k++]);
    } else if (
      k + 1 < file.length &&
      j + 1 < lines.length &&
      key(file[k]) &&
      key(file[k + 1]) === key(lines[j + 1])
    ) {
      out.push(s);
      k++;
    } else {
      out.push(s);
    }
  }
  return [...out, ...file.slice(k)].join("\n");
}
