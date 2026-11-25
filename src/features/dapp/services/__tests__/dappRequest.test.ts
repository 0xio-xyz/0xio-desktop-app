import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  fee: vi.fn(),
  preview: vi.fn(),
  deploy: vi.fn(),
  call: vi.fn(),
  sign: vi.fn(async () => "sig"),
  pub: vi.fn(async () => "pub"),
  transfer: vi.fn(),
  broadcast: vi.fn(),
  submit: vi.fn(),
  details: vi.fn(),
  view: vi.fn(),
  pvacState: vi.fn(),
  keySwitch: vi.fn(),
  keyMode: vi.fn(),
  viewCall: vi.fn(async (..._a: unknown[]) => "Pool"),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/network/networkService", async (importOriginal) => {
  const real = await importOriginal<typeof import("src/services/network/networkService")>();
  return {
    ...real,
    getBalance: vi.fn(async () => ({ balance: 2_500_000, nonce: 1 })),
    getRecommendedFeeStrict: (...a: unknown[]) => m.fee(...a),
    liveRecommendedOu: async (...a: unknown[]) => {
      const fee = await m.fee(...a);
      if (!fee) throw new real.FeeUnavailableError();
      return fee.recommended;
    },
    liveMinimumOu: async (...a: unknown[]) => {
      const fee = await m.fee(...a);
      if (!fee) throw new real.FeeUnavailableError();
      return fee.minimum;
    },
    submitTransaction: (...a: unknown[]) => m.submit(...a),
    getTransactionDetails: (...a: unknown[]) => m.details(...a),
    getViewPubkey: (...a: unknown[]) => m.view(...a),
    getNextNonce: vi.fn(async () => 7),
    getTransactionHistory: vi.fn(async () => ({ transactions: [] })),
  };
});
vi.mock("src/services/contracts/contractService", async (importOriginal) => {
  const real = await importOriginal<typeof import("src/services/contracts/contractService")>();
  return {
    ...real,
    previewDeploy: (...a: unknown[]) => m.preview(...a),
    deployContract: (...a: unknown[]) => m.deploy(...a),
    callContract: (...a: unknown[]) => m.call(...a),
    viewContract: (...a: unknown[]) => m.viewCall(...a),
  };
});
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    signMessage: (...a: unknown[]) => m.sign(...(a as [])),
    getPublicKey: (...a: unknown[]) => m.pub(...(a as [])),
  },
}));
vi.mock("src/services/network/transactionBuilder", () => ({
  buildTransferTx: (...a: unknown[]) => m.transfer(...a),
  broadcastSignedTx: (...a: unknown[]) => m.broadcast(...a),
  buildSignaturePayload: () => "{}",
  canonicalTx: (tx: unknown) => tx,
}));
vi.mock("src/services/pvac/pvacBridge", () => ({ pvacBridge: { isInitializedFor: () => true } }));
vi.mock("src/features/privacy/services/privacyService", () => ({
  encryptValue: vi.fn(async () => ({ cipher: "c" })),
  decryptCipher: vi.fn(async () => ({ value: 1 })),
  makeZeroProof: vi.fn(async () => ({ proof: "p", commitment: "c", blinding: "b" })),
  makeRangeProof: vi.fn(async () => ({ proof: "p" })),
  getPrivateBalance: vi.fn(async () => ({ value: 1 })),
  sendStealth: vi.fn(async () => ({ txHash: "h" })),
  getStealthOutputs: vi.fn(async () => []),
  claimOutput: vi.fn(),
  getPvacKeyOwnership: (...a: unknown[]) => m.pvacState(...a),
  resolveKeySwitchMode: (...a: unknown[]) => m.keyMode(...a),
  getKeySwitchFeeLive: vi.fn(async () => ({ ou: 1_000_000, floorOu: 5000 })),
  keySwitchBalance: (...a: unknown[]) => m.keySwitch(...a),
  assertSpendReady: vi.fn(async () => {}),
  reserveLayerSlot: vi.fn(async () => true),
  initPvac: vi.fn(),
}));

import * as networkService from "src/services/network/networkService";
import * as privacyService from "src/features/privacy/services/privacyService";
import * as dappService from "src/features/dapp/services/dappService";
import { DeployChangedError } from "src/services/contracts/contractService";
import {
  BridgeError,
  createDappRequestHandler,
  watchTxConfirmation,
  type ApprovalAnswer,
  type DappRequestDeps,
  type PendingApproval,
} from "src/features/dapp/services/dappRequest";
import { onDappEvent } from "src/features/dapp/services/dappEvents";
import { TxSubmitError, UnclearSubmitError } from "src/services/network/submitErrors";
import { relayReview } from "src/features/dapp/services/relaySites";
import { ClaimRefusedError, recordClaim } from "src/features/privacy/services/claimLedger";
import type { SiteWalletInfo } from "src/features/dapp/services/dappService";

const MAIN: SiteWalletInfo = {
  id: "w1",
  name: "Main",
  address: `oct${"A".repeat(44)}`,
  wallet_type: "mnemonic",
};
const SPEND: SiteWalletInfo = {
  id: "w2",
  name: "Spending",
  address: `oct${"B".repeat(44)}`,
  wallet_type: "private_key",
};
const WATCH: SiteWalletInfo = {
  id: "w3",
  name: "Cold",
  address: `oct${"C".repeat(44)}`,
  wallet_type: "watch",
};
const SITE = "https://dapp.example";
const CONTRACT = `oct${"D".repeat(44)}`;
const CODE = btoa("contract bytes!!");

let open: SiteWalletInfo;
let net: string;
let answer: ApprovalAnswer;
let reviews: Array<Omit<PendingApproval, "networkId">>;
let authOk: boolean;

