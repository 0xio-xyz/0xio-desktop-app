import { useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { qrMatrix } from "src/lib/qr";
import { formatOCT } from "src/lib/format";
import {
  FEE_CHANGED,
  FEE_SHORT,
  INSUFFICIENT_BALANCE,
  SCOPE_CHANGED,
} from "src/services/transactions/feeCopy";
import {
  loadAppearance,
  saveAppearance,
  TRAY_THEMES,
  type TrayTheme,
} from "src/features/settings/services/appearance";
import {
  AMOUNT_BAD,
  VERBS,
  badAmount,
  complete,
  keyUpdateCopy,
  parseAmount,
  parseLine,
  resolveAmount,
  shortAddr,
  whoLabel,
  type Verb,
} from "./commands";
import {
  type FeeRead,
  type TrayAction,
  type TraySendProgress,
  type TraySnapshot,
  type TrayState,
} from "./protocol";
import {
  keyConfirmScope,
  keyFeeGate,
  privateOpGate,
  privateSendBlock,
  reviewedFeeLapse,
  sendGate,
  type Gate,
} from "./gates";
import { feeText } from "src/services/transactions/feeText";

type Act = (a: TrayAction) => Promise<unknown>;
type Kind = "cmd" | "out" | "err" | "dim" | "acc" | "qr";
interface Line {
  id: number;
  kind: Kind;
  prompt?: string;
  key?: string;
  indent?: boolean;
  text: string;
}
type Pending =
  | {
      kind: "confirm";
      word: "y" | "yes";
      run: () => void;
      lapsed: (now: TraySnapshot) => string | null;
      command: string;
    }
  | { kind: "password"; purpose: "unlock" }
  | null;
interface Job {
  requestId: string;
  title: string;
  done: string;
}
/** What the CLI keeps while the panel is hidden and shown again, or the theme changes. */
export interface CliMemory {
  lines?: Line[];
  history?: string[];
  job?: Job | null;
}
/** Commands that sign or change what a running job signs with. */
const BUSY: Verb[] = ["send", "encrypt", "decrypt", "migrate", "use", "network", "theme"];

const errText = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "something went wrong";
const fee = (ou: number) => `${ou.toLocaleString("en-US")} OU (about ${formatOCT(ou)} OCT)`;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));
let seq = 0;
const line = (kind: Kind, text: string): Line => ({ id: ++seq, kind, text });
const kv = (key: string, text: string, indent = false): Line => ({
  ...line("out", text),
  key,
  indent,
});

