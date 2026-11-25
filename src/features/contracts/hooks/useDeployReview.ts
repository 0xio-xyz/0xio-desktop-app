import { useCallback, useMemo, useState } from "react";
import { recheckReviewedFee, useFee, type FeeQuote } from "src/hooks/transactions/useFees";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import i18n from "src/i18n";
import * as contractService from "src/services/contracts/contractService";
import {
  captureScope,
  type FeeRecommendation,
  type TxScope,
} from "src/services/network/networkService";
import { deployFee, parseDeployOu } from "src/features/dapp/services/deployRequest";
import type { DeployResult } from "src/types/contract";

interface DeployDraft {
  bytecodeB64: string;
  deployPayload?: string;
  constructorParams?: string;
}

interface DeployReviewState extends DeployDraft {
  scope: TxScope;
  nonce: number;
  contractAddress: string;
}

// webcli's required fee for the payload, from the live quote's minimum. Empty while no live read
// is in, so nothing can be signed.
export function ideDeployOu(bytecodeB64: string, live: FeeRecommendation | null): string {
  return live && bytecodeB64 ? deployFee(bytecodeB64, live.minimum).toString() : "";
}

export function deployQuote(quote: FeeQuote, required: string): FeeQuote {
  if (!required) return quote;
  const fixed = (f: FeeRecommendation | null) => f && { minimum: required, recommended: required };
  return { ...quote, fee: fixed(quote.fee), last: fixed(quote.last) };
}

export function chosenDeployOu(required: string, picked: string): string {
  if (!required || !picked) return required;
  const ou = parseDeployOu(picked);
  return ou != null && ou >= BigInt(required) ? ou.toString() : required;
}

// The fee is read again before signing, and the deploy signs only what the review showed.
export function useDeployReview(
  address: string,
  walletId: string,
  signedData: string | null,
  programDraft = false,
) {
  const txAuth = useTransactionAuth();
  const [review, setReview] = useState<DeployReviewState | null>(null);
  const code = (review ? review.deployPayload || review.bytecodeB64 : signedData) ?? "";
  const hint = code ? { encrypted_data_len: code.length } : undefined;
  const quote = useFee("program_deploy", { hint, enabled: !!hint });
  const [preparing, setPreparing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const program = review ? !!review.deployPayload : programDraft;
  const required = ideDeployOu(code, quote.fee);
  const [picked, setPicked] = useState("");
  const ou = chosenDeployOu(required, picked);
  const pickQuote = useMemo(() => deployQuote(quote, required), [quote, required]);
  const { retry } = quote;

  const open = useCallback(
    async (draft: DeployDraft) => {
      const scope = captureScope(address);
      setPreparing(true);
      setError("");
      try {
        const preview = await contractService.previewDeploy(draft.bytecodeB64, scope);
        setReview({ ...draft, ...preview, scope });
      } finally {
        setPreparing(false);
      }
    },
    [address],
  );

  const close = useCallback(() => {
    if (!checking) setReview(null);
  }, [checking]);

  const confirm = useCallback(async (): Promise<DeployResult | null> => {
    if (!review || checking || !ou) return null;
    setChecking(true);
    setError("");
    try {
      const r = await recheckReviewedFee("program_deploy", review.scope.networkId, ou, {
        encrypted_data_len: code.length,
      });
      if (r.error) {
        retry();
        setError(r.error);
        return null;
      }
    } finally {
      setChecking(false);
    }
    if (!(await txAuth.requestAuth(i18n.t("auth.deploy")))) return null;
    setReview(null);
    return contractService.deployContract({
      bytecodeB64: review.bytecodeB64,
      deployPayload: review.deployPayload,
      from: address,
      walletId,
      constructorParams: review.constructorParams,
      ou,
      scope: review.scope,
      reviewed: { nonce: review.nonce, contractAddress: review.contractAddress },
    });
  }, [review, checking, ou, code, retry, address, walletId, txAuth]);

  return {
    quote,
    pickQuote,
    ou,
    program,
    setOU: setPicked,
    review,
    preparing,
    checking,
    error,
    open,
    close,
    confirm,
    auth: txAuth,
  };
}
