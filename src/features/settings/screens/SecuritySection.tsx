import { useState } from "react";
import { useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import PasswordPrompt from "src/features/wallet/components/PasswordPrompt";
import PairedApps from "src/features/dapp/components/PairedApps";
import { usePairedApps } from "src/features/dapp/hooks/usePairedApps";
import { useDappSites } from "src/features/dapp/hooks/useDappSites";
import {
  recordKey,
  useRelaySites,
  useWaitingSiteRequests,
} from "src/features/dapp/hooks/useRelaySites";
import {
  RELAY_NETWORKS,
  RelaySitePanel,
  RelaySitesGroup,
  RemovingPanel,
  browserLabel,
  type RelayNetwork,
} from "src/features/dapp/components/RelaySites";
import { relaySitesOn } from "src/features/dapp/services/relaySites";
import { networkShortName } from "src/shared/layout/WalletMenu";
import { useWallet } from "src/contexts/useWallet";
import { backupLink, walletNeedsBackup, walletSecrets } from "src/hooks/wallet/useNeedsBackup";
import { walletBridge } from "src/services/wallet/walletBridge";
import { biometricService } from "src/services/wallet/biometricService";
import { isWindowsHello } from "src/features/security/onboarding/biometricLabel";
import { logger } from "src/lib/logger";
import TabLayout from "src/features/settings/components/TabLayout";
import {
  CaptionWallet,
  Group,
  StatusPanel,
  PillSelect,
  Row,
  TextAction,
  Toggle,
  Value,
} from "src/features/settings/components/parts";
import { biometricName, useSecurityState } from "src/features/settings/hooks/useSecurityState";
import SecurityPanel from "src/features/settings/panels/SecurityPanel";
import {
  HellModeDialog,
  PasswordDialog,
  type PasswordMode,
} from "src/features/settings/screens/SecurityDialogs";
import { AUTO_LOCK_OPTIONS } from "src/features/settings/screens/constants";

const AUTO_LOCK_KEY = "0xio_auto_lock_minutes";

function removingName(name: string, origin: string): string {
  const browser = browserLabel(origin.startsWith("moz-extension://") ? "firefox" : "chrome");
  return name.includes(browser) ? name : `${name} (${browser})`;
}

export default function SecuritySection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeWallet, wallets, networkId, showMessage } = useWallet();
  const security = useSecurityState();
  const pairing = usePairedApps();
  const sites = useDappSites(networkId);
  const relay = useRelaySites();
  const waiting = useWaitingSiteRequests();
  const [relayNet, setRelayNet] = useState<RelayNetwork>(
    RELAY_NETWORKS.includes(networkId as RelayNetwork) ? (networkId as RelayNetwork) : "mainnet",
  );
  const [pickedSite, setPickedSite] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const sitesOf = (key: string) => relay.list.filter((r) => r.client_id === key);
  const picked = relay.list.find((r) => recordKey(r) === pickedSite) ?? null;
  const removingApp = pairing.list?.find((p) => p.key === removing) ?? null;
  const [passwordMode, setPasswordMode] = useState<PasswordMode | null>(null);
  const [hellOpen, setHellOpen] = useState(false);
  const [biometricPrompt, setBiometricPrompt] = useState<"enable" | "disable" | null>(null);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [autoLock, setAutoLock] = useState(() => {
    const saved = localStorage.getItem(AUTO_LOCK_KEY);
    return saved ? parseInt(saved, 10) : 15;
  });
  const [tokenDiscovery, setTokenDiscovery] = useState(
    () => localStorage.getItem("0xio_token_discovery") === "true",
  );

  const { hasPassword, isHellMode, biometric } = security;
  const bioName = biometricName(biometric?.type);
  const secrets = isHellMode ? [] : walletSecrets(activeWallet);
  const needsBackup = walletNeedsBackup(activeWallet) && !isHellMode;
  const autoLockOptions = AUTO_LOCK_OPTIONS.map((o) => ({
    value: o.value,
    label: o.value === 0 ? t("settings.autoLockNever") : t("settings.minutes", { count: o.value }),
  }));

  const toggleBiometric = async (on: boolean) => {
    if (on) {
      setBiometricPrompt("enable");
      return;
    }
    setBiometricBusy(true);
    try {
      await biometricService.unlock(t("settings.biometricOffReason", { name: bioName }));
    } catch {
      setBiometricBusy(false);
      setBiometricPrompt("disable");
      return;
    }
    try {
      await biometricService.disable();
      security.setBiometricEnabled(false);
    } catch (err: unknown) {
      showMessage("error", err instanceof Error ? err.message : t("settings.biometricFailed"));
    } finally {
      setBiometricBusy(false);
    }
  };

  const confirmBiometric = async (pw: string) => {
    const action = biometricPrompt;
    setBiometricBusy(true);
    setBiometricPrompt(null);
    try {
      await walletBridge.unlock(pw);
      if (action === "enable") {
        await biometricService.enable(pw);
        security.setBiometricEnabled(true);
      } else {
        await biometricService.disable();
        security.setBiometricEnabled(false);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
      logger.error("settings", `biometric ${action} error:`, err);
      showMessage("error", msg || t("settings.biometricFailed"));
    } finally {
      setBiometricBusy(false);
    }
  };

  const panel = removingApp ? (
    <StatusPanel>
      <RemovingPanel
        name={removingName(removingApp.name, removingApp.origin)}
        sites={sitesOf(removingApp.key)}
      />
    </StatusPanel>
  ) : picked ? (
    <StatusPanel>
      <RelaySitePanel
        record={picked}
        waiting={waiting ?? 0}
        onDisconnect={() => {
          setPickedSite(null);
          void relay.disconnect(picked);
        }}
      />
    </StatusPanel>
  ) : (
    <SecurityPanel
      security={security}
      autoLockLabel={autoLockOptions.find((o) => o.value === autoLock)?.label ?? ""}
      pairing={pairing}
      siteCount={sites.length + relaySitesOn(networkId, relay.list).length}
      waiting={waiting}
    />
  );

  return (
    <TabLayout panel={panel}>
      <Group caption={t("settings.unlock")}>
        <Row label={t("settings.autoLock")}>
          <PillSelect
            label={t("settings.autoLock")}
            value={autoLock}
            onChange={(m) => {
              setAutoLock(m);
              localStorage.setItem(AUTO_LOCK_KEY, String(m));
            }}
            options={autoLockOptions}
          />
        </Row>
        <Row label={t("settings.passwordLabel")}>
          {hasPassword ? (
            <>
              <TextAction onClick={() => setPasswordMode("change")}>
                {t("settings.change")}
              </TextAction>
              {!isHellMode && wallets.every((w) => w.wallet_type === "watch") && (
                <TextAction onClick={() => setPasswordMode("remove")}>
                  {t("security.remove")}
                </TextAction>
              )}
            </>
          ) : (
            <TextAction onClick={() => setPasswordMode("set")}>
              {t("settings.setPassword")}
            </TextAction>
          )}
        </Row>
        <Row
          label={bioName}
          sub={
            biometric?.turnedOff && !biometric.enabled
              ? t(isWindowsHello() ? "biometric.helloReset" : "biometric.fingerprintsChanged", {
                  name: bioName,
                })
              : undefined
          }
        >
          {biometric && !biometric.available ? (
            <Value muted>{t("settings.notAvailable")}</Value>
          ) : (
            <Toggle
              on={!!biometric?.enabled}
              label={bioName}
              disabled={!biometric || biometricBusy}
              onChange={(on) => void toggleBiometric(on)}
            />
          )}
        </Row>
      </Group>

      <PairedApps
        pairing={pairing}
        sitesOf={sitesOf}
        removing={removing}
        onRemoving={(key) => {
          setPickedSite(null);
          setRemoving(key);
        }}
      />

      <RelaySitesGroup
        list={relay.list}
        network={relayNet}
        onNetwork={(n) => {
          setPickedSite(null);
          setRelayNet(n);
        }}
        selected={pickedSite}
        onSelect={(key) => {
          setRemoving(null);
          setPickedSite(key);
        }}
        onDisconnect={(r) => void relay.disconnect(r)}
      />

      <Group
        caption={t("settings.keys")}
        right={
          activeWallet && (
            <CaptionWallet>
              <WalletAvatar address={activeWallet.address} size={18} />
              {activeWallet.name}
            </CaptionWallet>
          )
        }
      >
        {secrets.map((kind) => (
          <Row
            key={kind}
            label={t(kind === "phrase" ? "secret.phrase" : "secret.key")}
            onClick={() => activeWallet && navigate(backupLink(activeWallet.id, kind))}
          >
            <Value chevron>
              {needsBackup && kind === secrets[0] ? t("settings.notBackedUp") : undefined}
            </Value>
          </Row>
        ))}
        <Row label={t("settings.hellMode")}>
          {isHellMode ? (
            <Value muted>{t("settings.on")}</Value>
          ) : (
            <TextAction onClick={() => setHellOpen(true)}>{t("settings.activate")}</TextAction>
          )}
        </Row>
      </Group>

      <Group caption={t("settings.privacy")}>
        <Row label={t("connectedSites.title")} onClick={() => navigate("/connected-sites")}>
          <Value chevron>
            {t("settings.sitesOn", { count: sites.length, network: networkShortName(networkId) })}
          </Value>
        </Row>
        <Row label={t("settings.tokenDiscovery")}>
          <Toggle
            on={tokenDiscovery}
            label={t("settings.tokenDiscovery")}
            onChange={(on) => {
              setTokenDiscovery(on);
              localStorage.setItem("0xio_token_discovery", String(on));
            }}
          />
        </Row>
      </Group>

      <PasswordDialog
        mode={passwordMode}
        security={security}
        onClose={() => setPasswordMode(null)}
      />
      <HellModeDialog open={hellOpen} security={security} onClose={() => setHellOpen(false)} />
      {biometricPrompt && (
        <PasswordPrompt
          isOpen
          onSubmit={(pw: string) => void confirmBiometric(pw)}
          onCancel={() => setBiometricPrompt(null)}
          error=""
        />
      )}
    </TabLayout>
  );
}
