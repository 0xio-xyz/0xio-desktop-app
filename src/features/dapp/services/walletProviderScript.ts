/**
 * Injected into circle pages before they load in the browser frame; talks to useDappBridge over
 * window.parent.postMessage.
 */

export function getDesktopProviderScript(): string {
  return `(function() {
  'use strict';
  if (window.wallet0xio) return;

  var requestId = 0;
  var pendingRequests = new Map();

  var LONG_METHODS = {
    call_contract: true, sendTransaction: true, sign_transaction: true,
    broadcast_only: true, encrypt_balance: true, decrypt_balance: true,
    send_private_transfer: true, claim_private_transfer: true,
    signMessage: true, connect: true, deploy_contract: true
  };

  // The wallet code itself stays in data.code (WATCH_ONLY, USER_REJECTED, ...).
  var RFC_CODES = {
    USER_REJECTED: 4001, PERMISSION_DENIED: 4100, WATCH_ONLY: 4100, NOT_CONNECTED: 4100,
    WALLET_LOCKED: 4100, UNAUTHORIZED: 4100, NETWORK_ERROR: 4901, DISCONNECTED: 4900,
    INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603
  };
  function walletError(error, fallback) {
    var isObj = error && typeof error === 'object';
    var e = new Error((isObj ? error.message : error) || 'Request failed');
    var name = (isObj && typeof error.code === 'string' && error.code) || fallback || 'INTERNAL_ERROR';
    e.code = RFC_CODES[name] || 4200;
    e.data = { code: name, message: e.message };
    return e;
  }
  function notConnected() {
    return Promise.reject(walletError('Wallet not connected', 'NOT_CONNECTED'));
  }
  function canSignOf(data) {
    return data && typeof data.canSign === 'boolean' ? data.canSign : null;
  }

  function sendMessage(method, params) {
    return new Promise(function(resolve, reject) {
      var id = 'dp_' + (++requestId);
      var timeout = LONG_METHODS[method] ? 180000 : 30000;
      pendingRequests.set(id, { resolve: resolve, reject: reject });

      setTimeout(function() {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(walletError('Request timeout'));
        }
      }, timeout);

      window.parent.postMessage({
        source: '0xio-sdk-request',
        request: { id: id, method: method, params: params || {}, timestamp: Date.now() }
      }, '*');
    });
  }

  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data) return;
    if (data.source === '0xio-sdk-bridge' && data.response) {
      var resp = data.response;
      var pending = pendingRequests.get(resp.id);
      if (pending) {
        pendingRequests.delete(resp.id);
        if (resp.success) {
          pending.resolve(resp.data);
        } else {
          pending.reject(walletError(resp.error));
        }
      }
    }
    if (data.source === '0xio-sdk-bridge' && data.event && data.event.type !== 'walletReady') {
      var ev = data.event;
      if (ev.type === 'accountChanged') {
        api.address = (ev.data && ev.data.address) || null;
        api.canSign = canSignOf(ev.data);
      } else if (ev.type === 'disconnect') {
        api.isConnected = false; api.address = null; api.canSign = null;
      }
      emit(ev.type, ev.data);
    }
  });


  var _listeners = {};
  function emit(event) {
    var args = Array.prototype.slice.call(arguments, 1);
    var fns = _listeners[event];
    if (fns) fns.forEach(function(fn) { try { fn.apply(null, args); } catch(e) {} });
  }


  var api = {
    isConnected: false,
    address: null,
    balance: null,
    canSign: null,

    on: function(event, callback) {
      if (!_listeners[event]) _listeners[event] = [];
      _listeners[event].push(callback);
    },
    off: function(event, callback) {
      var fns = _listeners[event];
      if (fns) { var idx = fns.indexOf(callback); if (idx > -1) fns.splice(idx, 1); }
    },
    emit: emit,

    isAvailable: function() {
      return sendMessage('ping').then(function(r) { return r && r.pong || false; }).catch(function() { return false; });
    },
    connect: function() {
      return sendMessage('connect').then(function(result) {
        api.isConnected = true;
        api.address = result.address;
        api.balance = result.balance;
        api.canSign = canSignOf(result);
        return { address: api.address, balance: api.balance, canSign: api.canSign };
      });
    },
    disconnect: function() {
      return sendMessage('disconnect').then(function() {
        api.isConnected = false; api.address = null; api.balance = null; api.canSign = null;
        return { success: true };
      });
    },
    getAddress: function() {
      if (!api.isConnected) return notConnected();
      return Promise.resolve(api.address);
    },
    getBalance: function() {
      return sendMessage('getBalance').then(function(r) { api.balance = r.balance; return r.balance; });
    },
    getNetworkInfo: function() {
      return sendMessage('get_network_info');
    },
    getWalletInfo: function() {
      if (!api.isConnected) return notConnected();
      return sendMessage('getWalletInfo').then(function(r) {
        api.address = r.address; api.balance = r.balance;
        if (typeof r.canSign === 'boolean') api.canSign = r.canSign;
        return r;
      });
    },
    sendTransaction: function(opts) {
      if (!api.isConnected) return notConnected();
      return sendMessage('sendTransaction', { to: opts.to, amount: opts.amount, memo: opts.memo || opts.message });
    },
    callContract: function(opts) {
      if (!api.isConnected) return notConnected();
      var payload = {
        contract: opts.contract, method: opts.method,
        params: opts.params || opts.args || [],
        amount: opts.amount != null ? String(opts.amount) : '0'
      };
      if (opts.ou != null) payload.ou = String(opts.ou);
      return sendMessage('call_contract', payload);
    },
    deployContract: function(opts) {
      if (!api.isConnected) return notConnected();
      var o = opts || {};
      var payload = { bytecode: o.bytecode };
      if (o.params != null) payload.params = o.params;
      if (o.ou != null) payload.ou = String(o.ou);
      return sendMessage('deploy_contract', payload);
    },
    signMessage: function(message) {
      if (!api.isConnected) return notConnected();
      return sendMessage('signMessage', { message: message }).then(function(r) { return r.signature; });
    },
    getTransactionHistory: function(limit) {
      return sendMessage('get_transaction_history', { limit: limit || 50 });
    },
    getPublicKey: function() {
      if (!api.isConnected) return notConnected();
      return sendMessage('getPublicKey').then(function(r) { return r.publicKey; });
    },
    switchNetwork: function(networkId) {
      return sendMessage('switch_network', { networkId: networkId });
    },
    getConnectionStatus: function() {
      return sendMessage('getConnectionStatus');
    },
    getSessionInfo: function() {
      return sendMessage('ping').then(function(r) {
        return r && r.hasActiveWallet ? { hasActiveWallet: true, address: r.walletAddress } : { hasActiveWallet: false, address: null };
      }).catch(function() { return { hasActiveWallet: false, address: null }; });
    },
    getConnectedSite: function() {
      var links = document.querySelectorAll('link[rel*="icon"]');
      var favicon = links.length > 0 ? links[links.length - 1].href : window.location.origin + '/favicon.ico';
      return { hostname: window.location.hostname, origin: window.location.origin, url: window.location.href, title: document.title, favicon: favicon };
    },
    contractCallView: function(opts) {
      return sendMessage('contract_call_view', { contract: opts.contract, method: opts.method, params: opts.params || [], caller: opts.caller });
    },
    getContractStorage: function(contract, key) {
      return sendMessage('get_contract_storage', { contract: contract, key: key });
    },
    getPrivateBalanceInfo: function() {
      return sendMessage('get_private_balance_info');
    },
    encryptBalance: function(amount) {
      if (!api.isConnected) return notConnected();
      return sendMessage('encrypt_balance', { amount: amount });
    },
    decryptBalance: function(amount) {
      if (!api.isConnected) return notConnected();
      return sendMessage('decrypt_balance', { amount: amount });
    },
    sendPrivateTransfer: function(opts) {
      if (!api.isConnected) return notConnected();
      return sendMessage('send_private_transfer', { to: opts.to, amount: opts.amount, message: opts.message });
    },
    getPendingPrivateTransfers: function() {
      return sendMessage('get_pending_private_transfers');
    },
    claimPrivateTransfer: function(transferId) {
      if (!api.isConnected) return notConnected();
      return sendMessage('claim_private_transfer', { transferId: transferId });
    },
    signTransactionOnly: function(txParams) {
      if (!api.isConnected) return notConnected();
      return sendMessage('sign_transaction', txParams);
    },
    broadcastOnly: function(signedTx) {
      return sendMessage('broadcast_only', { signedTx: signedTx });
    },
    declareIntegration: function(opts) {
      opts = opts || {};
      var meta = document.createElement('meta');
      meta.name = '0xio-dapp';
      meta.content = JSON.stringify({ name: opts.name || document.title, description: opts.description || '0xio DApp', version: opts.version || '1.0.0', integrated: true, timestamp: Date.now() });
      document.head.appendChild(meta);
    }
  };

  window.wallet0xio = api;
  window.ZeroXIOWallet = api;
  if (!window.wallet) window.wallet = api;
  if (!window.octraWallet) window.octraWallet = api;
  window.__0XIO_EXTENSION__ = true;


  window.addEventListener('message', function(event) {
    if (event.source !== window || !event.data) return;
    var src = event.data.source || event.data.type;
    if (src === '0xio-sdk-request' || src === 'octra-sdk-request') {
      var request = event.data.request || event.data;
      var reqId = request.id || event.data.id;
      window.parent.postMessage({
        source: '0xio-sdk-request',
        request: {
          id: reqId,
          method: request.method || event.data.method,
          params: request.params || event.data.params || {},
          timestamp: Date.now(),
          v: request.v,
          rid: typeof request.rid === 'string' ? request.rid : undefined
        }
      }, '*');
    }
  });


  var _octraListeners = {};
  function _octraEmit(event) {
    var args = Array.prototype.slice.call(arguments, 1);
    var fns = _octraListeners[event];
    if (fns) fns.forEach(function(fn) { try { fn.apply(null, args); } catch(e) {} });
  }

  var octraProvider = {
    isOctra: true,
    isFhex: true,
    get canSign() { return api.isConnected ? api.canSign : null; },
    _emit: _octraEmit,
    request: function(args) {
      var method = args && args.method;
      if (!method) return Promise.reject(walletError('request requires a method', 'INVALID_PARAMS'));
      var params = args.params || {};
      var p0 = Array.isArray(params) ? params[0] : params;

      switch (method) {
        case 'octra_requestAccounts':
          return sendMessage('connect', p0 || {}).then(function(r) {
            if (r && r.address) {
              api.isConnected = true; api.address = r.address; api.balance = r.balance || null;
              api.canSign = canSignOf(r);
              var chainId = (r.networkInfo && r.networkInfo.id) || 'mainnet';
              var permissions = r.permissions || [];
              _octraEmit('connect', { chainId: chainId, canSign: api.canSign });
              _octraEmit('accountsChanged', [r.address]);
              _octraEmit('permissionsChanged', permissions);
            }
            return r && r.address ? [r.address] : [];
          });
        case 'octra_accounts':
          return Promise.resolve(api.isConnected && api.address ? [api.address] : []);
        case 'octra_networkId':
          return sendMessage('get_network_info').then(function(r) { return r && r.id || null; });
        case 'octra_networkInfo':
          return sendMessage('get_network_info');
        case 'octra_permissions':
          return sendMessage('getConnectionStatus').then(function(r) { return r && r.permissions || []; });
        case 'octra_switchNetwork':
          return sendMessage('switch_network', { networkId: (p0 && p0.networkId) || p0 });
        case 'octra_signMessage':
          return sendMessage('signMessage', { message: (p0 && p0.message) || p0 }).then(function(r) { return r && r.signature || r; });
        case 'octra_sendTransaction':
          return sendMessage('sendTransaction', p0 || {}).then(function(r) {
            var h = r && (r.txHash || r.hash);
            return { hash: h, accepted: !!h, status: 'pending', txHash: h };
          });
        case 'octra_signTransaction':
          return sendMessage('sign_transaction', p0 || {}).then(function(r) { return r && r.signedTx || r; });
        case 'octra_submitTransaction':
          return sendMessage('broadcast_only', p0 || {}).then(function(r) {
            var h = r && (r.txHash || r.hash);
            return { hash: h, accepted: !!h, status: 'pending', txHash: h };
          });
        case 'octra_callContract':
          return sendMessage('contract_call_view', p0 || {});
        case 'octra_sendContractTransaction':
          return sendMessage('call_contract', p0 || {}).then(function(r) {
            var h = r && (r.txHash || r.hash);
            return { hash: h, accepted: !!h, status: 'pending', txHash: h };
          });
        case 'octra_deployContract':
          return sendMessage('deploy_contract', p0 || {}).then(function(r) {
            var h = r && (r.txHash || r.hash);
            return { hash: h, accepted: !!h, status: 'pending', txHash: h, contractAddress: r && r.contractAddress };
          });
        case 'octra_getEncryptedBalance':
          return sendMessage('get_private_balance_info');
        case 'octra_encryptBalance':
          return sendMessage('encrypt_balance', p0 || {});
        case 'octra_decryptBalance':
          return sendMessage('decrypt_balance', p0 || {});
        case 'octra_sendPrivateTransfer':
          return sendMessage('send_private_transfer', p0 || {});
        case 'octra_getContractReceipt':
          return Promise.reject(walletError('octra_getContractReceipt is not yet supported', 'UNSUPPORTED_METHOD'));
        case 'octra_scanStealth':
          return Promise.reject(walletError('octra_scanStealth is not yet supported', 'UNSUPPORTED_METHOD'));
        case 'octra_claimStealth':
        case 'octra_claimPrivateTransfer':
          return sendMessage('claim_private_transfer', p0 || {});
        case 'octra_getPrivateCapabilities':
          return sendMessage('get_private_capabilities', p0 || {});
        case 'octra_callContractView':
          return sendMessage('contract_call_view', p0 || {});
        case 'octra_getPrivateBalance':
          return sendMessage('get_private_balance', p0 || {});
        case 'octra_encryptValue':
          return sendMessage('encrypt_value', p0 || {});
        case 'octra_decryptValue':
          return sendMessage('decrypt_value', p0 || {});
        case 'octra_makeZeroProof':
          return sendMessage('make_zero_proof', p0 || {});
        case 'octra_makeRangeProof':
          return sendMessage('make_range_proof', p0 || {});
        case 'octra_registerPrivateViewKey':
          return sendMessage('register_private_view_key', p0 || {});
        case 'octra_sendContractTransactionSequence':
          return sendMessage('send_contract_transaction_sequence', p0 || {});
        default:
          if (method && (method.startsWith('octra_') || method.startsWith('oct_'))) {
            return sendMessage('rpc_call', { method: method, params: params });
          }
          return Promise.reject(walletError('Unsupported method: ' + method, 'UNSUPPORTED_METHOD'));
      }
    },
    on: function(event, listener) {
      if (!_octraListeners[event]) _octraListeners[event] = [];
      _octraListeners[event].push(listener);
      return octraProvider;
    },
    removeListener: function(event, listener) {
      var fns = _octraListeners[event];
      if (fns) { var idx = fns.indexOf(listener); if (idx > -1) fns.splice(idx, 1); }
      return octraProvider;
    }
  };

  window.octra = octraProvider;
  if (!window.octraProviders) window.octraProviders = [];
  window.octraProviders.push(octraProvider);


  window.dispatchEvent(new CustomEvent('0xioWalletReady', { detail: { version: '1.2.0', wallet: api } }));
  window.dispatchEvent(new CustomEvent('wallet0xioReady', { detail: { version: '1.2.0', wallet: api } }));
  window.dispatchEvent(new CustomEvent('octraWalletReady', { detail: { version: '1.2.0', provider: octraProvider } }));
  window.dispatchEvent(new CustomEvent('octra#initialized'));
})();`;
}
