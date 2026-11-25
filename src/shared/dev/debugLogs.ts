interface RpcLogEntry {
  id: number;
  timestamp: number;
  method: string;
  url: string;
  duration?: number;
  status: "pending" | "ok" | "error";
  error?: string;
  requestSize?: number;
  responseSize?: number;
  params?: string;
  responsePreview?: string;
}

interface PvacTiming {
  operation: string;
  duration: number;
  timestamp: number;
  details?: string;
}

const rpcLogs: RpcLogEntry[] = [];
const pvacTimings: PvacTiming[] = [];
let logIdCounter = 0;
let listeners: (() => void)[] = [];

export function subscribeDebugLogs(cb: () => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

export function debugLogs() {
  return { rpcLogs, pvacTimings };
}

function notify() {
  listeners.forEach((l) => l());
}

export function clearDebugLogs() {
  rpcLogs.length = 0;
  pvacTimings.length = 0;
  notify();
}

export function logRpc(entry: Omit<RpcLogEntry, "id">) {
  rpcLogs.unshift({ ...entry, id: ++logIdCounter });
  if (rpcLogs.length > 200) rpcLogs.pop();
  notify();
}

export function updateRpcLog(id: number, update: Partial<RpcLogEntry>) {
  const idx = rpcLogs.findIndex((l) => l.id === id);
  if (idx >= 0) {
    Object.assign(rpcLogs[idx], update);
    notify();
  }
}

export function logPvacTiming(entry: PvacTiming) {
  pvacTimings.unshift(entry);
  if (pvacTimings.length > 50) pvacTimings.pop();
  notify();
}

export function getNextRpcLogId() {
  return ++logIdCounter;
}
