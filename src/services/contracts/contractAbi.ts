import type { AbiMethod, AbiParam, ContractAbi } from "src/types/contract";

const text = (v: unknown): string => (typeof v === "string" ? v : "");

function readParams(entry: Record<string, unknown>): AbiParam[] {
  const names = Array.isArray(entry.input_names) ? entry.input_names : [];
  const list = [entry.params, entry.inputs, entry.args].find(Array.isArray) ?? names;
  return list.map((p: unknown, i: number) => {
    const named = p && typeof p === "object" ? (p as Record<string, unknown>) : null;
    return {
      name: text(named?.name) || text(names[i]) || `arg${i}`,
      type: named ? text(named.type) : list === names ? "" : text(p),
    };
  });
}

function readMethod(m: unknown): AbiMethod | null {
  if (typeof m === "string") return m ? { name: m, params: [], mutates: true, typed: false } : null;
  if (!m || typeof m !== "object") return null;
  const entry = m as Record<string, unknown>;
  const name = text(entry.name);
  if (!name) return null;
  const returns = text(entry.returns) || text(entry.output);
  const described = ["inputs", "args", "input_names"].some((k) => Array.isArray(entry[k]));
  // A list saved before `typed` existed: a names-only entry kept `params: []` and no return type.
  const savedBare =
    Array.isArray(entry.params) && entry.params.length === 0 && !entry.returns && !entry.output;
  const typed = described || (Array.isArray(entry.params) && !savedBare);
  return {
    name,
    params: readParams(entry),
    ...(returns ? { returns } : {}),
    mutates: typeof entry.mutates === "boolean" ? entry.mutates : entry.view !== true,
    ...(typed && entry.typed !== false ? {} : { typed: false }),
  };
}

export function normalizeAbi(raw: unknown): ContractAbi {
  let body = raw;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return [];
    }
    if (typeof body === "string") return [];
  }
  if (!body || typeof body !== "object") return [];
  if (!Array.isArray(body)) {
    const r = body as Record<string, unknown>;
    const list = [r.functions, r.methods].find(Array.isArray);
    if (!list) return normalizeAbi(r.abi);
    body = list;
  }
  const seen = new Set<string>();
  const out: ContractAbi = [];
  for (const m of body as unknown[]) {
    const method = readMethod(m);
    if (!method || seen.has(method.name)) continue;
    seen.add(method.name);
    out.push(method);
  }
  return out;
}
