import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import { invoke } from "@tauri-apps/api/core";
import OutlineTag from "src/shared/ui/OutlineTag";
import { PlusIcon } from "src/shared/layout/navIcons";
import { useWallet } from "src/contexts/useWallet";
import { NETWORKS, isCustomNetwork, loadCustomNetworks } from "src/services/network/config";
import type { NetworkConfig } from "src/types/network";
import TabLayout from "src/features/settings/components/TabLayout";
import { Group, NetDot, Row, TextAction, Value } from "src/features/settings/components/parts";
import NetworkPanel from "src/features/settings/panels/NetworkPanel";
import NetworkFormPage from "src/features/settings/screens/NetworkFormPage";
import {
  explorerBase,
  isTestnetId,
  netColor,
  netHost,
  netName,
} from "src/features/settings/screens/networkParts";

export default function NetworkSection() {
  const { t } = useTranslation();
  const { networkId, setNetworkId, showMessage } = useWallet();
  const [custom, setCustom] = useState<NetworkConfig[]>(loadCustomNetworks);
  const [form, setForm] = useState<{ editing: NetworkConfig | null } | null>(null);

  const ids = [
    ...Object.keys(NETWORKS).filter((id) => !isCustomNetwork(id)),
    ...custom.map((n) => n.id),
  ];
  const active = NETWORKS[networkId];
  const panel = <NetworkPanel networkId={networkId} ids={ids} />;

  if (form) {
    return (
      <TabLayout panel={panel}>
        <NetworkFormPage
          editing={form.editing}
          custom={custom}
          onSaved={(next, switchTo) => {
            setCustom(next);
            if (switchTo) setNetworkId(switchTo);
            setForm(null);
          }}
          onBack={() => setForm(null)}
        />
      </TabLayout>
    );
  }

  return (
    <TabLayout panel={panel}>
      <Group caption={t("settings.networks")}>
        {ids.map((id) => {
          const own = custom.find((n) => n.id === id);
          return (
            <Row
              key={id}
              selected={id === networkId}
              onClick={() => id !== networkId && setNetworkId(id)}
              lead={<NetDot color={netColor(id)} />}
              label={
                <>
                  {netName(id)}
                  {isTestnetId(id) && <OutlineTag label={t("history.testnet")} />}
                </>
              }
              sub={netHost(id)}
            >
              {own && (
                <TextAction onClick={() => setForm({ editing: own })}>
                  {t("settings.edit")}
                </TextAction>
              )}
            </Row>
          );
        })}
        <Row
          onClick={() => setForm({ editing: null })}
          lead={
            <span className="grid w-2 place-items-center text-content-secondary">
              <PlusIcon size={14} />
            </span>
          }
          label={<span className="text-content-secondary">{t("settings.addNetwork")}</span>}
        />
      </Group>

      {active && (
        <Group caption={t("settings.endpointsOf", { name: netName(networkId) })}>
          <Row label={t("settings.rpcEndpoint")}>
            <span className="max-w-72 truncate">
              <Value>{active.rpcEndpoint ?? active.rpcUrl}</Value>
            </span>
          </Row>
          {active.explorerUrl && (
            <Row label={t("settings.explorer")}>
              <span className="max-w-72 truncate">
                <Value>{explorerBase(active.explorerUrl)}</Value>
              </span>
            </Row>
          )}
        </Group>
      )}

      <Group caption={t("settings.logs")}>
        <Row
          label={t("settings.openLogs")}
          onClick={() =>
            void invoke("open_log_folder").catch(() =>
              showMessage("error", t("settings.logsUnavailable")),
            )
          }
        >
          <Value chevron />
        </Row>
      </Group>
    </TabLayout>
  );
}
