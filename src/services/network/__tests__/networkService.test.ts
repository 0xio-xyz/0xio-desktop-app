import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
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

beforeEach(() => {
  localStorage.clear();
});

import {
  getBaseUrl,
  setNetwork,
  getNetwork,
  jsonRpcCall,
  getBalance,
  getNonce,
  getNextNonce,
  resetPendingNonce,
  submitTransaction,
  getContractStorage,
  getPvacPubkey,
  clearPvacPubkeyCache,
  getTransactionDetails,
  captureScope,
  setActiveAddress,
  trackedHash,
  getTransactionHistory,
} from "src/services/network/networkService";
import type { SignedTransaction } from "src/types/transaction";
import { canonicalTx } from "src/services/network/transactionBuilder";
import { logger } from "src/lib/logger";

function mockJsonResponse(
  result: unknown,
  error?: { code: number; message: string; data?: string },
) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: 1, result, error }),
  });
}

function scopeFor(address: string) {
  setActiveAddress(address);
  return captureScope(address);
}

function mockHttpError(status: number) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({}),
  });
}

describe("network management", () => {
  afterEach(() => {
    setNetwork("mainnet");
  });

  it("defaults to mainnet base URL", () => {
    const url = getBaseUrl();
    expect(url).toContain("octra.network");
  });

  it("switches to devnet", () => {
    setNetwork("devnet");
    expect(getNetwork()).toBe("devnet");
    const url = getBaseUrl();
    expect(url).toContain("devnet.octrascan.io");
  });

  it("persists network selection to localStorage", () => {
    setNetwork("devnet");
    expect(localStorage.getItem("0xio_network")).toBe("devnet");
  });

  it("falls back to mainnet for unknown network", () => {
    setNetwork("unknown_network");
    const url = getBaseUrl();
    expect(url).toContain("octra.network");
  });
});

describe("jsonRpcCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNetwork("mainnet");
  });

  it("sends correct JSON-RPC request format", async () => {
    mockJsonResponse("result_value");

    await jsonRpcCall("test_method", ["param1", "param2"]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/rpc");
    const body = JSON.parse(options.body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("test_method");
    expect(body.params).toEqual(["param1", "param2"]);
    expect(typeof body.id).toBe("number");
  });

  it("returns the result field on success", async () => {
    mockJsonResponse({ foo: "bar" });
    const result = await jsonRpcCall<{ foo: string }>("my_method");
    expect(result).toEqual({ foo: "bar" });
  });

  it("throws on HTTP error", async () => {
    mockHttpError(500);
    await expect(jsonRpcCall("failing_method")).rejects.toThrow("RPC HTTP error: 500");
  });

  it("throws on RPC error response", async () => {
    mockJsonResponse(null, { code: -32600, message: "Invalid request" });
    await expect(jsonRpcCall("bad_method")).rejects.toThrow("Invalid request");
  });

  it("includes error data in thrown message when present", async () => {
    mockJsonResponse(null, { code: -32000, message: "Nonce too low", data: "expected 5 got 3" });
    await expect(jsonRpcCall("nonce_method")).rejects.toThrow("Nonce too low: expected 5 got 3");
  });

  it("sends empty params array by default", async () => {
    mockJsonResponse("ok");
    await jsonRpcCall("no_params");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params).toEqual([]);
  });
});

describe("getBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNetwork("mainnet");
  });

  it("parses balance_raw as number", async () => {
    mockJsonResponse({
      address: "octTest",
      balance_raw: 5_000_000,
      nonce: 3,
      has_pvac_pubkey: false,
    });
    const { balance, nonce } = await getBalance("octTest");
    expect(balance).toBe(5_000_000);
    expect(nonce).toBe(3);
  });

  it("parses balance_raw as string", async () => {
    mockJsonResponse({
      address: "octTest",
      balance_raw: "12345678",
      nonce: 1,
      has_pvac_pubkey: false,
    });
    const { balance } = await getBalance("octTest");
    expect(balance).toBe(12345678);
  });

  it("falls back to balance (OCT string) when balance_raw is absent", async () => {
    mockJsonResponse({ address: "octTest", balance: "1.5", nonce: 0, has_pvac_pubkey: false });
    const { balance } = await getBalance("octTest");
    expect(balance).toBe(1_500_000);
  });

  it("returns 0 when both balance fields are missing", async () => {
    mockJsonResponse({ address: "octTest", nonce: 0, has_pvac_pubkey: false });
    const { balance } = await getBalance("octTest");
    expect(balance).toBe(0);
  });

  it("handles balance_raw = 0", async () => {
    mockJsonResponse({ address: "octTest", balance_raw: 0, nonce: 0, has_pvac_pubkey: false });
    const { balance } = await getBalance("octTest");
    expect(balance).toBe(0);
  });

  it("handles non-numeric balance string gracefully", async () => {
    mockJsonResponse({
      address: "octTest",
      balance: "not_a_number",
      nonce: 0,
      has_pvac_pubkey: false,
    });
    const { balance } = await getBalance("octTest");
    expect(balance).toBe(0);
  });
});

