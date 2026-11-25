import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  sign: vi.fn(),
  balance: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    signMessage: (walletId: string, message: string) => m.sign(walletId, message),
    getPublicKey: vi.fn(async () => "PUB"),
  },
}));
vi.mock("src/services/network/networkService", () => ({
  jsonRpcCall: (method: string, params: unknown[]) => m.rpc(method, params),
  getBalance: (address: string, networkId: string) => m.balance(address, networkId),
}));
vi.mock("src/features/dapp/services/circleVerifier", () => ({
  circleVerify: (...args: unknown[]) => m.verify(...args),
}));

import {
  BRIDGE_METHODS,
  BridgeUnsupportedError,
  circleAuthMessage,
  createBridgeContext,
  getCircleBridgePrelude,
  handleBridgeMethod,
} from "src/features/dapp/services/circleBridgeService";
import vectors from "src/test/fixtures/circle-auth-vectors.json";

const CIRCLE = "octBqsZH2c1GBnBrYhUJPJHdmLuT8YMPXFpEKsPKqEYYYfi";
const ADDR = vectors.test_key.addr;
const PAYLOAD = {
  key: "k",
  slot_ref: "slot/main",
  state_ref: "state:1",
  subject_addr: ADDR,
  workflow_ref: "wf",
  register_ref: "reg",
  key_id: "default",
  object_ref: "obj-1",
  member_ref: "member-2",
  intent_id: "intent",
  request_id: "req",
  method: "get_counter",
  params: ["a", 1],
};

const WRITES = [
  "program.call",
  "wallet.send",
  "sealed_slot.put",
  "sealed_state.put",
  "slot_policy.put",
  "state_policy.put",
  "state_descriptor.put",
  "balance_cell.put",
  "register_cell.put",
  "transport_policy.put",
  "hfhe_policy.put",
  "key_policy.put",
  "key.grant",
  "key.extend",
  "key.revoke",
  "key.erase",
  "outbox.open",
  "relay.claim",
  "relay.cancel",
  "ingress.commit",
  "object.policy.define",
  "object.bind",
  "object.member.attach",
  "object.member.detach",
  "object.transition.apply",
];

const WALLET = { walletId: "w1", address: ADDR, networkId: "devnet", current: () => true };
const granted = vi.fn(async () => WALLET);

const call = (
  method: string,
  payload: Record<string, unknown> = PAYLOAD,
  access: () => Promise<typeof WALLET> = granted,
) => handleBridgeMethod(createBridgeContext(CIRCLE, "/index.html"), method, payload, access);

beforeEach(() => {
  m.rpc.mockReset().mockResolvedValue({ ok: true });
  m.sign.mockReset().mockResolvedValue("SIG");
  m.balance.mockReset().mockResolvedValue({ balance: "5", nonce: 2 });
  m.verify.mockReset().mockResolvedValue({ ok: true });
  granted.mockClear();
});

describe("circle read signature framing", () => {
  it("matches the reference builder byte for byte", () => {
    expect(vectors.vectors.length).toBeGreaterThan(8);
    for (const v of vectors.vectors) {
      expect(circleAuthMessage(v.op, v.circle_id, v.addr, v.subject)).toBe(v.message);
      expect(circleAuthMessage(v.op, v.circle_id, v.addr, v.subject)).not.toBe(v.legacy_message);
    }
    expect(circleAuthMessage("op", "c", "a")).toBe("octra_circle_auth_v2|2:op|1:c|1:a|0:");
  });

  it("signs the framed message and sends address, key and signature after the subject", async () => {
    await call("key_policy.read");
    expect(m.sign).toHaveBeenCalledWith(
      "w1",
      circleAuthMessage("octra_circle_key_policy", CIRCLE, ADDR, "default"),
    );
    expect(m.rpc).toHaveBeenCalledWith("octra_circleKeyPolicyAuth", [
      CIRCLE,
      "default",
      ADDR,
      "PUB",
      "SIG",
    ]);
  });

  it("frames an empty subject, a two-field subject and the view subject", async () => {
    await call("program.info");
    expect(m.sign).toHaveBeenLastCalledWith(
      "w1",
      circleAuthMessage("octra_circle_program_info", CIRCLE, ADDR, ""),
    );
    await call("object.member.read");
    expect(m.sign).toHaveBeenLastCalledWith(
      "w1",
      circleAuthMessage("octra_circle_object_member", CIRCLE, ADDR, "obj-1|member-2"),
    );
    const view = vectors.vectors.find((v) => v.subject.startsWith("get_counter|"))!;
    await call("program.view");
    expect(m.sign).toHaveBeenLastCalledWith(
      "w1",
      circleAuthMessage("octra_circle_view", CIRCLE, ADDR, view.subject),
    );
    expect(m.rpc).toHaveBeenLastCalledWith("octra_circleViewAuth", [
      CIRCLE,
      "get_counter",
      ["a", 1],
      ADDR,
      "PUB",
      "SIG",
      false,
    ]);
  });
});

