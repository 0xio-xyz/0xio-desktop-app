export class RpcError extends Error {
  readonly code?: number;
  readonly httpStatus?: number;
  /** A write that provably never reached the node. */
  readonly unsent: boolean;
  constructor(
    message: string,
    opts: { code?: number; httpStatus?: number; unsent?: boolean } = {},
  ) {
    super(message);
    this.name = "RpcError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.unsent = opts.unsent ?? false;
  }
}

type SubmitErrorKind = "nonce_used" | "resend" | "rejected" | "too_large";

const NONCE_USED = 112;
const RESEND = new Set([107, 110, 117, -32005]);
const REJECTED = new Set([
  100, 101, 102, 103, 104, 105, 108, 109, 111, 113, 114, 115, 116, 118, -32600, -32602,
]);

export function submitErrorKind(err: unknown): SubmitErrorKind | null {
  if (!(err instanceof RpcError)) return null;
  if (err.httpStatus === 413) return "too_large";
  if (err.code === undefined) return null;
  if (err.code === NONCE_USED) return "nonce_used";
  if (RESEND.has(err.code)) return "resend";
  if (REJECTED.has(err.code)) return "rejected";
  return null;
}

/** The node may have taken it: never a resend. `hash` is the local exact hash of what was sent. */
export class UnclearSubmitError extends Error {
  contractAddress?: string;
  constructor(
    readonly hash: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "UnclearSubmitError";
  }
}

export class TxSubmitError extends Error {
  readonly kind: SubmitErrorKind | "not_accepted";
  constructor(kind: SubmitErrorKind | "not_accepted", message: string) {
    super(message);
    this.name = "TxSubmitError";
    this.kind = kind;
  }
}