describe("getNonce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns pending_nonce when the node sends it, as webcli does", async () => {
    mockJsonResponse({ address: "octA", nonce: 5, pending_nonce: 8, has_pvac_pubkey: false });
    const nonce = await getNonce("octA");
    expect(nonce).toBe(8);
  });

  it("refuses a pending_nonce below the confirmed nonce", async () => {
    mockJsonResponse({ address: "octA", nonce: 5, pending_nonce: 4, has_pvac_pubkey: false });
    await expect(getNonce("octA")).rejects.toThrow(/precedes/);
  });

  it("falls back to this account's highest nonce in staging_view", async () => {
    mockJsonResponse({ address: "octA", nonce: 5, has_pvac_pubkey: false });
    mockJsonResponse({
      transactions: [
        { from: "octA", nonce: 7 },
        { from: "octB", nonce: 40 },
        { from: "octA", nonce: 6 },
      ],
    });
    expect(await getNonce("octA")).toBe(7);
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.method).toBe("staging_view");
  });

  it("refuses when staging_view cannot be read without pending_nonce", async () => {
    mockJsonResponse({ address: "octA", nonce: 5, has_pvac_pubkey: false });
    mockJsonResponse({ count: 0 });
    await expect(getNonce("octA")).rejects.toThrow(/pending transactions/);
  });
});

describe("getNextNonce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPendingNonce("octA");
  });

  it("returns confirmed+1 when no pending txs on server", async () => {
    mockJsonResponse({ address: "octA", nonce: 10, pending_nonce: 10, has_pvac_pubkey: false });
    const nonce = await getNextNonce("octA");
    expect(nonce).toBe(11);
  });

  it("uses server pending_nonce+1 when server has pending txs", async () => {
    mockJsonResponse({ address: "octA", nonce: 10, pending_nonce: 12, has_pvac_pubkey: false });
    const nonce = await getNextNonce("octA");
    expect(nonce).toBe(13);
  });

  it("uses staging_view when the node sends no pending_nonce", async () => {
    mockJsonResponse({ address: "octA", nonce: 10, has_pvac_pubkey: false });
    mockJsonResponse({ transactions: [{ from: "octA", nonce: 11 }] });
    expect(await getNextNonce("octA")).toBe(12);
    mockJsonResponse({ address: "octA", nonce: 10, has_pvac_pubkey: false });
    mockJsonResponse({ transactions: [] });
    expect(await getNextNonce("octA")).toBe(11);
  });

  it("increments locally on sequential calls", async () => {
    mockJsonResponse({ address: "octA", nonce: 5, pending_nonce: 5, has_pvac_pubkey: false });
    const n1 = await getNextNonce("octA");
    expect(n1).toBe(6);

    mockJsonResponse({ address: "octA", nonce: 5, pending_nonce: 5, has_pvac_pubkey: false });
    const n2 = await getNextNonce("octA");
    expect(n2).toBe(6);
  });

  it("resetPendingNonce clears local tracking", async () => {
    mockJsonResponse({ address: "octA", nonce: 5, pending_nonce: 8, has_pvac_pubkey: false });
    await getNextNonce("octA");

    resetPendingNonce("octA");

    mockJsonResponse({ address: "octA", nonce: 5, pending_nonce: 5, has_pvac_pubkey: false });
    const nonce = await getNextNonce("octA");
    expect(nonce).toBe(6);
  });
});

