import { UnclearSubmitError } from "src/services/network/submitErrors";
import {
  jsonRpcCall,
  jsonRpcCallOn,
  getNextNonce,
  releaseNonce,
  submitTransaction,
  assertScope,
  FeeUnavailableError,
  type TxScope,
} from "src/services/network/networkService";
import { walletBridge } from "src/services/wallet/walletBridge";
import { buildSignaturePayload, canonicalTx } from "src/services/network/transactionBuilder";
import { logger } from "src/lib/logger";
import type { SignedTransaction } from "src/types/transaction";
import type {
  CompileResult,
  ContractLanguage,
  PredictedAddress,
  ContractInfo,
  ContractReceipt,
  ContractAbi,
  ContractListEntry,
  DeployResult,
} from "src/types/contract";
import { normalizeAbi } from "src/services/contracts/contractAbi";
import { txTimestamp } from "src/services/network/txTimestamp";

function requireFee(ou: string | undefined): string {
  const n = Number(String(ou ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new FeeUnavailableError();
  return String(Math.round(n));
}

export async function compile(source: string, language: ContractLanguage): Promise<CompileResult> {
  const method = language === "aml" ? "octra_compileAml" : "octra_compileAssembly";
  return logger.timed("contract", `compile(${language})`, async () => {
    // program=true (the webcli shape) returns the abi, disasm, deploy_payload and verification report.
    const params = language === "aml" ? [source, true] : [source];
    const result = await jsonRpcCall<Omit<CompileResult, "abi"> & { abi?: unknown }>(
      method,
      params,
    );
    logger.info("contract", `compiled: ${result.size} bytes, ${result.instructions} instructions`);
    return { ...result, abi: normalizeAbi(result.abi) };
  });
}

async function computeContractAddress(
  bytecodeB64: string,
  deployer: string,
  nonce: number,
  networkId?: string,
): Promise<PredictedAddress> {
  return jsonRpcCallOn<PredictedAddress>(networkId, "octra_computeContractAddress", [
    bytecodeB64,
    deployer,
    nonce,
  ]);
}

function assertCaller(from: string, scope: TxScope): void {
  if (from !== scope.address) {
    const e = new Error("This transaction is not from the active wallet. Nothing was sent.");
    e.name = "ScopeChanged";
    throw e;
  }
  assertScope(scope);
}

export class DeployChangedError extends Error {
  readonly code = "DEPLOY_CHANGED";
  constructor(message: string) {
    super(message);
    this.name = "DeployChangedError";
  }
}

/** Nothing is reserved: a review can stay open for minutes, so the deploy reads the nonce again. */
export async function previewDeploy(
  bytecodeB64: string,
  scope: TxScope,
): Promise<{ nonce: number; contractAddress: string }> {
  const nonce = await getNextNonce(scope.address, scope.networkId);
  releaseNonce(scope.address, nonce, scope.networkId);
  const predicted = await computeContractAddress(
    bytecodeB64,
    scope.address,
    nonce,
    scope.networkId,
  );
  if (typeof predicted?.address !== "string" || !predicted.address.startsWith("oct")) {
    throw new Error("The node did not return a contract address");
  }
  return { nonce, contractAddress: predicted.address };
}

export async function deployContract(params: {
  bytecodeB64: string;
  deployPayload?: string;
  from: string;
  walletId: string;
  constructorParams?: string;
  ou?: string;
  scope: TxScope;
  reviewed?: { nonce: number; contractAddress: string };
}): Promise<DeployResult> {
  return logger.timed("contract", "deploy", async () => {
    const { scope, reviewed } = params;
    assertCaller(params.from, scope);
    const ou = requireFee(params.ou);
    const nonce = await getNextNonce(params.from, scope.networkId);
    let predicted: PredictedAddress;
    if (reviewed && nonce === reviewed.nonce) {
      predicted = { address: reviewed.contractAddress, deployer: params.from, nonce };
    } else {
      try {
        predicted = await computeContractAddress(
          params.bytecodeB64,
          params.from,
          nonce,
          scope.networkId,
        );
      } catch (e) {
        releaseNonce(params.from, nonce, scope.networkId);
        throw e;
      }
      if (reviewed && predicted.address !== reviewed.contractAddress) {
        releaseNonce(params.from, nonce, scope.networkId);
        throw new DeployChangedError(
          "Another transaction from this wallet went out during the review, so the contract address changed. Nothing was sent. Deploy again.",
        );
      }
    }

    const tx: SignedTransaction = canonicalTx({
      from: params.from,
      to_: predicted.address,
      amount: "0",
      nonce,
      ou,
      timestamp: txTimestamp(),
      op_type: params.deployPayload ? "program_deploy" : "deploy",
      encrypted_data: params.deployPayload || params.bytecodeB64,
    });
    if (params.constructorParams) {
      tx.message = params.constructorParams;
    }

    assertCaller(params.from, scope);
    const canonical = buildSignaturePayload(tx);
    const [signature, publicKey] = await Promise.all([
      walletBridge.signMessage(params.walletId, canonical),
      walletBridge.getPublicKey(params.walletId),
    ]);
    tx.signature = signature;
    tx.public_key = publicKey;

    const txHash = await submitTransaction(tx, scope).catch((err) => {
      if (err instanceof UnclearSubmitError) err.contractAddress = predicted.address;
      throw err;
    });
    logger.info("contract", `deployed -> ${predicted.address} (tx: ${txHash})`);
    return { txHash, contractAddress: predicted.address };
  });
}

export const callMessage = (params: unknown[]): string => JSON.stringify(params);

export async function callContract(params: {
  contract: string;
  method: string;
  params: unknown[];
  from: string;
  walletId: string;
  amount?: string;
  ou?: string;
  scope: TxScope;
}): Promise<string> {
  return logger.timed("contract", `call(${params.method})`, async () => {
    const { scope } = params;
    assertCaller(params.from, scope);
    const ou = requireFee(params.ou);
    const nonce = await getNextNonce(params.from, scope.networkId);

    const tx: SignedTransaction = canonicalTx({
      from: params.from,
      to_: params.contract,
      amount: params.amount || "0",
      nonce,
      ou,
      timestamp: txTimestamp(),
      op_type: "call",
      encrypted_data: params.method,
      message: callMessage(params.params),
    });

    assertCaller(params.from, scope);
    const canonical = buildSignaturePayload(tx);
    const [signature, publicKey] = await Promise.all([
      walletBridge.signMessage(params.walletId, canonical),
      walletBridge.getPublicKey(params.walletId),
    ]);
    tx.signature = signature;
    tx.public_key = publicKey;

    const txHash = await submitTransaction(tx, scope);
    logger.info("contract", `call ${params.method} -> ${txHash}`);
    return txHash;
  });
}

export async function viewContract(
  contract: string,
  method: string,
  params: unknown[],
  caller: string,
  networkId?: string,
): Promise<unknown> {
  return logger.timed("contract", `view(${method})`, () =>
    jsonRpcCallOn<unknown>(networkId, "contract_call", [contract, method, params, caller]),
  );
}

export async function getContractInfo(address: string, networkId?: string): Promise<ContractInfo> {
  return jsonRpcCallOn<ContractInfo>(networkId, "vm_contract", [address]);
}

export async function getContractReceipt(txHash: string): Promise<ContractReceipt> {
  return jsonRpcCall<ContractReceipt>("contract_receipt", [txHash]);
}

export async function getContractAbi(address: string): Promise<ContractAbi | null> {
  try {
    const abi = normalizeAbi(await jsonRpcCall<unknown>("octra_contractAbi", [address]));
    return abi.length > 0 ? abi : null;
  } catch {
    return null;
  }
}

const DEPLOY_SCAN_PAGE = 100;
const DEPLOY_SCAN_MAX = 2000;

/** octra_listContracts leaves contracts out, so this reads the address's own deploy transactions. */
export async function listDeployedBy(
  address: string,
  networkId: string,
): Promise<ContractListEntry[]> {
  const deployed: string[] = [];
  for (let offset = 0; offset < DEPLOY_SCAN_MAX; offset += DEPLOY_SCAN_PAGE) {
    const page = await jsonRpcCallOn<{
      transactions?: { op_type?: string; from?: string; to?: string }[];
      total?: number;
      has_more?: boolean;
    }>(networkId, "octra_transactionsByAddress", [address, DEPLOY_SCAN_PAGE, offset]);
    const txs = page?.transactions ?? [];
    for (const tx of txs) {
      if (
        (tx.op_type === "deploy" || tx.op_type === "program_deploy") &&
        tx.from === address &&
        tx.to &&
        !deployed.includes(tx.to)
      ) {
        deployed.push(tx.to);
      }
    }
    const total = typeof page?.total === "number" ? page.total : 0;
    if (txs.length < DEPLOY_SCAN_PAGE || page?.has_more === false || offset + txs.length >= total) {
      break;
    }
  }
  const out: ContractListEntry[] = [];
  for (let i = 0; i < deployed.length; i += 4) {
    const batch = await Promise.all(
      deployed.slice(i, i + 4).map(async (addr): Promise<ContractListEntry> => {
        try {
          const info = await getContractInfo(addr, networkId);
          return { ...info, address: addr, owner: info.owner || address };
        } catch {
          return { address: addr, owner: address };
        }
      }),
    );
    out.push(...batch);
  }
  return out;
}

export async function listContracts(networkId?: string): Promise<ContractListEntry[]> {
  try {
    const result = await jsonRpcCallOn<ContractListEntry[] | { contracts: ContractListEntry[] }>(
      networkId,
      "octra_listContracts",
      [],
    );
    return Array.isArray(result)
      ? result
      : (result as { contracts: ContractListEntry[] }).contracts || [];
  } catch {
    return [];
  }
}

export async function verifyContract(
  address: string,
  source: string,
): Promise<{ verified: boolean; message?: string }> {
  const result = await jsonRpcCall<Record<string, unknown>>("contract_verify", [address, source]);
  return { verified: !result.error, message: result.error as string | undefined };
}
