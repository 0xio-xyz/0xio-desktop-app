import { invoke } from "@tauri-apps/api/core";
import type { WalletData } from "src/contexts/useWallet";

export interface UnlockStatus {
  attempts_left: number;
  next_lockout_seconds: number;
  locked_seconds: number;
}

interface SecretPreview {
  kind: "phrase" | "key";
  address: string;
  is_padded: boolean;
}

interface StealthScanOutput {
  id: number;
  eph_pub: string;
  stealth_tag: string;
  enc_amount: string;
}

interface StealthMatch {
  id: number;
  amount: string;
  claim_secret: string;
  blinding: string;
}

export const walletBridge = {
  async isInitialized(): Promise<boolean> {
    return invoke("wallet_is_initialized");
  },
  /** The phrase stays in Rust. `sealed` keeps the wallet waiting for its seal until the phrase was shown once. */
  async create(password: string, sealed = false): Promise<WalletData> {
    return invoke("wallet_create", { password, sealed });
  },
  async importMnemonic(mnemonic: string[], password: string): Promise<WalletData[]> {
    return invoke("wallet_import_mnemonic", { mnemonic, password });
  },
  async importPrivateKey(privateKey: string, password: string): Promise<WalletData> {
    return invoke("wallet_import_private_key", { privateKey, password });
  },
  async unlock(password: string): Promise<WalletData[]> {
    return invoke("wallet_unlock", { password });
  },
  async lock(): Promise<void> {
    return invoke("wallet_lock");
  },
  async unlockStatus(): Promise<UnlockStatus> {
    return invoke("wallet_unlock_status");
  },
  async previewSecret(secret: string): Promise<SecretPreview> {
    return invoke("wallet_preview_secret", { secret });
  },
  async mnemonicWordlist(): Promise<string[]> {
    return invoke("wallet_mnemonic_wordlist");
  },
  async markBackedUp(walletId: string): Promise<WalletData[]> {
    return invoke("wallet_mark_backed_up", { walletId });
  },
  async getPublicKey(walletId: string): Promise<string> {
    return invoke("wallet_get_public_key", { walletId });
  },
  async matchStealthOutputs(
    walletId: string,
    expectAddress: string,
    outputs: StealthScanOutput[],
  ): Promise<StealthMatch[]> {
    return invoke("stealth_match_outputs", { walletId, expectAddress, outputs });
  },
  /** The private key never leaves Rust. */
  async signMessage(walletId: string, message: string): Promise<string> {
    return invoke("wallet_sign_transaction", { walletId, password: "", message });
  },
  async delete(walletId: string): Promise<WalletData[]> {
    return invoke("wallet_delete", { walletId });
  },
  async createAdditional(password: string): Promise<WalletData> {
    return invoke("wallet_create_additional", { password });
  },
  async exportMnemonic(walletId: string, password: string): Promise<string[]> {
    return invoke("wallet_export_mnemonic", { walletId, password });
  },
  async exportPrivateKey(walletId: string, password: string): Promise<string> {
    return invoke("wallet_export_private_key", { walletId, password });
  },
  async verifyPassword(password: string): Promise<void> {
    return invoke("wallet_verify_password", { password });
  },
  async endReveal(): Promise<void> {
    return invoke("wallet_end_reveal");
  },
  async copySecret(walletId: string, kind: "phrase" | "key"): Promise<void> {
    return invoke("wallet_copy_secret", { walletId, kind });
  },
  async clearPastedSecret(text: string): Promise<boolean> {
    return invoke("wallet_clear_pasted_secret", { text });
  },
  async rename(walletId: string, newName: string): Promise<void> {
    return invoke("wallet_rename", { walletId, newName });
  },
  async setActive(walletId: string): Promise<void> {
    return invoke("wallet_set_active", { walletId });
  },
  async reset(): Promise<void> {
    return invoke("wallet_reset");
  },
  async hasPassword(): Promise<boolean> {
    return invoke("wallet_has_password");
  },
  /** A vault with keys but no password opens only once a password is set. */
  async needsPassword(): Promise<boolean> {
    return invoke("wallet_needs_password");
  },
  async setPassword(newPassword: string): Promise<void> {
    return invoke("wallet_change_password", { currentPassword: "", newPassword });
  },
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return invoke("wallet_change_password", { currentPassword, newPassword });
  },
  async removePassword(currentPassword: string): Promise<void> {
    return invoke("wallet_remove_password", { currentPassword });
  },
  async importAddress(address: string): Promise<WalletData> {
    return invoke("wallet_import_address", { address });
  },
  async isHellMode(): Promise<boolean> {
    return invoke("wallet_is_hell_mode");
  },
  async activateHellMode(): Promise<void> {
    return invoke("wallet_activate_hell_mode");
  },
  async finishSeal(walletId: string): Promise<WalletData[]> {
    return invoke("wallet_finish_seal", { walletId });
  },
  async sealWallet(walletId: string): Promise<void> {
    return invoke("wallet_seal_wallet", { walletId });
  },
  async deriveAccount(walletId: string, password: string, hdIndex: number): Promise<WalletData> {
    return invoke("wallet_derive_account", { walletId, password, hdIndex });
  },
  async scanHdAccounts(
    walletId: string,
    password: string,
    maxIndex: number = 20,
  ): Promise<{ accounts: Array<{ index: number; address: string; imported: boolean }> }> {
    return invoke("wallet_scan_hd_accounts", { walletId, password, maxIndex });
  },
};
