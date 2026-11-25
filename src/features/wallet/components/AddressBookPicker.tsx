import React, { useState, useMemo } from "react";
import { Search } from "src/shared/ui/icons";
import Modal from "src/shared/ui/Modal";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { EASE, FOCUS, Small } from "src/shared/ui/look";
import { getContacts, INTERNAL_TAG } from "src/services/storage/addressBookService";
import { useWallet } from "src/contexts/useWallet";
import { truncateAddress } from "src/lib/format";

interface AddressBookPickerProps {
  onSelect: (address: string) => void;
  onClose: () => void;
}

export default React.memo(function AddressBookPicker({
  onSelect,
  onClose,
}: AddressBookPickerProps) {
  const { networkId, activeWallet } = useWallet();
  // No sending to self: the active wallet is also present as a synced internal contact.
  // (the active wallet is also present as a synced internal contact).
  const contacts = useMemo(
    () => getContacts(networkId).filter((c) => c.address !== activeWallet?.address),
    [networkId, activeWallet?.address],
  );
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [contacts, search]);

  return (
    <Modal isOpen onClose={onClose} title="Select contact" look="ext" hideClose>
      <label className="relative mb-3 block">
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-content-muted"
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search contacts"
          aria-label="Search contacts"
          autoFocus
          className={`w-full rounded-xl bg-surface-highlight py-2.5 pr-4 pl-9.5 text-sm text-content placeholder:text-content-muted ${FOCUS}`}
        />
      </label>

      <div className="h-72 space-y-0.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-content-muted">
            {contacts.length === 0 ? "No contacts saved yet" : "No contacts match"}
          </p>
        ) : (
          filtered.map((contact) => {
            const isInternal = contact.tags.includes(INTERNAL_TAG);
            const tag = isInternal ? "Your wallet" : contact.tags.find((t) => t !== INTERNAL_TAG);
            return (
              <button
                key={contact.id}
                onClick={() => {
                  onSelect(contact.address);
                  onClose();
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-highlight ${EASE} ${FOCUS}`}
              >
                <WalletAvatar address={contact.address} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium text-content">
                      {contact.label}
                    </span>
                    {tag && <Small>{tag}</Small>}
                  </span>
                  <span className="block truncate font-mono text-xs text-content-muted">
                    {truncateAddress(contact.address, 14, 10)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
});
