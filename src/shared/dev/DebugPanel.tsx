import React, { useState, useEffect, useRef } from "react";
import {
  Monitor,
  X,
  Trash2,
  Copy,
  ChevronDown,
  ChevronUp,
  Network,
  Clock,
  Database,
  Layers,
} from "src/shared/ui/icons";
import { clearDebugLogs, debugLogs, subscribeDebugLogs } from "src/shared/dev/debugLogs";

function useDebugLogs() {
  const [, setTick] = useState(0);
  useEffect(() => subscribeDebugLogs(() => setTick((t) => t + 1)), []);
  return debugLogs();
}

function formatMs(ms: number) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(b?: number) {
  if (!b) return "-";
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

type Tab = "rpc" | "pvac" | "network";

function useMemoryUsage() {
  const [mem, setMem] = useState<{
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  } | null>(null);
  useEffect(() => {
    const update = () => {
      const p = performance as unknown as {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
      };
      if (p.memory) setMem(p.memory);
    };
    update();
    const id = setInterval(update, 2000);
    return () => clearInterval(id);
  }, []);
  return mem;
}

export default function DebugPanel({ onClose }: { onClose: () => void }) {
  const { rpcLogs: logs, pvacTimings: timings } = useDebugLogs();
  const mem = useMemoryUsage();
  const [tab, setTab] = useState<Tab>("rpc");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const filteredLogs = filter
    ? logs.filter((l) => l.method.toLowerCase().includes(filter.toLowerCase()))
    : logs;

  const avgLatency =
    logs.filter((l) => l.duration).reduce((sum, l) => sum + (l.duration || 0), 0) /
    (logs.filter((l) => l.duration).length || 1);
  const errorRate = logs.length
    ? ((logs.filter((l) => l.status === "error").length / logs.length) * 100).toFixed(1)
    : "0";
  const totalRequests = logs.length;

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "rpc", label: "RPC Calls", icon: <Network size={13} /> },
    { id: "pvac", label: "PVAC Timings", icon: <Layers size={13} /> },
    { id: "network", label: "Stats", icon: <Database size={13} /> },
  ];

  return (
    <div
      className="bg-surface border-t border-edge flex flex-col shrink-0"
      style={{ height: "280px" }}
    >
      <div className="flex items-center justify-between px-3 py-1 bg-surface border-b border-edge shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 border-r border-edge pr-3">
            <Monitor size={13} className="text-accent" />
            <span className="text-micro font-bold text-content-secondary uppercase tracking-wider">
              Debug
            </span>
          </div>
          <div className="flex gap-0.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1 px-2.5 py-1 text-micro rounded transition-colors ${
                  tab === t.id
                    ? "bg-accent/15 text-accent font-medium"
                    : "text-content-muted hover:text-content-secondary"
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tab === "rpc" && (
            <input
              type="text"
              placeholder="Filter methods..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="text-micro bg-surface border border-edge rounded px-2 py-0.5 w-32 text-content-secondary placeholder:text-content-muted focus:outline-none focus:border-accent/50"
            />
          )}
          <button
            onClick={clearDebugLogs}
            className="p-1 text-content-muted hover:text-content-secondary"
            title="Clear logs"
          >
            <Trash2 size={12} />
          </button>
          <button onClick={onClose} className="p-1 text-content-muted hover:text-content-secondary">
            <X size={12} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto text-micro font-mono">
        {tab === "rpc" && (
          <table className="w-full">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-content-muted text-left">
                <th className="px-2 py-1 w-16">Time</th>
                <th className="px-2 py-1 w-8">Status</th>
                <th className="px-2 py-1">Method</th>
                <th className="px-2 py-1 w-16 text-right">Duration</th>
                <th className="px-2 py-1 w-16 text-right">Size</th>
                <th className="px-2 py-1 w-6"></th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log) => (
                <React.Fragment key={log.id}>
                  <tr
                    className={`border-b border-edge/30 cursor-pointer hover:bg-surface-highlight ${
                      log.status === "error"
                        ? "bg-red-500/5"
                        : log.status === "pending"
                          ? "bg-yellow-500/5"
                          : ""
                    }`}
                    onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                  >
                    <td className="px-2 py-0.5 text-content-muted">{formatTime(log.timestamp)}</td>
                    <td className="px-2 py-0.5">
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${
                          log.status === "ok"
                            ? "bg-green-400"
                            : log.status === "error"
                              ? "bg-red-400"
                              : "bg-yellow-400 animate-pulse"
                        }`}
                      />
                    </td>
                    <td className="px-2 py-0.5 text-content-secondary truncate max-w-50">
                      {log.method}
                    </td>
                    <td className="px-2 py-0.5 text-right text-content-muted">
                      {log.duration ? formatMs(log.duration) : "..."}
                    </td>
                    <td className="px-2 py-0.5 text-right text-content-muted">
                      {formatBytes(log.responseSize)}
                    </td>
                    <td className="px-2 py-0.5">
                      {expanded === log.id ? (
                        <ChevronUp size={10} className="text-content-muted" />
                      ) : (
                        <ChevronDown size={10} className="text-content-muted" />
                      )}
                    </td>
                  </tr>
                  {expanded === log.id && (
                    <tr>
                      <td colSpan={6} className="px-4 py-2 bg-surface/50 border-b border-edge/30">
                        <div className="flex flex-col gap-1.5 text-[0.625rem]">
                          {log.duration && (
                            <div className="flex items-center gap-2">
                              <span className="text-content-muted w-12 shrink-0">Timing:</span>
                              <div className="flex-1 h-3 bg-surface rounded-full overflow-hidden">
                                <div
                                  className="h-full rounded-full transition-all"
                                  style={{
                                    width: `${Math.min((log.duration / 10000) * 100, 100)}%`,
                                    background:
                                      log.duration > 5000
                                        ? "#f87171"
                                        : log.duration > 1000
                                          ? "#fbbf24"
                                          : "#4ade80",
                                  }}
                                />
                              </div>
                              <span className="text-content-muted w-14 text-right">
                                {formatMs(log.duration)}
                              </span>
                            </div>
                          )}
                          <div>
                            <span className="text-content-muted">URL:</span>{" "}
                            <span className="text-content-secondary ml-1">{log.url}</span>
                          </div>
                          <div className="flex gap-4">
                            <span>
                              <span className="text-content-muted">Request:</span>{" "}
                              <span className="text-content-secondary ml-1">
                                {formatBytes(log.requestSize)}
                              </span>
                            </span>
                            <span>
                              <span className="text-content-muted">Response:</span>{" "}
                              <span className="text-content-secondary ml-1">
                                {formatBytes(log.responseSize)}
                              </span>
                            </span>
                          </div>
                          {log.params && (
                            <div>
                              <span className="text-content-muted">Params:</span>
                              <pre className="text-content-secondary mt-0.5 bg-surface rounded px-2 py-1 overflow-x-auto max-h-16 scrollbar-hide">
                                {log.params}
                              </pre>
                            </div>
                          )}
                          {log.responsePreview && (
                            <div>
                              <span className="text-content-muted">Response:</span>
                              <pre className="text-content-secondary mt-0.5 bg-surface rounded px-2 py-1 overflow-x-auto max-h-16 scrollbar-hide">
                                {log.responsePreview}
                              </pre>
                            </div>
                          )}
                          {log.error && (
                            <div>
                              <span className="text-red-400">Error:</span>{" "}
                              <span className="text-red-300 ml-1">{log.error}</span>
                            </div>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(JSON.stringify(log, null, 2));
                            }}
                            className="flex items-center gap-1 text-content-muted hover:text-content-secondary w-fit mt-1"
                          >
                            <Copy size={10} /> Copy JSON
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {filteredLogs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-content-muted">
                    No RPC calls logged yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {tab === "pvac" && (
          <table className="w-full">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-content-muted text-left">
                <th className="px-2 py-1 w-16">Time</th>
                <th className="px-2 py-1">Operation</th>
                <th className="px-2 py-1 w-20 text-right">Duration</th>
                <th className="px-2 py-1">Details</th>
              </tr>
            </thead>
            <tbody>
              {timings.map((t, i) => (
                <tr key={i} className="border-b border-edge/30">
                  <td className="px-2 py-0.5 text-content-muted">{formatTime(t.timestamp)}</td>
                  <td className="px-2 py-0.5 text-content-secondary">{t.operation}</td>
                  <td
                    className="px-2 py-0.5 text-right font-semibold"
                    style={{
                      color:
                        t.duration > 5000 ? "#f87171" : t.duration > 1000 ? "#fbbf24" : "#4ade80",
                    }}
                  >
                    {formatMs(t.duration)}
                  </td>
                  <td className="px-2 py-0.5 text-content-muted truncate max-w-75">
                    {t.details || "-"}
                  </td>
                </tr>
              ))}
              {timings.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-content-muted">
                    No PVAC operations logged yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {tab === "network" && (
          <div className="p-4 grid grid-cols-3 gap-4">
            <div className="bg-surface rounded-lg border border-edge p-3">
              <div className="flex items-center gap-2 mb-2">
                <Network size={14} className="text-accent" />
                <span className="text-xs text-content-muted">Total Requests</span>
              </div>
              <div className="text-2xl font-bold text-content-secondary">{totalRequests}</div>
            </div>
            <div className="bg-surface rounded-lg border border-edge p-3">
              <div className="flex items-center gap-2 mb-2">
                <Clock size={14} className="text-accent" />
                <span className="text-xs text-content-muted">Avg Latency</span>
              </div>
              <div className="text-2xl font-bold text-content-secondary">
                {formatMs(avgLatency)}
              </div>
            </div>
            <div className="bg-surface rounded-lg border border-edge p-3">
              <div className="flex items-center gap-2 mb-2">
                <Database size={14} className="text-accent" />
                <span className="text-xs text-content-muted">Error Rate</span>
              </div>
              <div
                className="text-2xl font-bold"
                style={{ color: parseFloat(errorRate) > 5 ? "#f87171" : "#4ade80" }}
              >
                {errorRate}%
              </div>
            </div>
            <div className="bg-surface rounded-lg border border-edge p-3 col-span-3">
              <div className="text-xs text-content-muted mb-2">Method Breakdown</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(
                  logs.reduce<Record<string, { count: number; avgMs: number }>>((acc, l) => {
                    if (!acc[l.method]) acc[l.method] = { count: 0, avgMs: 0 };
                    acc[l.method].count++;
                    if (l.duration) acc[l.method].avgMs += l.duration;
                    return acc;
                  }, {}),
                ).map(([method, { count, avgMs }]) => (
                  <div key={method} className="bg-surface rounded px-2 py-1 text-[0.625rem]">
                    <span className="text-content-secondary">{method}</span>
                    <span className="text-content-muted ml-1">×{count}</span>
                    <span className="text-content-muted ml-1">~{formatMs(avgMs / count)}</span>
                  </div>
                ))}
              </div>
            </div>
            {mem && (
              <div className="bg-surface rounded-lg border border-edge p-3 col-span-3">
                <div className="text-xs text-content-muted mb-2">Memory Usage</div>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex justify-between text-[0.625rem] mb-1">
                      <span className="text-content-muted">JS Heap</span>
                      <span className="text-content-secondary">
                        {formatBytes(mem.usedJSHeapSize)} / {formatBytes(mem.totalJSHeapSize)}
                      </span>
                    </div>
                    <div className="h-2 bg-surface rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${(mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100}%`,
                          background:
                            mem.usedJSHeapSize / mem.jsHeapSizeLimit > 0.8
                              ? "#f87171"
                              : mem.usedJSHeapSize / mem.jsHeapSizeLimit > 0.5
                                ? "#fbbf24"
                                : "#4ade80",
                        }}
                      />
                    </div>
                    <div className="text-[0.625rem] text-content-muted mt-1">
                      Limit: {formatBytes(mem.jsHeapSizeLimit)}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
