import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { isWindowsHello } from "src/features/security/onboarding/biometricLabel";
import i18n from "src/i18n";
import { logger } from "src/lib/logger";
import { announce } from "src/services/notices/noticeNative";
import { APP } from "src/services/notices/notifications";

/**
 * Touch ID and Windows Hello unlock, both in src-tauri/src/wallet/touch_id.rs. On macOS the vault
 * password sits in a keychain item of our own that only a current fingerprint opens: the prompt
 * never offers the Mac login password, and a fingerprint added or removed turns Touch ID off. On
 * Windows it is sealed under a Windows Hello key and turns off when Windows Hello is reset. An
 * unsigned dev build without keychain access keeps the dev store; a release build never reads it
 * and deletes one an older build left behind.
 */

export enum BiometryType {
  None = 0,
  Auto = 1,
  TouchID = 2,
  FaceID = 3,
}

const LEGACY_FILE = "biometric.json";
const LEGACY_PWD_KEY = "biometric_pwd";
const LEGACY_ENC_KEY = "biometric_enc_key";

const devStoreAllowed = () => import.meta.env.DEV;

let _legacyStore: Store | null = null;
async function legacyStore(): Promise<Store> {
  if (!_legacyStore) {
    _legacyStore = await load(LEGACY_FILE, { defaults: {}, autoSave: true });
  }
  return _legacyStore;
}

async function hasLegacy(): Promise<boolean> {
  if (!devStoreAllowed()) return false;
  try {
    const store = await legacyStore();
    const enc = await store.get<string>(LEGACY_ENC_KEY);
    const pwd = await store.get<string>(LEGACY_PWD_KEY);
    return !!enc && !!pwd;
  } catch {
    return false;
  }
}

async function legacyDecryptPassword(): Promise<string | null> {
  if (!devStoreAllowed()) return null;
  try {
    const store = await legacyStore();
    const encKeyB64 = await store.get<string>(LEGACY_ENC_KEY);
    const pwdB64 = await store.get<string>(LEGACY_PWD_KEY);
    if (!encKeyB64 || !pwdB64) return null;
    const rawKey = Uint8Array.from(atob(encKeyB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const combined = Uint8Array.from(atob(pwdB64), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plain);
  } catch (err) {
    logger.error("biometric", "legacy decrypt failed:", err);
    return null;
  }
}

async function legacyWritePassword(password: string): Promise<void> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(password)),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);
  const store = await legacyStore();
  await store.set(LEGACY_ENC_KEY, btoa(String.fromCharCode(...rawKey)));
  await store.set(LEGACY_PWD_KEY, btoa(String.fromCharCode(...combined)));
  await store.save();
}

async function purgeLegacy(): Promise<void> {
  try {
    const store = await legacyStore();
    await store.delete(LEGACY_PWD_KEY);
    await store.delete(LEGACY_ENC_KEY);
    await store.save();
  } catch (err) {
    logger.warn("biometric", "legacy purge failed:", err);
  }
}

async function purgeReleaseLegacy(): Promise<void> {
  if (devStoreAllowed()) return;
  try {
    const store = await legacyStore();
    const left =
      (await store.get<string>(LEGACY_PWD_KEY)) != null ||
      (await store.get<string>(LEGACY_ENC_KEY)) != null;
    if (!left) return;
  } catch {
    return;
  }
  await purgeLegacy();
  logger.info("biometric", "removed a dev store password left by an older build");
}

let keystoreUnavailable = false;

export class BiometryChangedError extends Error {
  constructor() {
    super("biometryChanged");
    this.name = "BiometryChangedError";
  }
}

const isUnsupported = (err: unknown) => String(err).includes("unsupported");

interface TouchIdState {
  enabled: boolean;
  turnedOff: boolean;
}

const storeSecret = (password: string) => invoke<void>("touch_id_store", { password });

const fingerprint = (reason: string, cancelTitle: string) =>
  invoke<void>("touch_id_prompt", { reason, cancelTitle });

const biometricCancel = () => i18n.t("biometric.cancel");
export const biometricUsePassword = () => i18n.t("biometric.usePassword");

