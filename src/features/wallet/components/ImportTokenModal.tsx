import { useState, useCallback } from "react";
import { Loader, X } from "src/shared/ui/icons";
import { getContractStorage } from "src/services/network/networkService";

interface ImportTokenModalProps {
  onClose: () => void;
  onImport: (address: string) => void;
}

export default function ImportTokenModal({ onClose, onImport }: ImportTokenModalProps) {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ symbol: string; name: string; decimals: number } | null>(
    null,
  );

  const handleScan = useCallback(async () => {
    const addr = address.trim();
    if (!addr) return;
    setLoading(true);
    setError("");
    setPreview(null);
    try {
      const [symbol, name, decimalsRaw] = await Promise.all([
        getContractStorage(addr, "symbol"),
        getContractStorage(addr, "name"),
        getContractStorage(addr, "decimals"),
      ]);
      if (!symbol) {
        setError("Not a valid token contract (no symbol found)");
        return;
      }
      setPreview({
        symbol,
        name: name || symbol,
        decimals: parseInt(decimalsRaw || "0") || 0,
      });
    } catch {
      setError("Failed to query contract");
    } finally {
      setLoading(false);
    }
  }, [address]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-edge rounded-2xl w-105 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
          <h2 className="text-sm font-semibold text-content">Import Token</h2>
          <button
            onClick={onClose}
            className="text-content-muted hover:text-content transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-content-secondary mb-1.5">
              Contract Address
            </label>
            <div className="flex gap-2">
              <input
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setPreview(null);
                  setError("");
                }}
                placeholder="oct..."
                className="flex-1 bg-surface-input border border-edge rounded-xl px-4 py-2.5 text-sm text-content font-mono placeholder:text-content-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
              />
              <button
                onClick={handleScan}
                disabled={loading || !address.trim()}
                className="px-4 py-2.5 rounded-xl text-sm font-medium bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-50 transition-colors"
              >
                {loading ? <Loader size={16} className="animate-spin" /> : "Scan"}
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          {preview && (
            <div className="rounded-xl bg-surface-card border border-edge p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-content-muted">Symbol</span>
                <span className="text-sm font-medium text-content">{preview.symbol}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-content-muted">Name</span>
                <span className="text-sm font-medium text-content">{preview.name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-content-muted">Decimals</span>
                <span className="text-sm font-medium text-content">{preview.decimals}</span>
              </div>
              <button
                onClick={() => onImport(address.trim())}
                className="w-full mt-2 py-2.5 rounded-xl text-sm font-medium bg-accent text-accent-fg hover:bg-accent/90 transition-colors"
              >
                Import {preview.symbol}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