describe("the method list a circle page receives", () => {
  it("is the context list, the prelude list and the served list at once", () => {
    const ctx = createBridgeContext(CIRCLE, "/index.html");
    expect(ctx.bridge_methods).toEqual([...BRIDGE_METHODS]);
    expect(new Set(BRIDGE_METHODS).size).toBe(BRIDGE_METHODS.length);
    const prelude = getCircleBridgePrelude(ctx);
    for (const name of BRIDGE_METHODS) expect(prelude).toContain(`"${name}"`);
  });

  it("serves every advertised method", async () => {
    for (const name of BRIDGE_METHODS) {
      await expect(call(name), name).resolves.toBeDefined();
    }
  });

  it("advertises no write and no FHE call but the two read-only verifiers", () => {
    for (const name of WRITES) expect(BRIDGE_METHODS).not.toContain(name);
    expect(BRIDGE_METHODS.filter((n) => n.startsWith("fhe."))).toEqual([
      "fhe.verify_zero",
      "fhe.verify_bound",
    ]);
    expect(BRIDGE_METHODS.some((n) => /\.(put|grant|extend|revoke|erase|send|call)$/.test(n))).toBe(
      false,
    );
  });

  it("answers an unlisted method with the unsupported error and its code", async () => {
    for (const name of [...WRITES, "fhe.encrypt", "nope", "constructor", "toString", "__proto__"]) {
      const err = (await call(name).catch((e) => e)) as BridgeUnsupportedError;
      expect(err, name).toBeInstanceOf(BridgeUnsupportedError);
      expect(err.code).toBe("UNSUPPORTED_METHOD");
      expect(err.message).toBe(`Method not supported: ${name}`);
      expect(err.message).not.toContain("approval");
    }
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.sign).not.toHaveBeenCalled();
    await expect(call(undefined as unknown as string)).rejects.toBeInstanceOf(
      BridgeUnsupportedError,
    );
  });

  it("hands the code to the page with the rejection", () => {
    const prelude = getCircleBridgePrelude(createBridgeContext(CIRCLE, "/index.html"));
    expect(prelude).toContain("failure.code = data.code");
  });
});

