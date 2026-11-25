import { describe, it, expect, vi, beforeEach } from "vitest";
import nacl from "tweetnacl";

vi.mock("src/services/network/networkService", () => ({
  getNextNonce: vi.fn().mockResolvedValue(42),
  submitTransaction: vi.fn().mockResolvedValue("mock_tx_hash_abc123"),
  localTxHash: vi.fn().mockResolvedValue("ab".repeat(32)),
  getTxTimeoutMs: vi.fn(() => 1000),
  resetPendingNonce: vi.fn(),
  assertScope: vi.fn(),
  FeeUnavailableError: class extends Error {
    name = "FeeUnavailable";
  },
}));

vi.mock("src/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    timed: vi.fn(async (_tag: string, _label: string, fn: () => Promise<unknown>) => fn()),
  },
}));

const TEST_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) TEST_SEED[i] = i;
const TEST_KEYPAIR = nacl.sign.keyPair.fromSeed(TEST_SEED);

function bytesToBase64Local(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
const TEST_PUB_B64 = bytesToBase64Local(TEST_KEYPAIR.publicKey);
const TEST_WALLET_ID = "test-wallet-id";

vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    signMessage: vi.fn(async (_walletId: string, message: string) => {
      const msgBytes = new TextEncoder().encode(message);
      const sig = nacl.sign.detached(msgBytes, TEST_KEYPAIR.secretKey);
      return bytesToBase64Local(sig);
    }),
    getPublicKey: vi.fn(async () => TEST_PUB_B64),
  },
}));

import {
  canonicalTx,
  buildSignaturePayload,
  buildTransferTx,
  buildHfheTx,
  broadcastSignedTx,
} from "src/services/network/transactionBuilder";
import * as networkService from "src/services/network/networkService";
import { base64ToBytes } from "src/services/crypto/cryptoService";
import type { SignedTransaction } from "src/types/transaction";

describe("buildSignaturePayload", () => {
  it("includes all required fields in JSON output", () => {
    const tx: SignedTransaction = {
      from: "octAlice",
      to_: "octBob",
      amount: "1000000",
      nonce: 5,
      ou: "3000",
      timestamp: 1700000000,
    };
    const payload = buildSignaturePayload(tx);
    const parsed = JSON.parse(payload);

    expect(parsed.from).toBe("octAlice");
    expect(parsed.to_).toBe("octBob");
    expect(parsed.amount).toBe("1000000");
    expect(parsed.nonce).toBe(5);
    expect(parsed.ou).toBe("3000");
    expect(parsed.timestamp).toBe(1700000000);
  });

  it("defaults op_type to 'standard' when not set", () => {
    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "0",
      nonce: 1,
      ou: "3000",
      timestamp: 0,
    };
    const parsed = JSON.parse(buildSignaturePayload(tx));
    expect(parsed.op_type).toBe("standard");
  });

  it("uses provided op_type", () => {
    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "0",
      nonce: 1,
      ou: "3000",
      timestamp: 0,
      op_type: "encrypt",
    };
    const parsed = JSON.parse(buildSignaturePayload(tx));
    expect(parsed.op_type).toBe("encrypt");
  });

  it("includes encrypted_data when present", () => {
    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "0",
      nonce: 1,
      ou: "3000",
      timestamp: 0,
      encrypted_data: "some_encrypted_blob",
    };
    const parsed = JSON.parse(buildSignaturePayload(tx));
    expect(parsed.encrypted_data).toBe("some_encrypted_blob");
  });

  it("excludes encrypted_data when not present", () => {
    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "0",
      nonce: 1,
      ou: "3000",
      timestamp: 0,
    };
    const parsed = JSON.parse(buildSignaturePayload(tx));
    expect(parsed).not.toHaveProperty("encrypted_data");
  });

  it("includes message when present", () => {
    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "0",
      nonce: 1,
      ou: "3000",
      timestamp: 0,
      message: "hello",
    };
    const parsed = JSON.parse(buildSignaturePayload(tx));
    expect(parsed.message).toBe("hello");
  });

  it("excludes message when not present", () => {
    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "0",
      nonce: 1,
      ou: "3000",
      timestamp: 0,
    };
    const parsed = JSON.parse(buildSignaturePayload(tx));
    expect(parsed).not.toHaveProperty("message");
  });

  it("produces valid JSON", () => {
    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "999",
      nonce: 99,
      ou: "3000",
      timestamp: 1234567890,
      op_type: "decrypt",
      encrypted_data: "blob",
      message: "memo",
    };
    const payload = buildSignaturePayload(tx);
    expect(() => JSON.parse(payload)).not.toThrow();
  });
});

