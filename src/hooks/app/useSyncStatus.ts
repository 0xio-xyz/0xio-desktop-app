import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

export function useSyncStatus() {
  const [extensionConnected, setConnected] = useState(false);
  const [isComputing, setComputing] = useState(false);

  useEffect(() => {
    const unsub1 = listen<number>("ws-clients-changed", (e) => {
      setConnected(e.payload > 0);
    });
    const unsub2 = listen<boolean>("ws-computing-changed", (e) => {
      setComputing(e.payload);
    });

    return () => {
      unsub1.then((f) => f());
      unsub2.then((f) => f());
    };
  }, []);

  return { extensionConnected, isComputing };
}
