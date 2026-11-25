import { invoke } from "@tauri-apps/api/core";
import type { RpcLink } from "src/services/network/rpcRetry";

export interface RpcExchange {
  link: RpcLink;
  status: number;
  /** The parsed reply; undefined when the body was not JSON. */
  data?: unknown;
  retryAfter: string | null;
}

function parse(body: string): unknown {
  try {
    return body ? JSON.parse(body) : undefined;
  } catch {
    return undefined;
  }
}

/** One POST in the Rust backend, which tells a request that never left from one that did. */
export async function postRpc(
  url: string,
  body: string,
  timeoutMs: number,
  clientTag?: string,
): Promise<RpcExchange> {
  try {
    const out = await invoke<{
      link: RpcLink;
      status: number;
      body: string;
      retryAfter: string | null;
    }>("node_rpc_post", { url, body, timeoutMs: Math.max(1, Math.round(timeoutMs)), clientTag });
    return {
      link: out.link,
      status: out.status,
      data: parse(out.body),
      retryAfter: out.retryAfter,
    };
  } catch {
    return { link: "broken", status: 0, retryAfter: null };
  }
}