const deps = (): DappRequestDeps => ({
  getOpenWallet: () => open,
  getWallets: () => [MAIN, SPEND, WATCH],
  getNetworkId: () => net,
  isLocked: () => false,
  waitForUnlock: async () => true,
  requestApproval: async (a) => {
    reviews.push(a);
    return answer;
  },
  requestAuth: async () => authOk,
  setNetworkId: (id) => {
    net = id;
    networkService.setNetwork(id);
  },
});

const call = (method: string, params: unknown = {}, origin = SITE) =>
  createDappRequestHandler(deps())({ id: "1", method, params, timestamp: 0 }, origin);

function openWallet(w: SiteWalletInfo) {
  open = w;
  networkService.setActiveAddress(w.address);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  net = "mainnet";
  networkService.setNetwork("mainnet");
  openWallet(MAIN);
  answer = { approved: true };
  reviews = [];
  authOk = true;
  m.pub.mockResolvedValue("pub");
  m.fee.mockResolvedValue({ recommended: "1000", minimum: "1000", fast: "2000" });
  m.preview.mockResolvedValue({ nonce: 7, contractAddress: CONTRACT });
  m.deploy.mockResolvedValue({ txHash: "dephash", contractAddress: CONTRACT });
  m.transfer.mockResolvedValue({ from: MAIN.address });
  m.broadcast.mockResolvedValue("txhash");
  m.call.mockResolvedValue("callhash");
});

describe("connect and the wallet a site sees", () => {
  it("reviews a new site with the open wallet and reports canSign", async () => {
    const r = await call("connect");
    expect(reviews[0].type).toBe("connect");
    expect(reviews[0].connect!.open.address).toBe(MAIN.address);
    expect(r.data).toMatchObject({ address: MAIN.address, canSign: true, publicKey: "pub" });
    expect(dappService.getSite("mainnet", SITE)!.inUse).toBe(MAIN.address);
  });

  it("a rejected connect stores nothing", async () => {
    answer = { approved: false };
    const r = await call("connect");
    expect(r.error!.code).toBe("USER_REJECTED");
    expect(dappService.isConnected("mainnet", SITE)).toBe(false);
  });

  it("a watch-only open wallet: the review offers the wallets that can sign", async () => {
    openWallet(WATCH);
    answer = { approved: true, selectedAddress: SPEND.address };
    const r = await call("connect");
    const choices = reviews[0].connect!.choices.map((w) => w.address);
    expect(choices).toEqual([MAIN.address, SPEND.address]);
    expect(r.data).toMatchObject({ address: SPEND.address, canSign: true });
  });

  it("the watch-only wallet itself may connect, with canSign false", async () => {
    openWallet(WATCH);
    const r = await call("connect");
    expect(r.data).toMatchObject({ address: WATCH.address, canSign: false, publicKey: null });
  });

  it("a picked watch-only wallet that is not open is refused", async () => {
    answer = { approved: true, selectedAddress: WATCH.address };
    const r = await call("connect");
    expect(r.error).toEqual({
      code: "WATCH_ONLY",
      message: "This wallet is watch-only and cannot sign.",
    });
  });

  it("a connected site reconnects silently on its own wallet, whichever is open", async () => {
    await call("connect");
    openWallet(WATCH);
    reviews = [];
    const r = await call("connect");
    expect(reviews).toHaveLength(0);
    expect(r.data).toMatchObject({ address: MAIN.address, canSign: true });
  });

  it("canSign on status and wallet info, and only the wallet in use is exposed", async () => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    dappService.connectWallet("mainnet", SITE, WATCH, MAIN.address);
    openWallet(WATCH);
    const status = await call("getConnectionStatus");
    expect(status.data).toMatchObject({ connected: true, address: WATCH.address, canSign: false });
    const info = await call("getWalletInfo");
    expect(info.data).toMatchObject({ address: WATCH.address, canSign: false });
    expect(JSON.stringify(status.data)).not.toContain(MAIN.address);
    openWallet(SPEND);
    const kept = await call("getConnectionStatus");
    expect(kept.data).toMatchObject({ connected: true, address: WATCH.address });
  });

  it("an unconnected site gets no address and no canSign", async () => {
    const status = await call("getConnectionStatus");
    expect(status.data).toMatchObject({ connected: false });
    expect(status.data).not.toHaveProperty("address");
    expect(status.data.canSign).toBeUndefined();
    expect((await call("getWalletInfo")).error!.code).toBe("NOT_CONNECTED");
  });

  it("a site whose wallets all left 0xio must connect again", async () => {
    dappService.connectWallet(
      "mainnet",
      SITE,
      { id: "gone", address: `oct${"E".repeat(44)}` },
      null,
    );
    const r = await call("getWalletInfo");
    expect(r.error).toEqual({
      code: "NOT_CONNECTED",
      message: "The wallet this site was connected to is no longer in 0xio. Connect again.",
    });
  });
});

