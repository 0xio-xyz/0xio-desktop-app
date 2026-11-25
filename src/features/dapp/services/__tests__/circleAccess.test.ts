import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("src/services/network/networkService", () => ({
  jsonRpcCall: (method: string, params: unknown[]) => m.rpc(method, params),
  setSiteScopeCheck: () => {},
}));
vi.mock("src/services/wallet/walletBridge", () => ({ walletBridge: {} }));
vi.mock("src/features/dapp/services/circleVerifier", () => ({ circleVerify: vi.fn() }));
vi.mock("src/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import * as dappService from "src/features/dapp/services/dappService";
import {
  circleGranted,
  circleOrigin,
  createCircleAccess,
  type CircleAccessDeps,
} from "src/features/dapp/services/circleAccess";
import type { SiteWalletInfo } from "src/features/dapp/services/dappService";
import {
  createBridgeContext,
  handleBridgeMethod,
} from "src/features/dapp/services/circleBridgeService";

const CIRCLE = "octBqsZH2c1GBnBrYhUJPJHdmLuT8YMPXFpEKsPKqEYYYfi";
const OTHER_CIRCLE = `oct${"7".repeat(44)}`;
const A: SiteWalletInfo = {
  id: "wa",
  address: `oct${"A".repeat(44)}`,
  name: "Main",
  wallet_type: "generated",
};
const B: SiteWalletInfo = {
  id: "wb",
  address: `oct${"B".repeat(44)}`,
  name: "Spending",
  wallet_type: "generated",
};
const WATCH: SiteWalletInfo = { ...B, id: "ww", wallet_type: "watch" };

let network: string;
let open: SiteWalletInfo | null;
let answer: (approved: boolean) => void;
let ask: ReturnType<typeof vi.fn<CircleAccessDeps["ask"]>>;
let access: (circleId: string) => ReturnType<ReturnType<typeof createCircleAccess>>;

function setup(extra: Partial<CircleAccessDeps> = {}) {
  ask = vi.fn<CircleAccessDeps["ask"]>(
    () =>
      new Promise<{ approved: boolean }>((resolve) => {
        answer = (approved) => resolve({ approved });
      }),
  );
  access = createCircleAccess({
    network: () => network,
    openWallet: () => open,
    ask,
    ...extra,
  });
}

beforeEach(() => {
  localStorage.clear();
  m.rpc.mockReset().mockResolvedValue({ healthy: true });
  network = "devnet";
  open = A;
  setup();
});

describe("a circle asks once per site", () => {
  it("asks, stores the grant on approve and reuses it without asking", async () => {
    const announce = vi.fn();
    setup({ announce });
    const first = access(CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith(circleOrigin(CIRCLE), A);
    answer(true);
    const w = await first;
    expect(w).toMatchObject({ walletId: "wa", address: A.address, networkId: "devnet" });
    expect(w.current()).toBe(true);
    expect(announce).toHaveBeenCalledWith(`oct://${CIRCLE}`, A);

    const site = dappService.getSite("devnet", `oct://${CIRCLE}`);
    expect(site?.accounts[A.address]?.walletId).toBe("wa");
    expect(dappService.listSites("devnet").map((s) => s.origin)).toEqual([`oct://${CIRCLE}`]);

    await expect(access(CIRCLE)).resolves.toMatchObject({ address: A.address });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("answers a reject with an error and code the circle can read, and stores nothing", async () => {
    const pending = access(CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    answer(false);
    await expect(pending).rejects.toMatchObject({
      code: "USER_REJECTED",
      message: "User rejected the connection.",
    });
    expect(circleGranted("devnet", CIRCLE, A.address)).toBe(false);
    const again = access(CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    answer(true);
    await expect(again).resolves.toBeTruthy();
  });

  it("asks again after the site is removed in Connected sites", async () => {
    dappService.connectWallet("devnet", circleOrigin(CIRCLE), A, A.address);
    await expect(access(CIRCLE)).resolves.toBeTruthy();
    expect(ask).not.toHaveBeenCalled();
    const held = await access(CIRCLE);

    dappService.disconnectSite("devnet", circleOrigin(CIRCLE));
    expect(held.current()).toBe(false);
    const again = access(CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer(true);
    await expect(again).resolves.toMatchObject({ address: A.address });
  });

  it("is scoped by network, address and circle", async () => {
    dappService.connectWallet("devnet", circleOrigin(CIRCLE), A, A.address);
    expect(circleGranted("devnet", CIRCLE, A.address)).toBe(true);
    expect(circleGranted("mainnet", CIRCLE, A.address)).toBe(false);
    expect(circleGranted("devnet", CIRCLE, B.address)).toBe(false);
    expect(circleGranted("devnet", OTHER_CIRCLE, A.address)).toBe(false);

    const held = await access(CIRCLE);
    network = "mainnet";
    expect(held.current()).toBe(false);
    void access(CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));

    network = "devnet";
    open = B;
    expect(held.current()).toBe(false);
    void access(CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    expect(ask).toHaveBeenLastCalledWith(circleOrigin(CIRCLE), B);

    open = A;
    void access(OTHER_CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(3));
  });

  it("shares one prompt between calls made while it is open", async () => {
    const calls = [access(CIRCLE), access(CIRCLE), access(CIRCLE)];
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer(true);
    const wallets = await Promise.all(calls);
    expect(wallets.every((w) => w.address === A.address)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("does not grant a wallet that changed while the prompt was open", async () => {
    const pending = access(CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    open = B;
    answer(true);
    await expect(pending).rejects.toMatchObject({ code: "WALLET_CHANGED" });
    expect(circleGranted("devnet", CIRCLE, A.address)).toBe(false);
    expect(circleGranted("devnet", CIRCLE, B.address)).toBe(false);
  });

  it("needs an open wallet that signs and passes a busy review through", async () => {
    open = null;
    await expect(access(CIRCLE)).rejects.toMatchObject({ code: "WALLET_LOCKED" });
    open = WATCH;
    await expect(access(CIRCLE)).rejects.toMatchObject({ code: "WATCH_ONLY" });
    open = A;
    setup({
      ask: vi.fn(async () => {
        throw Object.assign(new Error("Finish or reject the open request first"), {
          code: "RATE_LIMIT_EXCEEDED",
        });
      }),
    });
    await expect(access(CIRCLE)).rejects.toMatchObject({
      code: "RATE_LIMIT_EXCEEDED",
      message: "Finish or reject the open request first",
    });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("a relay call goes through the same grant", () => {
  const relay = (circleId: string) =>
    handleBridgeMethod(createBridgeContext(circleId, "/index.html"), "relay.health", {}, () =>
      access(circleId),
    );

  it("asks, reuses, answers a reject and asks again after revoke", async () => {
    const first = relay(CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer(false);
    await expect(first).rejects.toMatchObject({ code: "USER_REJECTED" });
    expect(m.rpc).not.toHaveBeenCalled();

    const second = relay(CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    answer(true);
    await expect(second).resolves.toEqual({ healthy: true });
    await expect(relay(CIRCLE)).resolves.toEqual({ healthy: true });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(m.rpc).toHaveBeenCalledTimes(2);

    dappService.disconnectSite("devnet", circleOrigin(CIRCLE));
    void relay(CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(3));
  });

  it("keeps circle.context answering while the relay prompt is open", async () => {
    void relay(CIRCLE);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    const ctx = await handleBridgeMethod(
      createBridgeContext(CIRCLE, "/index.html"),
      "circle.context",
      {},
      () => access(CIRCLE),
    );
    expect(ctx).toMatchObject({ circle_id: CIRCLE });
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
