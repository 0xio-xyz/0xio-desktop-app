/**
 * Every event names the sites it is for: there is no "every connected site" default, so an event
 * can only reach the sites connected to the wallet or the request it is about.
 */
export type DappEventType =
  | "accountChanged"
  | "disconnect"
  | "extensionLocked"
  | "extensionUnlocked"
  | "balanceChanged"
  | "networkChanged"
  | "transactionConfirmed";

type Listener = (type: DappEventType, data: unknown, origins: string[]) => void;

const listeners = new Set<Listener>();

export function onDappEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function publishDappEvent(type: DappEventType, data: unknown, origins: string[]): void {
  const to = [...new Set(origins.filter((o) => typeof o === "string" && o))];
  if (!to.length) return;
  listeners.forEach((fn) => {
    try {
      fn(type, data, to);
    } catch {}
  });
}