describe("watch-only refusals", () => {
  beforeEach(() => {
    openWallet(WATCH);
    dappService.connectWallet("mainnet", SITE, WATCH, WATCH.address, {
      permissions: ["private_balance_read", "private_proofs", "private_claims"],
    });
  });

  const cases: Array<[string, unknown]> = [
    ["signMessage", { message: "hi" }],
    ["send_transaction", { to: MAIN.address, amount: "1" }],
    ["sendTransaction", { to: MAIN.address, amount: "1" }],
    ["call_contract", { contract: CONTRACT, method: "m" }],
    ["send_contract_transaction", { contract: CONTRACT, method: "m" }],
    ["deploy_contract", { bytecode: CODE }],
    ["deployContract", { bytecode: CODE }],
    ["sign_transaction", { to: MAIN.address, amount: "1" }],
    ["send_contract_transaction_sequence", { transactions: [{ contract: CONTRACT, method: "m" }] }],
    ["send_private_transfer", { to: MAIN.address, amount_raw: "5" }],
    ["claim_private_transfer", {}],
    ["register_private_view_key", {}],
    ["encrypt_value", { value_raw: 1 }],
    ["decrypt_value", { cipher: "c" }],
    ["make_zero_proof", { cipher: "c" }],
    ["make_range_proof", { cipher: "c", value_raw: 1 }],
    ["get_private_balance", {}],
    ["getPublicKey", {}],
  ];

  it.each(cases)("%s answers WATCH_ONLY without a review", async (method, params) => {
    const r = await call(method, params);
    expect(r.success).toBe(false);
    expect(r.error).toEqual({
      code: "WATCH_ONLY",
      message: "This wallet is watch-only and cannot sign.",
    });
    expect(reviews).toHaveLength(0);
    expect(m.sign).not.toHaveBeenCalled();
  });

  it("reads still work", async () => {
    expect((await call("getBalance")).success).toBe(true);
    expect((await call("get_network_info")).success).toBe(true);
  });
});

describe("signing with the site's own wallet", () => {
  it("signs with the site's wallet when another wallet is open", async () => {
    dappService.connectWallet("mainnet", SITE, SPEND, MAIN.address);
    openWallet(MAIN);
    const r = await call("signMessage", { message: "hello" });
    expect(reviews[0].signer!.address).toBe(SPEND.address);
    expect(m.sign).toHaveBeenCalledWith(SPEND.id, expect.stringContaining("hello"));
    expect(r.data).toMatchObject({ address: SPEND.address });
  });

  it("refuses when the site moved to another wallet during the review", async () => {
    dappService.connectWallet("mainnet", SITE, SPEND, MAIN.address);
    const d = deps();
    d.requestApproval = async (a) => {
      reviews.push(a);
      dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
      return { approved: true };
    };
    const r = await createDappRequestHandler(d)(
      {
        id: "1",
        method: "send_transaction",
        params: { to: MAIN.address, amount: "1" },
        timestamp: 0,
      },
      SITE,
    );
    expect(r.error!.code).toBe("NETWORK_CHANGED");
    expect(m.transfer).not.toHaveBeenCalled();
  });

  it("a site send shows and signs the live fee, never a made-up one", async () => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    m.fee.mockResolvedValue({ recommended: "4321", minimum: "4000", fast: "5000" });
    await call("send_transaction", { to: MAIN.address, amount: "1" });
    expect(reviews[0].details!.ou).toBe("4321");
    expect(m.transfer).toHaveBeenCalledWith(expect.objectContaining({ ou: "4321" }));
  });

  it("a site send with an unreadable fee is refused before any review", async () => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    m.fee.mockResolvedValue(null);
    const r = await call("send_transaction", { to: MAIN.address, amount: "1" });
    expect(r.success).toBe(false);
    expect(reviews).toHaveLength(0);
    expect(m.transfer).not.toHaveBeenCalled();
  });

  it("private requests need the site to use the open wallet", async () => {
    dappService.connectWallet("mainnet", SITE, SPEND, MAIN.address, {
      permissions: ["private_balance_read"],
    });
    const r = await call("get_private_balance");
    expect(r.error!.code).toBe("WALLET_CHANGED");
  });
});

