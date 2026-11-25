import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "src/lib/query";
import { useTranslation } from "src/i18n/react";
import { Search } from "src/shared/ui/icons";
import CopyButton from "src/shared/ui/CopyButton";
import FeePicker from "src/shared/ui/FeePicker";
import ReviewPopup from "src/shared/ui/ReviewPopup";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import { Btn, Caps, EASE, FOCUS, KV, Skel } from "src/shared/ui/look";
import { Toggle } from "src/features/settings/components/parts";
import { useWallet } from "src/contexts/useWallet";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import * as privacyService from "src/features/privacy/services/privacyService";
import * as contractService from "src/services/contracts/contractService";
import { useContractInteraction } from "src/features/contracts/hooks/useContractInteraction";
import { useContractSource } from "src/features/contracts/sourceStore";
import type { UseContractRegistryReturn } from "src/features/contracts/hooks/useContractRegistry";
import type { AbiMethod, ContractAbi } from "src/types/contract";
import { formatOCT, truncateAddress } from "src/lib/format";

function isNumericType(type: string): boolean {
  return /int|uint|number/i.test(type);
}

export function jsonParamsError(json: string, method: AbiMethod): "invalid" | "count" | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.trim().replace(/enc\(\s*[^)]*\)/g, "0") || "[]");
  } catch {
    return "invalid";
  }
  if (!Array.isArray(parsed)) return "invalid";
  if (method.typed === false) return null;
  return parsed.length === method.params.length ? null : "count";
}

export function fieldsFromJson(
  json: string,
  method: AbiMethod,
): { values: Record<number, string>; enc: Record<number, boolean> } | null {
  const enc: Record<number, boolean> = {};
  const marked = json.replace(
    /enc\(\s*([^)]*)\)/g,
    (_, v: string) => `{"__enc":${JSON.stringify(v.trim())}}`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(marked);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== method.params.length) return null;
  const values: Record<number, string> = {};
  parsed.forEach((v, i) => {
    if (v && typeof v === "object" && "__enc" in v) {
      enc[i] = true;
      values[i] = String((v as { __enc: string }).__enc);
    } else {
      values[i] = typeof v === "string" ? v : JSON.stringify(v);
    }
  });
  return { values, enc };
}

