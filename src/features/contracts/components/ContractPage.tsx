import { useState } from "react";
import { useQuery } from "src/lib/query";
import { useTranslation } from "src/i18n/react";
import CopyButton from "src/shared/ui/CopyButton";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Btn, Caps, EASE, FOCUS, KV } from "src/shared/ui/look";
import { useWallet } from "src/contexts/useWallet";
import * as contractService from "src/services/contracts/contractService";
import CodeEditor from "src/features/contracts/components/editor/CodeEditor";
import { openSourceInBuild } from "src/features/contracts/components/editor/openInBuild";
import InteractTab from "src/features/contracts/components/InteractTab";
import VerifyTab from "src/features/contracts/components/VerifyTab";
import { useContractSource } from "src/features/contracts/sourceStore";
import type { UseContractRegistryReturn } from "src/features/contracts/hooks/useContractRegistry";
import type { ContractAbi, ContractInfo } from "src/types/contract";
import { formatOCTShort, truncateAddress } from "src/lib/format";

type View = "methods" | "source" | "verify";

interface Props {
  address: string;
  registry: UseContractRegistryReturn;
  onBack: () => void;
  onOpenInBuild: () => void;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-7.5 items-center gap-1.5 rounded-full bg-surface-highlight px-3 text-meta text-content-secondary">
      {children}
    </span>
  );
}