describe("deploy_contract", () => {
  beforeEach(() => dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address));

  it("reviews the contract address, code, params and the size-based fee floor", async () => {
    const r = await call("deploy_contract", { bytecode: CODE, params: ["a"] });
    expect(reviews[0].type).toBe("deploy");
    expect(reviews[0].deploy).toEqual({
      codeBytes: 16,
      contractAddress: CONTRACT,
      constructorParams: '["a"]',
      ou: "201000",
    });
    expect(reviews[0].signer!.address).toBe(MAIN.address);
    expect(m.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        ou: "201000",
        constructorParams: '["a"]',
        walletId: MAIN.id,
        reviewed: { nonce: 7, contractAddress: CONTRACT },
      }),
    );
    expect(r.data).toMatchObject({ txHash: "dephash", contractAddress: CONTRACT });
  });

  it("uses the node's minimum at 1, 2 or 5 times the base, a site's fee as set", async () => {
    m.fee.mockResolvedValue({ minimum: "402000", recommended: "402000" });
    await call("deploy_contract", { bytecode: CODE });
    expect(reviews[0].deploy!.ou).toBe("402000");
    expect(m.fee).toHaveBeenCalledWith("program_deploy", "mainnet", {
      encrypted_data_len: CODE.length,
    });
    reviews = [];
    m.fee.mockResolvedValue({ minimum: "750000", recommended: "750000" });
    await call("deploy_contract", { bytecode: CODE });
    expect(reviews[0].deploy!.ou).toBe("201000");
    reviews = [];
    await call("deploy_contract", { bytecode: CODE, ou: "10000000" });
    expect(reviews[0].deploy!.ou).toBe("10000000");
  });

  it("refuses a fee above 10,000,000 OU before any review", async () => {
    const r = await call("deploy_contract", { bytecode: CODE, ou: "10000001" });
    expect(r.error!.code).toBe("INVALID_PARAMS");
    expect(reviews).toHaveLength(0);
  });

  it("a fee read that fails shows no review and signs nothing", async () => {
    m.fee.mockResolvedValue(null);
    const r = await call("deploy_contract", { bytecode: CODE });
    expect(r.error!.code).toBe("DEPLOY_FAILED");
    expect(r.error!.message).toContain("Network fee unavailable");
    expect(reviews).toHaveLength(0);
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it("rejecting the review or the password sends nothing", async () => {
    answer = { approved: false };
    expect((await call("deploy_contract", { bytecode: CODE })).error!.code).toBe("USER_REJECTED");
    answer = { approved: true };
    authOk = false;
    expect((await call("deploy_contract", { bytecode: CODE })).error!.code).toBe("USER_REJECTED");
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it("a moved contract address is DEPLOY_CHANGED", async () => {
    m.deploy.mockRejectedValue(new DeployChangedError("moved"));
    expect((await call("deploy_contract", { bytecode: CODE })).error!.code).toBe("DEPLOY_CHANGED");
  });

  it("a failed preview is DEPLOY_FAILED and shows no review", async () => {
    m.preview.mockRejectedValue(new Error("node down"));
    const r = await call("deploy_contract", { bytecode: CODE });
    expect(r.error!.code).toBe("DEPLOY_FAILED");
    expect(reviews).toHaveLength(0);
  });

  it("an unconnected site cannot deploy", async () => {
    const r = await call("deploy_contract", { bytecode: CODE }, "https://other.example");
    expect(r.error!.code).toBe("NOT_CONNECTED");
  });
});

describe("claim_private_transfer", () => {
  const outputs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      amount: (i + 1) * 1_000_000,
      claimSecret: "s",
      blinding: "b",
    }));

  beforeEach(() => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address, {
      permissions: ["private_claims"],
    });
    vi.mocked(privacyService.claimOutput).mockImplementation(async (_s, out) => ({
      txHash: `claim${out.id}`,
    }));
  });

  it("reviews the amount, the count and each output of a short batch at the live fee", async () => {
    vi.mocked(privacyService.getStealthOutputs).mockResolvedValue(outputs(3));
    m.fee.mockResolvedValue({ recommended: "3000", minimum: "3000", fast: "6000" });
    const r = await call("claim_private_transfer", {});
    expect(reviews).toHaveLength(1);
    expect(reviews[0].details).toMatchObject({
      method: "claim_private",
      ou: "3000",
      amount: "6 OCT (private)",
      claims: {
        count: 3,
        totalRaw: "6000000",
        remaining: 0,
        outputs: [
          { id: 1, amountRaw: "1000000" },
          { id: 2, amountRaw: "2000000" },
          { id: 3, amountRaw: "3000000" },
        ],
      },
    });
    expect(m.fee).toHaveBeenCalledWith("claim", "mainnet");
    expect(privacyService.getStealthOutputs).toHaveBeenCalledWith("w1", MAIN.address, "mainnet");
    expect(privacyService.claimOutput).toHaveBeenCalledTimes(3);
    expect(vi.mocked(privacyService.claimOutput).mock.calls.every((c) => c[3] === "3000")).toBe(
      true,
    );
    expect(r.data).toMatchObject({ claimed_count: 3, claimed_total_raw: "6000000" });
  });

  it("keeps the cap at 25 and claims exactly what the review counted", async () => {
    vi.mocked(privacyService.getStealthOutputs).mockResolvedValue(outputs(30));
    await call("claim_private_transfer", { max_claims: 100 });
    const c = reviews[0].details!.claims!;
    expect(c.count).toBe(25);
    expect(c.remaining).toBe(5);
    expect(c.outputs).toBeUndefined();
    expect(c.totalRaw).toBe(String((25 * 26 * 1_000_000) / 2));
    expect(privacyService.claimOutput).toHaveBeenCalledTimes(25);
  });

  it("nothing to claim asks nothing, and a fee that cannot be read shows no review", async () => {
    vi.mocked(privacyService.getStealthOutputs).mockResolvedValue([]);
    expect((await call("claim_private_transfer", {})).data).toMatchObject({ status: "none" });
    vi.mocked(privacyService.getStealthOutputs).mockResolvedValue(outputs(2));
    m.fee.mockResolvedValue(null);
    const r = await call("claim_private_transfer", {});
    expect(r.error!.code).toBe("PRIVATE_TRANSFER_FAILED");
    expect(reviews).toHaveLength(0);
    expect(privacyService.claimOutput).not.toHaveBeenCalled();
  });

  it("a rejected review claims nothing", async () => {
    vi.mocked(privacyService.getStealthOutputs).mockResolvedValue(outputs(2));
    answer = { approved: false };
    expect((await call("claim_private_transfer", {})).error!.code).toBe("USER_REJECTED");
    expect(privacyService.claimOutput).not.toHaveBeenCalled();
  });
  it.each([
    [new ClaimRefusedError("CLAIM_OUTPUT_SPENT", "spent"), "CLAIM_OUTPUT_SPENT"],
    [new ClaimRefusedError("CLAIM_OUTPUT_UNREADABLE", "unread"), "CLAIM_OUTPUT_UNREADABLE"],
    [new ClaimRefusedError("CLAIM_CONFLICT", "conflict"), "CLAIM_CONFLICT"],
    [new Error("rpc capacity reached; nothing was sent"), "RATE_LIMIT_EXCEEDED"],
    [new Error("network unreachable"), "NETWORK_ERROR"],
    [new Error("proof failed"), "PRIVATE_TRANSFER_FAILED"],
  ])("answers %s with its code", async (err, code) => {
    vi.mocked(privacyService.getStealthOutputs).mockResolvedValue(outputs(1));
    vi.mocked(privacyService.claimOutput).mockRejectedValueOnce(err);
    expect((await call("claim_private_transfer", {})).error!.code).toBe(code);
  });

  it("a refusal after a sent claim keeps the earlier hash", async () => {
    vi.mocked(privacyService.getStealthOutputs).mockResolvedValue(outputs(2));
    vi.mocked(privacyService.claimOutput)
      .mockResolvedValueOnce({ txHash: "claim1" })
      .mockRejectedValueOnce(new ClaimRefusedError("CLAIM_OUTPUT_SPENT", "spent"));
    const r = await call("claim_private_transfer", {});
    expect(r.data).toMatchObject({ tx_hashes: ["claim1"], status: "partial" });
  });

  it("outputs already claimed here return their earlier hashes without a review", async () => {
    vi.mocked(privacyService.getStealthOutputs).mockResolvedValue(outputs(2));
    const scope = { networkId: "mainnet", address: MAIN.address };
    recordClaim(scope, 1, "h1", { nonce: 3 } as never);
    recordClaim(scope, 2, "h2", { nonce: 4 } as never);
    const r = await call("claim_private_transfer", {});
    expect(r.data).toMatchObject({
      claimed_count: 2,
      tx_hashes: ["h1", "h2"],
      status: "submitted",
    });
    expect(reviews).toHaveLength(0);
    expect(privacyService.claimOutput).not.toHaveBeenCalled();
  });
});

