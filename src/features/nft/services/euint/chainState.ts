// Chain-state living NFTs (EUINT Colonies and later). The program reads its own state from the RPC
// with read-only contract_call requests, so the frame may reach exactly one endpoint: the /rpc of
// the network the token lives on. token_uri can also be inline JSON, and a burned token reverts.

const MAINNET_RPC = "https://octra.network/rpc";

// The 0xio proxy carries our key; a program never gets to talk to it.
const BLOCKED_HOSTS = new Set(["rpc-proxy.0xio.xyz"]);

// No userinfo, query or fragment, and only characters that are safe inside a CSP source list.
const RPC_URL = /^(https?):\/\/([a-z0-9.-]+)(?::(\d{1,5}))?(\/[a-z0-9._~/-]*)?$/i;

interface RpcParts {
  scheme: string;
  host: string;
  port: string;
  path: string;
}

function parseRpc(raw: string): RpcParts | null {
  const m = RPC_URL.exec(raw.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase();
  if (!host || host.startsWith(".") || host.endsWith(".") || BLOCKED_HOSTS.has(host)) return null;
  let port = m[3] ?? "";
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) port = "";
  return { scheme, host, port, path: (m[4] ?? "").replace(/\/+$/, "") };
}

const formatRpc = (r: RpcParts) => `${r.scheme}://${r.host}${r.port ? `:${r.port}` : ""}${r.path}`;

// null when the network has no endpoint a program may reach, such as the 0xio proxy.
export function livingRpcEndpoint(networkRpc: string | null | undefined): string | null {
  if (!networkRpc) return null;
  const r = parseRpc(networkRpc);
  if (!r) return null;
  if (!/\/rpc$/.test(r.path)) r.path += "/rpc";
  return formatRpc(r);
}

function isAllowedRpc(value: string, endpoint: string | null): boolean {
  if (!endpoint) return false;
  const r = parseRpc(value);
  return !!r && formatRpc(r) === endpoint;
}

function decodeParam(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

// rpc= is pinned to `endpoint`; every other byte is kept as published (st= carries commas and
// colons). An rpc= naming any other host is dropped, and a token without one gets the endpoint
// unless that is mainnet, the program default.
export function livingQuery(uri: string, endpoint: string | null): string {
  const hi = uri.indexOf("#");
  const end = hi < 0 ? uri.length : hi;
  const qi = uri.indexOf("?");
  const raw = qi < 0 || qi > end ? "" : uri.slice(qi + 1, end);
  const out: string[] = [];
  let pinned = false;
  for (const part of raw.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (decodeParam(eq < 0 ? part : part.slice(0, eq)) !== "rpc") {
      out.push(part);
      continue;
    }
    if (pinned || !endpoint) continue;
    const value = decodeParam(eq < 0 ? "" : part.slice(eq + 1));
    if (value === endpoint) out.push(part);
    else if (isAllowedRpc(value, endpoint)) out.push(`rpc=${encodeURIComponent(endpoint)}`);
    else continue;
    pinned = true;
  }
  if (!pinned && endpoint && endpoint !== MAINNET_RPC) {
    out.push(`rpc=${encodeURIComponent(endpoint)}`);
  }
  return out.length ? `?${out.join("&")}` : "";
}

// A <head> that only shows up after the first <script> is text inside it, not a tag.
export function injectAtTop(html: string, snippet: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  const script = html.search(/<script/i);
  if (head && (script < 0 || head.index < script)) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + snippet + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + snippet + html.slice(doctype[0].length);
  return snippet + html;
}

const MAX_INLINE_JSON = 256 * 1024;

export function isInlineJsonUri(uri: string | null | undefined): boolean {
  return typeof uri === "string" && /^\s*data:application\/json/i.test(uri);
}

function asObject(text: string | null): Record<string, unknown> | null {
  if (text == null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// EUINT publishes `data:application/json;utf8,{...}` raw, with percent escapes inside its URLs
// that must survive; a percent-encoded body and `;base64` are also accepted.
export function parseInlineJsonUri(uri: string): Record<string, unknown> | null {
  const s = uri.trim();
  if (s.length > MAX_INLINE_JSON || !/^data:application\/json/i.test(s)) return null;
  const comma = s.indexOf(",");
  if (comma < 0) return null;
  const params = s
    .slice(5, comma)
    .split(";")
    .slice(1)
    .map((p) => p.trim().toLowerCase());
  const body = s.slice(comma + 1);
  if (params.includes("base64")) {
    try {
      const bin = atob(body.replace(/\s+/g, ""));
      return asObject(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    } catch {
      return null;
    }
  }
  const direct = asObject(body);
  if (direct) return direct;
  try {
    return asObject(decodeURIComponent(body));
  } catch {
    return null;
  }
}

// A burned or never minted id reverts; that is an answer, not a failed read.
export function isRevertError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /execution reverted|\breverted\b/i.test(msg);
}

export function readsChainState(animationUrl: string | null | undefined): boolean {
  if (!animationUrl) return false;
  const qi = animationUrl.indexOf("?");
  return qi >= 0 && /(?:^|&)contract=/.test(animationUrl.slice(qi + 1));
}

// Metadata that moves (chain-state art, inline JSON, unrevealed) is read again on every open.
export function isMutableToken(d: {
  uri: string | null | undefined;
  animationUrl: string | null | undefined;
}): boolean {
  return (
    isInlineJsonUri(d.uri) ||
    /\/unrevealed\.json(?:[?#]|$)/i.test(d.uri ?? "") ||
    readsChainState(d.animationUrl)
  );
}

// owners_page(start, count) answers one owner (or "-") per id, comma separated.
export const OWNERS_PAGE_SIZE = 50;
const OWNER_ENTRY = /^(?:-|oct[1-9A-HJ-NP-Za-km-z]{20,60})$/;

export function ownedIdsFromPage(
  page: string | null,
  start: number,
  count: number,
  wallet: string,
): string[] | null {
  if (typeof page !== "string") return null;
  const owners = page.split(",").map((o) => o.trim());
  if (owners.length !== count || !owners.every((o) => OWNER_ENTRY.test(o))) return null;
  const ids: string[] = [];
  owners.forEach((o, i) => {
    if (o === wallet) ids.push(String(start + i));
  });
  return ids;
}
