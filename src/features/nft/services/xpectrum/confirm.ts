// A submit resolves on mempool acceptance, not execution: a call can settle `confirmed` (fee
// charged) while it reverted, so callers re-read the on-chain state to prove the effect.

import { jsonRpcCall } from "src/services/network/networkService";

type TxStatus = "confirmed" | "rejected" | "dropped" | "timeout";
interface Receipt {
  status: TxStatus;
  reason: string | null;
}

interface RawReceipt {
  status?: string;
  error?: { type?: string; reason?: string };
  reject_reason?: string;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export async function waitForReceipt(
  txHash: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<Receipt> {
  const intervalMs = opts.intervalMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await jsonRpcCall<RawReceipt>("octra_transaction", [txHash]);
      const status = r?.status;
      if (status && status !== "pending") {
        const raw = r?.error?.reason ?? r?.reject_reason ?? null;
        return { status: status as TxStatus, reason: raw ? parseChainError(raw) : null };
      }
    } catch {}
    await sleep(intervalMs);
  }
  return { status: "timeout", reason: null };
}

// "execution reverted [contract: the message]" -> "The message".
function parseChainError(reason: string): string {
  const m = reason.match(/execution reverted\s*\[[^:\]]*:\s*([^\]]+)\]/i);
  let msg = (m ? m[1] : reason).trim();
  const colon = msg.indexOf(":");
  if (colon > -1 && colon < 24) msg = msg.slice(colon + 1).trim();
  return msg ? msg.charAt(0).toUpperCase() + msg.slice(1) : reason;
}
