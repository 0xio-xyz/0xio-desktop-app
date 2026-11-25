import { useState, useCallback, useMemo, useEffect } from "react";
import { useReviewFee, type FeeQuote } from "src/hooks/transactions/useFees";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import i18n from "src/i18n";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import * as contractService from "src/services/contracts/contractService";
import { captureScope, type TxScope } from "src/services/network/networkService";
import { expandEncParams, tryFheDecrypt, stripCipherPrefix } from "src/services/pvac/fhe";
import { logger } from "src/lib/logger";
import type { ContractAbi, AbiMethod, ContractReceipt } from "src/types/contract";

type MessageType = "success" | "error" | "warning" | "info" | "processing";

function isNumericType(type: string): boolean {
  return /int|uint|number/i.test(type);
}

export function validateContractAddress(addr: string): string | null {
  if (!addr.startsWith("oct")) return 'Address must start with "oct"';
  if (addr.length !== 47) return `Address must be 47 characters (got ${addr.length})`;
  return null;
}

interface ContractResult {
  raw: unknown;
  decrypted: number | null;
  txHash?: string;
  error?: string;
  ms: number;
}

interface UseContractInteractionOptions {
  address: string;
  ensurePvac: () => Promise<void>;
  walletId: string;
  showMessage: (type: MessageType, msg: string) => void;
  getCachedAbi?: (contractAddress: string) => ContractAbi | null;
  onAbiLoaded?: (contractAddress: string, abi: ContractAbi) => void;
}

interface UseContractInteractionReturn {
  auth: ReturnType<typeof useTransactionAuth>;
  contractAddr: string;
  setContractAddr: (v: string) => void;
  abi: ContractAbi | null;
  setAbi: (v: ContractAbi | null) => void;
  loadingAbi: boolean;
  selectedMethod: AbiMethod | null;
  methodName: string;
  setMethodName: (v: string) => void;
  params: {
    json: string;
    setJson: (v: string) => void;
    values: Record<number, string>;
    setValues: React.Dispatch<React.SetStateAction<Record<number, string>>>;
    encryptFlags: Record<number, boolean>;
    setEncryptFlags: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
    useRawJson: boolean;
    setUseRawJson: (v: boolean) => void;
  };
  amount: string;
  setAmount: (v: string) => void;
  ou: string;
  setOU: (v: string, mode?: string) => void;
  feeQuote: FeeQuote;
  callReview: CallReview | null;
  reviewError: string;
  checkingFee: boolean;
  openCallReview: () => Promise<void>;
  closeCallReview: () => void;
  confirmCall: () => Promise<void>;
  result: ContractResult | null;
  executing: boolean;
  receipt: ContractReceipt | null;
  loadingReceipt: boolean;
  loadAbi: () => Promise<void>;
  executeView: () => Promise<void>;
  handleAbiSelect: (name: string) => void;
  addressError: string | null;
}

interface CallReview {
  contract: string;
  method: string;
  params: unknown[];
  amountRaw: string;
  scope: TxScope;
}

