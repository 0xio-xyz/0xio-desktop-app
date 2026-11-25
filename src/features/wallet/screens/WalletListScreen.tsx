import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "src/lib/query";
import { useTranslation } from "src/i18n/react";
import { useNavigate } from "src/lib/router";
import { Wallet, Trash2, Eye, MoreVertical, GitBranch } from "src/shared/ui/icons";
import Button from "src/shared/ui/Button";
import Input from "src/shared/ui/Input";
import Modal from "src/shared/ui/Modal";
import EmptyState from "src/shared/ui/EmptyState";
import PasswordPrompt from "src/features/wallet/components/PasswordPrompt";
import AccountScan from "src/features/wallet/components/AccountScan";
import SetPasswordForm from "src/features/security/components/SetPasswordForm";
import { authErrorText } from "src/features/security/components/PhraseReveal";
import { useCopied } from "src/features/security/components/SecretSurface";
import {
  BACKUP_ROUTE,
  backupLink,
  walletNeedsBackup,
  walletSecrets,
  type WalletSecret,
} from "src/hooks/wallet/useNeedsBackup";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Btn, EASE, FOCUS, KV } from "src/shared/ui/look";
import { truncateAddress } from "src/lib/format";
import { Screen, PageTitle, Action, ScrollArea } from "src/shared/ui/flat";
import { useWallet, type WalletData } from "src/contexts/useWallet";
import { NETWORKS } from "src/services/network/config";
import { walletBridge } from "src/services/wallet/walletBridge";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { logger } from "src/lib/logger";

type ModalType =
  | "none"
  | "addWallet"
  | "importInput"
  | "importPassword"
  | "createPassword"
  | "deleteConfirm"
  | "deletePassword"
  | "watchInput"
  | "derivePassword"
  | "deriveIndex"
  | "setPassword";

type KeyAdd = "create" | "import" | "derive";

function kindLabel(w: WalletData, t: (k: string) => string): string {
  if (w.wallet_type === "watch") return t("wallet.kindWatch");
  return w.source === "private_key" ? t("wallet.kindKey") : t("wallet.kindHd");
}

function WalletMenu({
  wallet,
  onSecret,
  onDelete,
}: {
  wallet: WalletData;
  onSecret: (kind: WalletSecret) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = `flex h-9 w-full cursor-pointer items-center rounded-[10px] px-3 text-left text-body whitespace-nowrap hover:bg-(--bg-3) ${EASE} ${FOCUS}`;
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`grid size-8 cursor-pointer place-items-center rounded-full text-content-muted hover:bg-(--bg-3) hover:text-content ${EASE} ${FOCUS}`}
        aria-label={t("wallet.walletOptions")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreVertical size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className="look-raise absolute top-full right-0 z-10 mt-1 min-w-44 rounded-[14px] bg-surface-highlight p-1 animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none"
        >
          {walletSecrets(wallet).map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className={`${item} text-content`}
              onClick={pick(() => onSecret(kind))}
            >
              {t(kind === "phrase" ? "secret.phrase" : "secret.key")}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className={`${item} text-danger`}
            onClick={pick(onDelete)}
          >
            {t("wallet.deleteWallet")}
          </button>
        </div>
      )}
    </div>
  );
}

function CopyLine({
  label,
  copyLabel,
  value,
}: {
  label: string;
  copyLabel: string;
  value: string;
}) {
  const { t } = useTranslation();
  const { copied, flash } = useCopied();
  return (
    <div className="mt-3">
      <div className="text-[0.84375rem] text-content-muted">{label}</div>
      <div className="mt-1.5 flex min-h-14 items-center gap-1.5 rounded-[14px] bg-surface-highlight py-2 pr-1.5 pl-3.5">
        <span className="min-w-0 flex-1 font-mono text-meta break-all text-content">{value}</span>
        <button
          type="button"
          aria-label={copyLabel}
          disabled={!value}
          onClick={() => {
            void navigator.clipboard
              .writeText(value)
              .then(flash)
              .catch(() => {});
          }}
          className={`h-8 w-17 shrink-0 cursor-pointer rounded-full text-meta font-semibold text-content-secondary hover:bg-(--bg-3) hover:text-content disabled:cursor-default disabled:opacity-40 ${EASE} ${FOCUS}`}
        >
          {copied ? t("backup.copied") : t("backup.copy")}
        </button>
      </div>
    </div>
  );
}

