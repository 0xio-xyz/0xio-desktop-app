import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import { Action } from "src/shared/ui/flat";
import { useWallet } from "src/contexts/useWallet";
import { detectChain, jsonRpcCallAt } from "src/services/network/networkService";
import { RpcError } from "src/services/network/submitErrors";
import { saveCustomNetworks } from "src/services/network/config";
import type { NetworkConfig } from "src/types/network";
import { FOCUS, Group, Row, SubPage, Toggle } from "src/features/settings/components/parts";
import { NETWORK_COLORS, normalizeRpcBase } from "src/features/settings/screens/constants";

const FIELD =
  "h-8 w-72 rounded-full bg-surface-highlight px-3.5 text-[0.8125rem] text-content outline-none placeholder:text-content-muted focus-visible:ring-2 focus-visible:ring-accent";

function Field({
  value,
  onChange,
  placeholder,
  label,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  mono?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      className={`${FIELD} ${mono ? "font-mono" : ""}`}
    />
  );
}

export default function NetworkFormPage({
  editing,
  custom,
  onSaved,
  onBack,
}: {
  editing: NetworkConfig | null;
  custom: NetworkConfig[];
  onSaved: (next: NetworkConfig[], switchTo?: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { networkId, activeWallet, showMessage } = useWallet();
  const [form, setForm] = useState({
    name: editing?.name ?? "",
    rpcUrl: editing?.rpcUrl ?? "",
    explorerUrl: editing?.explorerUrl ?? "",
    explorerAddressUrl: editing?.explorerAddressUrl ?? "",
    indexerUrl: editing?.indexerUrl ?? "",
    supportsPrivacy: editing?.supportsPrivacy ?? false,
    color: editing?.color ?? NETWORK_COLORS[0],
  });
  const [checking, setChecking] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (!form.name.trim() || !form.rpcUrl.trim()) return;
    const rpcUrl = normalizeRpcBase(form.rpcUrl);
    setChecking(true);
    try {
      const fee = await jsonRpcCallAt<unknown>(`${rpcUrl}/rpc`, "octra_recommendedFee", [], {
        once: true,
      });
      if (!fee) {
        showMessage("error", t("settings.notOctraRpc"));
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showMessage(
        "error",
        e instanceof RpcError && e.code !== undefined
          ? msg
          : t("settings.rpcUnreachable", { url: `${rpcUrl}/rpc`, error: msg }),
      );
      return;
    } finally {
      setChecking(false);
    }

    if (!editing) {
      try {
        const chain = await detectChain(rpcUrl, activeWallet?.address ?? "");
        if (chain === "mainnet" || chain === "devnet") {
          showMessage("info", t("settings.respondsLike", { chain }));
        }
      } catch {}
    }

    const id = editing && editing.rpcUrl === rpcUrl ? editing.id : `custom_${Date.now()}`;
    const indexer = form.indexerUrl.trim().replace(/\/$/, "");
    const net: NetworkConfig = {
      id,
      name: form.name.trim(),
      rpcUrl,
      explorerUrl: form.explorerUrl.trim() || (indexer ? `${indexer}/tx.html?hash=` : ""),
      explorerAddressUrl:
        form.explorerAddressUrl.trim() || (indexer ? `${indexer}/address.html?addr=` : ""),
      indexerUrl: indexer,
      supportsPrivacy: form.supportsPrivacy,
      color: form.color,
    };
    const next = editing ? custom.map((n) => (n.id === editing.id ? net : n)) : [...custom, net];
    saveCustomNetworks(next);
    onSaved(next, editing && id !== editing.id && networkId === editing.id ? id : undefined);
  };

  const remove = () => {
    if (!editing) return;
    const next = custom.filter((n) => n.id !== editing.id);
    saveCustomNetworks(next);
    onSaved(next, networkId === editing.id ? "mainnet" : undefined);
  };

  const ready = !!form.name.trim() && !!form.rpcUrl.trim() && !checking;

  return (
    <SubPage
      title={editing ? t("settings.editNetwork") : t("settings.addNetwork")}
      onBack={onBack}
      backLabel={t("common.back")}
    >
      <form
        className="flex flex-col gap-6.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void save();
        }}
      >
        <Group>
          <Row label={t("settings.networkName")}>
            <Field
              value={form.name}
              onChange={(name) => set({ name })}
              placeholder={t("settings.networkNamePlaceholder")}
              label={t("settings.networkName")}
            />
          </Row>
          <Row
            label={t("settings.rpcUrl")}
            sub={
              form.rpcUrl.trim()
                ? t("settings.requestsTo", { url: `${normalizeRpcBase(form.rpcUrl)}/rpc` })
                : undefined
            }
          >
            <Field
              value={form.rpcUrl}
              onChange={(rpcUrl) => set({ rpcUrl })}
              placeholder="http://127.0.0.1:8080"
              label={t("settings.rpcUrl")}
              mono
            />
          </Row>
          <Row label={t("settings.explorerUrl")}>
            <Field
              value={form.explorerUrl}
              onChange={(explorerUrl) => set({ explorerUrl })}
              placeholder="https://explorer.example.com/tx.html?hash="
              label={t("settings.explorerUrl")}
              mono
            />
          </Row>
          <Row label={t("settings.addressExplorerUrl")}>
            <Field
              value={form.explorerAddressUrl}
              onChange={(explorerAddressUrl) => set({ explorerAddressUrl })}
              placeholder="https://explorer.example.com/address.html?addr="
              label={t("settings.addressExplorerUrl")}
              mono
            />
          </Row>
          <Row label={t("settings.indexerUrl")}>
            <Field
              value={form.indexerUrl}
              onChange={(indexerUrl) => set({ indexerUrl })}
              placeholder="https://explorer.example.com"
              label={t("settings.indexerUrl")}
              mono
            />
          </Row>
        </Group>

        <Group>
          <Row label={t("settings.supportsPrivacy")}>
            <Toggle
              on={form.supportsPrivacy}
              label={t("settings.supportsPrivacy")}
              onChange={(supportsPrivacy) => set({ supportsPrivacy })}
            />
          </Row>
          <Row label={t("settings.colour")}>
            <span className="flex items-center gap-0.5">
              {NETWORK_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  aria-pressed={form.color === c}
                  onClick={() => set({ color: c })}
                  className={`grid size-7.5 cursor-pointer place-items-center rounded-[10px] transition-colors duration-200 ease-out ${FOCUS} ${form.color === c ? "bg-(--bg-3)" : "hover:bg-surface-highlight"}`}
                >
                  <span className="block size-4.5 rounded-full" style={{ backgroundColor: c }} />
                </button>
              ))}
            </span>
          </Row>
          {editing && <Row label={t("settings.removeNetwork")} negative onClick={remove} />}
        </Group>

        <p className="px-4.5 text-meta leading-relaxed text-content-muted">
          {t("settings.customRpcNote")}
        </p>

        <div className="flex gap-2.5">
          <Action type="button" weight="raised" full onClick={onBack}>
            {t("common.cancel")}
          </Action>
          <Action type="submit" weight="primary" full disabled={!ready}>
            {checking
              ? t("settings.checkingRpc")
              : editing
                ? t("settings.saveChanges")
                : t("settings.addNetwork")}
          </Action>
        </div>
      </form>
    </SubPage>
  );
}
