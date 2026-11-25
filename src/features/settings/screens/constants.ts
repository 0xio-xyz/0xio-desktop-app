export const AUTO_LOCK_OPTIONS = [5, 15, 30, 60, 0].map((value) => ({ value }));

export const PVAC_TTL_MINUTES = [5, 10, 15, 30, 60];
export const TX_TIMEOUT_SECONDS = [60, 90, 120, 180, 300];
export const RPC_TIMEOUT_SECONDS = [10, 15, 30, 45, 60];
export const PROOF_THREAD_CHOICES = [0, 2, 4, 6, 8];

export const NETWORK_COLORS = ["#7aa2ff", "#5dd39e", "#ef6b6b", "#3b82f6", "#14b8a6", "#ec4899"];

/** The caller appends /rpc; a bare host gets http:// so it resolves to the node, not the app origin. */
export function normalizeRpcBase(raw: string): string {
  let u = raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/rpc$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u;
}
