import { useState, useCallback, useMemo } from "react";

const STORAGE_PREFIX = "0xio_ou_";

type Fees = { minimum: string; recommended: string; fast?: string };

/**
 * With live `fees`, a preset is stored by mode, not value, so it keeps tracking the live fee;
 * only a typed Custom value is frozen. Without `fees` a saved preset resolves to `networkDefault`.
 */
export function usePersistedOU(
  key: string,
  networkDefault: string,
  fees?: Fees,
): [string, (value: string, mode?: string) => void] {
  const storageKey = `${STORAGE_PREFIX}${key}`;

  // "" is Normal, "slow"/"normal"/"fast" a preset, a number a frozen Custom value.
  const [stored, setStored] = useState<string>(() => {
    try {
      return localStorage.getItem(storageKey) ?? "";
    } catch {
      return "";
    }
  });

  const resolved = useMemo(() => {
    if (fees) {
      if (stored === "slow") return fees.minimum;
      if (stored === "fast") return fees.fast ?? fees.recommended;
      if (stored === "" || stored === "normal") return fees.recommended;
      return stored;
    }
    if (stored === "slow" || stored === "normal" || stored === "fast") return networkDefault;
    return stored || networkDefault;
  }, [stored, fees, networkDefault]);

  const setOU = useCallback(
    (value: string, mode?: string) => {
      const next = fees && mode && mode !== "custom" ? mode : value;
      setStored(next);
      try {
        if (next === "" || next === "normal") localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, next);
      } catch {}
    },
    [storageKey, fees],
  );

  return [resolved, setOU];
}