export default function ContractPage({ address, registry, onBack, onOpenInBuild }: Props) {
  const { t } = useTranslation();
  const { networkId, activeWallet, showMessage } = useWallet();
  const [view, setView] = useState<View>("methods");
  const [rename, setRename] = useState<string | null>(null);

  const info = useQuery<ContractInfo>({
    queryKey: ["contractInfo", address, networkId],
    queryFn: () => contractService.getContractInfo(address, networkId),
    staleTime: 30_000,
  });
  const abi = useQuery<ContractAbi | null>({
    queryKey: ["contractAbi", networkId, address],
    queryFn: () => contractService.getContractAbi(address),
    staleTime: 5 * 60_000,
  });
  const stored = useContractSource(networkId, address);
  const saved = registry.contracts.find((c) => c.address === address);
  const yours = !!info.data?.owner && info.data.owner === activeWallet?.address;
  const name = saved?.name || t("contracts.compile.unnamed");

  const commitRename = () => {
    const next = (rename ?? "").trim();
    if (saved && next && next !== saved.name) registry.updateContract(address, { name: next });
    setRename(null);
  };

  const toggle = (v: View) => setView((cur) => (cur === v ? "methods" : v));

  const openInBuild = async () => {
    if (!stored) return;
    try {
      await openSourceInBuild(saved?.name || "contract", stored.source, stored.language);
      onOpenInBuild();
    } catch (e) {
      showMessage("error", e instanceof Error ? e.message : String(e));
    }
  };

  const balance =
    info.data?.balance && /^\d+$/.test(info.data.balance)
      ? formatOCTShort(Number(info.data.balance))
      : null;

  const action = (on: boolean) =>
    `inline-flex h-9 cursor-pointer items-center rounded-full px-4 text-body font-medium ${EASE} ${FOCUS} ${
      on ? "bg-(--bg-3) text-content" : "bg-surface-highlight text-content hover:bg-(--bg-3)"
    }`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="look-raise shrink-0 rounded-[22px] bg-surface-card px-5 py-4">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-lead">
              <button
                type="button"
                onClick={onBack}
                className={`shrink-0 cursor-pointer rounded-lg text-content-muted hover:text-content ${EASE} ${FOCUS}`}
              >
                {t("contracts.hub.back")}
              </button>
              <span aria-hidden="true" className="text-content-muted">
                /
              </span>
              {rename != null ? (
                <input
                  value={rename}
                  onChange={(e) => setRename(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRename(null);
                  }}
                  aria-label={t("contracts.hub.rename")}
                  maxLength={64}
                  autoFocus
                  className="h-7 min-w-0 flex-1 rounded-lg bg-surface-highlight px-2 font-semibold text-content focus:outline-none"
                />
              ) : saved ? (
                <button
                  type="button"
                  onClick={() => setRename(saved.name)}
                  title={t("contracts.hub.rename")}
                  className={`min-w-0 cursor-text truncate rounded-lg font-semibold text-content hover:bg-surface-highlight ${EASE} ${FOCUS}`}
                >
                  {name}
                </button>
              ) : (
                <span className="truncate font-semibold text-content-secondary">{name}</span>
              )}
            </div>
            <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-meta text-content-muted">{address}</span>
              <CopyButton text={address} size={12} />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              aria-pressed={!!saved}
              onClick={() =>
                saved
                  ? registry.removeContract(address)
                  : registry.addManual(address, truncateAddress(address))
              }
              className={action(!!saved)}
            >
              {saved ? t("contracts.hub.saved") : t("contracts.hub.save")}
            </button>
            <button
              type="button"
              aria-pressed={view === "source"}
              onClick={() => toggle("source")}
              className={action(view === "source")}
            >
              {t("contracts.page.source")}
            </button>
            <button
              type="button"
              aria-pressed={view === "verify"}
              onClick={() => toggle("verify")}
              className={action(view === "verify")}
            >
              {t("contracts.hub.verify")}
            </button>
            {stored && (
              <Btn size="sm" onClick={() => void openInBuild()}>
                {t("contracts.page.openInBuild")}
              </Btn>
            )}
          </div>
        </div>
        <div className="mt-3.5 flex min-h-7.5 flex-wrap items-center gap-2">
          {info.data?.version != null && <Chip>{String(info.data.version)}</Chip>}
          {balance != null && (
            <Chip>
              <span className="text-content tabular-nums">{balance} OCT</span>
            </Chip>
          )}
          <Chip>
            {stored?.verified ? (
              <span className="text-positive">{t("contracts.compile.verified")}</span>
            ) : (
              <span className="text-content-muted">{t("contracts.compile.notVerified")}</span>
            )}
          </Chip>
          {info.data?.owner &&
            (yours ? (
              <Chip>
                {t("contracts.page.createdBy")}
                <WalletAvatar address={activeWallet!.address} size={16} />
                <span className="text-content">{activeWallet!.name}</span>
              </Chip>
            ) : (
              <Chip>
                {t("contracts.page.owner")}
                <span className="font-mono text-content">{truncateAddress(info.data.owner)}</span>
              </Chip>
            ))}
        </div>
      </div>

      {view === "methods" && (
        <InteractTab address={address} registry={registry} onAddSource={() => setView("verify")} />
      )}
      {view === "verify" && <VerifyTab address={address} />}
      {view === "source" && (
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="look-raise flex min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-surface-card">
            {stored ? (
              <>
                <div className="flex h-12 shrink-0 items-center gap-3 px-4">
                  <span className="font-mono text-body text-content">{stored.file}</span>
                  <span className="text-meta text-content-muted">
                    {stored.origin === "deployed"
                      ? t("contracts.page.deployedHere")
                      : t("contracts.page.verifiedHere")}
                  </span>
                  <span className="flex-1" />
                  <CopyButton text={stored.source} size={13} />
                </div>
                <div className="relative min-h-0 flex-1">
                  <CodeEditor
                    key={`${networkId}-${address}-${stored.at}`}
                    value={stored.source}
                    onChange={() => {}}
                    language={stored.language}
                    readOnly
                  />
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 scrollbar-hide">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-lead font-semibold text-content">
                    {t("contracts.page.noSource")}
                  </span>
                  <Btn size="sm" weight="primary" onClick={() => setView("verify")}>
                    {t("contracts.page.verifyWithSource")}
                  </Btn>
                </div>
                {[
                  { key: "read", label: t("contracts.interact.read"), mutates: false },
                  { key: "write", label: t("contracts.interact.write"), mutates: true },
                  { key: "untyped", label: t("contracts.interact.methodsAll"), mutates: null },
                ].map((g) => {
                  const items = (abi.data ?? []).filter((x) =>
                    g.mutates === null
                      ? x.typed === false
                      : x.typed !== false && x.mutates === g.mutates,
                  );
                  return items.length ? (
                    <div key={g.key} className="pt-5">
                      <Caps>{g.label}</Caps>
                      <div className="mt-2 space-y-1">
                        {items.map((x) => (
                          <p key={x.name} className="font-mono text-meta text-content">
                            {x.name}
                            <span className="text-content-muted">
                              ({x.params.map((p) => `${p.name}: ${p.type}`).join(", ")})
                              {x.returns ? `: ${x.returns}` : ""}
                            </span>
                          </p>
                        ))}
                      </div>
                    </div>
                  ) : null;
                })}
              </div>
            )}
          </div>
          <div className="look-raise w-75 shrink-0 self-start rounded-[22px] bg-surface-card px-4.5 py-4">
            <Caps>{t("contracts.page.code")}</Caps>
            <div className="mt-2">
              <KV label={t("contracts.interact.codeHash")}>
                <span className="font-mono text-meta">
                  {info.data?.code_hash ? truncateAddress(info.data.code_hash, 6, 4) : ""}
                </span>
              </KV>
              <KV label={t("contracts.interact.version")}>
                {info.data?.version != null ? String(info.data.version) : ""}
              </KV>
              <KV label={t("contracts.page.language")}>
                {stored ? (stored.language === "assembly" ? "Assembly" : "AppliedML") : ""}
              </KV>
              <KV label={t("contracts.page.verifiedLabel")}>
                <span className={stored?.verified ? "text-positive" : "text-content-muted"}>
                  {stored?.verified
                    ? t("contracts.compile.verified")
                    : t("contracts.compile.notVerified")}
                </span>
              </KV>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
