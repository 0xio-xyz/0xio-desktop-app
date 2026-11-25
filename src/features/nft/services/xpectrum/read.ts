import { jsonRpcCall } from "src/services/network/networkService";

// A grid's tiles issue identical views at once and jsonRpcCall has no dedupe: collapse them.
const inFlight = new Map<string, Promise<string | null>>();

function rawView(
  contract: string,
  method: string,
  params: unknown[],
  caller?: string,
): Promise<string | null> {
  const key = `${contract}|${method}|${JSON.stringify(params)}|${caller ?? ""}`;
  const hit = inFlight.get(key);
  if (hit) return hit;

  const p = (async () => {
    const raw = await jsonRpcCall<unknown>("contract_call", [
      contract,
      method,
      params.length > 0 ? params : "",
      caller ?? contract,
    ]);
    const r =
      raw && typeof raw === "object" && "result" in raw
        ? (raw as Record<string, unknown>).result
        : raw;
    return r != null ? String(r) : null;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, p);
  return p;
}

export async function callView(
  contract: string,
  method: string,
  params: unknown[] = [],
  caller?: string,
): Promise<string | null> {
  try {
    return await rawView(contract, method, params, caller);
  } catch {
    return null;
  }
}

// Lets a node error propagate, for reads where a timeout must not pass as a real negative.
export async function callViewStrict(
  contract: string,
  method: string,
  params: unknown[] = [],
  caller?: string,
): Promise<string | null> {
  return rawView(contract, method, params, caller);
}

export const splitPipe = (s: string | null): string[] => (s ? s.split("|") : []);
export const toNum = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

export function isContractRevert(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /execution reverted|revert|method not found|unknown method/i.test(msg);
}
