import { FEE_SHORT, INSUFFICIENT_BALANCE } from "./feeCopy";

export type SpendKind = "public" | "encrypt" | "token" | "decrypt" | "private";

interface SpendInput {
  kind: SpendKind;
  balance: number | null;
  publicMicro: number | null;
  feeOu: number | null;
  amount: number;
  count?: number;
}

export interface SpendCheck {
  max: number | null;
  error: string | null;
  ok: boolean;
}

export function spendCheck({
  kind,
  balance,
  publicMicro,
  feeOu,
  amount,
  count = 1,
}: SpendInput): SpendCheck {
  if (balance === null || publicMicro === null || feeOu === null)
    return { max: null, error: null, ok: false };
  const fees = feeOu * count;
  const feeFromSpend = kind === "public" || kind === "encrypt";
  const max = Math.max(0, feeFromSpend ? balance - feeOu : balance);
  let error: string | null = null;
  if (feeFromSpend) {
    if (amount > 0 && amount + fees > balance) error = INSUFFICIENT_BALANCE;
  } else if (publicMicro < fees) error = FEE_SHORT;
  else if (amount > balance) error = INSUFFICIENT_BALANCE;
  return { max, error, ok: error === null && amount > 0 };
}
