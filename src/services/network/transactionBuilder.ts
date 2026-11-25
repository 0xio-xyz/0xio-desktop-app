import { walletBridge } from "src/services/wallet/walletBridge";
import * as networkService from "src/services/network/networkService";
import type { TxScope } from "src/services/network/networkService";
import type { SignedTransaction } from "src/types/transaction";
import { logger } from "src/lib/logger";
import { formatTimestamp, jsonEscape, plainDigits } from "src/services/network/txHash";
import { txTimestamp } from "src/services/network/txTimestamp";
import { UnclearSubmitError } from "src/services/network/submitErrors";

/** The node signs and hashes an optional field sent as "" as that value, while the signing text
 *  leaves it out; so a record this wallet builds never carries one, as in the reference client. */
function withoutEmptyFields<T extends SignedTransaction>(tx: T): T {
  const out = { ...tx };
  if (out.public_key === "") delete out.public_key;
  if (out.message === "") delete out.message;
  if (out.encrypted_data === "") delete out.encrypted_data;
  return out;
}

/** Amount and ou as webcli's plain digits, so what is submitted is what is signed. */
export function canonicalTx<T extends SignedTransaction>(tx: T): T {
  return withoutEmptyFields({ ...tx, amount: plainDigits(tx.amount), ou: plainDigits(tx.ou) });
}

/** webcli signing_json: the exact text that gets Ed25519-signed and the node rebuilds. */
export function buildSignaturePayload(tx: SignedTransaction): string {
  let text =
    `{"from":"${jsonEscape(tx.from)}","to_":"${jsonEscape(tx.to_)}"` +
    `,"amount":"${plainDigits(tx.amount)}","nonce":${tx.nonce},"ou":"${plainDigits(tx.ou)}"` +
    `,"timestamp":${formatTimestamp(tx.timestamp)},"op_type":"${jsonEscape(tx.op_type || "standard")}"`;
  if (tx.encrypted_data) text += `,"encrypted_data":"${jsonEscape(tx.encrypted_data)}"`;
  if (tx.message) text += `,"message":"${jsonEscape(tx.message)}"`;
  return `${text}}`;
}

/** A missing fee is never made up. */
function requireOu(ou: string | undefined): string {
  const n = Number(String(ou ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new networkService.FeeUnavailableError();
  return String(Math.round(n));
}

function assertSender(from: string, scope: TxScope): void {
  if (from !== scope.address) {
    const e = new Error("This transaction is not from the active wallet. Nothing was signed.");
    e.name = "ScopeChanged";
    throw e;
  }
  networkService.assertScope(scope);
}

/** The private key never leaves the Rust side. */
async function signAndFinalizeSecure(
  unsigned: SignedTransaction,
  walletId: string,
  scope: TxScope,
): Promise<SignedTransaction> {
  const tx = canonicalTx(unsigned);
  assertSender(tx.from, scope);
  const start = performance.now();
  const canonical = buildSignaturePayload(tx);
  logger.info("tx", `sigPayload (${canonical.length} chars): ${canonical.slice(0, 300)}...`);
  const [signature, publicKey] = await Promise.all([
    walletBridge.signMessage(walletId, canonical),
    walletBridge.getPublicKey(walletId),
  ]);
  logger.info(
    "tx",
    `signed(secure): sig=${signature.slice(0, 24)}... pub=${publicKey.slice(0, 16)}... (${(performance.now() - start).toFixed(0)}ms)`,
  );
  return { ...tx, signature, public_key: publicKey };
}

export async function buildTransferTx(params: {
  from: string;
  to: string;
  amount: number | string | bigint;
  walletId: string;
  ou?: string;
  message?: string;
  scope: TxScope;
}): Promise<SignedTransaction> {
  return logger.timed("tx", "buildTransferTx", async () => {
    assertSender(params.from, params.scope);
    const ou = requireOu(params.ou);
    const nonce = await networkService.getNextNonce(params.from, params.scope.networkId);

    const tx: SignedTransaction = {
      from: params.from,
      to_: params.to,
      amount: plainDigits(params.amount),
      nonce,
      ou,
      timestamp: txTimestamp(),
    };

    if (params.message) {
      tx.message = params.message.slice(0, 1024);
    }

    logger.debug(
      "tx",
      `transfer: ${params.from.slice(0, 10)}... -> ${params.to.slice(0, 10)}..., amount=${params.amount}, ou=${ou}, nonce=${nonce}`,
    );
    return signAndFinalizeSecure(tx, params.walletId, params.scope);
  });
}

/** Message byte limits the node sets per op (tx_payload message_limit); others keep 1024. */
const HFHE_MESSAGE_MAX: Record<string, number> = {
  circle_asset_put: 8192,
  circle_asset_put_encrypted: 8192,
};

export async function buildHfheTx(params: {
  from: string;
  to: string;
  amount: string;
  opType: string;
  encryptedData: string;
  walletId: string;
  ou?: string;
  message?: string;
  nonce?: number;
  scope: TxScope;
}): Promise<SignedTransaction> {
  return logger.timed("tx", `buildHfheTx(${params.opType})`, async () => {
    assertSender(params.from, params.scope);
    const ou = requireOu(params.ou);
    if (
      params.message &&
      new TextEncoder().encode(params.message).length > (HFHE_MESSAGE_MAX[params.opType] ?? 1024)
    )
      throw new Error("Transaction message too long");
    const nonce =
      params.nonce ?? (await networkService.getNextNonce(params.from, params.scope.networkId));

    const tx: SignedTransaction = {
      from: params.from,
      to_: params.to,
      amount: params.amount,
      nonce,
      ou,
      timestamp: txTimestamp(),
      op_type: params.opType,
      encrypted_data: params.encryptedData,
    };

    if (params.message) tx.message = params.message;

    logger.info(
      "tx",
      `hfhe: op=${params.opType}, from=${params.from.slice(0, 12)}..., to=${params.to.slice(0, 12)}, amount=${params.amount}, ou=${ou}, nonce=${nonce}, timestamp=${tx.timestamp}, dataLen=${params.encryptedData.length}`,
    );
    return signAndFinalizeSecure(tx, params.walletId, params.scope);
  });
}

/** Submit a signed transaction once. A used nonce is never re-signed here: the caller reviews
 *  again with a fresh nonce. */
export async function broadcastSignedTx(tx: SignedTransaction, scope: TxScope): Promise<string> {
  assertSender(tx.from, scope);
  return logger.timed("tx", "broadcast", async () => {
    const timeoutMs = networkService.getTxTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Error(`Transaction timed out after ${timeoutMs / 1000}s`);
      const hash = await Promise.race([
        networkService.submitTransaction(tx, scope),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timedOut), timeoutMs);
        }),
      ]).catch(async (err) => {
        const local = err === timedOut ? await networkService.localTxHash(tx) : null;
        throw local ? new UnclearSubmitError(local, err) : err;
      });
      logger.info("tx", `broadcast OK -> ${hash}`);
      return hash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("timed out") && msg.toLowerCase().includes("nonce"))
        networkService.resetPendingNonce(tx.from, scope.networkId);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });
}
