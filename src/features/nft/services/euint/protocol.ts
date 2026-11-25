// The host answers only read methods (bridge.ts) over postMessage: never signing or key access.

export const LIVING_MSG = "octra-living" as const;

interface BridgeRequest {
  source: typeof LIVING_MSG;
  type: "bridge-request";
  id: number;
  method: string;
  params: unknown[];
}

interface SnapshotMessage {
  source: typeof LIVING_MSG;
  type: "snapshot";
  dataUrl: string;
}

interface BridgeResponse {
  source: typeof LIVING_MSG;
  type: "bridge-response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function isLiving(d: unknown): d is BridgeRequest | BridgeResponse | SnapshotMessage {
  return !!d && typeof d === "object" && (d as { source?: unknown }).source === LIVING_MSG;
}

// An oct:// with no path resolves to /index.html, so it counts too.
export function isLivingProgramUri(uri: string | null | undefined): boolean {
  if (!uri) return false;
  const u = uri.toLowerCase();
  if (!u.startsWith("oct://")) return false;
  if (u.includes(".html") || u.includes(".htm")) return true;

  const rest = u.slice(6).split(/[?#]/, 1)[0];
  if (!rest) return false;
  const si = rest.indexOf("/");
  const path = si === -1 ? "" : rest.slice(si);
  return path === "" || path === "/";
}

// Plain ES5: it runs in the untrusted document, so no bundler or TS constructs.
export function buildPrelude(inputs: Record<string, unknown>): string {
  const search = typeof inputs._search === "string" ? (inputs._search as string) : "";
  return `
<script>
(function () {
  // Preserve the animation_url query (e.g. ?seed=...) so deterministic-from-seed programs are stable.
  // The program runs from a data: URL, so location.search is empty and history.replaceState throws
  // in the opaque origin - override location.search + URLSearchParams (what such programs read:
  // new URLSearchParams(location.search).get('seed')) to return the query.
  try {
    var __qs = ${JSON.stringify(search).replace(/</g, "\\u003c")};
    if (__qs) {
      try { Object.defineProperty(Object.getPrototypeOf(location), 'search', { configurable: true, get: function () { return __qs; } }); } catch (e) {}
      var __USP = window.URLSearchParams;
      if (__USP) { window.URLSearchParams = function (i) { if (i === '' || i == null) i = __qs; return new __USP(i); }; window.URLSearchParams.prototype = __USP.prototype; }
      try { history.replaceState(null, '', __qs); } catch (e) {}
    }
  } catch (e) {}
  window.__OCTRA_INPUTS__ = ${JSON.stringify(inputs).replace(/</g, "\\u003c")};
  var pending = {}, seq = 0, audioCb = null, audioCtxs = [];
  // Audio: many pieces output at a low level and gate sound on their own in-frame control, ignoring
  // the host onAudio() flag. Boost loudness (master gain + limiter) and track every AudioContext so
  // the wallet's speaker toggle can resume/suspend it directly - program-agnostic.
  var AUDIO_BOOST = 3.2;
  try {
    var AN = window.AudioNode;
    if (AN && AN.prototype && AN.prototype.connect) {
      var _connect = AN.prototype.connect;
      AN.prototype.connect = function (target) {
        try {
          var ctx = this.context;
          if (ctx && target && target === ctx.destination) {
            var master = ctx.__octraMaster;
            if (!master) {
              master = ctx.createGain();
              master.gain.value = AUDIO_BOOST;
              var limiter = ctx.createDynamicsCompressor();
              try {
                limiter.threshold.value = -3; limiter.knee.value = 0;
                limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.25;
              } catch (e2) {}
              _connect.call(master, limiter);
              _connect.call(limiter, ctx.destination);
              ctx.__octraMaster = master;
            }
            var args = Array.prototype.slice.call(arguments);
            args[0] = master;
            return _connect.apply(this, args);
          }
        } catch (e1) {}
        return _connect.apply(this, arguments);
      };
    }
    var patchCtor = function (name) {
      var Orig = window[name];
      if (!Orig) return;
      var Patched = function (opts) {
        var ctx = opts !== undefined ? new Orig(opts) : new Orig();
        try { audioCtxs.push(ctx); } catch (e3) {}
        return ctx;
      };
      Patched.prototype = Orig.prototype;
      window[name] = Patched;
    };
    patchCtor('AudioContext');
    patchCtor('webkitAudioContext');
  } catch (e) {}
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== '${LIVING_MSG}') return;
    if (d.type === 'audio') {
      var on = !!d.enabled;
      window.OctraCircle.audioEnabled = on;
      // Drive the program's AudioContext(s) directly - works even if it never registers onAudio().
      try {
        for (var i = 0; i < audioCtxs.length; i++) {
          var c = audioCtxs[i];
          if (on) { if (c && c.resume) c.resume(); }
          else { if (c && c.suspend) c.suspend(); }
        }
      } catch (err) {}
      if (audioCb) { try { audioCb(on); } catch (err) {} }
      return;
    }
    if (d.type !== 'bridge-response') return;
    var p = pending[d.id]; if (!p) return; delete pending[d.id];
    if (d.ok) p.resolve(d.result); else p.reject(new Error(d.error || 'bridge error'));
  });
  window.OctraCircle = {
    inputs: (window.__OCTRA_INPUTS__ || {}),
    audioEnabled: false,
    onAudio: function (cb) { audioCb = cb; if (this.audioEnabled) { try { cb(true); } catch (err) {} } },
    request: function (method, params) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending[id] = { resolve: resolve, reject: reject };
        parent.postMessage(
          { source: '${LIVING_MSG}', type: 'bridge-request', id: id, method: method, params: params || [] },
          '*'
        );
        setTimeout(function () {
          if (pending[id]) { delete pending[id]; reject(new Error('bridge timeout')); }
        }, 20000);
      });
    }
  };
  // Poster capture - once the art has settled, snapshot the canvas (center-cropped square, scaled
  // to 256px) and hand it to the host, which caches it as a static grid thumbnail so the gallery
  // never has to run the program. Best-effort: a tainted or absent canvas just yields nothing.
  setTimeout(function () {
    try {
      var cs = document.querySelectorAll('canvas'), best = null, area = 0;
      for (var i = 0; i < cs.length; i++) {
        var a = cs[i].width * cs[i].height;
        if (a > area) { area = a; best = cs[i]; }
      }
      if (!best || !best.width || !best.height) return;
      var S = 256, side = Math.min(best.width, best.height);
      var sx = (best.width - side) / 2, sy = (best.height - side) / 2;
      var oc = document.createElement('canvas'); oc.width = S; oc.height = S;
      oc.getContext('2d').drawImage(best, sx, sy, side, side, 0, 0, S, S);
      // WebKit ignores image/webp in toDataURL and silently returns PNG (~190KB for detailed
      // art). Verify the encoder honoured it, else fall back to JPEG.
      var url = oc.toDataURL('image/webp', 0.72);
      if (url.indexOf('data:image/webp') !== 0) url = oc.toDataURL('image/jpeg', 0.72);
      if (url && url.length > 64) parent.postMessage({ source: '${LIVING_MSG}', type: 'snapshot', dataUrl: url }, '*');
    } catch (e) {}
  }, 3000);
})();
</script>`;
}