export default function WalletListScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    wallets,
    refreshWallets,
    showMessage,
    setIsInitialized,
    setIsLocked,
    setActiveWallet,
    setWallets: setWalletsCtx,
    networkId,
  } = useWallet();
  const queryClient = useQueryClient();

  const [modal, setModal] = useState<ModalType>("none");
  const [targetWalletId, setTargetWalletId] = useState<string | null>(null);
  const [importKey, setImportKey] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked =
    wallets.find((w) => w.id === pickedId) ??
    wallets.find((w) => w.is_active) ??
    wallets[0] ??
    null;
  const pickedKeyId = picked && picked.wallet_type !== "watch" ? picked.id : null;
  const { data: pickedPublicKey = "" } = useQuery({
    queryKey: ["walletPublicKey", pickedKeyId, picked?.address],
    queryFn: () => walletBridge.getPublicKey(pickedKeyId!),
    enabled: !!pickedKeyId,
    staleTime: Infinity,
  });
  const [loading, setLoading] = useState(false);
  const [hasPassword, setHasPassword] = useState(true);
  const passwordFailure = (err: unknown) =>
    authErrorText(err, t) ?? (err instanceof Error ? err.message : String(err));
  const [pendingAdd, setPendingAdd] = useState<KeyAdd | null>(null);
  const [watchAddress, setWatchAddress] = useState("");
  const [deriveIndex, setDeriveIndex] = useState(1);

  useEffect(() => {
    walletBridge
      .hasPassword()
      .then(setHasPassword)
      .catch(() => {});
  }, []);

  const closeModal = useCallback(() => {
    setModal("none");
    setTargetWalletId(null);
    setPasswordError("");
    setImportKey("");
    setWatchAddress("");
  }, []);

  const handleSwitch = useCallback(
    async (wallet: WalletData) => {
      logger.info("wallet", `Switch clicked: ${wallet.name} (${wallet.id.slice(0, 8)})`);
      try {
        pvacBridge.destroy().catch(() => {});
        const start = performance.now();
        await walletBridge.setActive(wallet.id);
        logger.info(
          "wallet",
          `wallet_set_active completed in ${Math.round(performance.now() - start)}ms`,
        );
        refreshWallets(wallets.map((w) => ({ ...w, is_active: w.id === wallet.id })));
      } catch (err: unknown) {
        showMessage("error", err instanceof Error ? err.message : t("wallet.switchFailed"));
      }
    },
    [wallets, refreshWallets, showMessage],
  );

  const handleRename = useCallback(
    async (id: string) => {
      if (!newName.trim()) {
        setRenamingId(null);
        return;
      }
      try {
        await walletBridge.rename(id, newName.trim());
        refreshWallets(wallets.map((w) => (w.id === id ? { ...w, name: newName.trim() } : w)));
        showMessage("success", t("wallet.walletRenamed"));
      } catch (err: unknown) {
        showMessage("error", err instanceof Error ? err.message : t("wallet.renameFailed"));
      }
      setRenamingId(null);
    },
    [newName, wallets, refreshWallets, showMessage],
  );

  const handleImportWithPassword = useCallback(
    async (password: string) => {
      if (!importKey.trim()) return;
      setPasswordError("");
      try {
        const wallet = await walletBridge.importPrivateKey(importKey.trim(), password);
        refreshWallets([
          ...wallets.map((w) => ({ ...w, is_active: false })),
          { ...wallet, is_active: true },
        ]);
        closeModal();
      } catch (err: unknown) {
        setPasswordError(passwordFailure(err));
      }
    },
    [importKey, wallets, refreshWallets, showMessage, closeModal],
  );

  // Rust keeps the phrase and the backup runs later from Home. A wallet made under the seal goes
  // straight to its one showing, then the seal.
  const handleCreateWallet = useCallback(
    async (password: string) => {
      setPasswordError("");
      setLoading(true);
      try {
        const wallet = await walletBridge.createAdditional(password);
        refreshWallets([...wallets.map((w) => ({ ...w, is_active: false })), wallet]);
        closeModal();
        navigate(wallet.seal_pending ? BACKUP_ROUTE : "/");
      } catch (err: unknown) {
        setPasswordError(passwordFailure(err));
      } finally {
        setLoading(false);
      }
    },
    [wallets, refreshWallets, closeModal, navigate],
  );

  const handleWatchAddress = useCallback(async () => {
    const addr = watchAddress.trim();
    if (!addr.startsWith("oct") || addr.length !== 47) return;
    setLoading(true);
    try {
      const wallet = await walletBridge.importAddress(addr);
      refreshWallets([
        ...wallets.map((w) => ({ ...w, is_active: false })),
        { ...wallet, is_active: true },
      ]);
      closeModal();
      showMessage("success", t("wallet.watchAddressAdded"));
    } catch (err: unknown) {
      showMessage("error", err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [watchAddress, wallets, refreshWallets, showMessage, closeModal]);

  const handleDeriveAccount = useCallback(
    async (password: string) => {
      if (!targetWalletId) return;
      setPasswordError("");
      setLoading(true);
      try {
        const wallet = await walletBridge.deriveAccount(targetWalletId, password, deriveIndex);
        refreshWallets([
          ...wallets.map((w) => ({ ...w, is_active: false })),
          { ...wallet, is_active: true },
        ]);
        closeModal();
        showMessage("success", t("wallet.derivedSuccess", { index: deriveIndex }));
      } catch (err: unknown) {
        setPasswordError(passwordFailure(err));
      } finally {
        setLoading(false);
      }
    },
    [targetWalletId, deriveIndex, wallets, refreshWallets, showMessage, closeModal, t],
  );

  const handleDelete = useCallback(async () => {
    if (!targetWalletId) return;
    setLoading(true);
    try {
      const updatedWallets = await walletBridge.delete(targetWalletId);

      const deletedWallet = wallets.find((w) => w.id === targetWalletId);
      if (deletedWallet) {
        const addr = deletedWallet.address.toLowerCase();
        const keysToRemove = Object.keys(localStorage).filter(
          (k) => k.includes(addr) || k.includes(targetWalletId),
        );
        keysToRemove.forEach((k) => localStorage.removeItem(k));
        queryClient.removeQueries({ queryKey: ["transactionHistory"] });
        queryClient.removeQueries({ queryKey: ["walletBalance"] });
      }

      const wList = updatedWallets as WalletData[];
      if (wList.length === 0) {
        setWalletsCtx([]);
        setActiveWallet(null);
        setIsInitialized(false);
        setIsLocked(false);
        closeModal();
        navigate("/onboarding");
        return;
      }
      refreshWallets(wList);
      closeModal();
      showMessage("success", t("wallet.walletDeleted"));
    } catch (err: unknown) {
      showMessage("error", err instanceof Error ? err.message : String(err));
      closeModal();
    } finally {
      setLoading(false);
    }
  }, [
    targetWalletId,
    refreshWallets,
    showMessage,
    closeModal,
    setWalletsCtx,
    setActiveWallet,
    setIsInitialized,
    setIsLocked,
    navigate,
  ]);

  const handleDeleteWithPassword = useCallback(
    async (password: string) => {
      if (!targetWalletId) return;
      setPasswordError("");
      setLoading(true);
      try {
        await walletBridge.verifyPassword(password);
      } catch (err: unknown) {
        setPasswordError(authErrorText(err, t) ?? t("wallet.deleteFailed"));
        return;
      } finally {
        setLoading(false);
      }
      await handleDelete();
    },
    [targetWalletId, handleDelete],
  );

  const targetWallet = wallets.find((w) => w.id === targetWalletId);

  const keyAddHandlers: Record<KeyAdd, (password: string) => Promise<void>> = {
    create: handleCreateWallet,
    import: handleImportWithPassword,
    derive: handleDeriveAccount,
  };
  const passwordModals: Record<KeyAdd, ModalType> = {
    create: "createPassword",
    import: "importPassword",
    derive: "derivePassword",
  };

  const addWithKey = (add: KeyAdd) => {
    if (hasPassword) {
      setModal(passwordModals[add]);
      return;
    }
    setPendingAdd(add);
    setModal("setPassword");
  };

  const passwordHandler =
    modal === "importPassword"
      ? handleImportWithPassword
      : modal === "createPassword"
        ? handleCreateWallet
        : modal === "derivePassword"
          ? handleDeriveAccount
          : modal === "deletePassword"
            ? handleDeleteWithPassword
            : null;

  useEffect(() => {
    if (passwordError && !passwordHandler) {
      showMessage("error", passwordError);
      setPasswordError("");
    }
  }, [passwordError, passwordHandler, showMessage]);

  return (
    <Screen>
      <PageTitle
        title={t("wallet.wallets")}
        right={
          <Action weight="primary" onClick={() => setModal("addWallet")}>
            {t("wallet.addWallet")}
          </Action>
        }
      />

      <div className="mt-6 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(17.5rem,0.6fr)] gap-7">
        <ScrollArea fade>
          {wallets.length === 0 ? (
            <div className="py-10">
              <EmptyState icon={Wallet} title={t("wallet.noWallets")} />
            </div>
          ) : (
            <div className="space-y-0.5">
              {wallets.map((wallet) => (
                <div
                  key={wallet.id}
                  onClick={() => renamingId !== wallet.id && setPickedId(wallet.id)}
                  aria-current={picked?.id === wallet.id ? "true" : undefined}
                  className={`flex h-17 cursor-pointer items-center gap-3.5 rounded-2xl px-4 transition-colors duration-200 ${
                    picked?.id === wallet.id ? "bg-surface-highlight" : "hover:bg-surface-highlight"
                  }`}
                >
                  <WalletAvatar address={wallet.address} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex h-6 min-w-0 items-center gap-2">
                      {renamingId === wallet.id ? (
                        <input
                          className="h-7 w-44 rounded-xl border-0 bg-surface-card px-3 py-0 text-body font-semibold text-content outline-none"
                          value={newName}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setNewName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRename(wallet.id);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          onBlur={() => handleRename(wallet.id)}
                          aria-label={t("wallet.rename")}
                          autoFocus
                        />
                      ) : (
                        <>
                          <span className="truncate text-body font-semibold text-content">
                            {wallet.name}
                          </span>
                          {wallet.is_active && (
                            <span className="shrink-0 rounded-full bg-(--bg-3) px-2 py-0.5 text-micro text-content-secondary">
                              {t("wallet.active")}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-micro text-content-muted">
                      <span className="font-mono">{truncateAddress(wallet.address, 12, 8)}</span>
                      <span className="ml-2">{kindLabel(wallet, t)}</span>
                    </p>
                  </div>
                  <div
                    className="flex shrink-0 items-center gap-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {!wallet.is_active && (
                      <Action onClick={() => handleSwitch(wallet)} className="py-2 text-meta">
                        {t("wallet.switch")}
                      </Action>
                    )}
                    <WalletMenu
                      wallet={wallet}
                      onSecret={(kind) => navigate(backupLink(wallet.id, kind))}
                      onDelete={() => {
                        setTargetWalletId(wallet.id);
                        setModal("deleteConfirm");
                      }}
                    />
                  </div>
                </div>
              ))}

              {wallets.some((w) => w.source === "mnemonic") && (
                <button
                  onClick={() => setModal("deriveIndex")}
                  className="flex h-17 w-full cursor-pointer items-center gap-3.5 rounded-2xl px-4 text-left transition-colors duration-200 hover:bg-surface-highlight"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-highlight text-content-secondary">
                    <GitBranch size={15} />
                  </span>
                  <p className="min-w-0 text-body font-semibold text-content">
                    {t("wallet.deriveAccount")}
                  </p>
                </button>
              )}
            </div>
          )}
        </ScrollArea>

        <aside className="look-raise flex min-h-0 flex-col overflow-y-auto rounded-[22px] bg-surface-card px-6 py-5.5 scrollbar-hide">
          {picked && (
            <>
              <div className="flex items-center gap-3">
                <WalletAvatar address={picked.address} size={40} />
                <div className="min-w-0">
                  <div className="truncate text-lead font-semibold text-content">{picked.name}</div>
                  <div className="mt-0.5 text-meta text-content-muted">{kindLabel(picked, t)}</div>
                </div>
              </div>
              <div className="mt-5">
                <KV label={t("wallet.backupLabel")}>
                  {picked.wallet_type === "watch"
                    ? t("wallet.backupNone")
                    : walletNeedsBackup(picked)
                      ? t("wallet.notBackedUp")
                      : t("wallet.backedUp")}
                </KV>
                <KV label={t("wallet.added")}>
                  {picked.created_at
                    ? new Date(
                        picked.created_at < 1e12 ? picked.created_at * 1000 : picked.created_at,
                      ).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })
                    : ""}
                </KV>
                <KV label={t("wallet.network")}>{NETWORKS[networkId]?.name ?? networkId}</KV>
                <CopyLine
                  key={picked.id}
                  label={t("wallet.address")}
                  copyLabel={t("wallet.copyAddress")}
                  value={picked.address}
                />
                {pickedKeyId && (
                  <CopyLine
                    key={`${picked.id}:public`}
                    label={t("wallet.publicKey")}
                    copyLabel={t("wallet.copyPublicKey")}
                    value={pickedPublicKey}
                  />
                )}
              </div>
              <span className="min-h-6 flex-1" />
              <div className="flex flex-wrap gap-2">
                {!picked.is_active && (
                  <Btn
                    size="sm"
                    weight="primary"
                    className="look-key"
                    onClick={() => handleSwitch(picked)}
                  >
                    {t("wallet.switch")}
                  </Btn>
                )}
                {picked.wallet_type !== "watch" && walletNeedsBackup(picked) && (
                  <Btn size="sm" onClick={() => navigate(backupLink(picked.id))}>
                    {t("wallet.backUp")}
                  </Btn>
                )}
                <Btn
                  size="sm"
                  onClick={() => {
                    setRenamingId(picked.id);
                    setNewName(picked.name);
                  }}
                >
                  {t("wallet.rename")}
                </Btn>
                {walletSecrets(picked).map((kind) => (
                  <Btn key={kind} size="sm" onClick={() => navigate(backupLink(picked.id, kind))}>
                    {t(kind === "phrase" ? "secret.phrase" : "secret.key")}
                  </Btn>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>

      <Modal
        isOpen={modal === "addWallet"}
        onClose={closeModal}
        title={t("createImport.addWallet")}
      >
        <div className="space-y-1">
          {[
            {
              id: "create",
              title: t("wallet.createWallet"),
              run: () => addWithKey("create"),
            },
            {
              id: "import",
              title: t("wallet.importWallet"),
              run: () => setModal("importInput"),
            },
            {
              id: "watch",
              title: t("wallet.watchAddress"),
              run: () => setModal("watchInput"),
            },
            ...(wallets.some((w) => w.source === "mnemonic")
              ? [
                  {
                    id: "derive",
                    title: t("wallet.deriveAccount"),
                    run: () => setModal("deriveIndex"),
                  },
                ]
              : []),
          ].map((choice) => (
            <button
              key={choice.id}
              onClick={choice.run}
              className="w-full rounded-2xl bg-surface px-5 py-4 text-left hover:bg-surface-highlight transition-colors cursor-pointer"
            >
              <p className="text-body font-semibold text-content">{choice.title}</p>
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        isOpen={modal === "importInput"}
        onClose={closeModal}
        title={t("wallet.importPrivateKeyTitle")}
      >
        <div className="space-y-3">
          <Input
            label={t("wallet.privateKeyBase64")}
            placeholder={t("wallet.enterPrivateKey")}
            value={importKey}
            onChange={(e) => setImportKey(e.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="secondary" fullWidth onClick={closeModal}>
              {t("common.cancel")}
            </Button>
            <Button fullWidth onClick={() => addWithKey("import")} disabled={!importKey.trim()}>
              {t("wallet.continue")}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={modal === "watchInput"} onClose={closeModal} title={t("wallet.watchAddress")}>
        <div className="space-y-3">
          <Input
            label={t("wallet.publicAddress")}
            placeholder={t("wallet.addressPlaceholder")}
            value={watchAddress}
            onChange={(e) => setWatchAddress(e.target.value.trim())}
            error={
              watchAddress && (!watchAddress.startsWith("oct") || watchAddress.length !== 47)
                ? t("wallet.invalidAddressFormat")
                : undefined
            }
          />
          <div className="flex gap-2">
            <Button variant="secondary" fullWidth onClick={closeModal}>
              {t("common.cancel")}
            </Button>
            <Button
              fullWidth
              onClick={handleWatchAddress}
              disabled={!watchAddress.startsWith("oct") || watchAddress.length !== 47}
              loading={loading}
            >
              <Eye size={14} className="mr-1" /> {t("wallet.startWatching")}
            </Button>
          </div>
        </div>
      </Modal>

      {(modal === "deriveIndex" || modal === "derivePassword") && (
        <AccountScan
          wallets={wallets.filter((w) => w.source === "mnemonic")}
          networkId={networkId}
          hasPassword={hasPassword}
          held={modal === "derivePassword"}
          onAdd={(parentId, index) => {
            setTargetWalletId(parentId);
            setDeriveIndex(index);
            addWithKey("derive");
          }}
          onClose={closeModal}
        />
      )}

      {passwordHandler && (
        <PasswordPrompt
          isOpen
          onSubmit={passwordHandler}
          onCancel={
            modal === "derivePassword"
              ? () => {
                  setPasswordError("");
                  setModal("deriveIndex");
                }
              : closeModal
          }
          error={passwordError}
          busy={loading}
          title={modal === "deletePassword" ? t("wallet.deleteWallet") : undefined}
        />
      )}

      <Modal
        isOpen={modal === "setPassword"}
        onClose={() => {
          setPendingAdd(null);
          closeModal();
        }}
        title={t("addWallet.passwordTitle")}
        hideClose
      >
        <SetPasswordForm
          onSet={async (password) => {
            const add = pendingAdd;
            setHasPassword(true);
            setPendingAdd(null);
            setModal("none");
            if (add) await keyAddHandlers[add](password);
            setImportKey("");
          }}
        />
      </Modal>

      <Modal
        isOpen={modal === "deleteConfirm"}
        onClose={closeModal}
        title={t("wallet.deleteWallet")}
      >
        <div className="space-y-4">
          <p className="text-sm text-content-secondary">
            {t("wallet.deleteConfirmDesc", { name: targetWallet?.name })}
          </p>
          <div className="flex gap-3">
            <Button variant="secondary" fullWidth onClick={closeModal}>
              {t("common.cancel")}
            </Button>
            <Button
              fullWidth
              onClick={hasPassword ? () => setModal("deletePassword") : handleDelete}
              loading={loading}
            >
              <Trash2 size={14} className="mr-1" /> {t("common.delete")}
            </Button>
          </div>
        </div>
      </Modal>
    </Screen>
  );
}
