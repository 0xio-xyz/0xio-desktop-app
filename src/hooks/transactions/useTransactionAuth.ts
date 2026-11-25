import { useState, useCallback, useRef } from "react";
import { logger } from "src/lib/logger";

interface TransactionAuthState {
  isOpen: boolean;
  title: string;
  requestAuth: (title?: string) => Promise<boolean>;
  handleResult: (approved: boolean) => void;
}

export function useTransactionAuth(): TransactionAuthState {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const resolveRef = useRef<((approved: boolean) => void) | null>(null);

  const requestAuth = useCallback((authTitle?: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setTitle(authTitle ?? "");
      setIsOpen(true);
    });
  }, []);

  const handleResult = useCallback((approved: boolean) => {
    setIsOpen(false);
    logger.debug("txauth", approved ? "approved" : "denied");
    if (resolveRef.current) {
      resolveRef.current(approved);
      resolveRef.current = null;
    }
  }, []);

  return { isOpen, title, requestAuth, handleResult };
}
