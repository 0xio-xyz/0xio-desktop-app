// A site's deploy_contract request: what it may ask for, and the fee it is priced at. Same limits
// and fee rule as the extension (0xio-wallet: src/utils/octra/deployTx.ts) and SDK 2.10.0.

import { isOctAddress } from "src/features/dapp/services/siteModel";
import { MAX_FEE_RAW } from "src/services/network/feePolicy";

const DEPLOY_MAX_CODE_BYTES = 512 * 1024;
const DEPLOY_MAX_PARAMS_CHARS = 64 * 1024;
const DEPLOY_MIN_OU = 1n;
export const DEPLOY_MAX_OU = BigInt(MAX_FEE_RAW);
const NODE_MIN_FLOOR_OU = 5_000n;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function base64DecodedLength(value: string): number | null {
  if (!value || value.length % 4 !== 0 || !BASE64_RE.test(value)) return null;
  const pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - pad;
}

/** webcli's size-based deploy fee: 200000 OU plus 1000 OU per started KiB of payload. */
export function deployBaseOu(payloadChars: number): bigint {
  return 200_000n + BigInt(Math.ceil(payloadChars / 1024)) * 1000n;
}

function parseBaseUnits(value: unknown): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "string" && /^\d{1,30}$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

export function parseDeployOu(value: unknown): bigint | null {
  const ou = parseBaseUnits(value);
  if (ou == null || ou < DEPLOY_MIN_OU || ou > DEPLOY_MAX_OU) return null;
  return ou;
}

// The signed text escapes every control character the way the node does, but a lone surrogate
// cannot be encoded at all, so it would sign bytes the node never rebuilds.
function signable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

interface DeployRequest {
  bytecodeB64: string;
  codeBytes: number;
  constructorParams: string;
  ou: bigint | null;
}

type DeployRequestResult = { ok: true; request: DeployRequest } | { ok: false; error: string };

export function parseDeployRequest(raw: unknown): DeployRequestResult {
  const p = (Array.isArray(raw) ? (raw[0] ?? {}) : (raw ?? {})) as Record<string, unknown>;
  const bytecode = p.bytecode ?? p.bytecodeB64;
  if (typeof bytecode !== "string" || !bytecode) {
    return { ok: false, error: "bytecode (base64) is required" };
  }
  const codeBytes = base64DecodedLength(bytecode);
  if (codeBytes == null || codeBytes === 0) {
    return { ok: false, error: "bytecode must be base64" };
  }
  if (codeBytes > DEPLOY_MAX_CODE_BYTES) {
    return { ok: false, error: `bytecode is larger than ${DEPLOY_MAX_CODE_BYTES / 1024} KB` };
  }

  let params = "";
  const rawParams = p.params ?? p.constructorParams;
  if (Array.isArray(rawParams)) {
    try {
      params = JSON.stringify(rawParams);
    } catch {
      return { ok: false, error: "Constructor params are not serialisable" };
    }
  } else if (typeof rawParams === "string") {
    params = rawParams;
  } else if (rawParams != null) {
    return { ok: false, error: "Constructor params must be a JSON string or an array" };
  }
  if (params.length > DEPLOY_MAX_PARAMS_CHARS) {
    return { ok: false, error: "Constructor params are too long" };
  }
  if (params) {
    if (!signable(params)) {
      return { ok: false, error: "Constructor params hold characters that cannot be signed" };
    }
    try {
      JSON.parse(params);
    } catch {
      return { ok: false, error: "Constructor params must be valid JSON" };
    }
  }

  let ou: bigint | null = null;
  if (p.ou != null && p.ou !== "") {
    ou = parseDeployOu(p.ou);
    if (ou == null) return { ok: false, error: "Invalid fee" };
  }

  return { ok: true, request: { bytecodeB64: bytecode, codeBytes, constructorParams: params, ou } };
}

/**
 * webcli's required deploy fee for a payload: the size-based base, or the node's minimum for that
 * size when it is exactly 1, 2 or 5 times the base and inside 5,000 to 10,000,000 OU.
 */
export function deployFee(payload: string, nodeMinimum: unknown): bigint {
  const base = deployBaseOu(payload.length);
  const min = parseBaseUnits(nodeMinimum);
  if (min == null || (min !== base && min !== base * 2n && min !== base * 5n)) return base;
  return min >= NODE_MIN_FLOOR_OU && min <= DEPLOY_MAX_OU ? min : base;
}

export interface DeployReview {
  codeBytes: number;
  contractAddress: string;
  constructorParams: string;
  ou: string;
}

export function deployReviewError(review: Partial<DeployReview> | undefined): string | null {
  const p = review ?? {};
  if (typeof p.codeBytes !== "number" || !Number.isSafeInteger(p.codeBytes) || p.codeBytes <= 0) {
    return "Invalid contract code";
  }
  if (!isOctAddress(p.contractAddress)) return "No contract address from the node";
  if (parseDeployOu(p.ou) == null) return "Invalid fee";
  if (p.constructorParams != null && typeof p.constructorParams !== "string") {
    return "Invalid constructor params";
  }
  return null;
}