function show(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

interface Props {
  address: string;
  registry?: UseContractRegistryReturn;
  onAddSource?: () => void;
}

export default function InteractTab({ address: contract, registry, onAddSource }: Props) {
  const { t } = useTranslation();
  const { activeWallet, networkId, showMessage } = useWallet();
  const address = activeWallet?.address ?? "";
  const walletId = activeWallet?.id ?? "";

  const ensurePvac = useCallback(async () => {
    if (pvacBridge.isInitializedFor(address)) return;
    await privacyService.initPvac(walletId, address);
  }, [walletId, address]);

  const ci = useContractInteraction({ address, ensurePvac, walletId, showMessage });
  const { setContractAddr, setAbi, handleAbiSelect } = ci;

  const isFull = (a: ContractAbi | null | undefined): boolean =>
    !!a?.length && a.every((x) => x.typed !== false);
  const cachedAbi = registry?.contracts.find((c) => c.address === contract)?.abi ?? null;
  const stored = useContractSource(networkId, contract);
  const compiledQuery = useQuery<ContractAbi | null>({
    queryKey: ["contractAbiFromSource", networkId, contract, stored?.at],
    queryFn: async () =>
      (await contractService.compile(stored!.source, stored!.language)).abi ?? null,
    enabled: !!stored && !isFull(cachedAbi),
    staleTime: Infinity,
    retry: false,
  });
  const abiQuery = useQuery<ContractAbi | null>({
    queryKey: ["contractAbi", networkId, contract],
    queryFn: () => contractService.getContractAbi(contract),
    enabled: !!contract && !isFull(cachedAbi),
    staleTime: 5 * 60_000,
  });
  const abi = isFull(cachedAbi)
    ? cachedAbi
    : isFull(compiledQuery.data)
      ? (compiledQuery.data ?? null)
      : stored && compiledQuery.isLoading
        ? null
        : cachedAbi?.length
          ? cachedAbi
          : (abiQuery.data ?? null);

  // effect:audited - the page's contract and its ABI drive the call form.
  useEffect(() => {
    setContractAddr(contract);
  }, [contract, setContractAddr]);

  // effect:audited - a newly read ABI opens its first method.
  useEffect(() => {
    if (!abi) return;
    setAbi(abi);
    if (abi[0]) {
      handleAbiSelect(abi[0].name);
      if (abi[0].typed === false) ci.params.setUseRawJson(true);
    }
    const better = isFull(abi) ? !isFull(cachedAbi) : !cachedAbi?.length;
    if (abi !== cachedAbi && better && registry?.contracts.some((c) => c.address === contract)) {
      registry.updateContract(contract, { abi });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abi]);

  const [filter, setFilter] = useState("");
  const [missing, setMissing] = useState<string[]>([]);

  const m = ci.selectedMethod;
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (ci.abi ?? []).filter((x) => !q || x.name.toLowerCase().includes(q));
    const typed = list.filter((x) => x.typed !== false);
    return [
      { key: "read", label: t("contracts.interact.read"), items: typed.filter((x) => !x.mutates) },
      { key: "write", label: t("contracts.interact.write"), items: typed.filter((x) => x.mutates) },
      {
        key: "untyped",
        label: t("contracts.interact.methodsAll"),
        items: list.filter((x) => x.typed === false),
      },
    ];
  }, [ci.abi, filter, t]);

  const jsonError = m && ci.params.useRawJson ? jsonParamsError(ci.params.json, m) : null;

  const untyped = m?.typed === false;

  const pick = (name: string) => {
    setMissing([]);
    handleAbiSelect(name);
    if (ci.abi?.find((x) => x.name === name)?.typed === false) ci.params.setUseRawJson(true);
  };

  const setJsonMode = (on: boolean) => {
    if (!m) return;
    if (!on) {
      const back = fieldsFromJson(ci.params.json, m);
      if (back) {
        ci.params.setValues(back.values);
        ci.params.setEncryptFlags(back.enc);
      }
    }
    ci.params.setUseRawJson(on);
  };

  const ready = (): boolean => {
    if (!m || ci.executing) return false;
    if (ci.params.useRawJson || untyped) return !jsonError;
    const empty = m.params.filter((_, i) => !(ci.params.values[i] ?? "").trim()).map((p) => p.name);
    setMissing(empty);
    return empty.length === 0;
  };

  const r = ci.result;
  const rc = ci.receipt;
  const status = !r?.txHash
    ? null
    : rc
      ? rc.status === "success"
        ? "confirmed"
        : "failed"
      : ci.loadingReceipt
        ? "pending"
        : "submitted";

  const rv = ci.callReview;

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <div className="look-raise flex w-75 shrink-0 flex-col overflow-hidden rounded-[22px] bg-surface-card p-3">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-content-muted"
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("contracts.interact.search")}
            aria-label={t("contracts.interact.search")}
            className="h-9.5 w-full rounded-full bg-surface-highlight pr-3 pl-8.5 text-meta text-content placeholder:text-content-muted focus:outline-none"
          />
        </div>
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto scrollbar-hide">
          {!ci.abi &&
            abiQuery.isLoading &&
            Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex h-10 items-center px-3">
                <Skel w="w-32" />
              </div>
            ))}
          {!abiQuery.isLoading && !ci.abi && (
            <p className="px-3 py-3 text-meta text-content-muted">
              {t("contracts.interact.noAbi")}
            </p>
          )}
          {groups.map((g) =>
            g.items.length ? (
              <div key={g.key} className="pt-2">
                <div className="px-3 pb-1.5">
                  <Caps>{g.label}</Caps>
                </div>
                {g.items.map((x) => {
                  const on = m?.name === x.name;
                  return (
                    <button
                      key={x.name}
                      type="button"
                      onClick={() => pick(x.name)}
                      aria-pressed={on}
                      className={`flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-3 text-left ${EASE} ${FOCUS} ${on ? "bg-(--bg-3)" : "hover:bg-surface-highlight"}`}
                    >
                      <span className="truncate font-mono text-[0.8125rem] text-content">
                        {x.name}
                      </span>
                      <span className="shrink-0 font-mono text-micro text-content-muted">
                        {x.mutates ? x.params.map((p) => p.name).join(" ") : (x.returns ?? "")}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null,
          )}
          {ci.abi && groups.every((g) => g.items.length === 0) && (
            <p className="px-3 py-3 text-meta text-content-muted">
              {t("contracts.interact.noMatch")}
            </p>
          )}
        </div>
      </div>

      <div className="look-raise flex min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-surface-card">
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-7 py-6 scrollbar-hide">
          {m ? (
            <>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-mono text-[1.375rem] font-medium text-content">{m.name}</div>
                  <div className="mt-1.5 font-mono text-meta text-content-muted">
                    {untyped ? (
                      `${m.name}(...)`
                    ) : (
                      <>
                        <span className="text-accent">{m.mutates ? "fn" : "view fn"}</span> {m.name}
                        ({m.params.map((p) => `${p.name}: ${p.type}`).join(", ")})
                        {m.returns ? `: ${m.returns}` : ""}
                      </>
                    )}
                  </div>
                </div>
                {untyped && onAddSource && (
                  <Btn size="sm" className="w-32 shrink-0" onClick={onAddSource}>
                    {t("contracts.interact.addSource")}
                  </Btn>
                )}
              </div>

              {(m.params.length > 0 || untyped) && (
                <div className="space-y-3">
                  <Caps
                    right={
                      !untyped && (
                        <span className="inline-flex items-center gap-2 normal-case">
                          <span className="text-meta tracking-normal text-content-secondary">
                            JSON
                          </span>
                          <Toggle
                            on={ci.params.useRawJson}
                            onChange={setJsonMode}
                            label={t("contracts.interact.jsonMode")}
                          />
                        </span>
                      )
                    }
                  >
                    {t("contracts.interact.parameters")}
                  </Caps>
                  {ci.params.useRawJson || untyped ? (
                    <div>
                      <div className="mb-1.5 text-right font-mono text-micro text-content-muted">
                        {untyped ? "[...]" : `[${m.params.map((p) => p.type).join(", ")}]`}
                      </div>
                      <textarea
                        value={ci.params.json}
                        onChange={(e) => ci.params.setJson(e.target.value)}
                        aria-label={t("contracts.interact.parametersJson")}
                        rows={3}
                        spellCheck={false}
                        className="w-full resize-none rounded-xl bg-surface-highlight px-3.5 py-3 font-mono text-meta text-content focus:outline-none"
                      />
                      <p role="alert" className="mt-1.5 min-h-5 text-meta text-danger">
                        {jsonError === "invalid"
                          ? t("contracts.interact.jsonInvalid")
                          : jsonError === "count"
                            ? t("contracts.interact.jsonCount", { count: m.params.length })
                            : ""}
                      </p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-x-6 gap-y-3 xl:grid-cols-2">
                      {m.params.map((p, i) => (
                        <div key={`${m.name}-${i}`}>
                          <div className="mb-1.5 flex items-center justify-between gap-2 text-meta">
                            <span className="font-mono text-content-secondary">{p.name}</span>
                            <span className="font-mono text-content-muted">{p.type}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <input
                              value={ci.params.values[i] ?? ""}
                              onChange={(e) => {
                                setMissing([]);
                                ci.params.setValues((prev) => ({ ...prev, [i]: e.target.value }));
                              }}
                              placeholder={isNumericType(p.type) ? "0" : p.type}
                              aria-label={p.name}
                              spellCheck={false}
                              className="h-10.5 min-w-0 flex-1 rounded-xl bg-surface-highlight px-3.5 font-mono text-meta text-content placeholder:text-content-muted focus:outline-none"
                            />
                            {isNumericType(p.type) && (
                              <span className="inline-flex shrink-0 items-center gap-2 text-meta text-content-secondary">
                                <Toggle
                                  on={ci.params.encryptFlags[i] ?? false}
                                  onChange={(next) =>
                                    ci.params.setEncryptFlags((prev) => ({ ...prev, [i]: next }))
                                  }
                                  label={`${t("contracts.interact.encrypt")} ${p.name}`}
                                />
                                {t("contracts.interact.encrypt")}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {(m.mutates || untyped) && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-meta">
                    <span className="text-content-secondary">{t("contracts.interact.amount")}</span>
                    <span className="text-content-muted">OCT</span>
                  </div>
                  <input
                    value={ci.amount}
                    onChange={(e) => ci.setAmount(e.target.value)}
                    placeholder="0"
                    aria-label={t("contracts.interact.amount")}
                    inputMode="decimal"
                    className="h-10.5 w-full rounded-xl bg-surface-highlight px-3.5 font-mono text-meta text-content placeholder:text-content-muted focus:outline-none"
                  />
                </div>
              )}

              <div className="min-h-44">
                {ci.executing && !r && (
                  <div className="rounded-2xl bg-surface-highlight px-5 py-4 opacity-60">
                    <Skel w="w-40" />
                  </div>
                )}
                {r && (
                  <div
                    className={`rounded-2xl bg-surface-highlight px-5 py-3 transition-opacity duration-200 ease-out ${status === "pending" ? "opacity-60" : ""}`}
                  >
                    {r.error ? (
                      <KV label={t("contracts.interact.status")}>
                        <span className="text-danger">{r.error}</span>
                      </KV>
                    ) : r.txHash ? (
                      <>
                        <KV label={t("contracts.interact.status")}>
                          <span
                            className={
                              status === "confirmed"
                                ? "text-positive"
                                : status === "failed"
                                  ? "text-danger"
                                  : "text-content-secondary"
                            }
                          >
                            {t(`contracts.interact.status_${status}`)}
                          </span>
                        </KV>
                        {rc?.error && (
                          <KV label={t("contracts.interact.error")}>
                            <span className="text-danger">{rc.error}</span>
                          </KV>
                        )}
                        {rc?.return_value != null && (
                          <KV label={t("contracts.interact.returnValue")}>
                            <span className="max-w-80 truncate font-mono text-meta">
                              {show(rc.return_value)}
                            </span>
                          </KV>
                        )}
                        <KV label={t("sendFlow.hash")}>
                          <span className="inline-flex items-center gap-1.5 font-mono text-meta">
                            {truncateAddress(r.txHash, 10, 6)}
                            <CopyButton text={r.txHash} size={11} />
                          </span>
                        </KV>
                        {rc?.gas_used != null && (
                          <KV label={t("contracts.interact.gasUsed")}>
                            <span className="tabular-nums">{rc.gas_used.toLocaleString()}</span>
                          </KV>
                        )}
                        {Array.isArray(rc?.events) && rc.events.length > 0 && (
                          <div className="mt-2 space-y-1 rounded-xl bg-(--bg-3) px-3.5 py-2.5">
                            <Caps>{t("contracts.interact.events")}</Caps>
                            {rc.events.map((ev, i) => (
                              <p key={i} className="truncate font-mono text-micro text-content">
                                {show(ev)}
                              </p>
                            ))}
                          </div>
                        )}
                      </>
                    ) : r.decrypted !== null ? (
                      <>
                        <KV label={t("contracts.interact.result")}>
                          <span className="font-mono text-lead">{r.decrypted}</span>
                        </KV>
                        <KV label={t("contracts.interact.encrypted")}>
                          <span className="max-w-80 truncate font-mono text-meta">
                            {String(r.raw).slice(0, 40)}...
                          </span>
                        </KV>
                      </>
                    ) : (
                      <>
                        <KV label={t("contracts.interact.result")}>
                          <span className="max-w-120 font-mono text-lead break-all">
                            {show(r.raw)}
                          </span>
                        </KV>
                        {m.returns && (
                          <KV label={t("contracts.interact.type")}>
                            <span className="font-mono text-meta">{m.returns}</span>
                          </KV>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            !abiQuery.isLoading && (
              <p className="text-meta text-content-muted">{t("contracts.interact.noAbi")}</p>
            )
          )}
        </div>
        {m && (
          <div className="flex h-18 shrink-0 items-center gap-4 px-7">
            {untyped ? (
              <>
                <span className="inline-flex items-center gap-2 text-meta text-content-muted">
                  {t("sendFlow.networkFee")}
                  <FeePicker quote={ci.feeQuote} ou={ci.ou} onChange={ci.setOU} />
                </span>
                <span className="min-w-0 flex-1" />
                <Btn
                  className="w-32"
                  disabled={ci.executing || !!jsonError}
                  onClick={() => {
                    if (ready()) void ci.executeView();
                  }}
                >
                  {t("contracts.interact.run")}
                </Btn>
                <Btn
                  weight="primary"
                  className="w-44"
                  disabled={ci.executing || !!jsonError}
                  onClick={() => {
                    if (ready()) void ci.openCallReview();
                  }}
                >
                  {t("contracts.interact.reviewCall")}
                </Btn>
              </>
            ) : m.mutates ? (
              <>
                <span className="inline-flex items-center gap-2 text-meta text-content-muted">
                  {t("sendFlow.networkFee")}
                  <FeePicker quote={ci.feeQuote} ou={ci.ou} onChange={ci.setOU} />
                </span>
                <span className="min-w-0 flex-1 truncate text-meta text-danger">
                  {missing.length > 0
                    ? t("contracts.interact.missing", { names: missing.join(", ") })
                    : ""}
                </span>
                <Btn
                  weight="primary"
                  className="w-44"
                  disabled={ci.executing || !!jsonError}
                  onClick={() => {
                    if (ready()) void ci.openCallReview();
                  }}
                >
                  {t("contracts.interact.reviewCall")}
                </Btn>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-meta text-danger">
                  {missing.length > 0
                    ? t("contracts.interact.missing", { names: missing.join(", ") })
                    : ""}
                </span>
                <Btn
                  weight="primary"
                  className="w-44"
                  disabled={ci.executing || !!jsonError}
                  onClick={() => {
                    if (ready()) void ci.executeView();
                  }}
                >
                  {t("contracts.interact.run")}
                </Btn>
              </>
            )}
          </div>
        )}
      </div>

      <TransactionAuthModal
        isOpen={ci.auth.isOpen}
        onResult={ci.auth.handleResult}
        title={ci.auth.title}
      />
      <ReviewPopup
        open={!!rv}
        label={t("contracts.interact.reviewTitle")}
        caption={t("contracts.interact.reviewTitle")}
        verb={t("contracts.interact.call")}
        onReject={ci.closeCallReview}
        onConfirm={() => void ci.confirmCall()}
        confirmDisabled={ci.feeQuote.status !== "ok" || !ci.ou}
        busy={ci.checkingFee}
        error={ci.reviewError}
      >
        {rv && (
          <>
            <KV label={t("contracts.interact.from")}>{activeWallet?.name ?? ""}</KV>
            <KV label={t("contracts.interact.contract")}>
              <span className="max-w-70 truncate font-mono text-meta">{rv.contract}</span>
            </KV>
            <KV label={t("contracts.interact.method")}>
              <span className="font-mono text-meta">{rv.method}</span>
            </KV>
            {rv.params.map((v, i) => (
              <KV
                key={i}
                label={<span className="font-mono">{m?.params[i]?.name ?? `#${i + 1}`}</span>}
              >
                <span className="max-w-70 truncate font-mono text-meta">
                  {ci.params.encryptFlags[i] && !ci.params.useRawJson
                    ? `${t("contracts.interact.encrypted")} ${show(v).slice(0, 12)}...`
                    : show(v)}
                </span>
              </KV>
            ))}
            <KV label={t("sendFlow.amount")}>{formatOCT(Number(rv.amountRaw))} OCT</KV>
            <KV label={t("sendFlow.networkFee")}>
              <FeePicker
                quote={ci.feeQuote}
                ou={ci.ou}
                onChange={ci.setOU}
                disabled={ci.checkingFee}
              />
            </KV>
          </>
        )}
      </ReviewPopup>
    </div>
  );
}
