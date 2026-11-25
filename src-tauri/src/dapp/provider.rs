//! SECURITY: the page can call Tauri's raw IPC directly, so capabilities/dapp.json is what limits
//! it to `dapp_bridge_request`; the origin is read from the webview's URL on the Rust side.

/// The surface matches the extension's injected provider: dapps detect the wallet by its globals,
/// flags and request() shape.
pub(crate) fn provider_script() -> String {
    r#"
(function () {
  if (window.wallet0xio) return;

  const pending = new Map();
  let seq = 0;
  const listeners = new Map();

  // The wallet code itself stays in `data.code`.
  const RFC_CODES = {
    USER_REJECTED: 4001,
    PERMISSION_DENIED: 4100,
    WATCH_ONLY: 4100,
    NOT_CONNECTED: 4100,
    WALLET_LOCKED: 4100,
    UNAUTHORIZED: 4100,
    NETWORK_ERROR: 4901,
    DISCONNECTED: 4900,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
  };
  function walletError(message, code) {
    const e = new Error(message || "Request failed");
    const name = typeof code === "string" && code ? code : "INTERNAL_ERROR";
    e.code = RFC_CODES[name] || 4200;
    e.data = { code: name, message: e.message };
    return e;
  }
  function ipcError(e) {
    if (e && typeof e === "object" && typeof e.message === "string") {
      return walletError(e.message, e.code);
    }
    const text = typeof e === "string" ? e : "";
    return /not allowed|not found/i.test(text)
      ? walletError("This page cannot reach the wallet", "UNAUTHORIZED")
      : walletError(text || "The wallet could not be reached", "INTERNAL_ERROR");
  }
  // A sandboxed page has the origin "null", which postMessage refuses as a target.
  const SELF = window.location.origin === "null" ? "*" : window.location.origin;

  window.__octraResolve = function (id, payload) {
    console.log("[0xio] <-", id, payload);
    const p = pending.get(id);
    if (!p) {
      console.warn("[0xio] reply for an unknown request", id);
      return;
    }
    pending.delete(id);
    if (p.raw) p.resolve(payload || {});
    else if (payload && payload.error) p.reject(walletError(payload.error, payload.code));
    else p.resolve(payload ? payload.result : undefined);
  };

  function canSignOf(data) {
    return data && typeof data.canSign === "boolean" ? data.canSign : null;
  }

  window.__octraEmit = function (event, data) {
    if (event === "accountChanged") {
      api.address = (data && data.address) || null;
      api.canSign = canSignOf(data);
    } else if (event === "disconnect") {
      api.isConnected = false;
      api.address = null;
      api.canSign = null;
    }
    (listeners.get(event) || []).forEach((fn) => {
      try { fn(data); } catch (_) {}
    });
  };

  const LOG = "[0xio]";
  function send(method, params, rid, raw) {
    const id = `${Date.now()}-${seq++}`;
    const ipc = window.__TAURI_INTERNALS__;
    if (!ipc || typeof ipc.invoke !== "function") {
      // Tauri did not expose its IPC to this remote origin.
      console.error(
        LOG,
        "__TAURI_INTERNALS__ is unavailable in this webview - the dApp window has no IPC.",
        "keys:",
        Object.keys(window).filter((k) => k.indexOf("TAURI") === 0),
      );
      return Promise.reject(
        walletError("0xio: wallet IPC unavailable in this window", "UNAUTHORIZED"),
      );
    }
    console.log(LOG, "->", method, id, params || {});
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, raw: !!raw });
      ipc
        .invoke("dapp_bridge_request", { id, method, params: params || {}, rid: rid || null })
        .then(() => console.log(LOG, "   invoke accepted", id))
        .catch((e) => {
          console.error(LOG, "   invoke REJECTED", id, e);
          pending.delete(id);
          reject(ipcError(e));
        });
    });
  }

  // octra_* names map to the bridge's methods, as the extension does: a name forwarded as is has
  // no handler.
  const DIRECT = {
    octra_networkInfo: "get_network_info",
    octra_switchNetwork: "switch_network",
    octra_callContract: "contract_call_view",
    octra_callContractView: "contract_call_view",
    octra_sendContractTransaction: "send_contract_transaction",
    octra_sendContractTransactionSequence: "send_contract_transaction_sequence",
    octra_getEncryptedBalance: "get_private_balance_info",
    octra_getPrivateBalance: "get_private_balance",
    octra_getPrivateCapabilities: "get_private_capabilities",
    octra_encryptBalance: "encrypt_balance",
    octra_decryptBalance: "decrypt_balance",
    octra_sendPrivateTransfer: "send_private_transfer",
    octra_claimPrivateTransfer: "claim_private_transfer",
    octra_claimStealth: "claim_private_transfer",
    octra_encryptValue: "encrypt_value",
    octra_decryptValue: "decrypt_value",
    octra_makeZeroProof: "make_zero_proof",
    octra_makeRangeProof: "make_range_proof",
    octra_registerPrivateViewKey: "register_private_view_key",
    octra_signTransaction: "sign_transaction",
    octra_submitTransaction: "broadcast_only",
    octra_sendTransaction: "send_transaction",
    octra_signMessage: "signMessage",
    octra_deployContract: "deploy_contract",
  };

  async function handleRpc(method, params) {
    const p0 = Array.isArray(params) ? params[0] : params;

    if (method === "octra_requestAccounts") {
      const r = await send("connect", p0 || {});
      if (r && r.address) {
        api.isConnected = true;
        api.address = r.address;
        api.balance = r.balance != null ? r.balance : null;
        api.canSign = canSignOf(r);
        const chainId = (r.networkInfo && r.networkInfo.id) || "mainnet";
        window.__octraEmit("connect", { chainId, canSign: api.canSign });
        window.__octraEmit("accountsChanged", [r.address]);
        window.__octraEmit("permissionsChanged", r.permissions || []);
      }
      return [r && r.address].filter(Boolean);
    }
    if (method === "octra_accounts") {
      const st = await send("getConnectionStatus", {});
      return [st && st.address].filter(Boolean);
    }
    if (method === "octra_networkId") {
      const info = await send("get_network_info", {});
      return info && info.id;
    }
    if (method === "octra_permissions") {
      const st = await send("getConnectionStatus", {});
      return (st && st.permissions) || [];
    }
    if (method === "octra_sendTransaction") {
      const r = await send("send_transaction", p0 || {});
      const txHash = r && (r.txHash || r.hash);
      return { hash: txHash, accepted: !!txHash, status: "pending", txHash };
    }
    if (method === "octra_signTransaction") {
      const r = await send("sign_transaction", p0 || {});
      return (r && r.signedTx) || r;
    }
    if (method === "octra_deployContract") {
      const r = await send("deploy_contract", p0 || {});
      const txHash = r && (r.txHash || r.hash);
      return {
        hash: txHash,
        accepted: !!txHash,
        status: "pending",
        txHash,
        contractAddress: r && r.contractAddress,
      };
    }
    if (method === "octra_scanStealth") {
      return send("get_pending_private_transfers", p0 || {});
    }
    if (method === "octra_getContractReceipt") {
      return send("rpc_call", { method, params });
    }
    const direct = DIRECT[method];
    if (direct) return send(direct, p0 || {});
    return send("rpc_call", { method, params });
  }

  const octraProvider = {
    isOctra: true,
    isFhex: true,
    get canSign() {
      return api.isConnected ? api.canSign : null;
    },
    request(args) {
      const method = args && args.method;
      if (!method) {
        return Promise.reject(walletError("request requires a method", "INVALID_PARAMS"));
      }
      return handleRpc(method, args.params);
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return octraProvider;
    },
    removeListener(event, listener) {
      const arr = listeners.get(event) || [];
      const i = arr.indexOf(listener);
      if (i >= 0) arr.splice(i, 1);
      return octraProvider;
    },
  };

  const call = (m) => (...args) => send(m, args.length === 1 ? args[0] : args);
  const api = {
    isConnected: false,
    address: null,
    balance: null,
    canSign: null,
    isAvailable: async () => {
      try {
        const r = await send("ping", {});
        return !!(r && (r.available === undefined || r.available));
      } catch (_) {
        return false;
      }
    },
    connect: async (params) => {
      const r = await send("connect", params || {});
      api.isConnected = !!(r && r.address);
      api.address = (r && r.address) || null;
      api.balance = r && r.balance != null ? r.balance : null;
      api.canSign = canSignOf(r);
      return r;
    },
    disconnect: async () => {
      const r = await send("disconnect", {});
      api.isConnected = false;
      api.address = null;
      api.balance = null;
      api.canSign = null;
      return r;
    },
    // Local, like the extension: the bridge has no case for these two.
    getAddress: async () => {
      if (!api.isConnected) throw walletError("Wallet not connected", "NOT_CONNECTED");
      return api.address;
    },
    getBalance: async () => {
      const r = await send("getBalance", {});
      api.balance = r && r.balance;
      return r && r.balance;
    },
    getNetworkInfo: call("get_network_info"),
    switchNetwork: call("switch_network"),
    getSessionInfo: async () => {
      try {
        const r = await send("ping", {});
        return r && r.hasActiveWallet
          ? { hasActiveWallet: true, address: r.walletAddress }
          : { hasActiveWallet: false, address: null };
      } catch (_) {
        return { hasActiveWallet: false, address: null };
      }
    },
    getWalletInfo: async () => {
      const r = await send("getWalletInfo", {});
      if (r && typeof r.canSign === "boolean") api.canSign = r.canSign;
      return r;
    },
    sendTransaction: call("send_transaction"),
    callContract: call("call_contract"),
    deployContract: (opts) => {
      const o = opts || {};
      const payload = { bytecode: o.bytecode };
      if (o.params != null) payload.params = o.params;
      if (o.ou != null) payload.ou = String(o.ou);
      return send("deploy_contract", payload);
    },
    contractCallView: call("contract_call_view"),
    getContractStorage: call("get_contract_storage"),
    signMessage: call("signMessage"),
    getTransactionHistory: call("get_transaction_history"),
    getPublicKey: call("getPublicKey"),
    getConnectionStatus: call("getConnectionStatus"),
    getPrivateBalanceInfo: call("get_private_balance_info"),
    encryptBalance: call("encrypt_balance"),
    decryptBalance: call("decrypt_balance"),
    sendPrivateTransfer: call("send_private_transfer"),
    getPendingPrivateTransfers: call("get_pending_private_transfers"),
    claimPrivateTransfer: call("claim_private_transfer"),
    request: (args) => octraProvider.request(args),

    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    off(event, cb) {
      const arr = listeners.get(event) || [];
      const i = arr.indexOf(cb);
      if (i > -1) arr.splice(i, 1);
    },
    getConnectedSite: async () => send("getConnectionStatus", {}),
    declareIntegration(options) {
      const o = options || {};
      const meta = document.createElement("meta");
      meta.name = "0xio-dapp";
      meta.content = JSON.stringify({
        name: o.name || document.title,
        description: o.description || "0xio DApp",
        version: o.version || "1.0.0",
        integrated: true,
      });
      document.head && document.head.appendChild(meta);
      void send("declareIntegration", o).catch(function () {});
    },
  };

  window.octra = octraProvider;
  window.octraProviders = (window.octraProviders || []).concat([octraProvider]);
  window.wallet0xio = api;
  window.ZeroXIOWallet = api;
  if (!window.wallet) window.wallet = api;

  // The SDK talks over window.postMessage, never window.octra.request; without this listener every
  // SDK call times out.
  const NONCE = (function () {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      const b = new Uint8Array(16);
      window.crypto.getRandomValues(b);
      return Array.from(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
    } catch (_) {
      return String(Date.now()) + "-" + String(seq++);
    }
  })();

  function announceNonce() {
    window.postMessage({ source: "0xio-sdk-nonce-init", nonce: NONCE }, SELF);
  }

  function sdkReply(id, success, data, error, extra) {
    const response = { id: id, success: success, data: data, error: error };
    if (extra && typeof extra.rid === "string") {
      response.rid = extra.rid;
      response.status = extra.status;
    }
    window.postMessage(
      { source: "0xio-sdk-bridge", response: response, sessionNonce: NONCE },
      SELF,
    );
  }

  function sdkError(err) {
    return {
      code: (err && err.data && err.data.code) || "INTERNAL_ERROR",
      message: (err && err.message) || String(err),
    };
  }

  window.__0xioSdkBridgeLoaded = true;

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data) return;
    if (event.data.source !== "0xio-sdk-request" && event.data.type !== "0xio-sdk-request") return;

    const request = event.data.request || event.data;
    const id = request.id || event.data.id;
    const method = request.method || event.data.method;
    const params = request.params || event.data.params;
    if (!id || !method) return;

    // The SDK can load after the first broadcast, and drops a reply whose nonce it never received.
    announceNonce();

    console.log(LOG, "sdk ->", method, id, params || {});
    if (method.indexOf("octra_") !== 0) {
      const rid = typeof request.rid === "string" ? request.rid : null;
      send(method, params || {}, rid, true).then(
        function (payload) {
          if (payload.error) {
            const error = {
              code: payload.code || "INTERNAL_ERROR",
              message: payload.error,
              details: payload.details,
            };
            sdkReply(id, false, undefined, error, payload);
          } else {
            sdkReply(id, true, payload.result, undefined, payload);
          }
        },
        function (err) {
          sdkReply(id, false, undefined, sdkError(err));
        },
      );
      return;
    }
    const p = handleRpc(method, params);
    p.then(
      function (data) {
        console.log(LOG, "sdk <-", method, id, "ok");
        sdkReply(id, true, data, undefined);
      },
      function (err) {
        console.warn(LOG, "sdk <-", method, id, "error:", err);
        sdkReply(id, false, undefined, sdkError(err));
      },
    );
  });

  const _emitLocal = window.__octraEmit;
  window.__octraEmit = function (event, data) {
    _emitLocal(event, data);
    window.postMessage(
      { source: "0xio-sdk-bridge", event: { type: event, data: data }, sessionNonce: NONCE },
      SELF,
    );
  };

  announceNonce();

  // Names and detail shapes match the extension's, or a dapp reports the wallet missing.
  const VERSION = "0.3.0";
  window.dispatchEvent(
    new CustomEvent("0xioWalletReady", { detail: { version: VERSION, wallet: api } }),
  );
  window.dispatchEvent(
    new CustomEvent("wallet0xioReady", { detail: { version: VERSION, wallet: api } }),
  );
  window.dispatchEvent(
    new CustomEvent("octraWalletReady", { detail: { version: VERSION, provider: octraProvider } }),
  );
  window.dispatchEvent(new CustomEvent("octra#initialized"));

  // A dapp that loaded before injection did not hear them.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      window.dispatchEvent(
        new CustomEvent("octraWalletReady", { detail: { version: VERSION, provider: octraProvider } }),
      );
      window.dispatchEvent(
        new CustomEvent("0xioWalletReady", { detail: { version: VERSION, wallet: api } }),
      );
    });
  }

  console.log(
    "[0xio] provider injected (desktop). IPC:",
    !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke),
    "| globals:",
    ["octra", "wallet0xio", "ZeroXIOWallet", "wallet", "octraProviders"].filter((k) => !!window[k]),
    "| sdk postMessage bridge:",
    !!window.__0xioSdkBridgeLoaded,
  );
})();
"#
    .to_string()
}
