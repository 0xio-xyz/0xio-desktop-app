// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDesktopProviderScript } from "src/features/dapp/services/walletProviderScript";

type Sent = { request: { id: string; method: string } };

const host = { postMessage: vi.fn() };

const answer = (error: unknown) => {
  const sent = host.postMessage.mock.calls[host.postMessage.mock.calls.length - 1][0] as Sent;
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "0xio-sdk-bridge", response: { id: sent.request.id, success: false, error } },
    }),
  );
};

const connect = () =>
  (window as any).octra.request({ method: "octra_requestAccounts" }) as Promise<unknown>;

beforeAll(() => {
  Object.defineProperty(window, "parent", { value: host, configurable: true });
  new Function(getDesktopProviderScript())();
});

describe("the browser tab provider always rejects with a code and a message", () => {
  it("a wallet refusal keeps its code", async () => {
    const p = connect();
    answer({ code: "USER_REJECTED", message: "Connection rejected" });
    await expect(p).rejects.toMatchObject({
      code: 4001,
      message: "Connection rejected",
      data: { code: "USER_REJECTED" },
    });
  });

  it("an unauthorized site reads as 4100", async () => {
    const p = connect();
    answer({ code: "UNAUTHORIZED", message: "Unknown site" });
    await expect(p).rejects.toMatchObject({ code: 4100, message: "Unknown site" });
  });

  it("an answer with no code is an internal error", async () => {
    const p = connect();
    answer("boom");
    await expect(p).rejects.toMatchObject({
      code: -32603,
      message: "boom",
      data: { code: "INTERNAL_ERROR" },
    });
    const q = connect();
    answer(undefined);
    await expect(q).rejects.toMatchObject({ code: -32603, message: "Request failed" });
  });

  it("local refusals carry one too", async () => {
    const w = window as any;
    await expect(w.octra.request({})).rejects.toMatchObject({
      code: -32602,
      message: "request requires a method",
    });
    await expect(w.octra.request({ method: "eth_accounts" })).rejects.toMatchObject({
      code: 4200,
      data: { code: "UNSUPPORTED_METHOD" },
    });
    await expect(w.wallet0xio.signMessage("hi")).rejects.toMatchObject({
      code: 4100,
      message: "Wallet not connected",
      data: { code: "NOT_CONNECTED" },
    });
  });
});