describe("events go only to the site concerned", () => {
  it("a transaction's outcome reaches only the site that asked, while it is on the signer", async () => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    dappService.connectWallet("mainnet", "https://other.example", MAIN, MAIN.address);
    const heard: Array<[string, string[]]> = [];
    const off = onDappEvent((type, _d, origins) => heard.push([type, origins]));
    m.details.mockResolvedValue({ status: "confirmed" });
    const scope = { networkId: "mainnet", address: MAIN.address };
    await watchTxConfirmation("h", SITE, scope, {}, { intervalMs: 1, timeoutMs: 1000 });
    expect(heard).toEqual([["transactionConfirmed", [SITE]]]);

    heard.length = 0;
    dappService.connectWallet("mainnet", SITE, SPEND, MAIN.address);
    await watchTxConfirmation("h", SITE, scope, {}, { intervalMs: 1, timeoutMs: 1000 });
    expect(heard).toEqual([]);
    off();
  });

  it("switch_network carries the site to the network it asked for", async () => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    const r = await call("switch_network", { networkId: "devnet" });
    expect(r.data).toMatchObject({ switched: true, network: "devnet" });
    expect(dappService.isConnected("devnet", SITE)).toBe(true);
    expect(dappService.isConnected("devnet", "https://other.example")).toBe(false);
  });
});

describe("amounts and fees a site names", () => {
  beforeEach(async () => {
    await call("connect");
    reviews = [];
  });

  it("labels a raw contract call amount in OCT, exactly", async () => {
    await call("call_contract", { contract: CONTRACT, method: "lock_to_eth", amount: "1000000" });
    expect(reviews[0].details!.amount).toBe("1 OCT");
    expect(m.call.mock.calls[0][0]).toMatchObject({ amount: "1000000" });
    reviews = [];
    await call("call_contract", { contract: CONTRACT, method: "m", amount: 1 });
    expect(reviews[0].details!.amount).toBe("0.000001 OCT");
    reviews = [];
    await call("send_transaction", { to: SPEND.address, amount: "1500000" });
    expect(reviews[0].details!.amount).toBe("1.5 OCT");
    reviews = [];
    await call("sign_transaction", { to: SPEND.address, amount: "2000000" });
    expect(reviews[0].details!.amount).toBe("2 OCT");
  });

  it("refuses a raw amount that is not a whole non-negative number before any review", async () => {
    for (const amount of ["1.5", "-1", "1e6", 1.5, -3, "abc"]) {
      const r = await call("call_contract", { contract: CONTRACT, method: "m", amount });
      expect(r.error!.code, String(amount)).toBe("INVALID_PARAMS");
      const s = await call("send_transaction", { to: SPEND.address, amount });
      expect(s.error!.code, String(amount)).toBe("INVALID_PARAMS");
    }
    expect(reviews).toEqual([]);
    expect(m.call).not.toHaveBeenCalled();
  });

  it("keeps a site's fee only at or above the live minimum", async () => {
    m.fee.mockResolvedValue({ recommended: "1000", minimum: "500", fast: "2000" });
    await call("send_transaction", { to: SPEND.address, amount: "1", ou: "700" });
    expect(reviews[0].details!.ou).toBe("700");
    for (const ou of ["10", "1.5", "-700", "abc", 99999999999]) {
      reviews = [];
      await call("send_transaction", { to: SPEND.address, amount: "1", ou });
      expect(reviews[0].details!.ou, String(ou)).toBe("1000");
    }
  });

  it("refuses before the review when no live fee can be read, even with a site fee", async () => {
    m.fee.mockResolvedValue(null);
    const r = await call("send_transaction", { to: SPEND.address, amount: "1", ou: "5000" });
    expect(r.success).toBe(false);
    expect(reviews).toEqual([]);
  });
});

describe("connect permissions and the lock", () => {
  it("connect reads requestPermissions as the SDK sends them", async () => {
    const r = await call("connect", { requestPermissions: ["accounts", "private_transfers", "x"] });
    expect(r.data.permissions).toEqual(["accounts", "private_transfers"]);
  });

  it("pre-connect reads are answered without unlocking", async () => {
    const waitForUnlock = vi.fn(async () => false);
    const locked = createDappRequestHandler({ ...deps(), isLocked: () => true, waitForUnlock });
    for (const method of [
      "register_dapp",
      "getConnectionStatus",
      "get_network_info",
      "getNetworkInfo",
    ]) {
      const r = await locked({ id: "1", method, params: {}, timestamp: 0 }, SITE);
      expect(r.success, method).toBe(true);
    }
    const status = await locked(
      { id: "1", method: "getConnectionStatus", params: {}, timestamp: 0 },
      SITE,
    );
    expect(status.data).toMatchObject({ connected: false });
    expect(status.data).not.toHaveProperty("address");
    expect(waitForUnlock).not.toHaveBeenCalled();
    const r = await locked({ id: "1", method: "getAddress", params: {}, timestamp: 0 }, SITE);
    expect(r.error!.code).toBe("NOT_CONNECTED");
    expect(waitForUnlock).not.toHaveBeenCalled();
  });

  it("a connected site keeps its session while 0xio is locked", async () => {
    await call("connect");
    const locked = createDappRequestHandler({ ...deps(), isLocked: () => true });
    const status = await locked(
      { id: "1", method: "getConnectionStatus", params: {}, timestamp: 0 },
      SITE,
    );
    expect(status.data).toMatchObject({ connected: true, address: MAIN.address, locked: true });
    expect(status.data.balance).toBeNull();
  });
});

