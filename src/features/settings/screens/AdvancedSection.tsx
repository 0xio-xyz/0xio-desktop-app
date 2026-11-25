import React, { useRef, useState } from "react";
import { useLocation, useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { invoke } from "@tauri-apps/api/core";
import Modal from "src/shared/ui/Modal";
import Input from "src/shared/ui/Input";
import { Action } from "src/shared/ui/flat";
import { useWallet } from "src/contexts/useWallet";
import { walletBridge } from "src/services/wallet/walletBridge";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { biometricService } from "src/services/wallet/biometricService";
import { getProviderLabel, isAiReady, useAiConfig } from "src/services/ai/aiSuggestionService";
import {
  PVAC_CACHE_TTL_KEY,
  pvacCacheTtlMinutes,
} from "src/features/privacy/services/privacyService";
import TabLayout from "src/features/settings/components/TabLayout";
import { Group, PillSelect, Row, TextAction, Value } from "src/features/settings/components/parts";
import AdvancedPanel from "src/features/settings/panels/AdvancedPanel";
import AiAssistantPage from "src/features/settings/screens/AiAssistantPage";
import {
  PROOF_THREAD_CHOICES,
  PVAC_TTL_MINUTES,
  RPC_TIMEOUT_SECONDS,
  TX_TIMEOUT_SECONDS,
} from "src/features/settings/screens/constants";
import { clearCaches } from "src/features/settings/services/caches";

function savedNumber(key: string, fallback: number): number {
  const saved = parseInt(localStorage.getItem(key) ?? "", 10);
  return Number.isFinite(saved) ? saved : fallback;
}

function exportSettings() {
  const data: Record<string, string> = {};
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("0xio_") || key === "app_language") {
      data[key] = localStorage.getItem(key) || "";
    }
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `0xio-settings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AdvancedSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showMessage, setIsInitialized, setIsLocked } = useWallet();
  const importRef = useRef<HTMLInputElement>(null);
  const { search } = useLocation();
  const [page, setPage] = useState<"ai" | null>(() =>
    new URLSearchParams(search).get("page") === "ai" ? "ai" : null,
  );
  const aiConfig = useAiConfig();
  const [cacheVersion, setCacheVersion] = useState(0);
  const [pvacTtl, setPvacTtl] = useState(pvacCacheTtlMinutes);
  const [proofThreads, setProofThreads] = useState(() => savedNumber("0xio_proof_threads", 0));
  const [txTimeout, setTxTimeout] = useState(() => savedNumber("0xio_tx_timeout_seconds", 120));
  const [rpcTimeout, setRpcTimeout] = useState(() => savedNumber("0xio_rpc_timeout_seconds", 30));
  const [resetOpen, setResetOpen] = useState(false);
  const [resetInput, setResetInput] = useState("");
  const [resetting, setResetting] = useState(false);

  const store = (key: string, value: number) => localStorage.setItem(key, String(value));
  const seconds = (s: number) => t("settings.seconds", { count: s });

  const importSettings = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        if (typeof data !== "object" || data === null) throw new Error("invalid");
        let count = 0;
        for (const [key, value] of Object.entries(data)) {
          if ((key.startsWith("0xio_") || key === "app_language") && typeof value === "string") {
            localStorage.setItem(key, value);
            count++;
          }
        }
        if (count === 0) throw new Error("no valid keys");
        showMessage("success", t("advanced.settingsImported"));
        setTimeout(() => window.location.reload(), 1000);
      } catch {
        showMessage("error", t("advanced.importFailed"));
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const reset = async () => {
    if (resetInput !== "RESET") return;
    setResetting(true);
    try {
      pvacBridge.destroy().catch(() => {});
      await biometricService.disable().catch(() => {});
      await walletBridge.reset();
      setIsInitialized(false);
      setIsLocked(false);
      setResetOpen(false);
      navigate("/onboarding");
    } catch (err: unknown) {
      showMessage("error", err instanceof Error ? err.message : t("settings.resetFailed"));
    } finally {
      setResetting(false);
    }
  };

  const panel = <AdvancedPanel cacheVersion={cacheVersion} />;

  if (page === "ai") {
    return (
      <TabLayout panel={panel}>
        <AiAssistantPage onBack={() => setPage(null)} />
      </TabLayout>
    );
  }

  return (
    <TabLayout panel={panel}>
      <Group caption={t("settings.performance")}>
        <Row label={t("advanced.pvacCacheTTL")}>
          <PillSelect
            label={t("advanced.pvacCacheTTL")}
            value={pvacTtl}
            onChange={(m) => {
              setPvacTtl(m);
              store(PVAC_CACHE_TTL_KEY, m);
            }}
            options={PVAC_TTL_MINUTES.map((m) => ({
              value: m,
              label: t("settings.minutes", { count: m }),
            }))}
          />
        </Row>
        <Row label={t("advanced.proofThreads")}>
          <PillSelect
            label={t("advanced.proofThreads")}
            value={proofThreads}
            onChange={(threads) => {
              setProofThreads(threads);
              store("0xio_proof_threads", threads);
              invoke("set_proof_threads", { threads }).catch(() => {});
            }}
            options={PROOF_THREAD_CHOICES.map((n) => ({
              value: n,
              label: n === 0 ? t("advanced.proofThreadsAuto") : String(n),
            }))}
          />
        </Row>
        <Row label={t("advanced.txTimeout")}>
          <PillSelect
            label={t("advanced.txTimeout")}
            value={txTimeout}
            onChange={(s) => {
              setTxTimeout(s);
              store("0xio_tx_timeout_seconds", s);
            }}
            options={TX_TIMEOUT_SECONDS.map((s) => ({ value: s, label: seconds(s) }))}
          />
        </Row>
        <Row label={t("advanced.rpcTimeout")}>
          <PillSelect
            label={t("advanced.rpcTimeout")}
            value={rpcTimeout}
            onChange={(s) => {
              setRpcTimeout(s);
              store("0xio_rpc_timeout_seconds", s);
            }}
            options={RPC_TIMEOUT_SECONDS.map((s) => ({ value: s, label: seconds(s) }))}
          />
        </Row>
      </Group>

      <Group caption={t("settings.tools")}>
        <Row
          label={t("settings.debugConsole")}
          onClick={() =>
            window.dispatchEvent(new CustomEvent("toggle-debug-console", { detail: "open" }))
          }
        >
          <Value chevron />
        </Row>
        <Row label={t("advanced.clearCache")}>
          <TextAction
            onClick={() => {
              clearCaches();
              setCacheVersion((v) => v + 1);
              showMessage("success", t("advanced.cacheCleared"));
            }}
          >
            {t("settings.clear")}
          </TextAction>
        </Row>
        <Row label={t("settings.settingsFile")}>
          <TextAction
            onClick={() => {
              exportSettings();
              showMessage("success", t("advanced.settingsExported"));
            }}
          >
            {t("settings.export")}
          </TextAction>
          <TextAction onClick={() => importRef.current?.click()}>{t("common.import")}</TextAction>
          <input
            ref={importRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={importSettings}
          />
        </Row>
        <Row label={t("settings.aiAssistant")} onClick={() => setPage("ai")}>
          <Value chevron>
            {isAiReady(aiConfig) ? getProviderLabel(aiConfig.provider) : t("settings.off")}
          </Value>
        </Row>
      </Group>

      <Group caption={t("settings.dangerZone")}>
        <Row
          negative
          label={t("settings.resetWallet")}
          onClick={() => {
            setResetInput("");
            setResetOpen(true);
          }}
        />
      </Group>

      <Modal
        isOpen={resetOpen}
        onClose={() => setResetOpen(false)}
        title={t("settings.resetWallet")}
        hideClose
        look="ext"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void reset();
          }}
        >
          <p className="text-meta font-semibold text-content">{t("settings.resetIrreversible")}</p>
          <p className="text-meta leading-relaxed text-content-secondary">
            {t("settings.resetDetails")}
          </p>
          <Input
            label={t("settings.typeResetToConfirm")}
            value={resetInput}
            onChange={(e) => setResetInput(e.target.value)}
            placeholder="RESET"
          />
          <div className="flex gap-2.5">
            <Action
              type="button"
              weight="raised"
              full
              onClick={() => setResetOpen(false)}
              disabled={resetting}
            >
              {t("common.reject")}
            </Action>
            <Action
              type="submit"
              weight="danger"
              full
              disabled={resetInput !== "RESET" || resetting}
            >
              {t("settings.deleteEverything")}
            </Action>
          </div>
        </form>
      </Modal>
    </TabLayout>
  );
}