describe("buildTransferTx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(networkService.getNextNonce).mockResolvedValue(42);
  });

  it("builds a signed transfer transaction", async () => {
    const tx = await buildTransferTx({
      from: "octSenderAddress",
      scope: { networkId: "mainnet", address: "octSenderAddress" },
      to: "octReceiverAddress",
      amount: 5_000_000,
      walletId: TEST_WALLET_ID,
      ou: "3000",
    });

    expect(tx.from).toBe("octSenderAddress");
    expect(tx.to_).toBe("octReceiverAddress");
    expect(tx.amount).toBe("5000000");
    expect(tx.nonce).toBe(42);
    expect(tx.signature).toBeDefined();
    expect(tx.public_key).toBe(TEST_PUB_B64);
  });

  it("calls getNextNonce with the sender address", async () => {
    await buildTransferTx({
      from: "octSender",
      scope: { networkId: "mainnet", address: "octSender" },
      to: "octReceiver",
      amount: 1_000_000,
      walletId: TEST_WALLET_ID,
      ou: "3000",
    });
    expect(networkService.getNextNonce).toHaveBeenCalledWith("octSender", "mainnet");
  });

  it.each([undefined, "", "0", "abc"])(
    "refuses to sign a transfer without a fee (%s)",
    async (ou) => {
      await expect(
        buildTransferTx({
          from: "octA",
          scope: { networkId: "mainnet", address: "octA" },
          to: "octB",
          amount: 100_000_000,
          walletId: TEST_WALLET_ID,
          ou,
        }),
      ).rejects.toMatchObject({ name: "FeeUnavailable" });
      expect(networkService.getNextNonce).not.toHaveBeenCalled();
    },
  );

  it("allows overriding OU", async () => {
    const tx = await buildTransferTx({
      from: "octA",
      scope: { networkId: "mainnet", address: "octA" },
      to: "octB",
      amount: 1_000_000,
      walletId: TEST_WALLET_ID,
      ou: "9999",
    });
    expect(tx.ou).toBe("9999");
  });

  it("includes message when provided (truncated to 1024)", async () => {
    const longMsg = "x".repeat(2000);
    const tx = await buildTransferTx({
      from: "octA",
      scope: { networkId: "mainnet", address: "octA" },
      to: "octB",
      amount: 1_000_000,
      walletId: TEST_WALLET_ID,
      ou: "3000",
      message: longMsg,
    });
    expect(tx.message).toBeDefined();
    expect(tx.message!.length).toBe(1024);
  });

  it("produces a signature that verifies", async () => {
    const tx = await buildTransferTx({
      from: "octA",
      scope: { networkId: "mainnet", address: "octA" },
      to: "octB",
      amount: 1_000_000,
      walletId: TEST_WALLET_ID,
      ou: "3000",
    });

    const sigBytes = base64ToBytes(tx.signature!);
    const payload = buildSignaturePayload(tx);
    const msgBytes = new TextEncoder().encode(payload);

    const valid = nacl.sign.detached.verify(msgBytes, sigBytes, TEST_KEYPAIR.publicKey);
    expect(valid).toBe(true);
  });
});