describe("a review shows everything a site gets signed or granted", () => {
  beforeEach(async () => {
    await call("connect");
    reviews = [];
  });

  it("a sequence shows every step with its contract, method, exact args and amount", async () => {
    const OTHER = `oct${"E".repeat(44)}`;
    const r = await call("send_contract_transaction_sequence", {
      transactions: [
        { contract: CONTRACT, method: "approve", params: [OTHER, "5", 7], amount: "1000000" },
        { contract: OTHER, method: "swap", params: [true], amount: 500000 },
        { contract: CONTRACT, method: "settle" },
      ],
    });
    expect(r.success).toBe(true);
    const d = reviews[0].details!;
    expect(d.amount).toBe("1.5 OCT");
    expect(d.steps).toEqual([
      { contract: CONTRACT, method: "approve", args: `["${OTHER}","5",7]`, amount: "1 OCT" },
      { contract: OTHER, method: "swap", args: "[true]", amount: "0.5 OCT" },
      { contract: CONTRACT, method: "settle", args: "[]", amount: "0 OCT" },
    ]);
    expect(relayReview(reviews[0])).toMatchObject({ amount: "1.5 OCT", steps: d.steps });
    const signed = m.call.mock.calls.map(([c]) => c);
    expect(signed.map((c) => [c.contract, c.method, JSON.stringify(c.params), c.amount])).toEqual(
      d.steps!.map((st, i) => [st.contract, st.method, st.args, ["1000000", "500000", "0"][i]]),
    );
  });

  it("a sequence with a step it cannot show is refused before the review", async () => {
    for (const transactions of [
      [{ contract: CONTRACT, method: "a" }, { contract: CONTRACT }],
      [{ contract: CONTRACT, method: "a", params: { to: "x" } }],
      [{ contract: CONTRACT, method: "a", amount: "1.5" }],
    ]) {
      const r = await call("send_contract_transaction_sequence", { transactions });
      expect(r.error!.code).toBe("INVALID_PARAMS");
    }
    expect(reviews).toEqual([]);
    expect(m.call).not.toHaveBeenCalled();
  });

  it("sign_transaction refuses any op_type but standard, and encrypted_data", async () => {
    for (const extra of [
      { op_type: "encrypt" },
      { op_type: "key_switch" },
      { op_type: "call" },
      { encrypted_data: "hidden" },
    ]) {
      const r = await call("sign_transaction", { to: SPEND.address, amount: "1", ...extra });
      expect(r.error).toEqual({
        code: "INVALID_PARAMS",
        message:
          'Sites can sign standard transfers only: op_type "standard" and no encrypted_data.',
      });
    }
    expect(reviews).toEqual([]);
    expect(m.sign).not.toHaveBeenCalled();
  });

  it("sign_transaction shows its memo exactly and signs a standard transfer with it", async () => {
    const memo = "pay\ninvoice 42";
    const r = await call("sign_transaction", {
      to: SPEND.address,
      amount: "1",
      op_type: "standard",
      message: memo,
    });
    expect(reviews[0].details!.message).toBe(memo);
    expect(relayReview(reviews[0]).message).toBe(memo);
    expect(r.data.signedTx).toMatchObject({
      op_type: "standard",
      message: memo,
      to_: SPEND.address,
    });
    expect(r.data.signedTx.encrypted_data).toBeUndefined();
  });

  it("refuses a memo the review cannot show in full", async () => {
    for (const method of ["sign_transaction", "send_transaction"]) {
      const long = await call(method, {
        to: SPEND.address,
        amount: "1",
        message: "m".repeat(4001),
      });
      expect(long.error!.code).toBe("INVALID_PARAMS");
      const odd = await call(method, { to: SPEND.address, amount: "1", message: { a: 1 } });
      expect(odd.error!.code).toBe("INVALID_PARAMS");
    }
    expect(reviews).toEqual([]);
  });

  it("call_contract shows its args exactly as the transaction signs them", async () => {
    const params = [CONTRACT, "100", 100, false, 'a"b'];
    await call("call_contract", { contract: CONTRACT, method: "transfer", params });
    const args = reviews[0].details!.args;
    expect(args).toBe(JSON.stringify(params));
    expect(relayReview(reviews[0]).args).toBe(args);
    const { callMessage } = await import("src/services/contracts/contractService");
    expect(callMessage(m.call.mock.calls[0][0].params)).toBe(args);
  });

  it("call_contract refuses params that are not an array", async () => {
    const r = await call("call_contract", { contract: CONTRACT, method: "m", params: { a: 1 } });
    expect(r.error!.code).toBe("INVALID_PARAMS");
    expect(reviews).toEqual([]);
  });

  it("signMessage refuses a message longer than the review shows, before the review", async () => {
    const r = await call("signMessage", { message: "x".repeat(4001) });
    expect(r.error).toEqual({
      code: "INVALID_PARAMS",
      message: "Message is too long to review. The limit is 4000 characters.",
    });
    expect(reviews).toEqual([]);
    expect(m.sign).not.toHaveBeenCalled();
    const fits = await call("signMessage", { message: "x".repeat(4000) });
    expect(fits.success).toBe(true);
    expect(relayReview(reviews[0]).message).toHaveLength(4000);
  });
});

