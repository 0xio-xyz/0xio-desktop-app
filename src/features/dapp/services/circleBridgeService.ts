/**
 * Circle bridge protocol (oct:// content <-> wallet host) over postMessage. Signing runs in the
 * Rust backend; the private key never reaches this side.
 */

import { walletBridge } from "src/services/wallet/walletBridge";
import * as networkService from "src/services/network/networkService";
import { MAX_CIPHERTEXT_B64 } from "src/features/dapp/services/circleVerifierPolicy";
import type { CircleWallet } from "src/features/dapp/services/circleAccess";
import { circleVerify, type VerifierKind } from "src/features/dapp/services/circleVerifier";

export interface CircleBridgeContext {
  circle_id: string;
  path: string;
  uri: string;
  bridge_token: string;
  bridge_methods: string[];
}

const BRIDGE_UNSUPPORTED = "UNSUPPORTED_METHOD";

export class BridgeUnsupportedError extends Error {
  readonly code = BRIDGE_UNSUPPORTED;
  constructor(method: unknown) {
    super(`Method not supported: ${typeof method === "string" ? method.slice(0, 64) : ""}`);
  }
}

/**
 * What a circle read signs, as webcli lib/tx_builder.hpp frame_v2 builds it:
 * octra_circle_auth_v2 then |<utf8 byte length>:<field> for op, circle, address and subject.
 * Vectors: src/test/fixtures/circle-auth-vectors.json.
 */
export function circleAuthMessage(
  op: string,
  circleId: string,
  addr: string,
  subject = "",
): string {
  const enc = new TextEncoder();
  return [op, circleId, addr, subject].reduce(
    (out, field) => `${out}|${enc.encode(field).length}:${field}`,
    "octra_circle_auth_v2",
  );
}

export async function circleAuthParams(
  walletId: string,
  address: string,
  op: string,
  circleId: string,
  subject = "",
): Promise<[string, string, string]> {
  const [sig, pubKey] = await Promise.all([
    walletBridge.signMessage(walletId, circleAuthMessage(op, circleId, address, subject)),
    walletBridge.getPublicKey(walletId),
  ]);
  return [address, pubKey, sig];
}

