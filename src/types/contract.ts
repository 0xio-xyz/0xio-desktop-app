export type ContractLanguage = "assembly" | "aml";

export interface AbiParam {
  name: string;
  type: string;
}

export interface AbiMethod {
  name: string;
  params: AbiParam[];
  returns?: string;
  mutates: boolean;
  /** False when the ABI names the method without its inputs or kind (octra_contractAbi). */
  typed?: boolean;
}

export type ContractAbi = AbiMethod[];

interface VerificationFinding {
  code?: string;
  severity?: string;
  function_name?: string;
  state_field?: string;
  parameter?: string;
  message?: string;
}

interface VerificationReport {
  schema?: string;
  engine?: string;
  proof_model?: string;
  safety?: "safe" | "warning" | "error";
  verified?: boolean;
  errors?: number;
  warnings?: number;
  trace?: { code?: string; status?: string }[];
  invariants?: { code?: string; status?: string; fields?: string[]; functions?: string[] }[];
  function_summaries?: {
    name?: string;
    visibility?: string;
    direct_writes?: string[];
    transitive_writes?: string[];
  }[];
  findings?: VerificationFinding[];
}

export interface CompileResult {
  bytecode: string;
  size: number;
  instructions: number;
  version?: string;
  abi?: ContractAbi;
  disasm?: string;
  verification?: VerificationReport;
  certificate?: { schema?: string; source_hash?: string; bytecode_hash?: string };
  program_envelope?: string;
  deploy_payload?: string;
  program_min_ou?: number;
}

export interface PredictedAddress {
  address: string;
  deployer: string;
  nonce: number;
}

export interface ContractInfo {
  address: string;
  owner: string;
  version: number | string;
  code_hash: string;
  balance: string;
}

export interface ContractReceipt {
  tx_hash: string;
  status: string;
  gas_used?: number;
  return_value?: unknown;
  error?: string;
  events?: unknown[];
}

export interface RegisteredContract {
  address: string;
  name: string;
  language: ContractLanguage;
  deployedAt: number;
  deployTxHash: string;
  bytecodeSize?: number;
  abi?: ContractAbi;
}

export interface TokenInfo {
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  logoURI?: string;
}

export interface DeployResult {
  txHash: string;
  contractAddress: string;
}

export interface ContractListEntry {
  address: string;
  owner: string;
  version?: number | string;
  code_hash?: string;
  /** Micro-OCT as a whole-number string. */
  balance?: string;
}
