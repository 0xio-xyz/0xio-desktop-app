import { useMemo, useState, useCallback, useEffect } from "react";
import { useQuery } from "src/lib/query";
import { useTranslation } from "src/i18n/react";
import { Search } from "src/shared/ui/icons";
import { PopupShell } from "src/shared/ui/ReviewPopup";
import { Btn, EASE, FOCUS, Pair, PillSwitch, Skel } from "src/shared/ui/look";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";
import ContractPage from "src/features/contracts/components/ContractPage";
import * as contractService from "src/services/contracts/contractService";
import { useWallet } from "src/contexts/useWallet";
import { formatOCTShort, truncateAddress } from "src/lib/format";
import type { UseContractRegistryReturn } from "src/features/contracts/hooks/useContractRegistry";
import type { ContractListEntry } from "src/types/contract";

interface Props {
  registry: UseContractRegistryReturn;
  prefillAddress: string;
  onPrefillConsumed: () => void;
  onOpenInBuild: () => void;
}

type Filter = "yours" | "saved" | "all";

interface Row {
  address: string;
  name?: string;
  version?: string;
  codeHash?: string;
  balance?: string;
}

const PLACEHOLDER_ROWS = 4;
const GRID =
  "grid grid-cols-[minmax(0,1.2fr)_minmax(0,2.4fr)_120px_120px_130px] items-center gap-4 px-4";

function balanceOf(raw: string | undefined): string | undefined {
  if (raw == null || raw === "" || !/^\d+$/.test(raw)) return undefined;
  return formatOCTShort(Number(raw));
}

