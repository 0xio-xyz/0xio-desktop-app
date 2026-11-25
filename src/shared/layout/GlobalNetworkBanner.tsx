import React, { useEffect, useState } from "react";
import { Activity, X } from "src/shared/ui/icons";
import { isNetworkSlow, subscribeNetworkHealth } from "src/services/network/networkHealth";

export default React.memo(function GlobalNetworkBanner() {
  const [slow, setSlow] = useState(isNetworkSlow());
  const [dismissed, setDismissed] = useState(false);

  // effect:audited - external health subscription + poll; not derivable from render.
  useEffect(() => {
    const recompute = () => {
      const s = isNetworkSlow();
      setSlow(s);
      // Recovered (a network switch clears the flag too): the next slow episode shows again.
      if (!s) setDismissed(false);
    };
    const unsub = subscribeNetworkHealth(recompute);
    const id = setInterval(recompute, 5000);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, []);

  if (!slow || dismissed) return null;

  return (
    <button
      type="button"
      onClick={() => setDismissed(true)}
      aria-label="Dismiss slow-network notice"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-100 flex items-center gap-2 max-w-[min(90vw,520px)] pl-4 pr-3 py-2.5 rounded-xl shadow-lg bg-caution text-black animate-in fade-in slide-in-from-bottom-2"
    >
      <Activity size={15} className="shrink-0" />
      <span className="text-meta font-medium text-left">
        Network is slow right now. Loads and transactions may take a while.
      </span>
      <X size={15} className="shrink-0 opacity-70" />
    </button>
  );
});