describe("submitTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends correct payload and returns the local hash", async () => {
    mockJsonResponse({ hash: "0xabc123" });

    const tx: SignedTransaction = {
      from: "octSender",
      to_: "octReceiver",
      amount: "1000000",
      nonce: 42,
      ou: "3000",
      timestamp: 1700000000,
      signature: "sig_base64",
      public_key: "pub_base64",
    };

    const hash = await submitTransaction(tx, scopeFor(tx.from));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params[0].from).toBe("octSender");
    expect(body.params[0].to_).toBe("octReceiver");
    expect(body.params[0].amount).toBe("1000000");
    expect(body.params[0].signature).toBe("sig_base64");
    expect(body.params[0].public_key).toBe("pub_base64");
  });

  it("returns the local hash when the node names one as tx_hash", async () => {
    mockJsonResponse({ tx_hash: "0xdef456" });

    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "0",
      nonce: 1,
      ou: "3000",
      timestamp: 0,
      signature: "sig",
      public_key: "pub",
    };

    const hash = await submitTransaction(tx, scopeFor(tx.from));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the local hash when no hash in response", async () => {
    mockJsonResponse({});

    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "0",
      nonce: 1,
      ou: "3000",
      timestamp: 0,
      signature: "sig",
      public_key: "pub",
    };

    const hash = await submitTransaction(tx, scopeFor(tx.from));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes op_type and encrypted_data for HFHE txs", async () => {
    mockJsonResponse({ hash: "0xhfhe" });

    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "0",
      nonce: 1,
      ou: "3000",
      timestamp: 0,
      op_type: "encrypt",
      encrypted_data: "enc_blob",
      signature: "sig",
      public_key: "pub",
    };

    await submitTransaction(tx, scopeFor(tx.from));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params[0].op_type).toBe("encrypt");
    expect(body.params[0].encrypted_data).toBe("enc_blob");
  });

  it("includes message field when present", async () => {
    mockJsonResponse({ hash: "0xmsg" });

    const tx: SignedTransaction = {
      from: "octA",
      to_: "octB",
      amount: "1000",
      nonce: 1,
      ou: "3000",
      timestamp: 0,
      message: "test memo",
      signature: "sig",
      public_key: "pub",
    };

    await submitTransaction(tx, scopeFor(tx.from));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params[0].message).toBe("test memo");
  });
});

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 20 && !done; i++) await vi.advanceTimersByTimeAsync(500);
  return p;
}

