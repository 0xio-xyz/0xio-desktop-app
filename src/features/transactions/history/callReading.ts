import { chainOf } from "./sides";
import type { KnownCalls } from "./callArgs";

type Translate = (key: string, options?: Record<string, unknown>) => string;

// The same mapping as the extension's History.
type CallAction =
  | "swap"
  | "approve"
  | "revoke"
  | "mint"
  | "burn"
  | "transfer"
  | "bridge"
  | "deposit"
  | "withdraw"
  | "claim"
  | "multicall"
  | "list"
  | "buy"
  | "stake"
  | "unstake"
  | "refund";

const ACTION_WORDS: Record<CallAction, string> = {
  swap: "Swap",
  approve: "Approve",
  revoke: "Revoke",
  mint: "Mint",
  burn: "Burn",
  transfer: "Transfer",
  bridge: "Bridge",
  deposit: "Deposit",
  withdraw: "Withdraw",
  claim: "Claim",
  multicall: "Multicall",
  list: "List",
  buy: "Buy",
  stake: "Stake",
  unstake: "Unstake",
  refund: "Refund",
};

const ACRONYMS = new Set([
  "nft",
  "oct",
  "ou",
  "id",
  "usd",
  "eth",
  "evm",
  "weth",
  "woct",
  "l1",
  "l2",
]);

const SELECTOR = /^0x[0-9a-f]{8}$/i;

export function readableMethod(method: string | null | undefined): string | null {
  const bare = (method ?? "").trim().replace(/\(.*$/, "");
  return bare && !SELECTOR.test(bare) ? bare : null;
}

export function methodWords(method: string): string {
  return method
    .trim()
    .replace(/\(.*$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) =>
      ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

const norm = (method: string) =>
  method
    .trim()
    .replace(/\(.*$/, "")
    .replace(/[_\s-]/g, "")
    .toLowerCase();

const EXACT: Record<string, CallAction> = {
  approve: "approve",
  increaseallowance: "approve",
  permit: "approve",
  setapprovalforall: "approve",
  approvenft: "approve",
  transfer: "transfer",
  transferfrom: "transfer",
  safetransferfrom: "transfer",
  safebatchtransferfrom: "transfer",
  transfernft: "transfer",
  multicall: "multicall",
  aggregate: "multicall",
  batch: "multicall",
  burntooctra: "bridge",
  locktoeth: "bridge",
  verifyandmint: "claim",
};

const PATTERNS: [RegExp, CallAction][] = [
  [/^exact(input|output)|swap/, "swap"],
  [/bridge|^sendtol2|^outboundtransfer/, "bridge"],
  [/^claim|^harvest|^getreward/, "claim"],
  [/^unstake|^undelegate/, "unstake"],
  [/^stake|^delegate/, "stake"],
  [/^withdraw|^emergencywithdraw|^redeem/, "withdraw"],
  [/^deposit/, "deposit"],
  [/^refund|^emergencyrefund/, "refund"],
  [/^burn/, "burn"],
  [/mint/, "mint"],
  [/^list/, "list"],
  [/^buy|^purchase/, "buy"],
];

const isZeroValue = (v: unknown) => /^0+$/.test(String(v ?? "").trim());
const isFalse = (v: unknown) => /^(false|0)$/i.test(String(v ?? "").trim());

interface CallContext {
  args?: readonly unknown[] | null;
  swapVault?: boolean;
}

export function callAction(
  method: string | null | undefined,
  ctx: CallContext = {},
): CallAction | null {
  const name = readableMethod(method);
  if (!name) return null;
  const n = norm(name);
  if (ctx.swapVault && n === "lock") return "swap";
  const action = EXACT[n] ?? PATTERNS.find(([re]) => re.test(n))?.[1] ?? null;
  if (action === "approve" && ctx.args) {
    if (n === "approve" && ctx.args.length >= 2 && isZeroValue(ctx.args[1])) return "revoke";
    if (n === "setapprovalforall" && ctx.args.length >= 2 && isFalse(ctx.args[1])) return "revoke";
  }
  return action;
}

const actionLabel = (action: CallAction, t: Translate): string =>
  t(`history.action.${action}`, { defaultValue: ACTION_WORDS[action] });

export function callTitle(
  method: string | null | undefined,
  t: Translate,
  ctx: CallContext = {},
): string {
  const action = callAction(method, ctx);
  if (action) return actionLabel(action, t);
  const name = readableMethod(method);
  return name ? methodWords(name) : t("history.contractCall", { defaultValue: "Contract call" });
}

export function methodRow(method: string | null | undefined, title: string): string | null {
  const name = readableMethod(method);
  if (!name) return null;
  const words = methodWords(name);
  return words.toLowerCase() === title.toLowerCase() ? null : words;
}

interface KnownOctraContract {
  network: string;
  address: string;
  name: string;
  swapVault?: boolean;
  calls?: KnownCalls;
}

const OCTRA_CONTRACTS: readonly KnownOctraContract[] = [
  {
    network: "mainnet",
    address: "oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq",
    name: "OCT Bridge",
    calls: "octBridge",
  },
  {
    network: "devnet",
    address: "octHqBuw3TGsgeGpu6GiumRTjQwc8VCRAo1ANhy5zL4ZVPc",
    name: "SwapVault",
    swapVault: true,
    calls: "swapVault",
  },
  {
    network: "devnet",
    address: "octDowmrJ3Ks8gSDk1rSzyNgPwDpUoHv2VhhnxC5shNKFMB",
    name: "SwapVault",
    swapVault: true,
    calls: "swapVault",
  },
  {
    network: "devnet",
    address: "oct46XYBqQt7yxZUSnBCqqKrsY8CxismrsMEANi8YLaBioe",
    name: "SwapVault",
    swapVault: true,
    calls: "swapVault",
  },
];

/** The only contract that may call itself OCT or WOCT on its network. */
export const WOCT: Record<string, string> = {
  devnet: "octCcgs68MFeeG8kpcwpHjdfD1M7tvjLKMvxkKMRkbNPmVs",
};

export function knownOctraContract(
  network: string,
  address: string | null | undefined,
): KnownOctraContract | null {
  if (!address) return null;
  const chain = chainOf(network);
  return OCTRA_CONTRACTS.find((c) => c.network === chain && c.address === address) ?? null;
}

export class BoundedCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
