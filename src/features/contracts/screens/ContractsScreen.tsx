import { useState, useCallback } from "react";
import { useTranslation } from "src/i18n/react";
import { Screen, PageTitle, PillTabs } from "src/shared/ui/flat";
import { useWallet } from "src/contexts/useWallet";
import { NETWORKS } from "src/services/network/config";
import { useContractRegistry } from "src/features/contracts/hooks/useContractRegistry";
import CompileDeployTab from "src/features/contracts/components/CompileDeployTab";
import ContractsHub from "src/features/contracts/components/ContractsHub";
import TokensTab from "src/features/contracts/components/TokensTab";

export default function ContractsScreen() {
  const { t } = useTranslation();
  const { networkId } = useWallet();
  const privacyEnabled = NETWORKS[networkId]?.supportsPrivacy ?? false;
  const [activeTab, setActiveTab] = useState("deploy");
  const [prefillAddress, setPrefillAddress] = useState("");
  const registry = useContractRegistry();

  const handleInteractWith = useCallback((address: string) => {
    setPrefillAddress(address);
    setActiveTab("contracts");
  }, []);

  if (!privacyEnabled) {
    return (
      <Screen>
        <PageTitle title={t("contracts.notAvailable")} />
      </Screen>
    );
  }

  const tabs = [
    { id: "deploy", label: t("contracts.compile.build") },
    {
      id: "contracts",
      label: t("contracts.hub", "Contracts"),
      badge: registry.contracts.length || undefined,
    },
    { id: "tokens", label: t("contracts.tokens") },
  ];

  return (
    <Screen wide>
      <PageTitle
        title={t("contracts.title")}
        right={<PillTabs tabs={tabs} value={activeTab} onChange={setActiveTab} />}
      />

      {/* The IDE (deploy tab) wants the whole window, so the workspace stays full width. It stays
          mounted under the other tabs so unsaved buffers and the chat survive a look elsewhere. */}
      <div className="flex-1 min-h-0 w-full pt-3.5 flex flex-col overflow-hidden">
        <div
          className={`flex-1 min-h-0 w-full ${activeTab === "tokens" ? "overflow-y-auto scrollbar-hide" : "overflow-hidden"}`}
          style={{ scrollbarWidth: "none" }}
        >
          <div className={activeTab === "deploy" ? "h-full" : "hidden"}>
            <CompileDeployTab registry={registry} onInteract={handleInteractWith} />
          </div>
          {activeTab === "contracts" && (
            <ContractsHub
              registry={registry}
              prefillAddress={prefillAddress}
              onPrefillConsumed={() => setPrefillAddress("")}
              onOpenInBuild={() => setActiveTab("deploy")}
            />
          )}
          {activeTab === "tokens" && <TokensTab />}
        </div>
      </div>
    </Screen>
  );
}
