import { invoke } from "@tauri-apps/api/core";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const isDev = import.meta.env.DEV;

function isDevMode(): boolean {
  return isDev || localStorage.getItem("0xio_developer_mode") === "true";
}

function shouldLog(level: LogLevel): boolean {
  const minLevel: LogLevel = isDevMode() ? "debug" : "warn";
  return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

function ts(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatTag(tag: string): string {
  return `${ts()} [${tag}]`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Fire-and-forget: pipes the message to Rust stderr so it shows in the terminal. */
function toTerminal(level: string, message: string) {
  invoke("frontend_log", { level, message }).catch(() => {});
}

export const logger = {
  debug: (tag: string, ...args: unknown[]) => {
    if (shouldLog("debug")) console.log(formatTag(tag), ...args);
  },

  info: (tag: string, ...args: unknown[]) => {
    if (shouldLog("info")) {
      const prefix = formatTag(tag);
      console.log(prefix, ...args);
      toTerminal("info", `${prefix} ${args.map(String).join(" ")}`);
    }
  },

  warn: (tag: string, ...args: unknown[]) => {
    if (shouldLog("warn")) {
      const prefix = formatTag(tag);
      console.warn(prefix, ...args);
      toTerminal("warn", `${prefix} ${args.map(String).join(" ")}`);
    }
  },

  error: (tag: string, ...args: unknown[]) => {
    if (shouldLog("error")) {
      const prefix = formatTag(tag);
      console.error(prefix, ...args);
      toTerminal("error", `${prefix} ${args.map(String).join(" ")}`);
    }
  },

  timed: async <T>(tag: string, label: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    if (shouldLog("debug")) console.log(formatTag(tag), `${label} started`);
    try {
      const result = await fn();
      const elapsed = performance.now() - start;
      if (shouldLog("info")) {
        const msg = `${formatTag(tag)} ${label} completed in ${formatMs(elapsed)}`;
        console.log(msg);
        toTerminal("info", msg);
      }
      return result;
    } catch (err) {
      const elapsed = performance.now() - start;
      if (shouldLog("error")) {
        const msg = `${formatTag(tag)} ${label} FAILED after ${formatMs(elapsed)}: ${err}`;
        console.error(msg);
        toTerminal("error", msg);
      }
      throw err;
    }
  },

  pvacOp: (label: string, result: { ms?: number }) => {
    if (shouldLog("info") && result.ms !== undefined) {
      const msg = `${formatTag("pvac")} ${label} - Rust: ${formatMs(result.ms)}`;
      console.log(msg);
      toTerminal("info", msg);
    }
  },
};
