export interface NetworkConfig {
  id: string;
  name: string;
  /** Base host. The JSON-RPC endpoint is `${rpcUrl}/rpc` unless rpcEndpoint overrides it. */
  rpcUrl: string;
  rpcEndpoint?: string;
  explorerUrl: string;
  explorerAddressUrl: string;
  indexerUrl: string;
  supportsPrivacy: boolean;
  color: string;
}

export interface RpcResponse<T = unknown> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: string };
}

export interface AccountInfo {
  address: string;
  balance?: string;
  /** Micro-OCT balance as string or number - some nodes return this instead of `balance` */
  balance_raw?: string | number;
  nonce: number;
  pending_nonce?: number;
  has_pvac_pubkey: boolean;
}
