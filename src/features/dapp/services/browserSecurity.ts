// Two guards are deliberately not configurable:
//   - dangerous URL schemes (javascript:, data:, file:, blob:): the DApp iframe runs with
//     allow-same-origin, so a script-bearing URL there can reach the wallet bridge.
//   - DApp transaction approval: wallet.send / program.call always route through the approval
//     modal (circleBridgeService throws BRIDGE_NEEDS_TX_APPROVAL); an auto-sign path would let a
//     browsed page spend funds with no prompt.

const KEY = "0xio_browser_security";

export interface BrowserSecuritySettings {
  blockInsecureSites: boolean;
}

const DEFAULT_BROWSER_SECURITY: BrowserSecuritySettings = {
  blockInsecureSites: true,
};

export function loadBrowserSecurity(): BrowserSecuritySettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_BROWSER_SECURITY };
    const parsed = JSON.parse(raw) as Partial<BrowserSecuritySettings>;
    return {
      blockInsecureSites:
        typeof parsed.blockInsecureSites === "boolean"
          ? parsed.blockInsecureSites
          : DEFAULT_BROWSER_SECURITY.blockInsecureSites,
    };
  } catch {
    return { ...DEFAULT_BROWSER_SECURITY };
  }
}

export function saveBrowserSecurity(settings: BrowserSecuritySettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

export function isBlockedInsecureUrl(url: string, blockInsecureSites: boolean): boolean {
  if (!blockInsecureSites) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return false;
    return !isLocalHost(parsed.hostname);
  } catch {
    return false;
  }
}