export function useContractInteraction({
  address,
  ensurePvac,
  walletId,
  showMessage,
  getCachedAbi,
  onAbiLoaded,
}: UseContractInteractionOptions): UseContractInteractionReturn {
  const [contractAddr, setContractAddr] = useState("");
  const [methodName, setMethodName] = useState("");
  const [paramsJson, setParamsJson] = useState("[]");
  const [amount, setAmount] = useState("");
  const fee = useReviewFee("call", "ide_call");
  const txAuth = useTransactionAuth();
  const [callReview, setCallReview] = useState<CallReview | null>(null);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ContractResult | null>(null);

  const [abi, setAbi] = useState<ContractAbi | null>(null);
  const [loadingAbi, setLoadingAbi] = useState(false);
  const [paramValues, setParamValues] = useState<Record<number, string>>({});
  const [encryptFlags, setEncryptFlags] = useState<Record<number, boolean>>({});
  const [useRawJson, setUseRawJson] = useState(false);

  const [receipt, setReceipt] = useState<ContractReceipt | null>(null);
  const [loadingReceipt, setLoadingReceipt] = useState(false);

  const addressError = useMemo(() => {
    const trimmed = contractAddr.trim();
    if (!trimmed) return null;
    return validateContractAddress(trimmed);
  }, [contractAddr]);

  const selectedMethod = useMemo<AbiMethod | null>(() => {
    if (!abi || !methodName) return null;
    return abi.find((m) => m.name === methodName) ?? null;
  }, [abi, methodName]);

  useEffect(() => {
    if (!selectedMethod || useRawJson || selectedMethod.params.length === 0) return;
    const parts = selectedMethod.params.map((p, i) => {
      const val = (paramValues[i] ?? "").trim();
      if (!val) return isNumericType(p.type) ? "0" : '""';
      if (encryptFlags[i]) return `enc(${val})`;
      if (isNumericType(p.type) && !isNaN(Number(val))) return val;
      return JSON.stringify(val);
    });
    setParamsJson(`[${parts.join(", ")}]`);
  }, [selectedMethod, paramValues, encryptFlags, useRawJson]);

  const expandParams = useCallback(
    async (raw: string): Promise<unknown[]> => {
      let expanded = raw.trim() || "[]";
      if (/enc\(/.test(expanded)) {
        await ensurePvac();
        expanded = await expandEncParams(expanded, async (val) => {
          const r = await pvacBridge.encrypt(val);
          return stripCipherPrefix(r.cipher);
        });
      }
      return JSON.parse(expanded);
    },
    [ensurePvac],
  );

  const fetchReceipt = useCallback(async (txHash: string) => {
    setLoadingReceipt(true);
    setReceipt(null);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
        const r = await contractService.getContractReceipt(txHash);
        if (r) {
          setReceipt(r);
          setLoadingReceipt(false);
          return;
        }
      } catch {
        logger.debug(
          "contract",
          `receipt attempt ${attempt + 1} failed for ${txHash.slice(0, 16)}`,
        );
      }
    }
    setLoadingReceipt(false);
  }, []);

  const loadAbi = useCallback(async () => {
    const trimmed = contractAddr.trim();
    if (!trimmed) return;
    if (validateContractAddress(trimmed)) {
      showMessage("error", validateContractAddress(trimmed)!);
      return;
    }
    if (getCachedAbi) {
      const cached = getCachedAbi(trimmed);
      if (cached && cached.length > 0) {
        setAbi(cached);
        showMessage("success", `Loaded ABI from cache: ${cached.length} method(s)`);
        return;
      }
    }
    setLoadingAbi(true);
    try {
      const result = await contractService.getContractAbi(trimmed);
      setAbi(result);
      if (result && result.length > 0) {
        showMessage("success", `Loaded ABI: ${result.length} method(s)`);
        onAbiLoaded?.(trimmed, result);
      } else {
        showMessage("info", "No ABI found for this contract");
      }
    } catch {
      showMessage("error", "Failed to load ABI");
    } finally {
      setLoadingAbi(false);
    }
  }, [contractAddr, showMessage, getCachedAbi, onAbiLoaded]);

  const executeView = useCallback(async () => {
    const trimmed = contractAddr.trim();
    if (!trimmed || !methodName.trim()) {
      showMessage("error", "Contract address and method name required");
      return;
    }
    const addrErr = validateContractAddress(trimmed);
    if (addrErr) {
      showMessage("error", addrErr);
      return;
    }
    setExecuting(true);
    setResult(null);
    const start = performance.now();
    logger.debug("contract", `view - ${trimmed.slice(0, 12)}...::${methodName}`);
    try {
      const params = await expandParams(paramsJson);
      const raw = await contractService.viewContract(trimmed, methodName, params, address);
      const ms = Math.round(performance.now() - start);
      let decrypted: number | null = null;
      if (pvacBridge.isInitialized()) {
        decrypted = await tryFheDecrypt(raw, (c) => pvacBridge.decrypt(c).then((r) => r.value));
      }
      logger.debug("contract", `view success - ${methodName} ${ms}ms`);
      setResult({ raw, decrypted, ms });
    } catch (err) {
      const ms = Math.round(performance.now() - start);
      logger.error(
        "contract",
        `view failed - ${methodName}: ${err instanceof Error ? err.message : "View failed"}`,
      );
      setResult({
        raw: null,
        decrypted: null,
        error: err instanceof Error ? err.message : "View failed",
        ms,
      });
    } finally {
      setExecuting(false);
    }
  }, [contractAddr, methodName, paramsJson, address, expandParams, showMessage]);

  const openCallReview = useCallback(async () => {
    const trimmed = contractAddr.trim();
    if (!trimmed || !methodName.trim()) {
      showMessage("error", "Contract address and method name required");
      return;
    }
    const addrErr = validateContractAddress(trimmed);
    if (addrErr) {
      showMessage("error", addrErr);
      return;
    }
    const scope = captureScope(address);
    try {
      const params = await expandParams(paramsJson);
      fee.recheck.setError("");
      setCallReview({
        contract: trimmed,
        method: methodName,
        params,
        amountRaw: amount.trim() ? String(Math.round(parseFloat(amount) * 1_000_000)) : "0",
        scope,
      });
    } catch (err) {
      showMessage("error", err instanceof Error ? err.message : "Invalid parameters");
    }
  }, [
    contractAddr,
    methodName,
    paramsJson,
    address,
    amount,
    expandParams,
    showMessage,
    fee.recheck,
  ]);

  const closeCallReview = useCallback(() => {
    if (!fee.recheck.checking) setCallReview(null);
  }, [fee.recheck.checking]);

  const confirmCall = useCallback(async () => {
    const review = callReview;
    if (!review || executing || fee.quote.status !== "ok" || !fee.ou) return;
    if (await fee.recheck.check(review.scope.networkId, fee.ou)) return;
    if (!(await txAuth.requestAuth(i18n.t("auth.contractCall")))) return;
    setCallReview(null);
    setExecuting(true);
    setResult(null);
    setReceipt(null);
    const start = performance.now();
    logger.info(
      "contract",
      `call - ${review.contract.slice(0, 12)}...::${review.method} ou=${fee.ou}`,
    );
    try {
      const txHash = await contractService.callContract({
        contract: review.contract,
        method: review.method,
        params: review.params,
        from: address,
        walletId,
        amount: review.amountRaw,
        ou: fee.ou,
        scope: review.scope,
      });
      const ms = Math.round(performance.now() - start);
      logger.info(
        "contract",
        `call success - ${review.method} hash=${txHash.slice(0, 16)}... ${ms}ms`,
      );
      setResult({ raw: { txHash }, decrypted: null, txHash, ms });
      showMessage("success", `Transaction submitted: ${txHash.slice(0, 16)}...`);
      fetchReceipt(txHash);
    } catch (err) {
      const ms = Math.round(performance.now() - start);
      logger.error(
        "contract",
        `call failed - ${review.method}: ${err instanceof Error ? err.message : "Call failed"} ${ms}ms`,
      );
      setResult({
        raw: null,
        decrypted: null,
        error: err instanceof Error ? err.message : "Call failed",
        ms,
      });
    } finally {
      setExecuting(false);
    }
  }, [
    callReview,
    executing,
    fee.quote.status,
    fee.ou,
    fee.recheck,
    address,
    walletId,
    showMessage,
    fetchReceipt,
    txAuth,
  ]);

  const handleAbiSelect = useCallback(
    (name: string) => {
      if (!abi) return;
      const method = abi.find((m) => m.name === name);
      if (method) {
        setMethodName(method.name);
        setResult(null);
        setReceipt(null);
        setAmount("");
        setParamValues({});
        setEncryptFlags({});
        setUseRawJson(false);
        if (method.params.length === 0) setParamsJson("[]");
      }
    },
    [abi],
  );

  const changeContract = useCallback((v: string) => {
    setContractAddr(v);
    setAbi(null);
  }, []);

  return {
    auth: txAuth,
    contractAddr,
    setContractAddr: changeContract,
    abi,
    setAbi,
    loadingAbi,
    selectedMethod,
    methodName,
    setMethodName,
    params: {
      json: paramsJson,
      setJson: setParamsJson,
      values: paramValues,
      setValues: setParamValues,
      encryptFlags,
      setEncryptFlags,
      useRawJson,
      setUseRawJson,
    },
    amount,
    setAmount,
    ou: fee.ou,
    setOU: fee.setOU,
    feeQuote: fee.quote,
    callReview,
    reviewError: fee.recheck.error,
    checkingFee: fee.recheck.checking,
    openCallReview,
    closeCallReview,
    confirmCall,
    result,
    executing,
    receipt,
    loadingReceipt,
    loadAbi,
    executeView,
    handleAbiSelect,
    addressError,
  };
}