describe("buildHfheTx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(networkService.getNextNonce).mockResolvedValue(10);
  });

  it("builds a signed HFHE transaction with op_type and encrypted_data", async () => {
    const tx = await buildHfheTx({
      from: "octSender",
      scope: { networkId: "mainnet", address: "octSender" },
      to: "octReceiver",
      amount: "0",
      opType: "encrypt",
      encryptedData: "encrypted_blob_here",
      walletId: TEST_WALLET_ID,
      ou: "3000",
    });

    expect(tx.from).toBe("octSender");
    expect(tx.to_).toBe("octReceiver");
    expect(tx.amount).toBe("0");
    expect(tx.op_type).toBe("encrypt");
    expect(tx.encrypted_data).toBe("encrypted_blob_here");
    expect(tx.nonce).toBe(10);
    expect(tx.signature).toBeDefined();
    expect(tx.public_key).toBe(TEST_PUB_B64);
  });

  it("uses provided nonce instead of fetching", async () => {
    const tx = await buildHfheTx({
      from: "octA",
      scope: { networkId: "mainnet", address: "octA" },
      to: "octB",
      amount: "0",
      opType: "decrypt",
      encryptedData: "data",
      walletId: TEST_WALLET_ID,
      ou: "3000",
      nonce: 999,
    });

    expect(tx.nonce).toBe(999);
    expect(networkService.getNextNonce).not.toHaveBeenCalled();
  });

  it("fetches nonce when not provided", async () => {
    await buildHfheTx({
      from: "octA",
      scope: { networkId: "mainnet", address: "octA" },
      to: "octB",
      amount: "0",
      opType: "encrypt",
      encryptedData: "data",
      walletId: TEST_WALLET_ID,
      ou: "3000",
    });

    expect(networkService.getNextNonce).toHaveBeenCalledWith("octA", "mainnet");
  });

  it("refuses a message over the limit instead of cutting it", async () => {
    const base = {
      from: "octA",
      scope: { networkId: "mainnet", address: "octA" },
      to: "octB",
      amount: "0",
      encryptedData: "",
      walletId: TEST_WALLET_ID,
      ou: "3000",
    };
    await expect(
      buildHfheTx({ ...base, opType: "deploy_circle", message: "x".repeat(1025) }),
    ).rejects.toThrow("Transaction message too long");
    await expect(
      buildHfheTx({ ...base, opType: "deploy_circle", message: "é".repeat(513) }),
    ).rejects.toThrow("Transaction message too long");
    const whole = "x".repeat(1024);
    expect((await buildHfheTx({ ...base, opType: "deploy_circle", message: whole })).message).toBe(
      whole,
    );
    const long = "p".repeat(8192);
    for (const opType of ["circle_asset_put", "circle_asset_put_encrypted"]) {
      expect((await buildHfheTx({ ...base, opType, message: long })).message).toBe(long);
      await expect(buildHfheTx({ ...base, opType, message: long + "p" })).rejects.toThrow(
        "Transaction message too long",
      );
    }
  });

  it("includes message when provided", async () => {
    const tx = await buildHfheTx({
      from: "octA",
      scope: { networkId: "mainnet", address: "octA" },
      to: "octB",
      amount: "0",
      opType: "encrypt",
      encryptedData: "data",
      walletId: TEST_WALLET_ID,
      ou: "3000",
      message: "memo text",
    });

    expect(tx.message).toBe("memo text");
  });

  it("refuses to sign an HFHE op without a fee instead of inventing one", async () => {
    await expect(
      buildHfheTx({
        from: "octA",
        scope: { networkId: "mainnet", address: "octA" },
        to: "octB",
        amount: "0",
        opType: "claim",
        encryptedData: "data",
        walletId: TEST_WALLET_ID,
      }),
    ).rejects.toMatchObject({ name: "FeeUnavailable" });
  });

  it("allows overriding OU", async () => {
    const tx = await buildHfheTx({
      from: "octA",
      scope: { networkId: "mainnet", address: "octA" },
      to: "octB",
      amount: "0",
      opType: "encrypt",
      encryptedData: "data",
      walletId: TEST_WALLET_ID,
      ou: "50000",
    });

    expect(tx.ou).toBe("50000");
  });

  it("produces a verifiable signature including encrypted_data in payload", async () => {
    const tx = await buildHfheTx({
      from: "octA",
      scope: { networkId: "mainnet", address: "octA" },
      to: "octB",
      amount: "0",
      opType: "encrypt",
      encryptedData: "important_encrypted_data",
      walletId: TEST_WALLET_ID,
      ou: "3000",
    });

    const payload = buildSignaturePayload(tx);
    const parsed = JSON.parse(payload);
    expect(parsed.encrypted_data).toBe("important_encrypted_data");
    expect(parsed.op_type).toBe("encrypt");

    const sigBytes = base64ToBytes(tx.signature!);
    const msgBytes = new TextEncoder().encode(payload);
    const valid = nacl.sign.detached.verify(msgBytes, sigBytes, TEST_KEYPAIR.publicKey);
    expect(valid).toBe(true);
  });
});

describe("signature payload format", () => {
  it("has canonical field ordering matching JSON.stringify insertion order", () => {
    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "100",
      nonce: 1,
      ou: "3000",
      timestamp: 1700000000,
      op_type: "encrypt",
      encrypted_data: "blob",
      message: "memo",
    };
    const payload = buildSignaturePayload(tx);
    const keys = [...payload.matchAll(/"(\w+)":/g)].map((m) => m[1]);
    expect(keys).toEqual([
      "from",
      "to_",
      "amount",
      "nonce",
      "ou",
      "timestamp",
      "op_type",
      "encrypted_data",
      "message",
    ]);
  });

  it("standard tx omits encrypted_data from payload", () => {
    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "100",
      nonce: 1,
      ou: "3000",
      timestamp: 1700000000,
    };
    const payload = buildSignaturePayload(tx);
    expect(payload).not.toContain("encrypted_data");
    expect(payload).not.toContain("message");
    expect(payload).toContain('"op_type":"standard"');
  });
});

