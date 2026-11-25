import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { logger } from "src/lib/logger";
import { Search, Star } from "src/shared/ui/icons";
import Button from "src/shared/ui/Button";
import Input from "src/shared/ui/Input";
import Modal from "src/shared/ui/Modal";
import { Screen, PageTitle, Action, ScrollArea } from "src/shared/ui/flat";
import { Btn, EASE, FOCUS, KV } from "src/shared/ui/look";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import NamedAddress from "src/shared/ui/NamedAddress";
import { truncateAddress } from "src/lib/format";
import { NETWORKS } from "src/services/network/config";
import { useWallet } from "src/contexts/useWallet";
import {
  getContacts,
  addContact,
  updateContact,
  deleteContact,
  toggleFavorite,
  getAllTags,
  parseContactsCsv,
  exportContactsCsv,
  isValidAddress,
  INTERNAL_TAG,
  type Contact,
} from "src/services/storage/addressBookService";

function FavoriteStar({
  on,
  onToggle,
  size,
  className = "",
}: {
  on: boolean;
  onToggle: () => void;
  size: number;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-label={t(on ? "addressBook.removeFavorite" : "addressBook.addFavorite")}
      className={`grid size-8 shrink-0 cursor-pointer place-items-center rounded-full transition-[opacity,color,background-color] duration-200 ease-out hover:bg-(--bg-3) motion-reduce:transition-none ${FOCUS} ${on ? "text-content" : "text-content-muted"} ${className}`}
    >
      <Star size={size} filled={on} />
    </button>
  );
}

