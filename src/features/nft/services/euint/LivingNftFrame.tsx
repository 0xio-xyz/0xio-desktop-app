import { useEffect, useRef, useState } from "react";
import { stageFrameDocument } from "src/services/sites/frameStage";
import { logger } from "src/lib/logger";
import { jsonRpcCallOn, rpcUrlFor } from "src/services/network/networkService";
import { parseOctUri } from "src/features/nft/services/xpectrum/circle";
import {
  resolveCircleAsset,
  type CircleAssetReply,
} from "src/features/circles/services/circleAsset";
import { handleLivingBridgeRequest } from "src/features/nft/services/euint/bridge";
import {
  injectAtTop,
  livingQuery,
  livingRpcEndpoint,
  readsChainState,
} from "src/features/nft/services/euint/chainState";
import { buildPrelude, isLiving, LIVING_MSG } from "src/features/nft/services/euint/protocol";

// The program file can change at the same path, so it is kept in memory for a few minutes only.
const PROGRAM_TTL_MS = 5 * 60_000;
const programs = new Map<string, { at: number; html: string }>();

async function loadProgram(
  networkId: string,
  circleId: string,
  path: string,
): Promise<string | null> {
  const p = path.startsWith("/") ? path : `/${path}`;
  const key = `${networkId}|${circleId}|${p}`;
  const hit = programs.get(key);
  if (hit && Date.now() - hit.at < PROGRAM_TTL_MS) return hit.html;
  try {
    const asset = await resolveCircleAsset(
      (q) => jsonRpcCallOn<CircleAssetReply>(networkId, "circle_asset", [circleId, q]),
      p,
    );
    if (!asset?.bytes.length) return null;
    const html = new TextDecoder().decode(asset.bytes);
    programs.set(key, { at: Date.now(), html });
    return html;
  } catch {
    return null;
  }
}

interface Props {
  uri: string;
  networkId: string;
  offline?: boolean;
  inputs?: Record<string, unknown>;
  className?: string;
  onError?: () => void;
  audioEnabled?: boolean;
  onSnapshot?: (dataUrl: string) => void;
}

// A chain-state program (its query names the contract) may read its own network's RPC endpoint;
// any other program stays offline.
export function LivingNftFrame({
  uri,
  networkId,
  offline,
  inputs,
  className,
  onError,
  audioEnabled,
  onSnapshot,
}: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  // The circle asset is immutable, so an empty result from a slow node is worth retrying.
  useEffect(() => {
    let alive = true;
    setFailed(false);
    setFrameSrc(null);
    void (async () => {
      const parsed = parseOctUri(uri);
      if (!parsed) {
        logger.warn("nft", `[LivingNFT] bad uri ${uri}`);
        if (alive) {
          setFailed(true);
          onErrorRef.current?.();
        }
        return;
      }
      const endpoint =
        !offline && readsChainState(uri) ? livingRpcEndpoint(rpcUrlFor(networkId)) : null;
      const search = livingQuery(uri, endpoint);
      let html: string | null = null;
      for (let attempt = 0; attempt < 4 && alive && !html; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
        html = await loadProgram(networkId, parsed.circleId, parsed.path);
      }
      if (!alive) return;
      if (!html) {
        logger.warn("nft", `[LivingNFT] program unavailable, node slow or down (${uri})`);
        setFailed(true);
        onErrorRef.current?.();
        return;
      }
      const prelude = buildPrelude({ ...(inputsRef.current ?? {}), _search: search });
      const injected = injectAtTop(html, prelude);
      const staged = endpoint
        ? await stageFrameDocument(injected, "chain", endpoint)
        : await stageFrameDocument(injected, "nft");
      if (!alive) return;
      // The real query on the frame URL gives the program a native location.search; the listener
      // reads only the path.
      setFrameSrc(`${staged}${search}`);
      logger.debug("nft", `[LivingNFT] mounted ${uri} (${html.length}c)`);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, networkId, offline]);

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const iframe = ref.current;
      if (!iframe || e.source !== iframe.contentWindow || !isLiving(e.data)) return;
      const d = e.data;
      if (d.type === "snapshot") {
        logger.debug(
          "nft",
          `[LivingNFT] poster captured ${d.dataUrl.slice(5, d.dataUrl.indexOf(";"))} ${(d.dataUrl.length / 1024).toFixed(0)}KB`,
        );
        onSnapshotRef.current?.(d.dataUrl);
        return;
      }
      if (d.type !== "bridge-request") return;
      try {
        const result = await handleLivingBridgeRequest(networkId, d.method, d.params);
        iframe.contentWindow?.postMessage(
          { source: LIVING_MSG, type: "bridge-response", id: d.id, ok: true, result },
          "*",
        );
      } catch (err) {
        iframe.contentWindow?.postMessage(
          {
            source: LIVING_MSG,
            type: "bridge-response",
            id: d.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          "*",
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [networkId]);

  useEffect(() => {
    ref.current?.contentWindow?.postMessage(
      { source: LIVING_MSG, type: "audio", enabled: !!audioEnabled },
      "*",
    );
  }, [audioEnabled]);

  if (failed || !frameSrc) return null;

  return (
    <iframe
      ref={ref}
      src={frameSrc}
      title="Living NFT"
      // allow-scripts only: opaque origin, no access to the wallet's DOM, storage or keys.
      // Autoplay needs `autoplay *`: the default 'src' allowlist never matches an opaque origin, so
      // AudioContext.resume() is silently denied. `*` is audio-only, no data surface.
      sandbox="allow-scripts"
      allow="autoplay *"
      referrerPolicy="no-referrer"
      className={className}
    />
  );
}
