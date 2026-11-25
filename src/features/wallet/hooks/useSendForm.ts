import { useCallback, useState } from "react";
import { useLocation, useSearchParams } from "src/lib/router";
import { useWallet } from "src/contexts/useWallet";
import { useBalance } from "src/hooks/wallet/useBalance";
import { useTokens } from "src/hooks/wallet/useTokens";
import { useFee, useFeeRecheck } from "src/hooks/transactions/useFees";
import { usePersistedOU } from "src/hooks/transactions/usePersistedOU";
import { ADDRESS_PREFIX, FINANCE, NETWORKS } from "src/services/network/config";
import { decimalToRaw, parseOCTInput } from "src/lib/format";
import { feeOu } from "src/services/transactions/reviewedFee";
import { spendCheck, type SpendCheck, type SpendKind } from "src/services/transactions/spendLimit";
import { INSUFFICIENT_BALANCE } from "src/services/transactions/feeCopy";
import type { TokenInfo } from "src/types/contract";

export type SendTab = "single" | "batch";
export type SendMode = "standard" | "private";

export const MESSAGE_MAX = 1024;

export function isAddress(v: string): boolean {
  return v.startsWith(ADDRESS_PREFIX) && v.length === 47;
}

export function exactTokenSpend(check: SpendCheck, raw: string, balance: string): SpendCheck {
  if (!check.ok) return check;
  if (raw === "0") return { ...check, ok: false };
  const held = /^\d+$/.test(balance) ? BigInt(balance) : 0n;
  return BigInt(raw) > held ? { ...check, error: INSUFFICIENT_BALANCE, ok: false } : check;
}

interface NavState {
  token?: TokenInfo;
  mode?: string;
  recipient?: string;
}

export function useSendForm() {
  const location = useLocation();
  const nav = (location.state as NavState | null) ?? {};
  const [searchParams, setSearchParams] = useSearchParams();
  const { networkId } = useWallet();
  const privacyEnabled = NETWORKS[networkId]?.supportsPrivacy ?? false;
  const { publicBalance, privateBalance, isLoading } = useBalance();
  const { tokens } = useTokens();

  const tab: SendTab = searchParams.get("tab") === "batch" ? "batch" : "single";
  const setTab = useCallback(
    (next: SendTab) => setSearchParams(next === "single" ? {} : { tab: next }, { replace: true }),
    [setSearchParams],
  );

  const [token, setTokenState] = useState<TokenInfo | null>(() => nav.token ?? null);
  const [mode, setModeState] = useState<SendMode>(() =>
    nav.mode === "private" && privacyEnabled ? "private" : "standard",
  );
  const [to, setTo] = useState<{ address: string; name: string | null }>(() => ({
    address: nav.recipient ?? "",
    name: null,
  }));
  const recipient = to.address;
  const setRecipient = useCallback(
    (address: string, name: string | null = null) => setTo({ address, name }),
    [],
  );
  const [amount, setAmount] = useState("");
  const [message, setMessageState] = useState("");

  const isToken = token !== null;
  const isPrivate = !isToken && mode === "private" && privacyEnabled;
  const unit = isToken ? token.symbol : "OCT";

  const setMode = useCallback(
    (m: SendMode) => {
      setModeState(m);
      if (m === "private" && token) {
        setTokenState(null);
        setAmount("");
      }
    },
    [token],
  );
  const setToken = useCallback((next: TokenInfo | null) => {
    setTokenState(next);
    setAmount("");
  }, []);
  const setMessage = useCallback((v: string) => setMessageState(v.slice(0, MESSAGE_MAX)), []);

  const feeOp = isToken ? "call" : isPrivate ? "stealth" : "standard";
  const quote = useFee(feeOp);
  const [ou, setOU] = usePersistedOU("send", "", quote.fee ?? undefined);
  const recheck = useFeeRecheck(feeOp, quote, setOU);
  const fee = quote.status === "ok" ? feeOu(ou) : null;

  const publicKnown = isLoading ? null : publicBalance;
  const tokenBalance = isToken ? parseInt(token.balance) / Math.pow(10, token.decimals) : 0;
  const spendKind: SpendKind = isToken ? "token" : isPrivate ? "private" : "public";
  const spendBalance = isToken ? tokenBalance : isPrivate ? privateBalance : publicKnown;
  const amountMicro = parseOCTInput(amount);
  const tokenAmount = isToken ? parseFloat(amount || "0") || 0 : 0;
  const tokenRaw = isToken ? decimalToRaw(amount, token.decimals) : "0";
  const checked = spendCheck({
    kind: spendKind,
    balance: spendBalance,
    publicMicro: publicKnown,
    feeOu: fee,
    amount: isToken ? tokenAmount : amountMicro,
  });
  const spend = isToken ? exactTokenSpend(checked, tokenRaw, token.balance) : checked;
  const maxUnits =
    spend.max === null ? null : isToken ? spend.max : spend.max / FINANCE.MICRO_OCT_MULTIPLIER;
  const validRecipient = isAddress(recipient);

  return {
    tab,
    setTab,
    privacyEnabled,
    mode,
    setMode,
    token,
    setToken,
    tokens: isPrivate ? [] : tokens,
    isToken,
    isPrivate,
    unit,
    recipient,
    recipientName: validRecipient ? to.name : null,
    setRecipient,
    validRecipient,
    amount,
    setAmount,
    amountMicro,
    tokenAmount,
    tokenRaw,
    tokenBalance,
    message,
    setMessage,
    quote,
    ou,
    setOU,
    fee,
    feeOp,
    recheck,
    spendKind,
    spendBalance,
    spend,
    maxUnits,
    publicKnown,
    privateBalance,
    ready: validRecipient && spend.ok,
    clear: () => {
      setTo({ address: "", name: null });
      setAmount("");
      setMessageState("");
    },
  };
}

export type SendForm = ReturnType<typeof useSendForm>;
