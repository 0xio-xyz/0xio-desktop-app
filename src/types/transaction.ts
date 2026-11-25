type TransactionType =
  | "send"
  | "receive"
  | "encrypt"
  | "decrypt"
  | "stealth_send"
  | "claim"
  | "contract_call"
  | "contract_deploy"
  | "key_switch";
type TransactionStatus = "confirmed" | "pending" | "failed";

export interface TokenTransfer {
  recipient: string;
  raw_amount: string;
  contract_address: string;
  symbol?: string;
  decimals?: number;
}

export interface Transaction {
  hash: string;
  type: TransactionType;
  amount: number;
  fee: number;
  from: string;
  to: string;
  timestamp: number;
  status: TransactionStatus;
  block_height?: number;
  nonce?: number;
  memo?: string;
  reject_reason?: string;
  op_type?: string;
  encrypted_data?: string;
  message?: string;
  token_transfer?: TokenTransfer;
  methodName?: string;
  network?: string;
  /** The node's own word for a failed row: rejected, dropped or expired. */
  chain_status?: string;
  drop_detail?: string;
}

export interface TransactionDetail {
  hash: string;
  from: string;
  to: string;
  amount_raw: string;
  op_type: string;
  status: string;
  timestamp: number;
  nonce: number;
  epoch?: number;
  block_height?: number;
  ou?: string;
  signature?: string;
  public_key?: string;
  message?: string;
  encrypted_data?: string;
  reject_reason?: string;
  reject_type?: string;
}

export interface SignedTransaction {
  from: string;
  to_: string;
  amount: string;
  nonce: number;
  ou: string;
  timestamp: number;
  op_type?: string;
  encrypted_data?: string;
  message?: string;
  signature?: string;
  public_key?: string;
}
