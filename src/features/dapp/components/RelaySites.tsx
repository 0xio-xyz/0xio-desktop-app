import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { useWallet } from "src/contexts/useWallet";
import { networkShortName } from "src/shared/layout/WalletMenu";
import {
  Group,
  KV,
  PanelCaption,
  PillAction,
  Row,
  Segmented,
  TextAction,
  Value,
} from "src/features/settings/components/parts";
import { recordKey } from "src/features/dapp/hooks/useRelaySites";
import { DIRECT, relaySitesOn, type RelayRecord } from "src/features/dapp/services/relaySites";
import { shortDate } from "src/lib/dates";

export const RELAY_NETWORKS = ["mainnet", "devnet"] as const;
export type RelayNetwork = (typeof RELAY_NETWORKS)[number];

export const browserLabel = (b: string) => (b === "firefox" ? "Firefox" : "Chrome");

const isDirect = (r: RelayRecord) => r.client_id === DIRECT;

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const middle = (a: string) => (a.length > 20 ? `${a.slice(0, 8)}...${a.slice(-8)}` : a);

function SiteMark({ origin }: { origin: string }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-highlight text-[0.75rem] font-semibold text-content-secondary uppercase"
    >
      {hostOf(origin)
        .replace(/^www\./, "")
        .charAt(0)}
    </span>
  );
}

function useWalletName(r: RelayRecord): string {
  const { wallets } = useWallet();
  return wallets.find((w) => w.address === r.address)?.name ?? r.wallet_name;
}

function WalletChip({ record }: { record: RelayRecord }) {
  const name = useWalletName(record);
  return (
    <span className="mr-1.5 inline-flex items-center gap-2">
      <WalletAvatar address={record.address} size={18} />
      <Value>{name}</Value>
    </span>
  );
}

export function RelaySitesGroup({
  list,
  network,
  onNetwork,
  selected,
  onSelect,
  onDisconnect,
}: {
  list: RelayRecord[];
  network: RelayNetwork;
  onNetwork: (n: RelayNetwork) => void;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onDisconnect: (r: RelayRecord) => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<string | null>(null);
  const sites = relaySitesOn(network, list);
  return (
    <Group
      caption={t("connectedSites.title")}
      right={
        <Segmented
          label={t("relaySites.networks")}
          value={network}
          onChange={(n) => {
            setConfirming(null);
            onNetwork(n);
          }}
          options={RELAY_NETWORKS.map((n) => ({ value: n, label: networkShortName(n) }))}
        />
      }
    >
      {sites.length === 0 && (
        <Row
          label={<span className="font-normal text-content-muted">{t("relaySites.none")}</span>}
        />
      )}
      {sites.map((r) => {
        const key = recordKey(r);
        return (
          <Row
            key={key}
            lead={<SiteMark origin={r.origin} />}
            label={hostOf(r.origin)}
            sub={
              isDirect(r)
                ? t("relay.direct")
                : t("relaySites.via", { browser: browserLabel(r.browser) })
            }
            selected={selected === key}
            onClick={() => onSelect(selected === key ? null : key)}
          >
            {confirming === key ? (
              <>
                <TextAction onClick={() => setConfirming(null)}>{t("common.cancel")}</TextAction>
                <TextAction
                  onClick={() => {
                    setConfirming(null);
                    if (selected === key) onSelect(null);
                    onDisconnect(r);
                  }}
                >
                  <span className="text-danger">{t("common.confirm")}</span>
                </TextAction>
              </>
            ) : (
              <>
                <WalletChip record={r} />
                <TextAction onClick={() => setConfirming(key)}>
                  {t("connectedSites.disconnect")}
                </TextAction>
              </>
            )}
          </Row>
        );
      })}
    </Group>
  );
}

export function RelaySitePanel({
  record,
  waiting,
  onDisconnect,
}: {
  record: RelayRecord;
  waiting: number;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const name = useWalletName(record);
  const last = record.last_request ?? null;
  return (
    <>
      <PanelCaption>{t("relaySites.site")}</PanelCaption>
      <div className="mt-3 mb-2 flex min-w-0 items-center gap-3">
        <SiteMark origin={record.origin} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-body font-semibold text-content">
            {hostOf(record.origin)}
          </span>
          <span className="truncate font-mono text-meta text-content-muted">{record.origin}</span>
        </span>
      </div>
      <KV
        label={t("relay.wallet")}
        value={
          <span className="inline-flex items-center gap-2">
            <WalletAvatar address={record.address} size={18} />
            {name}
          </span>
        }
        sub={<span className="font-mono">{middle(record.address)}</span>}
      />
      <KV label={t("relay.network")} value={networkShortName(record.network)} />
      {isDirect(record) ? (
        <KV label={t("relay.connection")} value={t("relay.direct")} />
      ) : (
        <KV
          label={t("relay.via")}
          value={t("relay.viaExtension", { browser: browserLabel(record.browser) })}
        />
      )}
      <KV label={t("relaySites.connected")} value={shortDate(record.connected_at)} />
      <KV
        label={t("relaySites.lastRequest")}
        value={
          last
            ? `${shortDate(last)} ${new Date(last).toTimeString().slice(0, 5)}`
            : t("relaySites.none")
        }
      />
      <KV label={t("relaySites.waiting")} value={waiting} />
      <div className="mt-4 flex justify-center">
        <PillAction onClick={onDisconnect}>{t("connectedSites.disconnect")}</PillAction>
      </div>
    </>
  );
}

export function RemovingPanel({ name, sites }: { name: string; sites: RelayRecord[] }) {
  const { t } = useTranslation();
  return (
    <>
      <PanelCaption>{t("relaySites.removing", { name })}</PanelCaption>
      <p className="mt-3 mb-2 text-meta leading-normal text-content-secondary">
        {t("relaySites.removingNote")}
      </p>
      {sites.map((r) => (
        <KV
          key={recordKey(r)}
          lead={<SiteMark origin={r.origin} />}
          label={hostOf(r.origin)}
          value={networkShortName(r.network)}
          muted
        />
      ))}
    </>
  );
}
