import { useTranslation } from "src/i18n/react";
import OutlineTag from "src/shared/ui/OutlineTag";
import { NETWORKS } from "src/services/network/config";
import {
  Figure,
  KV,
  Live,
  NetDot,
  PanelCaption,
  StatusPanel,
} from "src/features/settings/components/parts";
import {
  useChainHead,
  useNetworkPings,
  useRpcTimings,
} from "src/features/settings/hooks/useLiveInfo";
import {
  explorerBase,
  hostOf,
  isTestnetId,
  netColor,
  netName,
} from "src/features/settings/screens/networkParts";

const BAR_SLOTS = 24;
const BAR_H = 30;

function Bars({ values }: { values: readonly number[] }) {
  const max = Math.max(1, ...values);
  const empty = BAR_SLOTS - values.length;
  return (
    <div aria-hidden="true" className="flex h-7.5 items-end gap-1">
      {values.map((v, i) => (
        <i
          key={i}
          className="block w-1.75 rounded-xs bg-content-muted transition-[height] duration-250 ease-out"
          style={{ height: Math.max(3, Math.round((v / max) * BAR_H)) }}
        />
      ))}
      {Array.from({ length: Math.max(0, empty) }, (_, i) => (
        <i key={`e${i}`} className="block h-0.75 w-1.75 rounded-xs bg-surface-highlight" />
      ))}
    </div>
  );
}

export default function NetworkPanel({ networkId, ids }: { networkId: string; ids: string[] }) {
  const { t, i18n } = useTranslation();
  const head = useChainHead(networkId);
  const timings = useRpcTimings(networkId);
  const others = ids.filter((id) => id !== networkId);
  const pings = useNetworkPings(others);
  const net = NETWORKS[networkId];
  const latency = timings.length ? timings[timings.length - 1] : null;
  const fmt = new Intl.NumberFormat(i18n.language);

  const status = head.isError ? t("settings.notReachable") : head.data ? t("settings.live") : null;

  return (
    <StatusPanel>
      <PanelCaption right={<Live value={status} width="w-8" />}>
        <NetDot color={netColor(networkId)} />
        {netName(networkId)}
      </PanelCaption>
      <div className="@container mt-5">
        <div className="grid grid-cols-1 gap-4.5 @xs:grid-cols-2">
          <Figure
            label={t("settings.latestEpoch")}
            value={
              <Live
                value={head.data ? fmt.format(head.data) : head.isError ? "-" : null}
                stale={head.isFetching && !!head.data}
                width="w-28"
              />
            }
          />
          <Figure
            label={t("settings.latency")}
            value={<Live value={latency ?? (head.isError ? "-" : null)} width="w-12" />}
            unit={latency !== null ? "ms" : undefined}
          />
        </div>
      </div>
      <div className="mt-4.5 mb-2.5">
        <Bars values={timings} />
      </div>
      {net && <KV label={t("settings.rpc")} value={hostOf(net.rpcEndpoint ?? net.rpcUrl)} />}
      {net?.explorerUrl && (
        <KV label={t("settings.explorer")} value={hostOf(explorerBase(net.explorerUrl))} />
      )}
      <PanelCaption className="mt-4 mb-0.5">{t("settings.allNetworks")}</PanelCaption>
      {ids.map((id) => {
        const ms = id === networkId ? latency : pings[others.indexOf(id)]?.data;
        const pending =
          id === networkId
            ? latency === null && head.isPending
            : pings[others.indexOf(id)]?.isPending;
        const down = !pending && (ms === null || ms === undefined);
        return (
          <KV
            key={id}
            lead={<NetDot color={netColor(id)} />}
            label={
              <span className="inline-flex items-center gap-2">
                {netName(id)}
                {isTestnetId(id) && <OutlineTag label={t("history.testnet")} />}
              </span>
            }
            muted={down}
            value={
              pending ? (
                <Live value={null} width="w-10" />
              ) : down ? (
                t("settings.notReachable")
              ) : (
                <span className="text-[0.84375rem]">{ms} ms</span>
              )
            }
          />
        );
      })}
    </StatusPanel>
  );
}