describe("the connect review lists exactly what connect grants", () => {
  it("requestPermissions with private scopes are each on the review", async () => {
    const asked = ["accounts", "private_transfers", "private_balance_read", "x", "accounts"];
    const r = await call("connect", { requestPermissions: asked });
    const granted = ["accounts", "private_transfers", "private_balance_read"];
    expect(reviews[0].connect!.permissions).toEqual(granted);
    expect(relayReview(reviews[0]).scopes).toEqual(granted);
    expect(r.data.permissions).toEqual(granted);
    expect(dappService.getSite("mainnet", SITE)!.permissions).toEqual(granted);
  });

  it("permissions is read when requestPermissions is absent, else the public scopes", async () => {
    await call("connect", { permissions: ["private_claims"] });
    expect(relayReview(reviews[0]).scopes).toEqual(["private_claims"]);
    dappService.disconnectSite("mainnet", SITE);
    reviews = [];
    await call("connect");
    expect(relayReview(reviews[0]).scopes).toEqual([
      "accounts",
      "public_transactions",
      "contract_calls",
      "contract_views",
    ]);
  });
});

describe("broadcast_only", () => {
  beforeEach(() => dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address));

  it("refuses a record from another wallet without a review", async () => {
    const r = await call("broadcast_only", { signedTx: { from: SPEND.address, signature: "s" } });
    expect(r.error!.code).toBe("INVALID_PARAMS");
    expect(reviews).toHaveLength(0);
    expect(m.submit).not.toHaveBeenCalled();
  });

  it("submits the site's own record exactly as posted, with no second review", async () => {
    m.submit.mockResolvedValue("e8c57de561589b618874d89a6b495d4275099dae6f066bfa2766c5b892c39568");
    const signedTx = {
      from: MAIN.address,
      to_: SPEND.address,
      amount: "11000000",
      nonce: 36673,
      ou: "1000",
      timestamp: 1793915581.996,
      signature: "c2lnbmF0dXJl",
      op_type: "standard",
      message: "",
    };
    const r = await call("broadcast_only", { signedTx });
    expect(reviews).toHaveLength(0);
    expect(m.submit).toHaveBeenCalledTimes(1);
    expect(m.submit.mock.calls[0][0]).toEqual(signedTx);
    expect(m.submit.mock.calls[0][1]).toMatchObject({
      address: MAIN.address,
      networkId: "mainnet",
    });
    expect(r.data).toEqual({
      txHash: "e8c57de561589b618874d89a6b495d4275099dae6f066bfa2766c5b892c39568",
    });
  });
});

describe("register_private_view_key", () => {
  beforeEach(() => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    m.keySwitch.mockResolvedValue({ txHash: "kshash" });
    m.keyMode.mockResolvedValue({ mode: "empty_key_switch" });
  });

  it.each([
    ["another PVAC key is registered", "foreign", "empty_key_switch", "PVAC_KEY_MISMATCH"],
    [
      "the key update would not be an empty key_switch",
      "unregistered",
      "key_bound_migration",
      "PVAC_KEY_MISMATCH",
    ],
    [
      "this wallet's registration is unconfirmed",
      "pending",
      "empty_key_switch",
      "REGISTRATION_PENDING",
    ],
  ])("refuses before any review when %s", async (_why, state, mode, code) => {
    m.view.mockResolvedValue(null);
    m.pvacState.mockResolvedValue(state);
    m.keyMode.mockResolvedValue({ mode });
    const r = await call("register_private_view_key");
    expect(r.error!.code).toBe(code);
    expect(reviews).toHaveLength(0);
    expect(m.keySwitch).not.toHaveBeenCalled();
  });

  it("refuses another address before any review", async () => {
    const r = await call("register_private_view_key", { address: SPEND.address });
    expect(r.error!.code).toBe("INVALID_PARAMS");
    expect(reviews).toHaveLength(0);
  });

  it("answers registered from the free reads, with no review and nothing signed", async () => {
    m.view.mockResolvedValue("dmlldw==");
    m.pvacState.mockResolvedValue("registered");
    const r = await call("register_private_view_key");
    expect(r.data).toEqual({ status: "registered", view_pubkey: "dmlldw==", pvac: true });
    expect(reviews).toHaveLength(0);
    expect(m.keySwitch).not.toHaveBeenCalled();
  });

  it("reviews the key update with its live fee, then sends the empty key_switch", async () => {
    m.view.mockResolvedValue(null);
    m.pvacState.mockResolvedValue("unregistered");
    const r = await call("register_private_view_key");
    expect(reviews).toHaveLength(1);
    expect(reviews[0].details).toMatchObject({
      method: "register_view_key",
      ou: "1000000",
      to: MAIN.address,
    });
    expect(relayReview(reviews[0]).ou).toBe("1000000");
    expect(m.keySwitch).toHaveBeenCalledWith(
      expect.objectContaining({ address: MAIN.address, networkId: "mainnet" }),
      MAIN.id,
      { ou: "1000000", expect: { mode: "empty_key_switch", amountMicro: 0 } },
    );
    expect(r.data).toEqual({ txHash: "kshash", hash: "kshash", status: "submitted" });
  });

  it("refuses before the review when the balance cannot pay the fee", async () => {
    m.view.mockResolvedValue(null);
    m.pvacState.mockResolvedValue("unregistered");
    vi.mocked(networkService.getBalance).mockResolvedValueOnce({
      balance: 999_999,
      nonce: 1,
    } as never);
    const r = await call("register_private_view_key");
    expect(r.error!.code).toBe("INSUFFICIENT_BALANCE");
    expect(reviews).toHaveLength(0);
    expect(m.keySwitch).not.toHaveBeenCalled();
  });

  it("sends nothing when the user rejects", async () => {
    m.view.mockResolvedValue("dmlldw==");
    m.pvacState.mockResolvedValue("unregistered");
    answer = { approved: false };
    const r = await call("register_private_view_key");
    expect(r.error!.code).toBe("USER_REJECTED");
    expect(m.keySwitch).not.toHaveBeenCalled();
  });
});

