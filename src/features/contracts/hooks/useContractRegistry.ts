import { useState, useCallback, useEffect } from "react";
import { useWallet } from "src/contexts/useWallet";
import { normalizeAbi } from "src/services/contracts/contractAbi";
import type { RegisteredContract, ContractLanguage } from "src/types/contract";

const STORAGE_PREFIX = "0xio_contracts_";

function storageKey(address: string, networkId: string): string {
  return `${STORAGE_PREFIX}${address}_${networkId}`;
}

export function loadContracts(key: string): RegisteredContract[] {
  try {
    const raw = localStorage.getItem(key);
    const saved: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(saved)) return [];
    // Saves up to 0.6.0 kept the compiler's ABI as it came, a JSON string.
    return saved.map((c: RegisteredContract) =>
      c.abi === undefined ? c : { ...c, abi: normalizeAbi(c.abi) },
    );
  } catch {
    return [];
  }
}

function save(key: string, contracts: RegisteredContract[]) {
  localStorage.setItem(key, JSON.stringify(contracts));
}

export interface UseContractRegistryReturn {
  contracts: RegisteredContract[];
  addContract: (contract: RegisteredContract) => void;
  removeContract: (address: string) => void;
  updateContract: (address: string, updates: Partial<RegisteredContract>) => void;
  addManual: (address: string, name: string) => void;
}

export function useContractRegistry(): UseContractRegistryReturn {
  const { activeWallet, networkId } = useWallet();
  const walletAddr = activeWallet?.address ?? "";
  const key = storageKey(walletAddr, networkId);

  const [contracts, setContracts] = useState<RegisteredContract[]>(() => loadContracts(key));

  useEffect(() => {
    setContracts(loadContracts(key));
  }, [key]);

  const addContract = useCallback(
    (contract: RegisteredContract) => {
      setContracts((prev) => {
        if (prev.some((c) => c.address === contract.address)) return prev;
        const next = [contract, ...prev];
        save(key, next);
        return next;
      });
    },
    [key],
  );

  const removeContract = useCallback(
    (address: string) => {
      setContracts((prev) => {
        const next = prev.filter((c) => c.address !== address);
        save(key, next);
        return next;
      });
    },
    [key],
  );

  const updateContract = useCallback(
    (address: string, updates: Partial<RegisteredContract>) => {
      setContracts((prev) => {
        const next = prev.map((c) => (c.address === address ? { ...c, ...updates } : c));
        save(key, next);
        return next;
      });
    },
    [key],
  );

  const addManual = useCallback(
    (address: string, name: string) => {
      const contract: RegisteredContract = {
        address,
        name: name || "Imported Contract",
        language: "assembly" as ContractLanguage,
        deployedAt: Date.now(),
        deployTxHash: "",
      };
      addContract(contract);
    },
    [addContract],
  );

  return { contracts, addContract, removeContract, updateContract, addManual };
}