describe("submitTransaction outcomes", () => {
  const signed: SignedTransaction = {
    from: "oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB",
    to_: "oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F",
    amount: "1000000",
    nonce: 7,
    ou: "1000",
    timestamp: 1762300000.123,
    op_type: "standard",
    signature:
      "VBORX2a2r6uAlv2W0EPFqTp4sNf2+QL0CzPyAaqTrjYbe8qczkMrpqXMqMLFmEA02yiUIe26DqdmWcs2LQNCCw==",
    public_key: "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=",
  };
  const LOCAL = "f802c9eed1384aa62879c871ab3ccba84f536866dfa5373dd09f549a77aed8d9";

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks the local hash when the node returns none", async () => {
    mockJsonResponse({});
    expect(await submitTransaction(signed, scopeFor(signed.from))).toBe(LOCAL);
  });

  const RECORD = {
    from: "octEwb4krH6vW3Pr23hps9r8pTZ78dKpdpdmiY612FynidH",
    to_: "octHd7nZVgp1iUy6rDNywdBEK4C8MsoLFFjE5ukrDGuL8Ra",
    amount: "11000000",
    nonce: 36673,
    ou: "1000",
    timestamp: 1793915581.996,
    signature: "c2lnbmF0dXJl",
    op_type: "standard",
  };

  it("posts a site's pre-signed record as it is and hashes it as posted, an empty memo included", async () => {
    mockJsonResponse({});
    const tx = { ...RECORD, message: "" } as unknown as SignedTransaction;
    const hash = await submitTransaction(tx, scopeFor(tx.from));
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).params[0].message).toBe("");
    expect(hash).toBe("e8c57de561589b618874d89a6b495d4275099dae6f066bfa2766c5b892c39568");
  });

  it("a record this wallet builds goes out without an empty memo", async () => {
    mockJsonResponse({});
    const built = canonicalTx({
      ...RECORD,
      message: "",
      encrypted_data: "",
    } as unknown as SignedTransaction);
    const hash = await submitTransaction(built, scopeFor(built.from));
    const posted = JSON.parse(mockFetch.mock.calls[0][1].body).params[0];
    expect(posted).not.toHaveProperty("message");
    expect(posted).not.toHaveProperty("encrypted_data");
    expect(hash).toBe("cb59fd73fa7eb81315a87756b147f347ea5939ff9a22dc7c298cf4ddcb3668f3");
  });

  it("keeps the local hash and logs it when the node names another", async () => {
    mockJsonResponse({ tx_hash: "ab".repeat(32) });
    expect(await submitTransaction(signed, scopeFor(signed.from))).toBe(LOCAL);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "tx",
      expect.stringContaining(`node tx hash ${"ab".repeat(32)} differs from local ${LOCAL}`),
    );
  });

  it("tracks the node hash only when no local one could be computed", () => {
    expect(trackedHash("cd".repeat(32), null)).toBe("cd".repeat(32));
    expect(trackedHash("", LOCAL)).toBe(LOCAL);
    expect(trackedHash(LOCAL.toUpperCase(), LOCAL)).toBe(LOCAL);
  });

  it("resends the same signed bytes while the node says it is safe to", async () => {
    vi.useFakeTimers();
    mockJsonResponse(null, { code: -32005, message: "busy" });
    mockJsonResponse(null, { code: 110, message: "mempool full" });
    mockJsonResponse({ tx_hash: LOCAL });
    expect(await settle(submitTransaction(signed, scopeFor(signed.from)))).toBe(LOCAL);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const bodies = mockFetch.mock.calls.map((c) => JSON.parse(c[1].body).params[0]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it("stops after three attempts with a not accepted error", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) mockJsonResponse(null, { code: 117, message: "not now" });
    await expect(settle(submitTransaction(signed, scopeFor(signed.from)))).rejects.toMatchObject({
      name: "TxSubmitError",
      kind: "not_accepted",
      message: "The network did not accept this transaction. Try again.",
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("an unclear outcome is never a refusal: it carries the local hash of what was sent", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("network down"));
    await expect(submitTransaction(signed, scopeFor(signed.from))).rejects.toMatchObject({
      name: "UnclearSubmitError",
      hash: LOCAL,
    });
    mockJsonResponse(null, { code: 999, message: "something odd" });
    await expect(submitTransaction(signed, scopeFor(signed.from))).rejects.toMatchObject({
      name: "UnclearSubmitError",
      hash: LOCAL,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("a clear refusal stays an error", async () => {
    mockJsonResponse(null, { code: 101, message: "bad signature" });
    await expect(submitTransaction(signed, scopeFor(signed.from))).rejects.toMatchObject({
      name: "TxSubmitError",
      kind: "rejected",
    });
  });

  it("asks for a new review when the nonce was used, without resending", async () => {
    mockJsonResponse(null, { code: 112, message: "nonce already used" });
    await expect(submitTransaction(signed, scopeFor(signed.from))).rejects.toMatchObject({
      kind: "nonce_used",
      message: "This nonce was already used. Review again.",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("names a rejection and keeps the node's reason", async () => {
    mockJsonResponse(null, { code: 104, message: "fee too low" });
    await expect(submitTransaction(signed, scopeFor(signed.from))).rejects.toMatchObject({
      kind: "rejected",
      message: "The network rejected this transaction. (fee too low)",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("says a transaction is too large on HTTP 413", async () => {
    mockHttpError(413);
    await expect(submitTransaction(signed, scopeFor(signed.from))).rejects.toMatchObject({
      kind: "too_large",
      message: "This transaction is too large.",
    });
  });

  it("passes an unknown code through unchanged", async () => {
    mockJsonResponse(null, { code: 999, message: "odd" });
    await expect(submitTransaction(signed, scopeFor(signed.from))).rejects.toThrow("odd");
  });
});

describe("getContractStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns string value for existing key", async () => {
    mockJsonResponse({ value: "USDT" });
    const val = await getContractStorage("octContract123", "symbol");
    expect(val).toBe("USDT");
  });

  it("returns string for numeric value", async () => {
    mockJsonResponse({ value: 6 });
    const val = await getContractStorage("octContract123", "decimals");
    expect(val).toBe("6");
  });

  it("returns null when value is absent", async () => {
    mockJsonResponse({});
    const val = await getContractStorage("octContract123", "nonexistent");
    expect(val).toBeNull();
  });

  it("returns null on RPC error", async () => {
    mockJsonResponse(null, { code: -32000, message: "not found" });
    const val = await getContractStorage("octC", "key");
    expect(val).toBeNull();
  });
});

describe("getPvacPubkey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPvacPubkeyCache();
  });

  it("returns pubkey when present", async () => {
    mockJsonResponse({ pvac_pubkey: "base64pubkey==" });
    const pk = await getPvacPubkey("octAddr");
    expect(pk).toBe("base64pubkey==");
  });

  it("returns null when not registered", async () => {
    mockJsonResponse({});
    const pk = await getPvacPubkey("octAddr");
    expect(pk).toBeNull();
  });

  it("throws on transport error (not misread as 'no key')", async () => {
    mockHttpError(500);
    await expect(getPvacPubkey("octAddr")).rejects.toThrow();
  });
});

describe("getTransactionDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps response fields correctly", async () => {
    mockJsonResponse({
      tx_hash: "0xabc",
      from: "octAlice",
      to: "octBob",
      amount_raw: "5000000",
      op_type: "standard",
      status: "confirmed",
      timestamp: 1700000000,
      nonce: 5,
      epoch: 100,
      block_height: 999,
      ou: "3000",
      signature: "sig",
      public_key: "pub",
    });

    const detail = await getTransactionDetails("0xabc");
    expect(detail).not.toBeNull();
    expect(detail!.hash).toBe("0xabc");
    expect(detail!.from).toBe("octAlice");
    expect(detail!.to).toBe("octBob");
    expect(detail!.amount_raw).toBe("5000000");
    expect(detail!.op_type).toBe("standard");
    expect(detail!.status).toBe("confirmed");
    expect(detail!.nonce).toBe(5);
    expect(detail!.epoch).toBe(100);
    expect(detail!.block_height).toBe(999);
  });

  it("returns null on error", async () => {
    mockHttpError(404);
    const detail = await getTransactionDetails("0xnonexistent");
    expect(detail).toBeNull();
  });

  it("handles to_ field alias", async () => {
    mockJsonResponse({
      tx_hash: "0x1",
      from: "octA",
      to_: "octB",
      amount: "100",
      op_type: "standard",
      status: "pending",
      timestamp: 0,
      nonce: 1,
    });
    const detail = await getTransactionDetails("0x1");
    expect(detail!.to).toBe("octB");
  });

  it("extracts reject reason from error object", async () => {
    mockJsonResponse({
      tx_hash: "0xfailed",
      from: "octA",
      to: "octB",
      amount: "0",
      op_type: "standard",
      status: "failed",
      timestamp: 0,
      nonce: 1,
      error: { reason: "insufficient funds", type: "balance_error" },
    });
    const detail = await getTransactionDetails("0xfailed");
    expect(detail!.reject_reason).toBe("insufficient funds");
    expect(detail!.reject_type).toBe("balance_error");
  });

  it("includes message and encrypted_data when present", async () => {
    mockJsonResponse({
      tx_hash: "0x2",
      from: "octA",
      to: "octB",
      amount: "0",
      op_type: "encrypt",
      status: "confirmed",
      timestamp: 0,
      nonce: 1,
      message: "memo",
      encrypted_data: "enc_blob",
    });
    const detail = await getTransactionDetails("0x2");
    expect(detail!.message).toBe("memo");
    expect(detail!.encrypted_data).toBe("enc_blob");
  });

  it("excludes empty string message and encrypted_data", async () => {
    mockJsonResponse({
      tx_hash: "0x3",
      from: "octA",
      to: "octB",
      amount: "0",
      op_type: "standard",
      status: "confirmed",
      timestamp: 0,
      nonce: 1,
      message: "",
      encrypted_data: "",
    });
    const detail = await getTransactionDetails("0x3");
    expect(detail!.message).toBeUndefined();
    expect(detail!.encrypted_data).toBeUndefined();
  });
});

describe("getTransactionHistory", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("lists a failed tx once when the node repeats it", async () => {
    const failed = {
      hash: "f1",
      from: "octA",
      to: "octB",
      amount: "50000",
      timestamp: 1_800_000_000,
      nonce: 7,
      reason: "execution reverted [not enough sent]",
    };
    mockJsonResponse({
      transactions: [],
      rejected: [failed, failed, { ...failed }],
      dropped: [{ ...failed, hash: "f2" }, failed],
    });
    const { transactions } = await getTransactionHistory("octA", 20, 0, "devnet");
    expect(transactions.map((tx) => tx.hash).sort()).toEqual(["f1", "f2"]);
    expect(transactions.every((tx) => tx.status === "failed")).toBe(true);
  });
});