export default function AddressBookScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { networkId, showMessage } = useWallet();
  const [contacts, setContacts] = useState(() => getContacts(networkId));
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showModal, setShowModal] = useState<"add" | "edit" | null>(null);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);

  const [formLabel, setFormLabel] = useState("");
  const [formAddress, setFormAddress] = useState("");
  const [formTags, setFormTags] = useState("");
  const [formNotes, setFormNotes] = useState("");

  const allTags = useMemo(
    () => getAllTags(networkId).filter((t) => t !== INTERNAL_TAG),
    [contacts, networkId],
  );

  const filtered = useMemo(() => {
    let list = contacts;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (c) =>
          c.label.toLowerCase().includes(q) ||
          c.address.toLowerCase().includes(q) ||
          c.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (tagFilter === INTERNAL_TAG) {
      list = list.filter((c) => c.tags.includes(INTERNAL_TAG));
    } else if (tagFilter === "__external__") {
      list = list.filter((c) => !c.tags.includes(INTERNAL_TAG));
    } else if (tagFilter) {
      list = list.filter((c) => c.tags.includes(tagFilter));
    }
    return [...list].sort((a, b) => {
      if (!!a.isFavorite !== !!b.isFavorite) return a.isFavorite ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [contacts, search, tagFilter]);
  const picked = filtered.find((c) => c.id === pickedId) ?? filtered[0] ?? null;
  const pickedInternal = !!picked?.tags.includes(INTERNAL_TAG);
  const pickedTags = picked ? picked.tags.filter((tag) => tag !== INTERNAL_TAG) : [];

  const reload = useCallback(() => setContacts(getContacts(networkId)), [networkId]);

  const resetForm = useCallback(() => {
    setFormLabel("");
    setFormAddress("");
    setFormTags("");
    setFormNotes("");
    setEditingContact(null);
    setShowModal(null);
  }, []);

  const openEdit = useCallback((contact: Contact) => {
    setEditingContact(contact);
    setFormLabel(contact.label);
    setFormAddress(contact.address);
    setFormTags(contact.tags.join(", "));
    setFormNotes(contact.notes || "");
    setShowModal("edit");
  }, []);

  const handleSave = useCallback(() => {
    const address = formAddress.trim();
    if (!formLabel.trim() || !address) return;
    if (!isValidAddress(address)) {
      showMessage("error", t("addressBook.invalidPrefix"));
      return;
    }
    const tags = formTags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t && t !== INTERNAL_TAG);

    try {
      if (showModal === "edit" && editingContact) {
        updateContact(networkId, editingContact.id, {
          label: formLabel.trim(),
          address,
          tags,
          notes: formNotes.trim() || undefined,
        });
        logger.info("addressbook", `edit - id=${editingContact.id} label=${formLabel.trim()}`);
        showMessage("success", t("addressBook.contactUpdated"));
      } else {
        addContact(networkId, {
          label: formLabel.trim(),
          address,
          tags,
          notes: formNotes.trim() || undefined,
        });
        logger.info(
          "addressbook",
          `add - label=${formLabel.trim()} addr=${address.slice(0, 12)}...`,
        );
        showMessage("success", t("addressBook.contactSaved"));
      }
    } catch (err) {
      showMessage("error", err instanceof Error ? err.message : t("addressBook.saveFailed"));
      return;
    }
    reload();
    resetForm();
  }, [
    formLabel,
    formAddress,
    formTags,
    formNotes,
    showModal,
    editingContact,
    networkId,
    showMessage,
    reload,
    resetForm,
    t,
  ]);

  const handleToggleFavorite = useCallback(
    (id: string) => {
      toggleFavorite(networkId, id);
      reload();
    },
    [networkId, reload],
  );

  const handleCopy = useCallback(async (id: string, address: string) => {
    await navigator.clipboard.writeText(address);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
  }, []);

  const handleSend = useCallback(
    (address: string) => {
      navigate("/send", { state: { recipient: address } });
    },
    [navigate],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteContact(networkId, id);
      logger.info("addressbook", `delete - id=${id}`);
      setDeleteConfirm(null);
      reload();
      showMessage("info", t("addressBook.contactRemoved"));
    },
    [networkId, reload, showMessage],
  );

  const handleCsvImport = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = parseContactsCsv(reader.result as string);
        if (!parsed.length) {
          showMessage("error", t("addressBook.importFailed"));
          return;
        }
        let imported = 0;
        for (const c of parsed) {
          try {
            addContact(networkId, c);
            imported++;
          } catch {}
        }
        reload();
        logger.info("addressbook", `CSV import - ${imported}/${parsed.length} contacts`);
        showMessage(
          imported > 0 ? "success" : "info",
          t("addressBook.imported", { count: imported }),
        );
      };
      reader.readAsText(file);
    };
    input.click();
  }, [networkId, reload, showMessage]);

  const handleCsvExport = useCallback(() => {
    const csv = exportContactsCsv(contacts);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `0xio-contacts-${networkId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    logger.info("addressbook", `CSV export - ${contacts.length} contacts`);
    showMessage("success", t("addressBook.exported"));
  }, [contacts, networkId, showMessage]);

  return (
    <Screen>
      <PageTitle
        title={t("addressBook.title")}
        right={
          <div className="flex shrink-0 items-center gap-1">
            <Action weight="text" onClick={handleCsvImport} className="text-meta">
              {t("addressBook.importCsv")}
            </Action>
            <Action weight="text" onClick={handleCsvExport} className="text-meta">
              {t("addressBook.exportCsv")}
            </Action>
            <Action
              weight="primary"
              onClick={() => {
                resetForm();
                setShowModal("add");
              }}
            >
              {t("addressBook.addContact")}
            </Action>
          </div>
        }
      />

      <div className="mt-6 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(17.5rem,0.6fr)] gap-7">
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex shrink-0 items-center gap-2.5">
            <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-card px-4 transition-colors focus-within:bg-surface-highlight">
              <Search size={14} className="shrink-0 text-content-muted" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("addressBook.search")}
                aria-label={t("addressBook.search")}
                className="min-w-0 flex-1 border-0 bg-transparent text-meta text-content outline-none placeholder:text-content-muted"
              />
            </label>
            <div className="flex shrink-0 gap-0.5">
              {(
                [
                  { key: null, label: t("history.filter.all") },
                  { key: INTERNAL_TAG, label: t("addressBook.myWallets") },
                  { key: "__external__", label: t("addressBook.external") },
                  ...allTags.map((tag) => ({ key: tag, label: tag })),
                ] as Array<{ key: string | null; label: string }>
              ).map(({ key, label }) => (
                <button
                  key={key ?? "__all__"}
                  type="button"
                  aria-pressed={tagFilter === key}
                  onClick={() => setTagFilter(tagFilter === key ? null : key)}
                  className={`h-8 cursor-pointer rounded-full px-3 text-[0.8125rem] font-medium whitespace-nowrap ${EASE} ${FOCUS} ${
                    tagFilter === key
                      ? "bg-surface-highlight text-content"
                      : "text-content-muted hover:text-content"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <ScrollArea fade className="mt-3.5">
            <div className="space-y-0.5">
              {filtered.length === 0 ? (
                <div className="py-10 text-center text-meta text-content-muted">
                  {contacts.length > 0 && t("addressBook.noSearchResults")}
                </div>
              ) : (
                filtered.map((contact) => {
                  const isInternal = contact.tags.includes(INTERNAL_TAG);
                  return (
                    <div key={contact.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => setPickedId(contact.id)}
                        aria-current={picked?.id === contact.id ? "true" : undefined}
                        className={`flex h-16 w-full cursor-pointer items-center gap-3.5 rounded-2xl pr-14 pl-4 text-left transition-colors duration-200 ${FOCUS} ${
                          picked?.id === contact.id
                            ? "bg-surface-highlight"
                            : "hover:bg-surface-highlight"
                        }`}
                      >
                        <WalletAvatar address={contact.address} size={30} />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate text-body font-semibold text-content">
                              {contact.label}
                            </span>
                            <span className="shrink-0 text-micro text-content-muted">
                              {isInternal ? t("addressBook.yourWallet") : t("addressBook.external")}
                            </span>
                          </span>
                          <NamedAddress
                            address={contact.address}
                            networkId={networkId}
                            className="mt-0.5 flex font-mono text-micro text-content-muted"
                          >
                            {truncateAddress(contact.address, 16, 12)}
                          </NamedAddress>
                        </span>
                      </button>
                      <FavoriteStar
                        on={!!contact.isFavorite}
                        onToggle={() => handleToggleFavorite(contact.id)}
                        size={15}
                        className={`absolute top-1/2 right-3 -translate-y-1/2 ${contact.isFavorite ? "" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"}`}
                      />
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </div>

        <aside className="look-raise flex min-h-0 flex-col overflow-y-auto rounded-[22px] bg-surface-card px-6 py-5.5 scrollbar-hide">
          {picked ? (
            <>
              <div className="flex items-center gap-3">
                <WalletAvatar address={picked.address} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lead font-semibold text-content">
                    {picked.label}
                  </div>
                  <NamedAddress
                    key={picked.address}
                    address={picked.address}
                    networkId={networkId}
                    className="mt-0.5 flex text-meta text-content-muted"
                  >
                    {pickedInternal
                      ? t("addressBook.yourWallet")
                      : t("addressBook.externalContact")}
                  </NamedAddress>
                </div>
                <FavoriteStar
                  on={!!picked.isFavorite}
                  onToggle={() => handleToggleFavorite(picked.id)}
                  size={18}
                />
              </div>
              <p className="mt-4.5 font-mono text-meta leading-relaxed break-all text-content-secondary">
                {picked.address}
              </p>
              <div className="mt-2">
                <KV label={t("wallet.network")}>{NETWORKS[networkId]?.name ?? networkId}</KV>
                {pickedTags.length > 0 && (
                  <KV label={t("addressBook.tags")}>{pickedTags.join(" ")}</KV>
                )}
              </div>
              {picked.notes && (
                <p className="mt-2 text-meta leading-normal text-content-secondary">
                  {picked.notes}
                </p>
              )}
              <span className="min-h-6 flex-1" />
              <div className="flex flex-wrap gap-2">
                <Btn
                  size="sm"
                  weight="primary"
                  className="look-key"
                  onClick={() => handleSend(picked.address)}
                >
                  {t("addressBook.send")}
                </Btn>
                <Btn size="sm" onClick={() => handleCopy(picked.id, picked.address)}>
                  {copiedId === picked.id ? t("common.copied") : t("addressBook.copyAddress")}
                </Btn>
                {!pickedInternal && (
                  <>
                    <Btn size="sm" onClick={() => openEdit(picked)}>
                      {t("addressBook.edit")}
                    </Btn>
                    <Btn size="sm" weight="text" onClick={() => setDeleteConfirm(picked.id)}>
                      {t("common.delete")}
                    </Btn>
                  </>
                )}
              </div>
            </>
          ) : null}
        </aside>
      </div>

      <Modal
        isOpen={showModal !== null}
        onClose={resetForm}
        title={showModal === "edit" ? t("addressBook.editContact") : t("addressBook.addContact")}
      >
        <div className="space-y-4">
          <Input
            label={t("addressBook.name")}
            placeholder={t("addressBook.namePlaceholder")}
            value={formLabel}
            onChange={(e) => setFormLabel(e.target.value)}
            autoFocus
          />
          <Input
            label={t("addressBook.address")}
            placeholder={t("wallet.addressPlaceholder")}
            value={formAddress}
            onChange={(e) => setFormAddress(e.target.value)}
            error={
              formAddress.trim() && !isValidAddress(formAddress)
                ? t("addressBook.invalidPrefix")
                : undefined
            }
          />
          <Input
            label={t("addressBook.tagsLabel")}
            placeholder={t("addressBook.tagsPlaceholder")}
            value={formTags}
            onChange={(e) => setFormTags(e.target.value)}
          />
          <div>
            <label className="block text-sm font-medium text-content-secondary mb-1.5">
              {t("addressBook.notes")}
            </label>
            <textarea
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
              placeholder={t("addressBook.addNote")}
              rows={2}
              className="w-full px-4 py-3 rounded-xl bg-surface-input border border-edge text-sm text-content placeholder:text-content-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors resize-none"
            />
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" fullWidth onClick={resetForm}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              fullWidth
              onClick={handleSave}
              disabled={!formLabel.trim() || !formAddress.trim()}
            >
              {showModal === "edit" ? t("addressBook.update") : t("addressBook.addContact")}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        title={t("addressBook.deleteContact")}
        size="sm"
      >
        <p className="text-sm text-content-secondary mb-4">
          {t("addressBook.deleteConfirmGeneric")}
        </p>
        <div className="flex gap-3">
          <Button variant="secondary" fullWidth onClick={() => setDeleteConfirm(null)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            fullWidth
            onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
          >
            {t("common.delete")}
          </Button>
        </div>
      </Modal>
    </Screen>
  );
}
