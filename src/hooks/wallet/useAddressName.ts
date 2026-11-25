import { useCallback } from "react";
import { useWallet } from "src/contexts/useWallet";
import { getContacts } from "src/services/storage/addressBookService";

/** Who an address is: an address book entry or one of your wallets, on this network. */
export function useAddressName() {
  const { networkId, wallets } = useWallet();
  return useCallback(
    (address: string | null | undefined): { name: string; source: "book" | "wallet" } | null => {
      if (!address) return null;
      const wallet = wallets.find((w) => w.address === address);
      if (wallet) return { name: wallet.name, source: "wallet" };
      const contact = getContacts(networkId).find((c) => c.address === address);
      return contact ? { name: contact.label, source: "book" } : null;
    },
    [networkId, wallets],
  );
}