describe("bridge guards", () => {
  it("keeps everything that reads or signs as the wallet behind the circle's grant", async () => {
    const refused = Object.assign(new Error("User rejected the connection."), {
      code: "USER_REJECTED",
    });
    const deny = vi.fn(async () => {
      throw refused;
    });
    for (const name of [
      "wallet.info",
      "wallet.balance",
      "wallet.keys",
      "program.info",
      "key_policy.read",
      "fhe.verify_zero",
      "relay.request",
      "relay.status",
      "relay.response",
      "relay.receipt",
      "relay.ingress",
      "relay.health",
    ]) {
      await expect(call(name, PAYLOAD, deny), name).rejects.toBe(refused);
    }
    expect(m.sign).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.verify).not.toHaveBeenCalled();

    expect(await call("wallet.info", {})).toEqual({ address: ADDR, public_key: "PUB" });
    expect(await call("wallet.balance", {})).toEqual({ balance: "5", nonce: 2 });
    expect(m.balance).toHaveBeenCalledWith(ADDR, "devnet");
  });

  it("answers circle.context without asking, even while the prompt is open", async () => {
    const ask = vi.fn(() => new Promise<typeof WALLET>(() => {}));
    void call("relay.health", {}, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(await call("circle.context", {}, ask)).toMatchObject({ circle_id: CIRCLE });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("asks before a relay call and checks its input only after the grant", async () => {
    const refused = Object.assign(new Error("User rejected the connection."), {
      code: "USER_REJECTED",
    });
    const deny = vi.fn(async () => {
      throw refused;
    });
    await expect(call("relay.response", {}, deny)).rejects.toBe(refused);
    await expect(call("relay.response", {})).rejects.toThrow("relay.response requires request_id");
    await call("relay.status", { request_id: "r" });
    expect(m.rpc).toHaveBeenCalledWith("octra_relayStatus", ["r"]);
  });

  it("refuses a call aimed at another circle or address", async () => {
    await expect(call("program.info", { circle_id: `oct${"9".repeat(44)}` })).rejects.toThrow(
      "Bridge target override denied",
    );
    await expect(call("program.info", { address: ADDR })).rejects.toThrow(
      "Bridge target override denied",
    );
    await expect(call("key_policy.read", {})).rejects.toThrow("key_policy.read requires key_id");
  });
});

describe("sealed slot and state reads", () => {
  it("use the signed owner read", async () => {
    await call("sealed_slot.read");
    expect(m.sign).toHaveBeenCalledWith(
      "w1",
      circleAuthMessage(
        "octra_circle_asset_ciphertext_by_slot_ref",
        CIRCLE,
        ADDR,
        "slot_ref|slot/main",
      ),
    );
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith("octra_circleAssetCiphertextBySlotRefAuth", [
      CIRCLE,
      "slot/main",
      ADDR,
      "PUB",
      "SIG",
    ]);
  });

  it("fall back to the public read when the signed one is refused", async () => {
    m.rpc
      .mockRejectedValueOnce(new Error("circle owner authorization required"))
      .mockResolvedValueOnce({ ciphertext_b64: "AAAA" });
    expect(await call("sealed_state.read")).toEqual({ ciphertext_b64: "AAAA" });
    expect(m.rpc.mock.calls.map((c) => c[0])).toEqual([
      "octra_circleAssetCiphertextByStateRefAuth",
      "circle_asset_ciphertext_by_state_ref",
    ]);
    expect(m.rpc.mock.calls[1][1]).toEqual([CIRCLE, "state:1"]);
  });

  it("cap the relayed ciphertext on both paths", async () => {
    const big = { ciphertext_b64: "A".repeat(96 * 1024 + 4) };
    m.rpc.mockResolvedValue(big);
    await expect(call("sealed_slot.read")).rejects.toThrow("exceeds resource policy");
  });
});

describe("circle fhe verifiers", () => {
  it("verify as the granted wallet with signed circle reads", async () => {
    await call("fhe.verify_zero", { ciphertext: "c", zero_proof: "p" });
    const [kind, circle, payload, caller] = m.verify.mock.calls[0];
    expect([kind, circle, payload]).toEqual(["zero", CIRCLE, { ciphertext: "c", zero_proof: "p" }]);
    expect(caller).toMatchObject({ walletId: "w1", address: ADDR, networkId: "devnet" });
    await caller.authRead("octra_circleInfoAuth", "octra_circle_info", [CIRCLE]);
    expect(m.sign).toHaveBeenCalledWith(
      "w1",
      circleAuthMessage("octra_circle_info", CIRCLE, ADDR, ""),
    );
    expect(m.rpc).toHaveBeenCalledWith("octra_circleInfoAuth", [CIRCLE, ADDR, "PUB", "SIG"]);

    await call("fhe.verify_bound", { ciphertext: "c" });
    expect(m.verify.mock.calls[1][0]).toBe("bound");
  });

  it("refuse a call aimed at another circle", async () => {
    await expect(
      call("fhe.verify_zero", { circle_id: `oct${"9".repeat(44)}`, ciphertext: "c" }),
    ).rejects.toThrow("Bridge target override denied");
    expect(m.verify).not.toHaveBeenCalled();
  });
});
