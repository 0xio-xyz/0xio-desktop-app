import { describe, it, expect, vi, beforeEach } from "vitest";

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

const signMessage = vi.fn(async (_walletId: string, _message: string) => "sig");
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    signMessage: (walletId: string, message: string) => signMessage(walletId, message),
    getPublicKey: vi.fn(async () => "pub"),
  },
}));

import * as networkService from "src/services/network/networkService";
import {
  circleDeployPayload,
  circleIdOfDeploy,
  confirmCircleTx,
  deployCircle,
  sha256hex,
  utf8,
} from "src/features/circles/services/circleDeploy";
import vectors from "src/test/fixtures/circle-deploy-vectors.json";

type Submitted = { nonce: number; to_: string; from: string; message?: string };

let account = { nonce: 10, pending_nonce: 10 };
let submitError: string | null = null;
const submitted: Submitted[] = [];

beforeEach(() => {
  mockFetch.mockReset();
  signMessage.mockReset();
  signMessage.mockImplementation(async () => "sig");
  submitted.length = 0;
  submitError = null;
  account = { nonce: 10, pending_nonce: 10 };
  networkService.setNetwork("devnet");
  networkService.setActiveAddress("octA");
  mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    let result: unknown = null;
    let error: unknown;
    if (body.method === "octra_balance") result = account;
    if (body.method === "octra_submit") {
      submitted.push(body.params[0]);
      if (submitError) error = { code: 1, message: submitError };
      else result = { hash: "0xhash" };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ jsonrpc: "2.0", id: body.id, result, error }),
    };
  });
});

async function deploy(sealed = true) {
  return deployCircle({
    walletId: "w1",
    scope: networkService.captureScope("octA"),
    sealed,
    ou: "200000",
  });
}

async function expectIdMatchesTx(tx: Submitted, circleId: string) {
  expect(tx.to_).toBe(circleId);
  expect(await circleIdOfDeploy(tx.from, tx.nonce, JSON.parse(tx.message!))).toBe(circleId);
}

describe("deploy payload and circle id against the reference", () => {
  it("has both profiles, with ids the reference derives", async () => {
    expect(vectors.vectors.map((v) => v.profile)).toEqual(
      expect.arrayContaining(["public", "sealed"]),
    );
    for (const v of vectors.vectors) {
      const payload = circleDeployPayload(v.profile === "sealed");
      expect(JSON.stringify(payload)).toBe(v.message);
      expect(await sha256hex("octra:circle_deploy_payload:v1", [utf8(v.message)])).toBe(
        v.payload_hash,
      );
      expect(await circleIdOfDeploy(v.deployer, v.nonce, payload)).toBe(v.circle_id);
    }
  });

  it("uses only the mode strings the node parses", () => {
    expect(circleDeployPayload(false)).toMatchObject({
      privacy_class: "public",
      browser_mode: "native_sealed",
      resource_mode: "public_resources",
    });
    expect(circleDeployPayload(true)).toMatchObject({
      privacy_class: "sealed",
      browser_mode: "native_sealed",
      resource_mode: "sealed_read",
    });
  });

  it("signs the public payload text as the deploy message", async () => {
    const { circleId } = await deploy(false);
    const v = vectors.vectors.find((x) => x.profile === "public")!;
    expect(submitted[0].message).toBe(v.message);
    await expectIdMatchesTx(submitted[0], circleId);
  });
});

describe("deployCircle", () => {
  it("derives the circle id from the nonce the tx is signed with", async () => {
    const { circleId, hash } = await deploy();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].nonce).toBe(11);
    expect(submitted[0].message).toBe(JSON.stringify(circleDeployPayload(true)));
    await expectIdMatchesTx(submitted[0], circleId);
  });

  it("keeps the id and the tx on one nonce while the server has pending txs", async () => {
    account = { nonce: 10, pending_nonce: 12 };
    const { circleId } = await deploy();
    expect(submitted[0].nonce).toBe(13);
    await expectIdMatchesTx(submitted[0], circleId);
  });

  it("keeps the id and the tx on one nonce behind a locally issued nonce", async () => {
    account = { nonce: 10, pending_nonce: 12 };
    expect(await networkService.getNextNonce("octA", "devnet")).toBe(13);
    const { circleId } = await deploy(false);
    expect(submitted[0].nonce).toBe(14);
    await expectIdMatchesTx(submitted[0], circleId);
  });

  it("releases the reserved nonce when the build fails", async () => {
    account = { nonce: 10, pending_nonce: 12 };
    signMessage.mockRejectedValueOnce(new Error("signer locked"));
    await expect(deploy()).rejects.toThrow("signer locked");
    expect(submitted).toHaveLength(0);
    expect(await networkService.getNextNonce("octA", "devnet")).toBe(13);
  });

  it("does not release a nonce once a later one was issued", async () => {
    account = { nonce: 10, pending_nonce: 12 };
    const reserved = await networkService.getNextNonce("octA", "devnet");
    expect(await networkService.getNextNonce("octA", "devnet")).toBe(reserved + 1);
    networkService.releaseNonce("octA", reserved, "devnet");
    expect(await networkService.getNextNonce("octA", "devnet")).toBe(reserved + 2);
  });

  it("does not re-sign with a new nonce after a nonce rejection", async () => {
    account = { nonce: 10, pending_nonce: 12 };
    submitError = "nonce too low";
    await expect(deploy()).rejects.toThrow("nonce too low");
    expect(submitted).toHaveLength(1);
    expect(signMessage).toHaveBeenCalledTimes(1);
  });

  it("reserves nothing once the network moved during review", async () => {
    const scope = networkService.captureScope("octA");
    networkService.setNetwork("mainnet");
    await expect(
      deployCircle({ walletId: "w1", scope, sealed: true, ou: "200000" }),
    ).rejects.toMatchObject({ name: "ScopeChanged" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("confirmCircleTx", () => {
  const answer = (tx: unknown) =>
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: tx }),
    }));

  it("reports the node's reject reason", async () => {
    answer({
      status: "rejected",
      error: { type: "malformed_transaction", reason: "unknown browser mode: native" },
    });
    expect(await confirmCircleTx("ab".repeat(32), "devnet", 500, 1)).toEqual({
      status: "rejected",
      reason: "unknown browser mode: native",
    });
  });

  it("reports a confirmed transaction", async () => {
    answer({ status: "confirmed" });
    expect(await confirmCircleTx("ab".repeat(32), "devnet", 500, 1)).toEqual({
      status: "confirmed",
    });
  });

  it("stays pending when the window ends without a verdict", async () => {
    answer({ status: "pending" });
    expect(await confirmCircleTx("ab".repeat(32), "devnet", 30, 5)).toEqual({ status: "pending" });
  });
});