export default function Cli({
  state,
  act,
  progress,
  clearProgress,
  memory,
}: {
  state: TrayState;
  act: Act;
  progress: TraySendProgress | null;
  clearProgress: () => void;
  memory?: CliMemory;
}) {
  const snap = state.snapshot;
  const [mem] = useState<CliMemory>(() => memory ?? {});
  const [lines, keepLines] = useState<Line[]>(
    () => (mem.lines ??= [line("dim", "type 0xio --help for commands")]),
  );
  const [input, setInput] = useState("");
  const [history, keepHistory] = useState<string[]>(() => (mem.history ??= []));
  const [histAt, setHistAt] = useState(-1);
  const [pending, setPending] = useState<Pending>(null);
  const [job, keepJob] = useState<Job | null>(() => mem.job ?? null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const checking = useRef(false);
  const command = useRef("");
  const setLines = (next: (l: Line[]) => Line[]) => keepLines((mem.lines = next(mem.lines!)));
  const setHistory = (next: (h: string[]) => string[]) =>
    keepHistory((mem.history = next(mem.history!)));
  const setJob = (j: Job | null) => keepJob((mem.job = j));

  const live = job && progress?.requestId === job.requestId ? progress : null;
  const needPassword = live?.stage === "needPassword" && !snap?.locked;
  const jobOver = !!live && (live.stage === "sent" || live.stage === "failed");
  const busy = !!job && !jobOver;
  const wallet = snap?.wallets.find((w) => w.id === snap.activeId);
  const network = snap
    ? (snap.networks.find((n) => n.id === snap.network)?.name ?? snap.network)
    : "";

  const print = (...add: Line[]) => setLines((l) => [...l, ...add].slice(-400));
  const out = (...t: string[]) => print(...t.map((x) => line("out", x)));
  const err = (t: string) => print(line("err", feeText(t)));

  const settleJob = () => {
    if (!job || !jobOver) return;
    if (live.stage === "sent")
      print(line("acc", `${job.done}${live.pending ? "  (waiting for the network)" : ""}`));
    else err(live.error ?? "failed");
    setJob(null);
    clearProgress();
  };

  const startJob = async (
    title: string,
    done: string,
    build: (requestId: string) => TrayAction,
  ) => {
    const requestId = crypto.randomUUID();
    setJob({ requestId, title, done });
    try {
      await act(build(requestId));
    } catch {
      setJob(null);
      err("that request did not go through. try again");
    }
  };

  /** Sign on y: only while the wallet and network are the ones the review showed, what it was
   *  for still applies, and the node still takes each fee it showed. */
  const ask = (
    word: "y" | "yes",
    run: () => void,
    feeNow: (now: TraySnapshot) => [reviewedOu: number, now: FeeRead][],
    blockedNow?: (now: TraySnapshot) => string | null,
  ) => {
    const reviewed = snap!;
    print(line("acc", word === "y" ? "sign? [y/N]" : "type yes to sign"));
    setPending({
      kind: "confirm",
      word,
      run,
      command: command.current,
      lapsed: (now) =>
        now.locked || now.activeId !== reviewed.activeId || now.network !== reviewed.network
          ? SCOPE_CHANGED
          : (blockedNow?.(now) ?? reviewedFeeLapse(feeNow(now))),
    });
  };

  const readinessMoved = (now: TraySnapshot, still: boolean) =>
    still ? null : `${readinessText(now.privateReadiness)}. type migrate or private`;

  /** A failed fee read is asked for again. */
  const feeBlock = (g: Gate): string => {
    if (g.fee.state === "loading") return "network fee still loading. try again in a moment";
    if (g.retry) void act({ type: "retryReads" });
    return g.feeError;
  };

  const review = (rows: [string, string][]) =>
    print(line("out", "review"), ...rows.map(([k, v]) => kv(k, v, true)));

  const run = (raw: string) => {
    command.current = raw;
    const p = parseLine(raw, snap, true);
    if (!p.verb) {
      const word = raw
        .trim()
        .replace(/^\//, "")
        .replace(/^0xio\s+/i, "")
        .split(/\s+/)[0];
      err(`command not found: ${word}. type 0xio --help`);
      return;
    }
    const v = p.verb.verb;
    if (busy && BUSY.includes(v)) return err(`still running: ${job.title}`);
    if (v === "help") {
      print(
        line("dim", "usage: [0xio] <command>, a leading / works too"),
        ...VERBS.flatMap((x) => [line("acc", x.usage), line("dim", `  ${x.help}`)]),
        line("dim", "tab completes, up and down recall, ctrl+c cancels, ctrl+l clears"),
      );
      return;
    }
    if (v === "clear") return setLines(() => []);
    if (v === "quit") return void act({ type: "quit" });
    if (v === "open") {
      out("opening 0xio Desktop");
      return void act({ type: "openApp" });
    }
    if (v === "theme") {
      const name = p.args[0]?.toLowerCase() as TrayTheme | undefined;
      if (!name || !TRAY_THEMES.includes(name))
        return out(`themes: ${TRAY_THEMES.join(" ")}  (auto follows the app)`);
      saveAppearance({ ...loadAppearance(), trayTheme: name });
      return out(`theme ${name}`);
    }
    if (v === "login") {
      const on = p.args[0]?.toLowerCase();
      if (on !== "on" && on !== "off") return out(`startup is ${state.openAtLogin ? "on" : "off"}`);
      return void act({ type: "setOpenAtLogin", enabled: on === "on" })
        .then(() => out(`startup ${on}`))
        .catch(() => err("could not change startup. try again"));
    }
    if (!snap) return err("0xio Desktop has not loaded a wallet yet. type open");

    if (snap.locked) {
      if (v === "unlock") return setPending({ kind: "password", purpose: "unlock" });
      if (v === "touchid") {
        if (!snap.biometric) return err("Touch ID is off. type unlock");
        out("waiting for Touch ID");
        return void act({ type: "unlockBiometric" });
      }
      return err(`locked. type ${snap.biometric ? "unlock or touchid" : "unlock"}`);
    }
    if (v === "unlock" || v === "touchid") return out("already unlocked");
    if (v === "lock") {
      if (!snap.hasPassword) return err("set a password in 0xio Desktop to lock");
      return void act({ type: "lock" });
    }
    if (v === "balance") {
      if (snap.publicMicro === null) return err("balance not loaded yet");
      const pub = snap.publicMicro;
      const priv = snap.privateMicro ?? 0;
      return print(
        kv("total", `${formatOCT(pub + priv)} OCT`),
        kv("public", `${formatOCT(pub)} OCT`),
        ...(snap.privacy ? [kv("private", `${formatOCT(priv)} OCT`)] : []),
      );
    }
    if (v === "status") {
      const r = snap.privateReadiness;
      return print(
        kv("engine", state.computing ? "proving" : "private proofs on"),
        kv("extension", state.clients > 0 ? `connected (${state.clients})` : "not connected"),
        kv("claims", `${snap.claims} waiting`),
        kv("private", snap.privacy ? readinessText(r) : "not on this network"),
      );
    }
    if (v === "wallets")
      return out(
        ...snap.wallets.map(
          (w, i) =>
            `${w.id === snap.activeId ? "*" : " "} ${i + 1}  ${pad(w.name, 16)}${shortAddr(w.address)}`,
        ),
      );
    if (v === "use") {
      const q = p.args.join(" ").toLowerCase();
      const n = Number(q);
      const hit =
        Number.isInteger(n) && n > 0
          ? snap.wallets[n - 1]
          : (snap.wallets.find((w) => w.name.toLowerCase() === q) ??
            snap.wallets.find((w) => w.name.toLowerCase().startsWith(q)));
      if (!q || !hit) return err("which wallet? type wallets");
      out(`using ${hit.name}`);
      return void act({ type: "switchWallet", id: hit.id });
    }
    if (v === "network") {
      const q = p.args.join(" ").toLowerCase();
      if (!q)
        return out(
          ...snap.networks.map(
            (n) => `${n.id === snap.network ? "*" : " "} ${n.name.toLowerCase()}`,
          ),
        );
      const hit = snap.networks.find(
        (n) => n.id.toLowerCase() === q || n.name.toLowerCase().startsWith(q),
      );
      if (!hit) return err(`no network ${q}`);
      out(`network ${hit.name.toLowerCase()}`);
      return void act({ type: "setNetwork", id: hit.id });
    }
    if (v === "receive" || v === "qr") {
      if (!wallet) return err("no wallet");
      if (v === "qr") print(line("qr", wallet.address));
      out(wallet.address);
      return void navigator.clipboard
        .writeText(wallet.address)
        .then(() => print(line("dim", "copied")))
        .catch(() => {});
    }
    if (v === "claim") {
      if (!snap.claims) return out("nothing to claim");
      out(`${snap.claims} waiting, opening 0xio Desktop to claim`);
      return void act({ type: "openApp", route: "/privacy?tab=claim" });
    }
    if (!wallet) return err("no wallet. type wallets");
    if (!snap.canSign) return err("this wallet is watch-only");

    if (v === "send") {
      const s = p.send!;
      if (snap.publicMicro === null || (s.mode === "private" && snap.privateMicro === null))
        return err("balance not loaded yet");
      if (s.issues.length) {
        s.issues.forEach(err);
        s.toOptions.forEach((o) => print(line("dim", `  ${whoLabel(o)}`)));
        return;
      }
      const to = s.to!;
      const priv = s.mode === "private";
      if (priv && privateSendBlock(snap.privateReadiness))
        return err(`${readinessText(snap.privateReadiness)}. type migrate or private`);
      const g = sendGate(snap, s.mode, s.micro);
      const blocked = feeBlock(g);
      if (blocked) return err(blocked);
      if (!g.ok || g.feeOu === null) return err(INSUFFICIENT_BALANCE);
      const feeOu = g.feeOu;
      review([
        ["send", `${formatOCT(s.micro)} OCT ${priv ? "private" : "public"}`],
        ["from", wallet.name],
        ...((to.label
          ? [
              ["to", to.label],
              ["", to.address],
            ]
          : [["to", to.address]]) as [string, string][]),
        ["fee", fee(feeOu)],
        ["network", network],
      ]);
      return ask(
        "y",
        () =>
          startJob(
            `send ${formatOCT(s.micro)} OCT`,
            `sent ${formatOCT(s.micro)} OCT to ${whoLabel(to)}`,
            (requestId) => ({
              type: "send",
              requestId,
              to: to.address,
              amountMicro: s.micro,
              mode: s.mode,
              feeOu,
              walletId: wallet.id,
              network: snap.network,
            }),
          ),
        (now) => [[feeOu, priv ? now.fees.private : now.fees.public]],
        (now) =>
          priv && privateSendBlock(now.privateReadiness)
            ? `${readinessText(now.privateReadiness)}. type migrate or private`
            : null,
      );
    }

    if (!snap.privacy) return err(`private balance is not available on ${network.toLowerCase()}`);
    const r = snap.privateReadiness;
    if (v === "private") {
      return print(
        kv("private", `${formatOCT(snap.privateMicro ?? 0)} OCT`),
        kv("status", readinessText(r)),
        line("out", "encrypt <amount>, decrypt <amount>, migrate"),
      );
    }
    if (v === "encrypt" || v === "decrypt") {
      if (r.state !== "ok" && r.state !== "needsRefresh")
        return err(`${readinessText(r)}. type migrate or private`);
      const enc = v === "encrypt";
      const spec = p.args.map(parseAmount).find(Boolean);
      if (!spec)
        return err(
          p.args.some(badAmount) ? AMOUNT_BAD : `how much? ${v} <amount>, max, half or a percent`,
        );
      if (snap.publicMicro === null || (!enc && snap.privateMicro === null))
        return err("balance not loaded yet");
      const g0 = privateOpGate(snap, v, 0);
      const blocked = feeBlock(g0);
      if (blocked) return err(blocked);
      const micro = resolveAmount(spec, g0.available);
      if (micro <= 0) return err("nothing to move");
      if (micro > g0.available)
        return err(`${INSUFFICIENT_BALANCE} (${formatOCT(g0.available)} OCT available)`);
      const g = privateOpGate(snap, v, micro);
      const { refresh, opFeeOu, refreshFeeOu } = g;
      if (!g.ok || g.feeOu === null || opFeeOu === null || refreshFeeOu === null)
        return err(INSUFFICIENT_BALANCE);
      const total = g.feeOu;
      review([
        [v, `${formatOCT(micro)} OCT`],
        ["wallet", wallet.name],
        ["fee", refresh ? `${total.toLocaleString("en-US")} OU (2 transactions)` : fee(opFeeOu)],
        ...(refresh ? ([["first", "refreshes your private balance"]] as [string, string][]) : []),
        ["network", network],
      ]);
      return ask(
        "y",
        () =>
          startJob(
            `${v} ${formatOCT(micro)} OCT`,
            `${enc ? "encrypted" : "decrypted"} ${formatOCT(micro)} OCT`,
            (requestId) => ({
              type: "private",
              requestId,
              direction: v,
              amountMicro: micro,
              refresh,
              feeOu: opFeeOu,
              refreshFeeOu,
              walletId: wallet.id,
              network: snap.network,
            }),
          ),
        (now) => [
          [opFeeOu, enc ? now.fees.encrypt : now.fees.decrypt],
          ...(refresh ? ([[refreshFeeOu, now.fees.refresh]] as [number, FeeRead][]) : []),
        ],
        (now) => readinessMoved(now, (now.privateReadiness.state === "needsRefresh") === refresh),
      );
    }
    if (v === "migrate") {
      if (r.state === "needsRefresh") {
        const g = keyFeeGate(snap.fees.refresh, snap.publicMicro);
        const blocked = feeBlock(g);
        if (blocked) return err(blocked);
        if (!g.ok || g.feeOu === null) return err(FEE_SHORT);
        const feeOu = g.feeOu;
        review([
          ["refresh", "migrate your private balance"],
          ["fee", fee(feeOu)],
          ["network", network],
        ]);
        return ask(
          "y",
          () =>
            startJob("refresh", "private balance refreshed", (requestId) => ({
              type: "refresh",
              requestId,
              walletId: wallet.id,
              network: snap.network,
              feeOu,
            })),
          (now) => [[feeOu, now.fees.refresh]],
          (now) => readinessMoved(now, now.privateReadiness.state === "needsRefresh"),
        );
      }
      if (r.state === "keyUpdate") {
        const g = keyFeeGate(r.fee, snap.publicMicro);
        const blocked = feeBlock(g);
        if (blocked) return err(blocked);
        if (!g.ok || g.feeOu === null) return err(FEE_SHORT);
        const feeOu = g.feeOu;
        const copy = keyUpdateCopy(r.mode, r.amountMicro);
        review([
          [copy.action.toLowerCase(), copy.what],
          ["fee", fee(feeOu)],
          ["network", network],
        ]);
        print(line("dim", copy.confirm));
        const scope = keyConfirmScope(snap);
        return ask(
          "yes",
          () =>
            startJob(copy.title.toLowerCase(), copy.done.toLowerCase(), (requestId) => ({
              type: "migrate",
              requestId,
              walletId: wallet.id,
              network: snap.network,
              mode: r.mode,
              amountMicro: r.amountMicro,
              feeOu,
              confirmed: true,
            })),
          (now) => [
            [feeOu, now.privateReadiness.state === "keyUpdate" ? now.privateReadiness.fee : r.fee],
          ],
          (now) => readinessMoved(now, keyConfirmScope(now) === scope),
        );
      }
      if (r.state === "noKey" && r.setup.state === "offer") {
        const feeOu = r.setup.feeOu;
        review([
          ["turn on", "your private balance (one time)"],
          ["fee", fee(feeOu)],
          ["network", network],
        ]);
        return ask(
          "y",
          () =>
            startJob("turn on private balance", "private balance on", (requestId) => ({
              type: "turnOn",
              requestId,
              walletId: wallet.id,
              network: snap.network,
              feeOu,
            })),
          (now) => {
            const setup =
              now.privateReadiness.state === "noKey" ? now.privateReadiness.setup : null;
            return setup?.state === "offer"
              ? [[feeOu, { state: "ok", ou: setup.feeOu, floor: setup.floorOu }]]
              : [];
          },
          (now) =>
            readinessMoved(
              now,
              now.privateReadiness.state === "noKey" &&
                now.privateReadiness.setup.state === "offer",
            ),
        );
      }
      if (r.state === "noKey" && r.setup.state === "unavailable") {
        void act({ type: "retryReads" });
        return err(readinessText(r));
      }
      return out(readinessText(r));
    }
  };

  /** The password goes to Rust once per Enter, never empty, never echoed. */
  const checkPassword = async (command: string, args: Record<string, string>) => {
    if (!input || checking.current) return;
    print({ ...line("cmd", ""), prompt: promptText });
    setInput("");
    if (pending?.kind === "password") setPending(null);
    checking.current = true;
    try {
      await invoke(command, args);
    } catch (e) {
      err(errText(e).includes("Too many") ? errText(e) : "wrong password");
    } finally {
      checking.current = false;
    }
  };

  const submit = async () => {
    const raw = input;
    stick.current = true;
    if (needPassword && job)
      return checkPassword("tray_approve_send", { requestId: job.requestId, password: raw });
    if (pending?.kind === "password") return checkPassword("tray_unlock", { password: raw });
    print({ ...line("cmd", raw), prompt: promptText });
    setInput("");
    if (pending?.kind === "confirm") {
      setPending(null);
      const answer = raw.trim().toLowerCase();
      if (answer !== pending.word && !(pending.word === "y" && answer === "yes"))
        return out("cancelled");
      const lapsed = snap ? pending.lapsed(snap) : SCOPE_CHANGED;
      if (lapsed === FEE_CHANGED) {
        err(lapsed);
        return run(pending.command);
      }
      if (lapsed) return err(lapsed);
      pending.run();
      return;
    }
    settleJob();
    if (!raw.trim()) return;
    setHistory((h) => [raw, ...h.filter((x) => x !== raw)].slice(0, 50));
    setHistAt(-1);
    run(raw);
  };

  const cancel = () => {
    stick.current = true;
    print({ ...line("cmd", `${secret ? "" : input}^C`), prompt: promptText });
    setInput("");
    if (pending) setPending(null);
    if (!busy) return;
    if (live?.stage === "sending")
      return print(line("dim", `${job.title}: already running, it cannot be stopped now`));
    void act({ type: "cancelSend", requestId: job.requestId });
    print(line("dim", `${job.title}: cancelled`));
    setJob(null);
    clearProgress();
  };

  const tabComplete = () => {
    const m = /^(\s*(?:\/|0xio\s+)?)(.*)$/i.exec(input);
    const head = m?.[1] ?? "";
    const next = complete(m?.[2] ?? input, snap, true);
    if (next) setInput(head + next);
  };

  const secret = needPassword || pending?.kind === "password";
  const promptText = secret
    ? "password:"
    : pending?.kind === "confirm"
      ? `${pending.word === "y" ? "[y/N]" : "yes?"}`
      : `${(wallet?.name ?? "0xio").toLowerCase().replace(/\s+/g, "-")}@${network.toLowerCase() || "0xio"} $`;

  return (
    <div
      className="cli"
      onMouseUp={() => {
        if (!window.getSelection()?.toString()) inputRef.current?.focus();
      }}
    >
      <div
        className="cli-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        <Header snap={snap} state={state} network={network} />
        <div role="log" aria-live="polite">
          {lines.map((l) =>
            l.kind === "qr" ? (
              <QrBlock key={l.id} text={l.text} />
            ) : l.key !== undefined ? (
              <div key={l.id} className={`cli-l cli-kv ${l.kind}${l.indent ? " in" : ""}`}>
                <span className="cli-k">{l.key}</span>
                <span>{l.text}</span>
              </div>
            ) : (
              <div key={l.id} className={`cli-l ${l.kind}`}>
                {l.kind === "cmd" ? <span className="cli-p">{l.prompt ?? "$"} </span> : null}
                {l.text}
              </div>
            ),
          )}
          {job && <JobView job={job} live={live} />}
        </div>
        <div
          className="cli-in"
          ref={(el) => {
            if (stick.current) el?.scrollIntoView({ block: "end" });
          }}
        >
          <span className="cli-p" aria-hidden="true">
            {promptText}
          </span>
          <input
            ref={inputRef}
            value={input}
            type={secret ? "password" : "text"}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-label={secret ? "Password" : pending ? "Answer" : "Command"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              else if (e.key === "Tab") {
                e.preventDefault();
                if (!secret) tabComplete();
              } else if (e.key === "c" && e.ctrlKey) {
                e.preventDefault();
                cancel();
              } else if (e.key === "l" && e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
                setLines(() => []);
              } else if (e.key === "ArrowUp" && !secret) {
                e.preventDefault();
                const at = Math.min(history.length - 1, histAt + 1);
                if (at >= 0) {
                  setHistAt(at);
                  setInput(history[at]);
                }
              } else if (e.key === "ArrowDown" && !secret && histAt >= 0) {
                e.preventDefault();
                setHistAt(histAt - 1);
                setInput(histAt > 0 ? history[histAt - 1] : "");
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Header({
  snap,
  state,
  network,
}: {
  snap: TraySnapshot | null;
  state: TrayState;
  network: string;
}) {
  const wallet = snap?.wallets.find((w) => w.id === snap.activeId);
  const rows: ReactNode[] = [];
  const row = (k: string, v: ReactNode) =>
    rows.push(
      <div key={k} className="cli-l cli-kv out">
        <span className="cli-k">{k}</span>
        <span>{v}</span>
      </div>,
    );
  row(
    "engine",
    <>
      <span className={`cli-dot${state.computing ? " busy" : ""}`} />
      {state.computing
        ? state.computingExtension
          ? "proving for the extension"
          : "proving"
        : state.clients > 0
          ? "private proofs on, extension connected"
          : "private proofs on"}
    </>,
  );
  if (!snap) row("wallet", "not loaded, type open");
  else if (snap.locked)
    row("wallet", `locked, type ${snap.biometric ? "unlock or touchid" : "unlock"}`);
  else {
    row("wallet", `${wallet?.name ?? "wallet"}  ${wallet ? shortAddr(wallet.address) : ""}`);
    row("network", network.toLowerCase());
    if (snap.publicMicro !== null)
      row(
        "balance",
        `${formatOCT(snap.publicMicro + (snap.privateMicro ?? 0))} OCT${
          snap.privacy && snap.privateMicro !== null
            ? `  (${formatOCT(snap.privateMicro)} private)`
            : ""
        }`,
      );
    if (snap.claims > 0) row("claims", `${snap.claims} waiting, type claim`);
  }
  return <div className="cli-head">{rows}</div>;
}

function JobView({ job, live }: { job: Job; live: TraySendProgress | null }) {
  const stage = live?.stage;
  const steps = live?.steps ?? [];
  const at = live?.stepIndex ?? 0;
  return (
    <div className="cli-job" aria-live="polite">
      <div className="cli-l dim">{job.title}</div>
      {!live && <div className="cli-l dim">{"  "}waiting for 0xio Desktop</div>}
      {stage === "approving" && <div className="cli-l acc">{"  "}approve with Touch ID</div>}
      {stage === "needPassword" && <div className="cli-l acc">{"  "}Touch ID off or cancelled</div>}
      {stage === "sending" &&
        steps.map((s, i) => (
          <div key={s} className={`cli-l ${i < at ? "out" : i === at ? "acc" : "dim"}`}>
            {"  "}
            {i < at ? "●" : i === at ? "◉" : "○"} {s}
          </div>
        ))}
      {stage === "sent" && (
        <div className="cli-l acc">
          {"  "}
          {job.done}
          {live?.pending ? "  (waiting for the network)" : ""}
        </div>
      )}
      {stage === "failed" && (
        <div className="cli-l err">
          {"  "}
          {live?.error ?? "failed"}
        </div>
      )}
    </div>
  );
}

function readinessText(r: TraySnapshot["privateReadiness"]): string {
  switch (r.state) {
    case "checking":
      return "checking";
    case "ok":
      return "ready";
    case "needsRefresh":
      return "a refresh is due (migrate)";
    case "keyUpdate":
      return `${keyUpdateCopy(r.mode, r.amountMicro).status.toLowerCase()} (migrate)`;
    case "noKey":
      return r.setup.state === "short"
        ? `off. add ${formatOCT(r.setup.addMicro)} OCT to turn it on`
        : r.setup.state === "unavailable"
          ? r.setup.reason === "fee"
            ? "network fee unavailable. try again"
            : "could not check your private balance. try again"
          : r.setup.state === "checking"
            ? "checking"
            : "off (migrate turns it on)";
    case "waiting":
      return r.reason === "setupPending"
        ? "turning on, waiting for the network"
        : "refresh waiting for the network";
    case "blocked":
    case "stuck":
      return r.detail;
  }
}

function QrBlock({ text }: { text: string }) {
  const qr = qrMatrix(text, "M");
  const n = qr.size;
  const cells: string[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) if (!qr.data[y * n + x]) cells.push(`M${x + 2} ${y + 2}h1v1h-1z`);
  const size = n + 4;
  return (
    <svg
      className="cli-qr"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Wallet address QR code"
    >
      <rect width={size} height={size} fill="#e8e8e8" />
      <rect x="2" y="2" width={n} height={n} fill="#0a0a0c" />
      <path d={cells.join("")} fill="#e8e8e8" />
    </svg>
  );
}