async function sha256HexAsync(data: string): Promise<string> {
  const buf = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type BridgeCall = {
  context: CircleBridgeContext;
  method: string;
  payload: Record<string, any>;
  /** The wallet this circle was granted; asks the user the first time. */
  wallet: () => Promise<CircleWallet>;
  circle: () => string;
  auth: (
    rpcMethod: string,
    op: string,
    params: unknown[],
    subject?: string,
    trailing?: unknown[],
  ) => Promise<unknown>;
};
type BridgeHandler = (call: BridgeCall) => Promise<unknown> | unknown;

const authRead =
  (rpcMethod: string, op: string, ...fields: string[]): BridgeHandler =>
  (c) => {
    const cid = c.circle();
    const values = fields.map((f) => c.payload[f]);
    if (values.some((v) => !v)) throw new Error(`${c.method} requires ${fields.join(" and ")}`);
    return c.auth(rpcMethod, op, [cid, ...values], values.join("|"));
  };

// A sealed read relays node ciphertext straight to the circle. Cap it like the asset paths do:
// an oversized blob is a hostile node or a corrupt slot, never a legitimate read.
const capSealedRead = (res: unknown) => {
  const ct = (res as { ciphertext_b64?: string } | null)?.ciphertext_b64;
  if (ct && ct.length > MAX_CIPHERTEXT_B64)
    throw new Error("circle ciphertext exceeds resource policy");
  return res;
};

const sealedRead =
  (field: "slot_ref" | "state_ref", authRpc: string, plainRpc: string): BridgeHandler =>
  async (c) => {
    const cid = c.circle();
    const ref = c.payload[field];
    if (!ref) throw new Error(`${c.method} requires ${field}`);
    try {
      return capSealedRead(
        await c.auth(
          authRpc,
          `octra_circle_asset_ciphertext_by_${field}`,
          [cid, ref],
          `${field}|${ref}`,
        ),
      );
    } catch {
      return capSealedRead(await networkService.jsonRpcCall(plainRpc, [cid, ref]));
    }
  };

const verify =
  (kind: VerifierKind): BridgeHandler =>
  async (c) => {
    const cid = c.circle();
    const w = await c.wallet();
    return circleVerify(kind, cid, c.payload, {
      ...w,
      authRead: (rpcMethod, op, params, subject) => c.auth(rpcMethod, op, params, subject),
    });
  };

// webcli asks before the call runs (ensureBridgeGrant), so a refused grant answers first.
const granted =
  (handler: BridgeHandler): BridgeHandler =>
  async (c) => {
    await c.wallet();
    return handler(c);
  };

const relayById =
  (rpcMethod: string): BridgeHandler =>
  (c) => {
    if (!c.payload.request_id) throw new Error(`${c.method} requires request_id`);
    return networkService.jsonRpcCall(rpcMethod, [c.payload.request_id]);
  };

// Security: only these methods are served; a write joins the list with its review, never before.
// Everything but circle.context waits for the circle's grant (see circleAccess).
const HANDLERS: Record<string, BridgeHandler> = {
  "circle.context": (c) => c.context,

  "program.info": authRead("octra_circleProgramInfoAuth", "octra_circle_program_info"),
  "program.view": async (c) => {
    const cid = c.circle();
    const m = c.payload.method || "";
    const params = c.payload.params || [];
    const includeStorage = !!c.payload.include_storage;
    const paramsHash = await sha256HexAsync(JSON.stringify(params));
    return c.auth(
      "octra_circleViewAuth",
      "octra_circle_view",
      [cid, m, params],
      `${m}|${paramsHash}|${includeStorage ? "1" : "0"}`,
      [includeStorage],
    );
  },
  "program.storage": authRead("octra_circleStorageAuth", "octra_circle_storage", "key"),

  "sealed_slot.read": sealedRead(
    "slot_ref",
    "octra_circleAssetCiphertextBySlotRefAuth",
    "circle_asset_ciphertext_by_slot_ref",
  ),
  "sealed_state.read": sealedRead(
    "state_ref",
    "octra_circleAssetCiphertextByStateRefAuth",
    "circle_asset_ciphertext_by_state_ref",
  ),

  "slot_policy.read": authRead(
    "octra_circleSlotPolicyAuth",
    "octra_circle_slot_policy",
    "slot_ref",
  ),
  "state_policy.read": authRead(
    "octra_circleStatePolicyAuth",
    "octra_circle_state_policy",
    "state_ref",
  ),
  "state_descriptor.read": authRead(
    "octra_circleStateDescriptorAuth",
    "octra_circle_state_descriptor",
    "state_ref",
  ),
  "balance_cell.read": authRead(
    "octra_circleBalanceCellAuth",
    "octra_circle_balance_cell",
    "state_ref",
  ),
  "balance_binding.read": authRead(
    "octra_circleBalanceBindingAuth",
    "octra_circle_balance_binding",
    "subject_addr",
  ),
  "balance_workflow.read": authRead(
    "octra_circleBalanceWorkflowAuth",
    "octra_circle_balance_workflow",
    "workflow_ref",
  ),
  "register_cell.read": authRead(
    "octra_circleRegisterCellAuth",
    "octra_circle_register_cell",
    "state_ref",
  ),
  "register_binding.read": authRead(
    "octra_circleRegisterBindingAuth",
    "octra_circle_register_binding",
    "register_ref",
  ),
  "register_workflow.read": authRead(
    "octra_circleRegisterWorkflowAuth",
    "octra_circle_register_workflow",
    "workflow_ref",
  ),
  "transport_policy.read": authRead(
    "octra_circleTransportPolicyAuth",
    "octra_circle_transport_policy",
  ),
  "hfhe_policy.read": authRead("octra_circleHfhePolicyAuth", "octra_circle_hfhe_policy"),
  "key_policy.read": authRead("octra_circleKeyPolicyAuth", "octra_circle_key_policy", "key_id"),

  "object.refs.read": authRead("octra_circleObjectRefsAuth", "octra_circle_object_refs"),
  "object.list.read": authRead("octra_circleObjectListAuth", "octra_circle_object_list"),
  "object.detail.read": authRead(
    "octra_circleObjectDetailAuth",
    "octra_circle_object_detail",
    "object_ref",
  ),
  "object.member.read": authRead(
    "octra_circleObjectMemberAuth",
    "octra_circle_object_member",
    "object_ref",
    "member_ref",
  ),
  "object.summary.read": authRead(
    "octra_circleObjectSummaryAuth",
    "octra_circle_object_summary",
    "object_ref",
  ),
  "object.members.read": authRead(
    "octra_circleObjectMembersAuth",
    "octra_circle_object_members",
    "object_ref",
  ),

  "outbox.intent": authRead(
    "octra_circleOutboxIntentAuth",
    "octra_circle_outbox_intent",
    "intent_id",
  ),
  "outbox.claim": authRead("octra_circleOutboxClaimAuth", "octra_circle_outbox_claim", "intent_id"),
  "outbox.status": authRead(
    "octra_circleOutboxStatusAuth",
    "octra_circle_outbox_status",
    "intent_id",
  ),
  "ingress.packet": authRead(
    "octra_circleIngressPacketAuth",
    "octra_circle_ingress_packet",
    "intent_id",
  ),

  "wallet.info": async (c) => {
    const w = await c.wallet();
    return { address: w.address, public_key: await walletBridge.getPublicKey(w.walletId) };
  },
  "wallet.balance": async (c) => {
    const w = await c.wallet();
    const bal = await networkService.getBalance(w.address, w.networkId);
    return { balance: bal.balance, nonce: bal.nonce };
  },
  "wallet.keys": async (c) => ({
    public_key: await walletBridge.getPublicKey((await c.wallet()).walletId),
  }),

  "fhe.verify_zero": verify("zero"),
  "fhe.verify_bound": verify("bound"),

  "relay.request": granted((c) => networkService.jsonRpcCall("octra_relayRequest", [c.payload])),
  "relay.status": granted((c) =>
    networkService.jsonRpcCall(
      "octra_relayStatus",
      c.payload.request_id ? [c.payload.request_id] : [],
    ),
  ),
  "relay.response": granted(relayById("octra_relayResponse")),
  "relay.receipt": granted(relayById("octra_relayReceipt")),
  "relay.ingress": granted(relayById("octra_relayIngress")),
  "relay.health": granted(() => networkService.jsonRpcCall("octra_relayHealth", [])),
};

export const BRIDGE_METHODS: readonly string[] = Object.freeze(Object.keys(HANDLERS));

export async function handleBridgeMethod(
  context: CircleBridgeContext,
  method: string,
  payload: Record<string, any>,
  wallet: () => Promise<CircleWallet>,
): Promise<unknown> {
  const handler =
    typeof method === "string" && Object.prototype.hasOwnProperty.call(HANDLERS, method)
      ? HANDLERS[method]
      : null;
  if (!handler) throw new BridgeUnsupportedError(method);
  const circleId = context.circle_id;
  return handler({
    context,
    method,
    payload,
    wallet,
    circle: () => {
      if (payload.address) throw new Error("Bridge target override denied");
      if (payload.circle_id && payload.circle_id !== circleId)
        throw new Error("Bridge target override denied");
      return circleId;
    },
    auth: async (rpcMethod, op, params, subject = "", trailing = []) => {
      const w = await wallet();
      return networkService.jsonRpcCall(rpcMethod, [
        ...params,
        ...(await circleAuthParams(w.walletId, w.address, op, circleId, subject)),
        ...trailing,
      ]);
    },
  });
}

function generateBridgeToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createBridgeContext(circleId: string, path: string): CircleBridgeContext {
  const token = generateBridgeToken();
  return {
    circle_id: circleId,
    path,
    uri: `oct://${circleId}${path}`,
    bridge_token: token,
    bridge_methods: [...BRIDGE_METHODS],
  };
}

export function getCircleBridgePrelude(context: CircleBridgeContext): string {
  const contextJson = JSON.stringify({
    circle_id: context.circle_id,
    path: context.path,
    uri: context.uri,
    bridge_methods: context.bridge_methods,
  });
  const tokenJson = JSON.stringify(context.bridge_token);

  return `(function () {
  var context = ${contextJson};
  var bridgeToken = ${tokenJson};
  var waiters = new Map();
  var nextRequestId = 0;
  var safe = function (fn) { try { return fn(); } catch (_) { return undefined; } };
  var deny = function (name) { throw new Error(name + ' disabled in circle sandbox'); };
  var blockedStorage = function (name) {
    return Object.freeze({
      getItem: function () { deny(name); }, setItem: function () { deny(name); },
      removeItem: function () { deny(name); }, clear: function () { deny(name); },
      key: function () { return null; }, get length() { return 0; }
    });
  };
  window.OctraCircle = Object.freeze({
    context: Object.freeze(context),
    request: function (method, payload) {
      return new Promise(function (resolve, reject) {
        var id = 'req_' + String(++nextRequestId);
        waiters.set(id, { resolve: resolve, reject: reject });
        window.parent.postMessage({
          source: 'octra-circle-bridge',
          type: 'octra.circle.bridge.request',
          token: bridgeToken,
          id: id,
          method: method,
          payload: payload || {}
        }, '*');
      });
    },
    navigate: function (uri) {
      window.parent.postMessage({
        source: 'octra-circle-bridge',
        type: 'octra.circle.navigate',
        token: bridgeToken,
        uri: uri
      }, '*');
    }
  });
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { return; } }
    if (!data || data.token !== bridgeToken || data.type !== 'octra.circle.bridge.reply' || !data.id || !waiters.has(data.id)) return;
    var waiter = waiters.get(data.id);
    waiters.delete(data.id);
    if (data.ok) { waiter.resolve(data.result); } else {
      var failure = new Error(data.error || 'bridge request failed');
      if (data.code) failure.code = data.code;
      waiter.reject(failure);
    }
  });
  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    var href = anchor.getAttribute('href') || '';
    if (href.slice(0, 6).toLowerCase() !== 'oct://') return;
    event.preventDefault();
    window.OctraCircle.navigate(href);
  }, true);
  safe(function () {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: function () { return 'OctraCircle/1'; } });
  });
  safe(function () {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: function () { return 'Octra'; } });
  });
  safe(function () {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return blockedStorage('localStorage'); } });
  });
  safe(function () {
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: function () { return blockedStorage('sessionStorage'); } });
  });
  safe(function () { navigator.sendBeacon = function () { return false; }; });
})();`;
}
