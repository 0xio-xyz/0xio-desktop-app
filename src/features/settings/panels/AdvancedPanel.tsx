import { useMemo } from "react";
import { useTranslation } from "src/i18n/react";
import { invoke } from "@tauri-apps/api/core";
import { useWallet } from "src/contexts/useWallet";
import { pvacVerifiedCount } from "src/features/privacy/services/privacyService";
import {
  KV,
  Live,
  PanelCaption,
  StatusPanel,
  TextAction,
} from "src/features/settings/components/parts";
import { useSystemInfo } from "src/features/settings/hooks/useLiveInfo";
import { formatBytes, measureCaches, type CacheId } from "src/features/settings/services/caches";

const CACHE_LABEL: Record<CacheId, string> = {
  history: "settings.cacheHistory",
  nft: "settings.cacheNft",
  prices: "settings.cachePrices",
  balances: "settings.cacheBalances",
  methods: "settings.cacheMethods",
  queries: "settings.cacheQueries",
};

function Cores({ used, total }: { used: number; total: number }) {
  return (
    <div role="img" aria-label={`${used} / ${total}`} className="flex h-2.5 gap-1">
      {Array.from({ length: total }, (_, i) => (
        <i
          key={i}
          className={`block flex-1 rounded-[3px] transition-colors duration-250 ease-out ${i < used ? "bg-content" : "bg-(--bg-3)"}`}
        />
      ))}
    </div>
  );
}

const size = (bytes: number) => {
  const { value, unit } = formatBytes(bytes);
  return `${value} ${unit}`;
};

export default function AdvancedPanel({ cacheVersion }: { cacheVersion: number }) {
  const { t } = useTranslation();
  const { showMessage } = useWallet();
  const info = useSystemInfo();
  const caches = useMemo(() => measureCaches(), [cacheVersion]);
  const total = formatBytes(caches.reduce((n, c) => n + c.bytes, 0));
  const verified = pvacVerifiedCount();
  const sys = info.data;

  return (
    <StatusPanel>
      <div className="grid grid-cols-2 gap-4.5">
        <div className="min-w-0">
          <PanelCaption>{t("settings.caches")}</PanelCaption>
          <div className="look-figure mt-3 text-[1.875rem] text-content">
            {total.value}
            <span className="ml-1 text-[0.8125rem] font-normal tracking-normal text-content-muted">
              {total.unit}
            </span>
          </div>
        </div>
        <div className="min-w-0">
          <PanelCaption>{t("settings.proofThreadsShort")}</PanelCaption>
          <div className="look-figure mt-3 text-[1.875rem] text-content">
            <Live value={sys?.proof_threads || null} width="w-8" />
            <span className="ml-1 text-[0.8125rem] font-normal tracking-normal text-content-muted">
              {sys?.cores ? t("settings.ofCores", { count: sys.cores }) : ""}
            </span>
          </div>
        </div>
      </div>
      <div className="mt-4.5 mb-3">
        {sys?.cores ? (
          <Cores used={sys.proof_threads} total={Math.min(sys.cores, 32)} />
        ) : (
          <div className="h-2.5 animate-pulse rounded-[3px] bg-surface-highlight motion-reduce:animate-none" />
        )}
      </div>
      {caches.map((c) => (
        <KV key={c.id} label={t(CACHE_LABEL[c.id])} value={size(c.bytes)} />
      ))}
      <KV
        label={t("settings.pvacVerification")}
        value={t("settings.walletsCount", { count: verified })}
      />
      <PanelCaption className="mt-4 mb-0.5">{t("settings.logs")}</PanelCaption>
      <KV
        label={t("settings.today")}
        value={<Live value={sys ? (sys.log_bytes === null ? "-" : size(sys.log_bytes)) : null} />}
        action={
          <TextAction
            onClick={() =>
              void invoke("open_log_folder").catch(() =>
                showMessage("error", t("settings.logsUnavailable")),
              )
            }
          >
            {t("settings.openLogs")}
          </TextAction>
        }
      />
    </StatusPanel>
  );
}