export default function ContractsHub({
  registry,
  prefillAddress,
  onPrefillConsumed,
  onOpenInBuild,
}: Props) {
  const { t } = useTranslation();
  const { networkId, activeWallet } = useWallet();
  const walletAddr = activeWallet?.address ?? "";
  const [filter, setFilter] = useState<Filter>("yours");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [showAdd, setShowAdd] = useState(false);
  const [addAddress, setAddAddress] = useState("");
  const [addName, setAddName] = useState("");

  const { data: chainContracts, isLoading: loadingChain } = useQuery<ContractListEntry[]>({
    queryKey: ["allContracts", networkId],
    queryFn: () => contractService.listContracts(networkId),
    staleTime: 60_000,
  });

  const chainByAddress = useMemo(
    () => new Map((chainContracts ?? []).map((c) => [c.address, c])),
    [chainContracts],
  );
  const savedByAddress = useMemo(
    () => new Map(registry.contracts.map((c) => [c.address, c])),
    [registry.contracts],
  );

  const { data: deployed, isLoading: loadingDeployed } = useQuery<ContractListEntry[]>({
    queryKey: ["contractsDeployedBy", networkId, walletAddr],
    queryFn: () => contractService.listDeployedBy(walletAddr, networkId),
    enabled: !!walletAddr,
    staleTime: 60_000,
  });

  const yours = useMemo(() => {
    const seen = new Set<string>();
    const out: ContractListEntry[] = [];
    for (const c of [
      ...(deployed ?? []),
      ...(chainContracts ?? []).filter((c) => !!walletAddr && c.owner === walletAddr),
    ]) {
      if (seen.has(c.address)) continue;
      seen.add(c.address);
      out.push(c);
    }
    return out;
  }, [deployed, chainContracts, walletAddr]);

  const select = useCallback((address: string) => {
    setSelected(address);
  }, []);

  // effect:audited - a deploy (or external navigation) hands us an address to open.
  useEffect(() => {
    if (prefillAddress) {
      select(prefillAddress);
      onPrefillConsumed();
    }
  }, [prefillAddress, select, onPrefillConsumed]);

  const toRow = useCallback(
    (address: string): Row => {
      const c = chainByAddress.get(address) ?? deployed?.find((d) => d.address === address);
      return {
        address,
        name: savedByAddress.get(address)?.name,
        version: c?.version != null ? String(c.version) : undefined,
        codeHash: c?.code_hash,
        balance: c?.balance,
      };
    },
    [chainByAddress, savedByAddress, deployed],
  );

  const rows = useMemo(() => {
    const base: Row[] =
      filter === "saved"
        ? registry.contracts.map((c) => toRow(c.address))
        : (filter === "yours" ? yours : (chainContracts ?? [])).map((c) => toRow(c.address));
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (r) => r.address.toLowerCase().includes(q) || (r.name ?? "").toLowerCase().includes(q),
    );
  }, [filter, registry.contracts, yours, chainContracts, toRow, query]);

  const loading = filter === "yours" ? loadingDeployed : filter === "all" && loadingChain;

  useEscapeKey(showAdd, () => setShowAdd(false));

  const handleAdd = () => {
    if (!addAddress.trim()) return;
    registry.addManual(addAddress.trim(), addName.trim() || truncateAddress(addAddress.trim()));
    setShowAdd(false);
    setAddAddress("");
    setAddName("");
    select(addAddress.trim());
  };

  const field =
    "h-10.5 w-full rounded-xl bg-surface-highlight px-3.5 text-meta text-content placeholder:text-content-muted focus:outline-none";

  const emptyText =
    filter === "yours"
      ? t("contracts.hub.noneYours")
      : filter === "saved"
        ? t("contracts.hub.noneTracked")
        : t("contracts.hub.noneFound");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!selected ? (
        <div className="look-raise flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-surface-card">
          <div className="flex shrink-0 items-center gap-2.5 p-3">
            <PillSwitch<Filter>
              label={t("contracts.hub.filter")}
              value={filter}
              onChange={setFilter}
              options={[
                { value: "yours", label: t("contracts.hub.yours"), badge: yours.length },
                {
                  value: "saved",
                  label: t("contracts.hub.saved"),
                  badge: registry.contracts.length,
                },
                {
                  value: "all",
                  label: t("contracts.hub.all"),
                  badge: chainContracts?.length,
                },
              ]}
            />
            <div className="relative min-w-0 flex-1">
              <Search
                size={14}
                className="absolute top-1/2 left-3.5 -translate-y-1/2 text-content-muted"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("contracts.hub.search")}
                aria-label={t("contracts.hub.search")}
                className="h-10 w-full rounded-full bg-surface-highlight pr-4 pl-9.5 text-meta text-content placeholder:text-content-muted focus:outline-none"
              />
            </div>
            <Btn size="sm" onClick={() => setShowAdd(true)}>
              {t("contracts.hub.track")}
            </Btn>
          </div>

          <div
            className={`${GRID} h-8 shrink-0 text-[0.65625rem] font-medium tracking-[0.16em] text-content-muted uppercase`}
          >
            <span>{t("contracts.hub.colName")}</span>
            <span>{t("contracts.hub.colAddress")}</span>
            <span>{t("contracts.hub.colVersion")}</span>
            <span>{t("contracts.hub.colCode")}</span>
            <span className="text-right">{t("contracts.hub.colBalance")}</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 scrollbar-hide">
            {loading &&
              Array.from({ length: PLACEHOLDER_ROWS }, (_, i) => (
                <div key={i} className={`${GRID} h-14 rounded-xl`}>
                  <Skel w="w-24" />
                  <Skel w="w-64" />
                  <Skel w="w-14" />
                  <Skel w="w-16" />
                  <span className="text-right">
                    <Skel w="w-16" />
                  </span>
                </div>
              ))}
            {!loading && rows.length === 0 && (
              <p className="flex h-14 items-center px-4 text-meta text-content-muted">
                {emptyText}
              </p>
            )}
            {!loading &&
              rows.map((r) => {
                const bal = balanceOf(r.balance);
                return (
                  <button
                    key={r.address}
                    type="button"
                    onClick={() => select(r.address)}
                    className={`${GRID} h-14 w-full cursor-pointer rounded-xl text-left hover:bg-surface-highlight ${EASE} ${FOCUS}`}
                  >
                    <span
                      className={`truncate text-body font-medium ${r.name ? "text-content" : "text-content-muted"}`}
                    >
                      {r.name || t("contracts.compile.unnamed")}
                    </span>
                    <span className="truncate font-mono text-meta text-content-secondary">
                      {r.address}
                    </span>
                    <span className="truncate text-meta text-content-secondary">
                      {r.version ?? ""}
                    </span>
                    <span className="truncate font-mono text-meta text-content-muted">
                      {r.codeHash ? `${r.codeHash.slice(0, 6)}...${r.codeHash.slice(-4)}` : ""}
                    </span>
                    <span className="text-right text-meta text-content tabular-nums">
                      {bal != null ? `${bal} OCT` : ""}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>
      ) : (
        <ContractPage
          address={selected}
          registry={registry}
          onBack={() => setSelected("")}
          onOpenInBuild={onOpenInBuild}
        />
      )}

      <PopupShell
        open={showAdd}
        label={t("contracts.hub.trackTitle")}
        onScrim={() => setShowAdd(false)}
      >
        <h3 className="text-title font-semibold text-content">{t("contracts.hub.trackTitle")}</h3>
        <div className="mt-4 space-y-2.5">
          <input
            value={addAddress}
            onChange={(e) => setAddAddress(e.target.value)}
            placeholder="oct..."
            aria-label={t("contracts.interact.contract")}
            autoFocus
            className={`${field} font-mono`}
          />
          <input
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder={t("contracts.compile.name")}
            aria-label={t("contracts.compile.name")}
            className={field}
          />
        </div>
        <Pair
          className="mt-5"
          left={<Btn onClick={() => setShowAdd(false)}>{t("common.cancel")}</Btn>}
          right={
            <Btn weight="primary" onClick={handleAdd} disabled={!addAddress.trim()}>
              {t("contracts.hub.trackVerb")}
            </Btn>
          }
        />
      </PopupShell>
    </div>
  );
}
