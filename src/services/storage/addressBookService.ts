import { logger } from "src/lib/logger";

const STORAGE_PREFIX = "0xio_address_book_";

export const INTERNAL_TAG = "internal";

export interface Contact {
  id: string;
  label: string;
  address: string;
  tags: string[];
  notes?: string;
  isFavorite?: boolean;
  createdAt: number;
  updatedAt?: number;
}

export function isValidAddress(address: string): boolean {
  return typeof address === "string" && /^oct[A-Za-z0-9]{44}$/.test(address.trim());
}

function storageKey(networkId: string): string {
  return `${STORAGE_PREFIX}${networkId}`;
}

function readContacts(networkId: string): Contact[] {
  try {
    const raw = localStorage.getItem(storageKey(networkId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeContacts(networkId: string, contacts: Contact[]): void {
  localStorage.setItem(storageKey(networkId), JSON.stringify(contacts));
}

export function getContacts(networkId: string): Contact[] {
  return readContacts(networkId);
}

export function addContact(networkId: string, contact: Omit<Contact, "id" | "createdAt">): Contact {
  const address = contact.address.trim();
  if (!isValidAddress(address)) {
    throw new Error("Invalid Octra address");
  }
  const contacts = readContacts(networkId);
  const duplicate = contacts.find((c) => c.address.toLowerCase() === address.toLowerCase());
  if (duplicate) {
    throw new Error(`Address already saved as "${duplicate.label}"`);
  }
  const entry: Contact = {
    ...contact,
    address,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  contacts.push(entry);
  writeContacts(networkId, contacts);
  logger.debug(
    "addressbook",
    `added - ${contact.label} (${address.slice(0, 12)}...) [${contact.tags.join(",")}]`,
  );
  return entry;
}

export function updateContact(
  networkId: string,
  id: string,
  updates: Partial<Omit<Contact, "id" | "createdAt">>,
): Contact | null {
  const contacts = readContacts(networkId);
  const idx = contacts.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  if (updates.address !== undefined) {
    const address = updates.address.trim();
    if (!isValidAddress(address)) {
      throw new Error("Invalid Octra address");
    }
    const duplicate = contacts.find(
      (c) => c.id !== id && c.address.toLowerCase() === address.toLowerCase(),
    );
    if (duplicate) {
      throw new Error(`Address already saved as "${duplicate.label}"`);
    }
    updates = { ...updates, address };
  }
  contacts[idx] = { ...contacts[idx], ...updates, updatedAt: Date.now() };
  writeContacts(networkId, contacts);
  logger.debug("addressbook", `updated - id=${id}`);
  return contacts[idx];
}

export function toggleFavorite(networkId: string, id: string): Contact | null {
  const contacts = readContacts(networkId);
  const idx = contacts.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  contacts[idx] = {
    ...contacts[idx],
    isFavorite: !contacts[idx].isFavorite,
    updatedAt: Date.now(),
  };
  writeContacts(networkId, contacts);
  return contacts[idx];
}

export function deleteContact(networkId: string, id: string): boolean {
  const contacts = readContacts(networkId);
  const filtered = contacts.filter((c) => c.id !== id);
  if (filtered.length === contacts.length) return false;
  writeContacts(networkId, filtered);
  logger.debug("addressbook", `deleted - id=${id}`);
  return true;
}

export function getAllTags(networkId: string): string[] {
  const contacts = readContacts(networkId);
  const tagSet = new Set<string>();
  contacts.forEach((c) => c.tags.forEach((t) => tagSet.add(t)));
  return Array.from(tagSet).sort();
}

export function parseContactsCsv(csv: string): Omit<Contact, "id" | "createdAt">[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];
  const results: Omit<Contact, "id" | "createdAt">[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cols.length < 2 || !cols[1]) continue;
    results.push({
      label: cols[0] || `Contact ${i}`,
      address: cols[1],
      tags: cols[2]
        ? cols[2]
            .split(";")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      notes: cols[3] || undefined,
    });
  }
  return results;
}

export function syncInternalWallets(
  networkId: string,
  wallets: Array<{ name: string; address: string }>,
): void {
  let contacts = readContacts(networkId);
  const walletAddrs = new Set(wallets.map((w) => w.address));

  contacts = contacts.filter((c) => !c.tags.includes(INTERNAL_TAG) || walletAddrs.has(c.address));

  for (const wallet of wallets) {
    const idx = contacts.findIndex((c) => c.address === wallet.address);
    if (idx !== -1) {
      const existing = contacts[idx];
      const hasTag = existing.tags.includes(INTERNAL_TAG);
      contacts[idx] = {
        ...existing,
        label: wallet.name,
        tags: hasTag ? existing.tags : [INTERNAL_TAG, ...existing.tags],
      };
    } else {
      contacts.push({
        id: crypto.randomUUID(),
        label: wallet.name,
        address: wallet.address,
        tags: [INTERNAL_TAG],
        createdAt: Date.now(),
      });
    }
  }

  writeContacts(networkId, contacts);
}

export function exportContactsCsv(contacts: Contact[]): string {
  const header = "label,address,tags,notes";
  const rows = contacts.map(
    (c) => `"${c.label}","${c.address}","${c.tags.join(";")}","${c.notes || ""}"`,
  );
  return [header, ...rows].join("\n");
}
