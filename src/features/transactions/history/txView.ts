import type { Transaction } from "src/types/transaction";
import { formatOCT, formatTokenCompact } from "src/lib/format";
import { callTitle, knownOctraContract, methodRow } from "./callReading";
import { octraCallArgs } from "./callRows";
import { octraContractName, type ListedToken, type TokenFacts } from "./tokenNames";
import { isDead, txState, type TxState } from "./outcome";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface TxView {
  state: TxState;
  title: string;
  method: string | null;
  received: boolean;
  contract: { address: string; name: string | null } | null;
  counterparty: string | null;
  amount: string | null;
  unit: string;
  sign: "+" | "-" | "";
  args: unknown[] | null;
}

const TYPE_WORDS: Record<Transaction["type"], [string, string]> = {
  send: ["history.sentLabel", "Sent"],
  receive: ["history.receivedLabel", "Received"],
  encrypt: ["history.encryptBalance", "Encrypt balance"],
  decrypt: ["history.decryptBalance", "Decrypt balance"],
  stealth_send: ["history.stealthSend", "Stealth send"],
  claim: ["history.claimPrivate", "Claim private"],
  contract_call: ["history.contractCall", "Contract call"],
  contract_deploy: ["history.contractDeploy", "Deploy contract"],
  key_switch: ["history.keySwitch", "Key switch"],
};

const typeWords = (type: Transaction["type"], t: Translate): string => {
  const [key, fallback] = TYPE_WORDS[type] ?? ["history.transaction", "Transaction"];
  return t(key, { defaultValue: fallback });
};

export function txView(
  tx: Transaction,
  ctx: {
    me: string;
    network: string;
    method?: string | null;
    /** Read lazily; run through the spam rules here. */
    facts?: TokenFacts | null;
    listed?: readonly ListedToken[] | null;
    detailStatus?: string | null;
    args?: unknown[] | null;
    now?: number;
  },
  t: Translate,
): TxView {
  const state = txState(tx, ctx.detailStatus, ctx.now);
  const tt = tx.token_transfer;
  const isCall = tx.type === "contract_call" && !!tx.to;
  const method = tx.methodName ?? ctx.method ?? null;
  const args = octraCallArgs(tx.message) ?? ctx.args ?? null;
  const received = tt
    ? tt.recipient === ctx.me && tx.from !== ctx.me
    : tx.type === "receive" ||
      tx.type === "claim" ||
      tx.type === "decrypt" ||
      (tx.to === ctx.me && tx.from !== ctx.me);

  let title: string;
  let contract: TxView["contract"] = null;
  let methodLine: string | null = null;
  if (tt) {
    title = received
      ? t("history.receivedLabel", { defaultValue: "Received" })
      : t("history.sentLabel", { defaultValue: "Sent" });
  } else if (isCall) {
    const known = knownOctraContract(ctx.network, tx.to);
    title = callTitle(method, t, { swapVault: known?.swapVault, args });
    methodLine = methodRow(method, title);
    contract = {
      address: tx.to,
      name: octraContractName(ctx.network, tx.to, ctx.facts, ctx.listed),
    };
  } else {
    title = typeWords(tx.type, t);
  }

  const movedRaw = tt ? Number(tt.raw_amount) || 0 : tx.amount;
  const moved = movedRaw > 0;
  const amount = !moved
    ? null
    : tt
      ? formatTokenCompact(tt.raw_amount, tt.decimals || 0)
      : formatOCT(tx.amount);
  const unit = tt ? tt.symbol || t("history.token", { defaultValue: "Token" }) : "OCT";
  const sign: TxView["sign"] =
    !moved || isDead(state) || tx.type === "key_switch" ? "" : received ? "+" : "-";
  const counterparty = isCall && !tt ? null : received ? tx.from : tt ? tt.recipient : tx.to;

  return {
    state,
    title,
    method: methodLine,
    received,
    contract,
    counterparty,
    amount,
    unit,
    sign,
    args,
  };
}

const OP_TYPES: Record<string, Transaction["type"]> = {
  call: "contract_call",
  deploy: "contract_deploy",
  program_deploy: "contract_deploy",
  encrypt: "encrypt",
  decrypt: "decrypt",
  claim: "claim",
  private_transfer: "stealth_send",
  stealth: "stealth_send",
  key_switch: "key_switch",
};

export function rowFromDetail(
  detail: {
    hash: string;
    from: string;
    to: string;
    amount_raw: string;
    op_type: string;
    status: string;
    timestamp: number;
    nonce: number;
    ou?: string;
    message?: string;
    reject_reason?: string;
  },
  network: string,
  me: string,
): Transaction {
  const status = String(detail.status).toLowerCase();
  const type =
    OP_TYPES[detail.op_type] ?? (detail.to === me && detail.from !== me ? "receive" : "send");
  return {
    hash: detail.hash,
    type,
    amount: parseInt(detail.amount_raw) || 0,
    fee: parseInt(detail.ou ?? "0") || 0,
    from: detail.from,
    to: detail.to,
    timestamp: detail.timestamp < 1e12 ? detail.timestamp * 1000 : detail.timestamp,
    status: status === "confirmed" ? "confirmed" : status === "pending" ? "pending" : "failed",
    nonce: detail.nonce,
    op_type: detail.op_type,
    message: detail.message,
    reject_reason: detail.reject_reason,
    network,
    ...(status !== "confirmed" && status !== "pending" ? { chain_status: status } : {}),
  };
}
