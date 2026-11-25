import { fetch } from "@tauri-apps/plugin-http";
import type { RpcExchange } from "src/services/network/rpcTransport";

// Tests mock the HTTP plugin; the Rust exchange is covered by cargo test.
export async function postRpc(
  url: string,
  body: string,
  timeoutMs: number,
  clientTag?: string,
): Promise<RpcExchange> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<RpcExchange>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ link: "expired", status: 0, retryAfter: null });
    }, timeoutMs);
  });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (clientTag) headers["x-0xio-client"] = clientTag;
  const answered = (async (): Promise<RpcExchange> => {
    try {
      const reply = (await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      })) as Response;
      const status = reply.status ?? (reply.ok ? 200 : 500);
      let data: unknown;
      try {
        data = await reply.json();
      } catch {
        data = undefined;
      }
      return {
        link: "answered",
        status,
        data,
        retryAfter: reply.headers?.get?.("retry-after") ?? null,
      };
    } catch {
      return { link: "broken", status: 0, retryAfter: null };
    }
  })();
  try {
    return await Promise.race([answered, expired]);
  } finally {
    clearTimeout(timer);
  }
}