// Vectors from webcli 0.06.01 signing_json (lib/tx_builder.hpp, seed 01..20).
describe("webcli signing text", () => {
  const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const KEY = nacl.sign.keyPair.fromSeed(SEED);
  const FROM = "oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB";
  const TO = "oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F";
  const sign = (text: string) =>
    bytesToBase64Local(nacl.sign.detached(new TextEncoder().encode(text), KEY.secretKey));

  it("matches the reference key", () => {
    expect(bytesToBase64Local(KEY.publicKey)).toBe("ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=");
  });

  it("escapes DEL and control characters and strips leading zeros like webcli", () => {
    const tx: SignedTransaction = {
      from: FROM,
      to_: TO,
      amount: "0002500",
      nonce: 7,
      ou: "010000",
      timestamp: 1762300000,
      op_type: "standard",
      message: 'hi "there"\n\x01\x7f end',
    };
    const text = buildSignaturePayload(tx);
    expect(text).toBe(
      `{"from":"${FROM}","to_":"${TO}","amount":"2500","nonce":7,"ou":"10000","timestamp":1762300000.0,"op_type":"standard","message":"hi \\"there\\"\\n\\u0001\\u007f end"}`,
    );
    expect(sign(text)).toBe(
      "LEvmQfbKjHaFpwEI82uhnmsUq7LQZNLveMRBTg/06u7IQn7y8l5cZULJjKUch4pCYdIdJKnFMXZRYddId8zqCw==",
    );
  });

  it("matches the standard and call vectors", () => {
    const standard = buildSignaturePayload({
      from: FROM,
      to_: TO,
      amount: "1000000",
      nonce: 7,
      ou: "1000",
      timestamp: 1762300000.123,
      op_type: "standard",
    });
    expect(sign(standard)).toBe(
      "VBORX2a2r6uAlv2W0EPFqTp4sNf2+QL0CzPyAaqTrjYbe8qczkMrpqXMqMLFmEA02yiUIe26DqdmWcs2LQNCCw==",
    );
    const call = buildSignaturePayload({
      from: FROM,
      to_: TO,
      amount: "0",
      nonce: 9,
      ou: "1000",
      timestamp: 1762300123.456,
      op_type: "call",
      encrypted_data: "transfer",
      message: `["${TO}",12345678901234567890123]`,
    });
    expect(sign(call)).toBe(
      "hzhehT3p9IZuYR4tYW5IULKUvTYixE4lT/CPLg1Zth5RPHMamq7Fh7vVZi1ZvDTRVqHhFAWGaz4YaXlk/P9cDQ==",
    );
  });

  it("refuses amounts that are not plain digits", () => {
    const base = { from: FROM, to_: TO, nonce: 1, ou: "1000", timestamp: 1.5 };
    expect(() => buildSignaturePayload({ ...base, amount: "1e21" })).toThrow();
    expect(() => buildSignaturePayload({ ...base, amount: "1.5" })).toThrow();
  });

  it("signs and submits the same normalized fields", async () => {
    const tx = await buildHfheTx({
      from: "octSender",
      to: "octSender",
      amount: "000",
      opType: "decrypt",
      encryptedData: "x",
      walletId: TEST_WALLET_ID,
      ou: "5000",
      scope: { address: "octSender", networkId: "mainnet" } as never,
    });
    expect(tx.amount).toBe("0");
    expect(tx.ou).toBe("5000");
  });
});

describe("canonicalTx", () => {
  it("leaves out empty optional fields, which the node would sign and hash as values", () => {
    const tx = canonicalTx({
      from: "octA",
      to_: "octB",
      amount: "010",
      nonce: 1,
      ou: "1000",
      timestamp: 1,
      public_key: "",
      message: "",
      encrypted_data: "",
    } as SignedTransaction);
    expect(tx).not.toHaveProperty("public_key");
    expect(tx).not.toHaveProperty("message");
    expect(tx).not.toHaveProperty("encrypted_data");
    expect(tx.amount).toBe("10");
    expect(canonicalTx({ ...tx, message: "memo" }).message).toBe("memo");
  });
});

describe("broadcastSignedTx", () => {
  it("a submit that outlives its budget is unclear, never a refusal: it carries the local hash", async () => {
    vi.useFakeTimers();
    vi.mocked(networkService.submitTransaction).mockReturnValueOnce(new Promise(() => {}));
    const tx = {
      from: "octA",
      to_: "octB",
      amount: "1",
      nonce: 1,
      ou: "1000",
      timestamp: 1,
    } as SignedTransaction;
    const out = broadcastSignedTx(tx, { address: "octA", networkId: "mainnet" } as never).catch(
      (e) => e,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await out).toMatchObject({ name: "UnclearSubmitError", hash: "ab".repeat(32) });
    vi.useRealTimers();
  });
});