async function migrateLegacyIfNeeded(): Promise<void> {
  if (!devStoreAllowed()) return purgeReleaseLegacy();
  if (keystoreUnavailable) return;
  if (!(await hasLegacy())) return;
  const pwd = await legacyDecryptPassword();
  if (!pwd) {
    await purgeLegacy();
    return;
  }
  try {
    await storeSecret(pwd);
    await purgeLegacy();
    logger.info("biometric", "migrated legacy secret into OS keystore");
  } catch (err) {
    if (String(err).includes("-34018")) {
      keystoreUnavailable = true;
      logger.info(
        "biometric",
        "keystore unavailable (unsigned dev binary, -34018) - keeping the legacy store; run npm run tauri:dev or scripts/sign-dev.sh for the signed keychain path",
      );
      return;
    }
    logger.error("biometric", "keystore migration failed; keeping legacy for retry:", err);
  }
}

export const biometricService = {
  async isAvailable(): Promise<{ available: boolean; type: BiometryType }> {
    try {
      const available = await invoke<boolean>("touch_id_available");
      const type = isWindowsHello() ? BiometryType.Auto : BiometryType.TouchID;
      return { available, type: available ? type : BiometryType.None };
    } catch (err) {
      if (!isUnsupported(err)) logger.error("biometric", "availability check failed:", err);
      return { available: false, type: BiometryType.None };
    }
  },

  async isEnabled(): Promise<boolean> {
    await purgeReleaseLegacy();
    try {
      const state = await invoke<TouchIdState>("touch_id_state");
      return state.enabled || (await hasLegacy());
    } catch {
      return hasLegacy();
    }
  },

  async wasTurnedOff(): Promise<boolean> {
    try {
      return (await invoke<TouchIdState>("touch_id_state")).turnedOff;
    } catch {
      return false;
    }
  },

  async enable(password: string): Promise<void> {
    logger.debug("biometric", "enable: starting authenticate...");
    try {
      await fingerprint("Enable biometric unlock for 0xio Desktop", biometricCancel());
      logger.info("biometric", "enable: authenticate succeeded");
    } catch (err) {
      logger.error("biometric", "enable: authenticate failed:", JSON.stringify(err), err);
      throw new Error(
        `Biometric authentication failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
      );
    }

    try {
      await storeSecret(password);
      await purgeLegacy();
      logger.info("biometric", "enable: secret stored in OS keystore");
    } catch (err) {
      if (import.meta.env.DEV && String(err).includes("-34018")) {
        keystoreUnavailable = true;
        await legacyWritePassword(password);
        logger.info("biometric", "enable: dev build without keychain access, using the dev store");
        return;
      }
      logger.error("biometric", "enable: keystore write failed:", err);
      throw new Error("Failed to store credentials in the OS keystore");
    }
  },

  async unlock(reason = "Unlock 0xio Desktop", cancelTitle = biometricCancel()): Promise<string> {
    await migrateLegacyIfNeeded();

    try {
      return await invoke<string>("touch_id_read", { reason, cancelTitle });
    } catch (err) {
      const why = String(err);
      if (why.includes("biometryChanged")) {
        logger.info("biometric", "fingerprints or Windows Hello changed, unlock turned off");
        announce({
          id: `touchId:${Date.now()}`,
          kind: "touchId",
          scope: APP,
          title: isWindowsHello() ? "notices.windowsHelloOff" : "notices.touchIdOff",
          action: { kind: "settings", tab: "security" },
        });
        throw new BiometryChangedError();
      }
      if (!why.includes("itemNotFound") && !why.includes("-34018") && !isUnsupported(err)) {
        logger.error("biometric", "keystore unlock failed:", why);
        throw err;
      }
    }

    const legacy = await legacyDecryptPassword();
    if (legacy) {
      await fingerprint(reason, cancelTitle);
      return legacy;
    }

    throw new Error("No biometric credentials stored");
  },

  async disable(): Promise<void> {
    logger.debug("biometric", "disable: removing stored data...");
    try {
      await invoke("touch_id_clear");
    } catch (err) {
      if (!isUnsupported(err)) logger.warn("biometric", "disable: clear failed:", err);
    }
    await purgeLegacy();
    logger.info("biometric", "disable: done");
  },
};