describe("a review while another is open", () => {
  it("is refused as RATE_LIMIT_EXCEEDED with the open review in details", async () => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    const details = { reason: "review_pending", status: "review_open", requestId: "a".repeat(32) };
    const d = deps();
    d.requestApproval = async () => {
      throw new BridgeError(
        "RATE_LIMIT_EXCEEDED",
        "Finish or reject the open request first",
        details,
      );
    };
    const r = await createDappRequestHandler(d)(
      {
        id: "2",
        method: "signMessage",
        params: { message: "hi" },
        timestamp: 0,
        rid: "b".repeat(32),
      },
      SITE,
    );
    expect(r.error).toEqual({
      code: "RATE_LIMIT_EXCEEDED",
      message: "Finish or reject the open request first",
      details,
    });
  });
});

describe("an unclear submit", () => {
  const H = "ab".repeat(32);
  beforeEach(() => dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address));

  it("answers success with the local hash and submitted, on every site write", async () => {
    m.broadcast.mockRejectedValueOnce(new UnclearSubmitError(H, new Error("timed out")));
    const send = await call("send_transaction", { to: SPEND.address, amount: "1" });
    expect(send).toMatchObject({ success: true, data: { txHash: H, status: "submitted" } });

    m.call.mockRejectedValueOnce(new UnclearSubmitError(H, new Error("502")));
    const callR = await call("call_contract", {
      contract: CONTRACT,
      method: "deposit",
      params: [],
      amount: "0",
    });
    expect(callR).toMatchObject({ success: true, data: { txHash: H, status: "submitted" } });

    m.submit.mockRejectedValueOnce(new UnclearSubmitError(H, new Error("lost reply")));
    const b = await call("broadcast_only", { signedTx: { from: MAIN.address, signature: "s" } });
    expect(b).toMatchObject({ success: true, data: { txHash: H, status: "submitted" } });
  });

  it("a clear refusal is still an error", async () => {
    m.broadcast.mockRejectedValueOnce(new TxSubmitError("rejected", "Rejected by the network"));
    const r = await call("send_transaction", { to: SPEND.address, amount: "1" });
    expect(r.error!.code).toBe("TRANSACTION_FAILED");
  });
});

describe("a site that is not connected never learns the lock", () => {
  const lockedCall = async (method: string, origin: string, params: unknown = {}) => {
    const waitForUnlock = vi.fn(async () => true);
    const d = { ...deps(), isLocked: () => true, waitForUnlock };
    const r = await createDappRequestHandler(d)({ id: "1", method, params, timestamp: 0 }, origin);
    return { r, waited: waitForUnlock.mock.calls.length };
  };
  const STRANGER = "https://stranger.example";

  it("getConnectionStatus reads the same locked or unlocked, with no lock flag", async () => {
    const { r: lockedR } = await lockedCall("getConnectionStatus", STRANGER);
    const open = await call("getConnectionStatus", {}, STRANGER);
    expect(lockedR.data).toEqual(open.data);
    expect(lockedR.data).not.toHaveProperty("locked");
  });

  it("a connected site still hears that 0xio is locked", async () => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    const { r } = await lockedCall("getConnectionStatus", SITE);
    expect(r.data).toMatchObject({ connected: true, locked: true, address: MAIN.address });
  });

  it("other requests are refused at once, with no wait for the unlock", async () => {
    for (const method of ["getAddress", "getBalance", "signMessage", "send_transaction"]) {
      const { r, waited } = await lockedCall(method, STRANGER, { message: "x" });
      expect(r.error!.code).toBe("NOT_CONNECTED");
      expect(waited).toBe(0);
    }
    const { r, waited } = await lockedCall("disconnect", STRANGER);
    expect(r.data).toEqual({ disconnected: true });
    expect(waited).toBe(0);
  });

  it("ping says nothing about the wallet to a stranger", async () => {
    const { r } = await lockedCall("ping", STRANGER);
    expect(r.data).toEqual({ pong: true, available: true, hasActiveWallet: false });
  });

  it("unlocked, a stranger gets NOT_CONNECTED, never a wallet state", async () => {
    const r = await call("getAddress", {}, STRANGER);
    expect(r.error!.code).toBe("NOT_CONNECTED");
  });
});

describe("a site that is not connected", () => {
  const STRANGER = "https://stranger.example";

  it("reads public data without any wallet address, and runs contract views as no caller", async () => {
    dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
    const status = await call("getConnectionStatus", {}, STRANGER);
    expect(JSON.stringify(status)).not.toMatch(/"(address|publicKey|public_key|balance)"/);
    const view = await call(
      "contract_call_view",
      { contract: CONTRACT, method: "name", params: [] },
      STRANGER,
    );
    expect(view.success).toBe(true);
    expect(m.viewCall.mock.calls[m.viewCall.mock.calls.length - 1][3]).toBe("");
    await call("contract_call_view", { contract: CONTRACT, method: "name", params: [] }, SITE);
    expect(m.viewCall.mock.calls[m.viewCall.mock.calls.length - 1][3]).toBe(MAIN.address);
  });

  it("gets NOT_CONNECTED for wallet capabilities and pending transfers", async () => {
    for (const method of ["get_private_capabilities", "get_pending_private_transfers"]) {
      const r = await call(method, {}, STRANGER);
      expect(r.error!.code, method).toBe("NOT_CONNECTED");
    }
  });
});
