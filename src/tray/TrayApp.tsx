import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "src/i18n/react";
import { qrToCanvas } from "src/lib/qr";
import Mascot from "src/shared/ui/Mascot";
import { useMascot } from "src/hooks/ui/useMascot";
import { isValidAddress } from "src/services/storage/addressBookService";
import { isNameInput } from "src/services/names/ons";
import { formatOCT, parseOCTInput } from "src/lib/format";
import { usePanelKeys, useTrayState, useTrayTheme } from "./useTrayState";
import Cli, { type CliMemory } from "./Cli";
import {
  complete,
  describeSend,
  keyUpdateCopy,
  knownRecipients,
  parseAmount,
  parseLine,
  type Parsed,
  type Verb,
} from "./commands";
import type {
  PrivateDirection,
  TrayAction,
  TraySendProgress,
  TraySnapshot,
  TrayState,
} from "./protocol";
import {
  keyConfirmScope,
  keyFeeGate,
  privateOpGate,
  privateSendBlock,
  privateStatusLines,
  sendGate,
  type PrivateSendFix,
} from "./gates";
import { FeeValue, MessageSlot, StatusSlot, feeLabel } from "./parts";
import SiteRequests, { LockedSiteRow } from "./SiteRequests";
import { useSiteQueue, type SiteQueueState } from "./useSiteQueue";
import { feeText } from "src/services/transactions/feeText";

type Act = (a: TrayAction) => Promise<unknown>;

const middle = (a: string, head = 8, tail = 6) =>
  a.length > head + tail + 1 ? `${a.slice(0, head)}...${a.slice(-tail)}` : a;
const errText = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong";
const REQUEST_FAILED = "That request did not go through. Try again.";
const networkLabel = (snap: TraySnapshot) =>
  snap.networks.find((n) => n.id === snap.network)?.name ?? snap.network;

/** A font size that keeps `text` on one line in `width` px: digits are about 0.6em wide. */
const fitFont = (text: string, max: number, width: number, perChar = 0.6) =>
  Math.max(14, Math.min(max, Math.floor(width / (text.length * perChar))));

function Amount({ micro, width = 200 }: { micro: number; width?: number }) {
  const [int, dec] = formatOCT(micro).split(".");
  return (
    <span className="tp-bal" style={{ fontSize: fitFont(`${int}.${dec ?? ""} OCT`, 28, width) }}>
      {int}
      {dec ? <span className="dec">.{dec}</span> : null} <span className="unit">OCT</span>
    </span>
  );
}

const Chevron = ({ back }: { back?: boolean }) =>
  back ? (
    <svg width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
      <path
        d="M6.5 1.5L1.5 6.5l5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true" style={{ opacity: 0.6 }}>
      <path
        d="M1 1l3.5 3.5L8 1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );

export default function TrayApp() {
  const { state, progress, setProgress, opened, act } = useTrayState();
  const theme = useTrayTheme();
  const [cliMemory] = useState<CliMemory>({});
  const sites = useSiteQueue(opened);
  usePanelKeys(act);
  const snap = state.snapshot;
  if (snap && !snap.locked && (sites.items.length > 0 || sites.outcome))
    return (
      <div className="tp" role="dialog" aria-label="0xio Desktop">
        <div className="tp-tint" aria-hidden="true" />
        <StatusLine state={state} progress={progress} />
        <SiteRequests key={opened} sites={sites} progress={progress} />
      </div>
    );
  if (theme === "cli")
    return (
      <div className="tp" role="dialog" aria-label="0xio Desktop">
        <div className="tp-tint" aria-hidden="true" />
        <Cli
          key={opened}
          state={state}
          act={act}
          progress={progress}
          clearProgress={() => setProgress(null)}
          memory={cliMemory}
        />
      </div>
    );
  return (
    <div className="tp" role="dialog" aria-label="0xio Desktop">
      <div className="tp-tint" aria-hidden="true" />
      <StatusLine state={state} progress={progress} />
      <Body
        key={opened}
        state={state}
        act={act}
        progress={progress}
        clearProgress={() => setProgress(null)}
        sites={sites}
      />
    </div>
  );
}

function StatusLine({ state, progress }: { state: TrayState; progress: TraySendProgress | null }) {
  const snap = state.snapshot;
  const engine = state.computing
    ? state.computingExtension
      ? "Proving for the extension"
      : "Proving"
    : state.clients > 0
      ? "Extension connected"
      : "Private proofs on";
  const steps = progress?.stage === "sending" ? (progress.steps ?? []) : [];
  const at = progress?.stepIndex ?? 0;
  const network = snap
    ? (snap.networks.find((n) => n.id === snap.network)?.name ?? snap.network)
    : "";
  const beat = state.computing ? " busy" : snap?.locked ? " rest" : "";
  return (
    <div className="tp-stat" aria-live="polite">
      <span className={`tp-beat${beat}`} aria-hidden="true" />
      <span>{snap?.locked ? "Locked" : engine}</span>
      {steps.length > 0 && (
        <span className="tp-sq" aria-label={`Step ${at + 1} of ${steps.length}`}>
          {steps.map((label, i) => (
            <i key={label} className={i <= at ? "on" : ""} />
          ))}
        </span>
      )}
      <span className="r">{snap?.locked ? engine : network}</span>
    </div>
  );
}

type View = "home" | "send" | "receive" | "private";
type SendInit = { to?: string; amount?: string; mode?: "public" | "private"; review?: boolean };
type PrivateInit = {
  dir?: PrivateDirection;
  amount?: string;
  step?: "refreshReview" | "migrateReview";
};

function Body({
  state,
  act,
  progress,
  clearProgress,
  sites,
}: {
  state: TrayState;
  act: Act;
  progress: TraySendProgress | null;
  clearProgress: () => void;
  sites: SiteQueueState;
}) {
  const [view, setView] = useState<View>("home");
  const [sendInit, setSendInit] = useState<SendInit>({});
  const [privateInit, setPrivateInit] = useState<PrivateInit>({});
  const snap = state.snapshot;
  const home = () => setView("home");
  if (!snap) {
    return (
      <div className="tp-pad">
        <div className="tp-row" style={{ justifyContent: "flex-end" }}>
          <MoreMenu snap={null} state={state} act={act} />
        </div>
        <div className="tp-center tp-grow">
          <p className="tp-muted" style={{ margin: 0, fontSize: 13.5 }}>
            Open 0xio Desktop to get started.
          </p>
        </div>
      </div>
    );
  }
  if (snap.locked) return <Locked snap={snap} state={state} act={act} sites={sites} />;
  if (view === "send")
    return (
      <Send
        snap={snap}
        act={act}
        progress={progress}
        clearProgress={clearProgress}
        onBack={home}
        onPrivate={(init) => {
          setPrivateInit(init);
          setView("private");
        }}
        initial={sendInit}
      />
    );
  if (view === "receive") return <Receive snap={snap} onBack={home} />;
  if (view === "private" && snap.privacy && snap.canSign)
    return (
      <Private
        snap={snap}
        act={act}
        progress={progress}
        clearProgress={clearProgress}
        onBack={home}
        initial={privateInit}
      />
    );
  return (
    <Home
      snap={snap}
      state={state}
      act={act}
      onSend={(init = {}) => {
        setSendInit(init);
        setView("send");
      }}
      onReceive={() => setView("receive")}
      onPrivate={(init = {}) => {
        setPrivateInit(init);
        setView("private");
      }}
    />
  );
}

const HIDE_KEY = "0xio_tray_hide_balance";
const readHidden = () => {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
};

const plainAmount = (micro: number) => formatOCT(micro).replace(/,/g, "");
/** Issues that mean "fill in the rest in the form", not "this is wrong". */
const MISSING = /^(Who to\?|How much\?)/;

function Home({
  snap,
  state,
  act,
  onSend,
  onReceive,
  onPrivate,
}: {
  snap: TraySnapshot;
  state: TrayState;
  act: Act;
  onSend: (init?: SendInit) => void;
  onReceive: () => void;
  onPrivate: (init?: PrivateInit) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [hidden, setHidden] = useState(readHidden);
  const [cmd, setCmd] = useState("");
  const [cmdError, setCmdError] = useState("");
  const privateAction = snap.privacy && snap.canSign;
  const toggleHidden = () => {
    const next = !hidden;
    setHidden(next);
    try {
      localStorage.setItem(HIDE_KEY, next ? "1" : "0");
    } catch {}
  };
  const total = snap.publicMicro === null ? null : snap.publicMicro + (snap.privateMicro ?? 0);
  const [int, dec] = total === null ? ["", ""] : formatOCT(total).split(".");

  const parsed = parseLine(cmd, snap, false);
  const preview = cmd.trim() ? commandPreview(parsed, snap) : null;
  const completion = complete(cmd, snap, false);

  const runVerb = (verb: Verb, args: string[] = []) => {
    setCmdError("");
    if (verb === "receive") onReceive();
    else if (verb === "encrypt" || verb === "decrypt" || verb === "private") {
      if (!privateAction) return setCmdError("Private is not available here");
      const amount = args.map(parseAmount).find(Boolean);
      onPrivate(
        verb === "private"
          ? {}
          : { dir: verb, amount: amount?.kind === "exact" ? plainAmount(amount.micro) : undefined },
      );
    } else if (verb === "claim") void act({ type: "openApp", route: "/privacy?tab=claim" });
    else if (verb === "lock") {
      if (!snap.hasPassword) return setCmdError("Set a password to lock");
      void act({ type: "lock" });
    } else if (verb === "open") void act({ type: "openApp" });
    else if (verb === "send") onSend();
    setCmd("");
  };

  const run = () => {
    if (!parsed.verb) {
      setCmdError("Try send, receive, encrypt, decrypt, claim, lock or open");
      return;
    }
    const s = parsed.send;
    if (parsed.verb.verb !== "send" || !s) return runVerb(parsed.verb.verb, parsed.args);
    const hard = s.issues.find((i) => !MISSING.test(i));
    if (hard) return setCmdError(hard);
    setCmd("");
    onSend({
      to: s.to?.address,
      amount: s.amount ? plainAmount(s.micro) : undefined,
      mode: s.mode,
      review: s.issues.length === 0,
    });
  };

  const suggestions: Verb[] = [
    "send",
    "receive",
    ...(privateAction ? (["encrypt"] as Verb[]) : []),
    ...(snap.hasPassword ? (["lock"] as Verb[]) : []),
  ];

  return (
    <div className="tp-pad tp-home">
      <div className="tp-row tp-hd">
        <WalletPicker snap={snap} act={act} />
        <MoreMenu snap={snap} state={state} act={act} open={menu} onOpen={setMenu} />
      </div>

      <div className="tp-hero">
        <button
          className="tp-big"
          style={{
            fontSize: hidden || total === null ? undefined : fitFont(formatOCT(total), 50, 272),
          }}
          onClick={toggleHidden}
          aria-label={hidden ? "Show balance" : "Hide balance"}
        >
          {hidden ? (
            <span className="tp-hidden">{"••••••"}</span>
          ) : total === null ? (
            <span className="tp-faint" style={{ fontSize: 13 }}>
              Open 0xio Desktop to load the balance
            </span>
          ) : (
            <>
              {int}
              {dec ? <span className="dec">.{dec}</span> : null}
            </>
          )}
        </button>
        <span className="tp-mono tp-sub2">
          {!hidden && total !== null && snap.privacy && snap.privateMicro !== null
            ? `OCT  (${formatOCT(snap.privateMicro)} private)`
            : "OCT"}
        </span>
      </div>

      <div className={`tp-slot${snap.claims > 0 ? "" : " off"}`}>
        <button
          className="tp-claimrow tp-lens"
          tabIndex={snap.claims > 0 ? 0 : -1}
          onClick={() => void act({ type: "openApp", route: "/privacy?tab=claim" })}
        >
          <span className="tp-mono">
            {"›"} {snap.claims} {snap.claims === 1 ? "transfer" : "transfers"} waiting
          </span>
          <b>Claim</b>
        </button>
      </div>

      <div className={`tp-cmd${cmdError ? " err" : ""}`}>
        <span className="p" aria-hidden="true">
          {"›"}
        </span>
        <input
          value={cmd}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label="Command"
          aria-describedby="tp-cmd-help"
          placeholder="send 10 to 0xio"
          onChange={(e) => {
            setCmd(e.target.value);
            setCmdError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
            else if (e.key === "Tab" && completion) {
              e.preventDefault();
              setCmd(completion);
            } else if (e.key === "Escape" && cmd) {
              e.stopPropagation();
              setCmd("");
            }
          }}
        />
        <kbd>{completion ? "tab" : "return"}</kbd>
      </div>
      <div id="tp-cmd-help" className="tp-sugg" aria-live="polite">
        {cmdError ? (
          <span className="tp-cmderr">{cmdError}</span>
        ) : preview ? (
          <span className={`tp-preview${preview.ok ? " ok" : ""}`}>{preview.text}</span>
        ) : (
          suggestions.map((v) => (
            <button key={v} className="tp-lens" onClick={() => runVerb(v)}>
              {v}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function commandPreview(p: Parsed, snap: TraySnapshot): { text: string; ok: boolean } {
  if (!p.verb)
    return { text: "Try send, receive, encrypt, decrypt, claim, lock or open", ok: false };
  const s = p.send;
  if (!s) return { text: p.verb.help, ok: true };
  if (!s.issues.length) return { text: `${describeSend(s)}, return to review`, ok: true };
  const hard = s.issues.find((i) => !MISSING.test(i));
  if (hard) return { text: hard, ok: false };
  if (s.to || s.amount) return { text: `${describeSend(s)}, return to fill the rest`, ok: true };
  return { text: s.issues[0], ok: snap.wallets.length > 0 };
}

function WalletPicker({ snap, act }: { snap: TraySnapshot; act: Act }) {
  const [open, setOpen] = useState(false);
  const wallet = snap.wallets.find((w) => w.id === snap.activeId) ?? snap.wallets[0];
  return (
    <div style={{ position: "relative", minWidth: 0 }}>
      <button
        className="tp-walletbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>{wallet?.name ?? "Wallet"}</span>
        <Chevron />
      </button>
      {open && <div className="tp-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
      {open && (
        <div className="tp-menu left" role="menu" aria-label="Wallets">
          {snap.wallets.map((w) => (
            <button
              key={w.id}
              role="menuitemradio"
              aria-checked={w.id === snap.activeId}
              onClick={() => {
                setOpen(false);
                if (w.id !== snap.activeId) void act({ type: "switchWallet", id: w.id });
              }}
            >
              <span className={`tp-dot${w.id === snap.activeId ? " on" : ""}`} />
              <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span>{w.name}</span>
                <span className="tp-mono tp-faint" style={{ fontSize: 11 }}>
                  {middle(w.address)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MoreMenu({
  snap,
  state,
  act,
  open: controlled,
  onOpen,
}: {
  snap: TraySnapshot | null;
  state: TrayState;
  act: Act;
  open?: boolean;
  onOpen?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = onOpen ?? setOwn;
  const [error, setError] = useState("");
  const loginToggle = async () => {
    setError("");
    try {
      await act({ type: "setOpenAtLogin", enabled: !state.openAtLogin });
    } catch {
      setError("Could not change Open at login. Try again.");
    }
  };
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div style={{ position: "relative" }}>
      <button
        className="tp-icon"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open && <div className="tp-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
      {open && (
        <div className="tp-menu right" role="menu" aria-label="More">
          {snap && !snap.locked && (
            <>
              <p className="tp-menuhd">Network</p>
              {snap.networks.map((n) => (
                <button
                  key={n.id}
                  role="menuitemradio"
                  aria-checked={n.id === snap.network}
                  onClick={pick(() => {
                    if (n.id !== snap.network) void act({ type: "setNetwork", id: n.id });
                  })}
                >
                  <span className={`tp-dot${n.id === snap.network ? " on" : ""}`} />
                  {n.name}
                </button>
              ))}
              <div className="tp-sep" />
              <button
                role="menuitem"
                disabled={!snap.hasPassword}
                onClick={pick(() => void act({ type: "lock" }))}
              >
                Lock now<span className="tp-kbd">{"⌘"}L</span>
              </button>
            </>
          )}
          <button role="menuitemcheckbox" aria-checked={state.openAtLogin} onClick={loginToggle}>
            Open at login
            <span className={`tp-switch${state.openAtLogin ? " on" : ""}`} aria-hidden="true" />
          </button>
          {error && (
            <div className="tp-err" style={{ padding: "0 10px" }}>
              {error}
            </div>
          )}
          <div className="tp-sep" />
          <button role="menuitem" onClick={pick(() => void act({ type: "openApp" }))}>
            Open 0xio Desktop<span className="tp-kbd">{"⌘"}O</span>
          </button>
          <button role="menuitem" onClick={pick(() => void act({ type: "quit" }))}>
            Quit<span className="tp-kbd">{"⌘"}Q</span>
          </button>
        </div>
      )}
    </div>
  );
}

function SubHead({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  return (
    <div className="tp-sub">
      {onBack && (
        <button className="tp-back" aria-label="Back" onClick={onBack}>
          <Chevron back />
        </button>
      )}
      <span className="t">{title}</span>
      {right}
    </div>
  );
}

function Working({ title, progress }: { title: string; progress: TraySendProgress }) {
  const steps = progress.steps ?? [];
  const at = progress.stepIndex ?? 0;
  return (
    <div className="tp-pad">
      <SubHead title={title} />
      <div className="tp-recess tp-steps" aria-live="polite">
        {steps.map((label, i) => (
          <div key={label} className={`tp-step${i < at ? " done" : i === at ? " now" : ""}`}>
            <i />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

function WaitApprove({ approving, onCancel }: { approving: boolean; onCancel: () => void }) {
  return (
    <div className="tp-pad">
      <SubHead title="Approve" />
      <div className="tp-center" style={{ padding: "14px 0 6px" }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>
          {approving ? "Approve with Touch ID" : "Waiting for 0xio Desktop"}
        </span>
      </div>
      <button className="tp-btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** The password, checked in Rust, when Touch ID is off or was cancelled. */
function PasswordApprove({ requestId, onCancel }: { requestId: string; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const approve = async () => {
    setPwError("");
    try {
      await invoke("tray_approve_send", { requestId, password });
      setPassword("");
    } catch (e) {
      setPwError(errText(e).includes("Too many") ? errText(e) : "Wrong password");
    }
  };
  return (
    <div className="tp-pad">
      <SubHead title="Approve" onBack={onCancel} />
      <div>
        <label className="tp-label" htmlFor="tp-approve-pw">
          Password
        </label>
        <div className={`tp-field pw${pwError ? " err" : ""}`}>
          <input
            id="tp-approve-pw"
            type="password"
            value={password}
            autoFocus
            placeholder="Your wallet password"
            aria-invalid={!!pwError}
            aria-describedby="tp-approve-err"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && password && void approve()}
          />
        </div>
        <div id="tp-approve-err" className="tp-err" role="alert">
          {pwError}
        </div>
      </div>
      <div className="tp-two">
        <button className="tp-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="tp-btn pri" disabled={!password} onClick={() => void approve()}>
          Approve
        </button>
      </div>
    </div>
  );
}

function Send({
  snap,
  act,
  progress,
  clearProgress,
  onBack,
  onPrivate,
  initial,
}: {
  snap: TraySnapshot;
  act: Act;
  progress: TraySendProgress | null;
  clearProgress: () => void;
  onBack: () => void;
  onPrivate: (init: PrivateInit) => void;
  initial?: SendInit;
}) {
  const { t } = useTranslation();
  const wallet = snap.wallets.find((w) => w.id === snap.activeId);
  const [mode, setMode] = useState<"public" | "private">(
    initial?.mode ?? (snap.privacy ? "private" : "public"),
  );
  const [to, setTo] = useState(initial?.to ?? "");
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [step, setStep] = useState<"form" | "review" | "waiting">(
    initial?.review ? "review" : "form",
  );
  const [requestId, setRequestId] = useState("");
  const [requestError, setRequestError] = useState("");
  const live = progress && progress.requestId === requestId ? progress : null;

  const priv = mode === "private" && snap.privacy;
  const micro = parseOCTInput(amount);
  const gate = sendGate(snap, priv ? "private" : "public", micro);
  const block = priv ? privateSendBlock(snap.privateReadiness) : null;
  const available = gate.available;
  const addressOk = isValidAddress(to.trim());
  const canReview = addressOk && gate.ok && !!wallet && !block;
  const formError = isNameInput(to)
    ? t("ons.trayRefused")
    : to && !addressOk
      ? "That address does not look right"
      : amount
        ? gate.amountError
        : "";
  const retry = () => void act({ type: "retryReads" });
  const fix = block?.line ? privateFix(snap, block.fix, onPrivate, retry) : null;
  const toName = knownRecipients(snap).find((r) => r.address === to.trim())?.label;

  const submit = async () => {
    if (!wallet || !canReview || gate.feeOu === null) return;
    const id = crypto.randomUUID();
    setRequestId(id);
    setRequestError("");
    setStep("waiting");
    try {
      await act({
        type: "send",
        requestId: id,
        to: to.trim(),
        amountMicro: micro,
        mode: priv ? "private" : "public",
        feeOu: gate.feeOu,
        walletId: wallet.id,
        network: snap.network,
      });
    } catch {
      setRequestError(REQUEST_FAILED);
      setStep("review");
    }
  };
  const cancel = () => {
    if (requestId) void act({ type: "cancelSend", requestId });
    clearProgress();
    setStep("review");
  };
  const done = () => {
    clearProgress();
    onBack();
  };

  if (step === "waiting" && live?.stage === "sent") {
    return (
      <div className="tp-pad">
        <div className="tp-center" style={{ padding: "14px 0 4px" }}>
          <span style={{ fontSize: 22, fontWeight: 600 }}>Sent</span>
          <span className="tp-muted" style={{ fontSize: 13 }}>
            {formatOCT(micro)} OCT to <span className="tp-mono">{middle(to.trim())}</span>
          </span>
        </div>
        <div className="tp-two">
          <button className="tp-btn" onClick={done}>
            Done
          </button>
          <button className="tp-btn" onClick={() => void act({ type: "openApp", route: "/" })}>
            View details
          </button>
        </div>
      </div>
    );
  }

  if (step === "waiting" && live?.stage === "failed") {
    return (
      <div className="tp-pad">
        <SubHead title="Send" onBack={cancel} />
        <MessageSlot text={live.error ?? REQUEST_FAILED} />
        <button className="tp-btn" onClick={cancel}>
          Back to review
        </button>
      </div>
    );
  }

  if (step === "waiting" && live?.stage === "sending")
    return <Working title={priv ? "Sending privately" : "Sending"} progress={live} />;
  if (step === "waiting" && live?.stage === "needPassword")
    return <PasswordApprove requestId={requestId} onCancel={cancel} />;
  if (step === "waiting")
    return <WaitApprove approving={live?.stage === "approving"} onCancel={cancel} />;

  if (step === "review") {
    return (
      <div className="tp-pad">
        <SubHead
          title="Review"
          onBack={() => setStep("form")}
          right={
            <span className="tp-faint" style={{ fontSize: 12.5 }}>
              {wallet?.name}
            </span>
          }
        />
        <div className="tp-row">
          <Amount micro={micro} />
          <span className={`tp-tag ${priv ? "priv" : "pub"}`}>{priv ? "Private" : "Public"}</span>
        </div>
        <div className="tp-recess" style={{ padding: "4px 14px" }}>
          <div className="tp-kv">
            <span>From</span>
            <span>{wallet?.name}</span>
          </div>
          <div className="tp-kv">
            <span>To</span>
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              {toName && <span>{toName}</span>}
              <span className="tp-mono" style={{ fontSize: 12.5 }}>
                {middle(to.trim())}
              </span>
            </span>
          </div>
          <div className="tp-kv">
            <span>Network fee</span>
            <FeeValue fee={gate.fee} />
          </div>
          <div className="tp-kv">
            <span>Network</span>
            <span>{networkLabel(snap)}</span>
          </div>
        </div>
        {fix && !requestError ? (
          <MessageSlot text={block?.line ?? ""} onRetry={fix.run} label={fix.label} />
        ) : (
          <MessageSlot
            text={requestError || block?.line || gate.feeError || gate.amountError}
            onRetry={gate.retry ? retry : undefined}
          />
        )}
        <div className="tp-two">
          <button className="tp-btn" onClick={() => setStep("form")}>
            Back
          </button>
          <button className="tp-btn pri" disabled={!canReview} onClick={() => void submit()}>
            Send
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tp-pad">
      <SubHead
        title="Send"
        onBack={onBack}
        right={
          <span className="tp-faint" style={{ fontSize: 12.5 }}>
            {wallet?.name}
          </span>
        }
      />
      <div className="tp-seg" role="group" aria-label="Send type">
        <button aria-pressed={!priv} onClick={() => setMode("public")}>
          Public
        </button>
        <button aria-pressed={priv} disabled={!snap.privacy} onClick={() => setMode("private")}>
          Private
        </button>
      </div>
      <div>
        <label className="tp-label" htmlFor="tp-to">
          To
        </label>
        <div className={`tp-field${to && !addressOk ? " err" : ""}`}>
          <input
            id="tp-to"
            value={to}
            spellCheck={false}
            placeholder="Address starting with oct"
            onChange={(e) => setTo(e.target.value)}
          />
          {to ? (
            <button className="tp-link" onClick={() => setTo("")}>
              Clear
            </button>
          ) : (
            <button
              className="tp-link"
              onClick={async () => {
                try {
                  setTo((await navigator.clipboard.readText()).trim());
                } catch {
                  document.getElementById("tp-to")?.focus();
                }
              }}
            >
              Paste
            </button>
          )}
        </div>
      </div>
      <div>
        <label className="tp-label" htmlFor="tp-amount">
          Amount
        </label>
        <div className={`tp-field big${amount && gate.amountError ? " err" : ""}`}>
          <input
            id="tp-amount"
            inputMode="decimal"
            value={amount}
            placeholder="0"
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          />
          <span className="unit">OCT</span>
          <button
            className="tp-link"
            disabled={gate.feeOu === null}
            onClick={() => setAmount(formatOCT(available).replace(/,/g, ""))}
          >
            Max
          </button>
        </div>
        <div className="tp-hint">
          {formError ? (
            <span style={{ color: "var(--error)" }}>{feeText(formError)}</span>
          ) : (
            `Available ${formatOCT(available)} OCT${priv ? " private" : ""}`
          )}
        </div>
      </div>
      <div className="tp-kv" style={{ border: 0, padding: 0 }}>
        <span>Network fee</span>
        <span className="tp-muted">
          <FeeValue fee={gate.fee} />
        </span>
      </div>
      {fix ? (
        <MessageSlot text={block?.line ?? ""} onRetry={fix.run} label={fix.label} />
      ) : (
        <MessageSlot text={block?.line || gate.feeError} onRetry={gate.retry ? retry : undefined} />
      )}
      <button className="tp-btn pri" disabled={!canReview} onClick={() => setStep("review")}>
        Review
      </button>
    </div>
  );
}

function privateFix(
  snap: TraySnapshot,
  fix: PrivateSendFix | null,
  onPrivate: (init: PrivateInit) => void,
  retry: () => void,
): { label: string; run: () => void } | null {
  const r = snap.privateReadiness;
  if (fix === "retry") return { label: "Retry", run: retry };
  if (fix === "migrate")
    return { label: "Migrate", run: () => onPrivate({ step: "refreshReview" }) };
  if (fix === "turnOn") return { label: "Turn on", run: () => onPrivate({}) };
  if (fix === "keyUpdate" && r.state === "keyUpdate")
    return {
      label: keyUpdateCopy(r.mode, r.amountMicro).action,
      run: () => onPrivate({ step: "migrateReview" }),
    };
  return null;
}

function Private({
  snap,
  act,
  progress,
  clearProgress,
  onBack,
  initial,
}: {
  snap: TraySnapshot;
  act: Act;
  progress: TraySendProgress | null;
  clearProgress: () => void;
  onBack: () => void;
  initial?: PrivateInit;
}) {
  const wallet = snap.wallets.find((w) => w.id === snap.activeId);
  const [dir, setDir] = useState<PrivateDirection>(initial?.dir ?? "encrypt");
  const [step, setStep] = useState<
    "home" | "form" | "review" | "refreshReview" | "migrateReview" | "waiting"
  >(initial?.step ?? (initial?.dir ? "form" : "home"));
  const [job, setJob] = useState<"op" | "refresh" | "turnOn" | "migrate">("op");
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [requestId, setRequestId] = useState("");
  const [requestError, setRequestError] = useState("");
  const live = progress && progress.requestId === requestId ? progress : null;
  const retry = () => void act({ type: "retryReads" });

  const enc = dir === "encrypt";
  const verb = enc ? "encrypt" : "decrypt";
  const readiness = snap.privateReadiness;
  const pub = snap.publicMicro ?? 0;
  const priv = snap.privateMicro ?? 0;
  const micro = parseOCTInput(amount);
  const op = privateOpGate(snap, dir, micro);
  const refresh = op.refresh;
  const available = op.available;
  const formError = amount ? op.amountError : "";
  const feeFormat = (ou: number) =>
    refresh ? `${ou.toLocaleString("en-US")} OU (2 transactions)` : feeLabel(ou);
  const heading = step === "home" ? "Private" : enc ? "Encrypt" : "Decrypt";
  const network = networkLabel(snap);
  const walletName = (
    <span className="tp-faint" style={{ fontSize: 12.5 }}>
      {wallet?.name}
    </span>
  );
  const networkRow = (
    <div className="tp-kv">
      <span>Network</span>
      <span>{network}</span>
    </div>
  );

  const refreshGate = keyFeeGate(snap.fees.refresh, snap.publicMicro);
  const setupOffer = readiness.state === "noKey" ? readiness.setup : null;
  const keyUpdate = readiness.state === "keyUpdate" ? readiness : null;
  const keyCopy = keyUpdate ? keyUpdateCopy(keyUpdate.mode, keyUpdate.amountMicro) : null;
  const keyGate = keyUpdate ? keyFeeGate(keyUpdate.fee, snap.publicMicro) : null;
  const confirmScope = keyConfirmScope(snap);
  const confirmed = !!confirmScope && confirmedFor === confirmScope;

  const open = (d: PrivateDirection) => {
    setDir(d);
    setAmount("");
    setStep("form");
  };
  const send = async (type: typeof job, back: typeof step, build: (id: string) => TrayAction) => {
    if (!wallet) return;
    const id = crypto.randomUUID();
    setJob(type);
    setRequestId(id);
    setRequestError("");
    setStep("waiting");
    try {
      await act(build(id));
    } catch {
      setRequestError(REQUEST_FAILED);
      setStep(back);
    }
  };
  const submitKey = (type: "refresh" | "turnOn", feeOu: number | null) => {
    if (!wallet || !feeOu) return;
    void send(type, type === "refresh" ? "refreshReview" : "home", (id) => ({
      type,
      requestId: id,
      walletId: wallet.id,
      network: snap.network,
      feeOu,
    }));
  };
  const submitMigrate = () => {
    const feeOu = keyGate?.feeOu;
    if (!wallet || !keyUpdate || !feeOu || !confirmed || !keyGate?.ok) return;
    void send("migrate", "migrateReview", (id) => ({
      type: "migrate",
      requestId: id,
      walletId: wallet.id,
      network: snap.network,
      mode: keyUpdate.mode,
      amountMicro: keyUpdate.amountMicro,
      feeOu,
      confirmed: true,
    }));
  };
  const submit = () => {
    const feeOu = op.opFeeOu;
    const refreshFeeOu = op.refreshFeeOu;
    if (!wallet || !op.ok || feeOu === null || refreshFeeOu === null) return;
    void send("op", "review", (id) => ({
      type: "private",
      requestId: id,
      direction: dir,
      amountMicro: micro,
      refresh,
      feeOu,
      refreshFeeOu,
      walletId: wallet.id,
      network: snap.network,
    }));
  };
  const cancel = () => {
    if (requestId) void act({ type: "cancelSend", requestId });
    clearProgress();
    setStep(
      job === "refresh"
        ? "refreshReview"
        : job === "migrate"
          ? "migrateReview"
          : job === "turnOn"
            ? "home"
            : "review",
    );
  };
  const close = () => {
    clearProgress();
    setRequestId("");
    setAmount("");
    setConfirmedFor(null);
    setStep("home");
  };

  if (step === "waiting" && live?.stage === "sent") {
    return (
      <div className="tp-pad">
        <SubHead title={job === "op" ? heading : "Private"} right={walletName} />
        <div className="tp-center" style={{ padding: "14px 0 4px" }}>
          <span style={{ fontSize: 22, fontWeight: 600 }}>
            {live.pending
              ? "Submitted"
              : job === "refresh"
                ? "Migrated"
                : job === "migrate"
                  ? keyCopy?.done
                  : job === "turnOn"
                    ? "Setting up"
                    : enc
                      ? "Encrypted"
                      : "Decrypted"}
          </span>
          {(job === "op" || job === "turnOn" || live.pending) && (
            <span className="tp-muted" style={{ fontSize: 13 }}>
              {job === "op" ? `${formatOCT(micro)} OCT` : "Waiting for the network"}
            </span>
          )}
        </div>
        <button className="tp-btn" onClick={close}>
          Done
        </button>
      </div>
    );
  }
  if (step === "waiting" && live?.stage === "failed") {
    return (
      <div className="tp-pad">
        <SubHead title={job === "op" ? heading : "Private"} onBack={close} right={walletName} />
        <MessageSlot text={live.error ?? REQUEST_FAILED} />
        <div className="tp-two">
          <button className="tp-btn" onClick={close}>
            Close
          </button>
          <button className="tp-btn pri" onClick={cancel}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (step === "waiting" && live?.stage === "sending")
    return (
      <Working
        title={
          job === "refresh"
            ? "Migrating"
            : job === "migrate"
              ? (keyCopy?.working ?? "Migrating")
              : job === "turnOn"
                ? "Turning on"
                : enc
                  ? "Encrypting"
                  : "Decrypting"
        }
        progress={live}
      />
    );
  if (step === "waiting" && live?.stage === "needPassword")
    return <PasswordApprove requestId={requestId} onCancel={cancel} />;
  if (step === "waiting")
    return <WaitApprove approving={live?.stage === "approving"} onCancel={cancel} />;

  if (setupOffer?.state === "offer") {
    const fee = { state: "ok", ou: setupOffer.feeOu } as const;
    return (
      <div className="tp-pad">
        <SubHead title="Private" onBack={onBack} right={walletName} />
        <div className="tp-center" style={{ padding: "6px 0 0", gap: 6 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Turn on private balance</span>
          <span className="tp-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
            Encrypt and send privately from this wallet.
          </span>
        </div>
        <div className="tp-recess" style={{ padding: "4px 14px" }}>
          <div className="tp-kv">
            <span>Network fee (one time)</span>
            <FeeValue fee={fee} />
          </div>
          {networkRow}
        </div>
        <MessageSlot text={requestError} />
        <div className="tp-two">
          <button className="tp-btn" onClick={onBack}>
            Not now
          </button>
          <button
            className="tp-btn pri"
            disabled={!wallet}
            onClick={() => submitKey("turnOn", setupOffer.feeOu)}
          >
            Turn on
          </button>
        </div>
      </div>
    );
  }

  const usable =
    readiness.state === "ok" ||
    readiness.state === "needsRefresh" ||
    readiness.state === "checking";

  if (step === "migrateReview" && keyUpdate && keyCopy && keyGate) {
    return (
      <div className="tp-pad">
        <SubHead title={keyCopy.title} onBack={() => setStep("home")} right={walletName} />
        <div className="tp-recess" style={{ padding: "4px 14px" }}>
          <div className="tp-kv">
            <span>What</span>
            <span>{keyCopy.what}</span>
          </div>
          <div className="tp-kv">
            <span>Network fee</span>
            <FeeValue fee={keyUpdate.fee} />
          </div>
          {networkRow}
        </div>
        <button
          className="tp-switchrow"
          role="switch"
          aria-checked={confirmed}
          onClick={() => setConfirmedFor(confirmed ? null : confirmScope)}
        >
          <span style={{ textAlign: "left", fontSize: 12.5, lineHeight: 1.5 }}>
            {keyCopy.confirm}
          </span>
          <span className={`tp-switch${confirmed ? " on" : ""}`} aria-hidden="true" />
        </button>
        <MessageSlot
          text={requestError || keyGate.feeError}
          onRetry={keyGate.retry ? retry : undefined}
        />
        <div className="tp-two">
          <button className="tp-btn" onClick={() => setStep("home")}>
            Back
          </button>
          <button
            className="tp-btn pri"
            disabled={!keyGate.ok || !confirmed || !wallet}
            onClick={submitMigrate}
          >
            {keyCopy.action}
          </button>
        </div>
      </div>
    );
  }

  if (step === "refreshReview" && readiness.state === "needsRefresh") {
    return (
      <div className="tp-pad">
        <SubHead title="Migrate balance" onBack={() => setStep("home")} right={walletName} />
        <div className="tp-recess" style={{ padding: "4px 14px" }}>
          <div className="tp-kv">
            <span>What</span>
            <span>Rebuilds your private balance as one fresh copy under your key</span>
          </div>
          <div className="tp-kv">
            <span>Network fee</span>
            <FeeValue fee={snap.fees.refresh} />
          </div>
          {networkRow}
        </div>
        <MessageSlot
          text={requestError || refreshGate.feeError}
          onRetry={refreshGate.retry ? retry : undefined}
        />
        <div className="tp-two">
          <button className="tp-btn" onClick={() => setStep("home")}>
            Back
          </button>
          <button
            className="tp-btn pri"
            disabled={!refreshGate.ok || !wallet}
            onClick={() => submitKey("refresh", refreshGate.feeOu)}
          >
            Migrate
          </button>
        </div>
      </div>
    );
  }

  if (usable && step === "review") {
    return (
      <div className="tp-pad">
        <SubHead title={heading} onBack={() => setStep("form")} right={walletName} />
        <div className="tp-row">
          <Amount micro={micro} />
          <span className="tp-tag priv">{enc ? "Encrypt" : "Decrypt"}</span>
        </div>
        <div className="tp-recess" style={{ padding: "4px 14px" }}>
          <div className="tp-kv">
            <span>{enc ? "From public" : "From private"}</span>
            <span>{formatOCT(enc ? pub : priv)} OCT</span>
          </div>
          {refresh && (
            <>
              <div className="tp-kv">
                <span>Steps</span>
                <span>Refresh your private balance, then {verb}</span>
              </div>
              <div className="tp-kv">
                <span>Why</span>
                <span>It reached its limit of layers</span>
              </div>
            </>
          )}
          <div className="tp-kv">
            <span>Network fee</span>
            <FeeValue fee={op.fee} label={feeFormat} />
          </div>
          {networkRow}
        </div>
        <MessageSlot
          text={requestError || op.feeError || op.amountError}
          onRetry={op.retry ? retry : undefined}
        />
        <div className="tp-two">
          <button className="tp-btn" onClick={() => setStep("form")}>
            Back
          </button>
          <button
            className="tp-btn pri"
            disabled={!op.ok || !wallet || readiness.state === "checking"}
            onClick={submit}
          >
            {enc ? "Encrypt" : "Decrypt"}
          </button>
        </div>
      </div>
    );
  }

  if (usable && step === "form") {
    return (
      <div className="tp-pad">
        <SubHead title={heading} onBack={() => setStep("home")} right={walletName} />
        <div className="tp-seg" role="group" aria-label="Direction">
          <button aria-pressed={enc} onClick={() => setDir("encrypt")}>
            Encrypt
          </button>
          <button aria-pressed={!enc} onClick={() => setDir("decrypt")}>
            Decrypt
          </button>
        </div>
        <div>
          <label className="tp-label" htmlFor="tp-priv-amount">
            Amount
          </label>
          <div className={`tp-field big${formError ? " err" : ""}`}>
            <input
              id="tp-priv-amount"
              inputMode="decimal"
              value={amount}
              autoFocus
              placeholder="0"
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <span className="unit">OCT</span>
            <button
              className="tp-link"
              disabled={op.feeOu === null}
              onClick={() => setAmount(formatOCT(available).replace(/,/g, ""))}
            >
              Max
            </button>
          </div>
          <div className="tp-hint">
            {formError ? (
              <span style={{ color: "var(--error)" }}>{feeText(formError)}</span>
            ) : (
              `Available ${formatOCT(available)} OCT ${enc ? "public" : "private"}`
            )}
          </div>
        </div>
        <div className="tp-kv" style={{ border: 0, padding: 0 }}>
          <span>Network fee</span>
          <span className="tp-muted">
            <FeeValue fee={op.fee} label={feeFormat} />
          </span>
        </div>
        <MessageSlot text={op.feeError} onRetry={op.retry ? retry : undefined} />
        <button
          className="tp-btn pri"
          disabled={!op.ok || !wallet || readiness.state === "checking"}
          onClick={() => setStep("review")}
        >
          Review
        </button>
      </div>
    );
  }

  return (
    <div className="tp-pad">
      <SubHead title="Private" onBack={onBack} right={walletName} />
      <div className="tp-recess" style={{ padding: "4px 14px" }}>
        <div className="tp-kv">
          <span>Public</span>
          <span>{snap.publicMicro === null ? "" : `${formatOCT(pub)} OCT`}</span>
        </div>
        <div className="tp-kv">
          <span>Private</span>
          <span>{snap.privateMicro === null ? "" : `${formatOCT(priv)} OCT`}</span>
        </div>
      </div>
      <StatusSlot lines={privateStatusLines(readiness)} />
      {readiness.state === "ok" || readiness.state === "checking" ? (
        <div className="tp-two">
          <button
            className="tp-btn pri"
            disabled={readiness.state === "checking"}
            onClick={() => open("encrypt")}
          >
            Encrypt
          </button>
          <button
            className="tp-btn"
            disabled={readiness.state === "checking"}
            onClick={() => open("decrypt")}
          >
            Decrypt
          </button>
        </div>
      ) : readiness.state === "needsRefresh" ? (
        <div
          className="tp-act"
          style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.5fr)" }}
        >
          <button className="tp-btn" onClick={() => open("encrypt")}>
            Encrypt
          </button>
          <button className="tp-btn" onClick={() => open("decrypt")}>
            Decrypt
          </button>
          <button
            className="tp-btn pri"
            onClick={() => {
              setRequestError("");
              setStep("refreshReview");
            }}
          >
            Migrate balance
          </button>
        </div>
      ) : keyUpdate && keyCopy ? (
        <button
          className="tp-btn pri"
          onClick={() => {
            setRequestError("");
            setConfirmedFor(null);
            setStep("migrateReview");
          }}
        >
          {keyCopy.title}
        </button>
      ) : setupOffer?.state === "unavailable" ? (
        <button className="tp-btn pri" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

function useQr(canvas: RefObject<HTMLCanvasElement | null>, value: string) {
  // Syncs the canvas with the address.
  useEffect(() => {
    if (!canvas.current || !value) return;
    qrToCanvas(canvas.current, value, {
      margin: 0,
      width: 368,
      level: "M",
      dark: "#141519",
      light: "#ffffff",
    });
  }, [canvas, value]);
}

function Receive({ snap, onBack }: { snap: TraySnapshot; onBack: () => void }) {
  const wallet = snap.wallets.find((w) => w.id === snap.activeId);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  useQr(canvas, wallet?.address ?? "");
  const network = snap.networks.find((n) => n.id === snap.network)?.name ?? snap.network;
  const copy = async () => {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  };
  const save = () => {
    if (!canvas.current || !wallet) return;
    const link = document.createElement("a");
    link.download = `${wallet.address.slice(0, 12)}-qr.png`;
    link.href = canvas.current.toDataURL("image/png");
    link.click();
  };
  return (
    <div className="tp-pad">
      <SubHead title="Receive" onBack={onBack} right={<span className="tp-pill">{network}</span>} />
      <div className="tp-center" style={{ gap: 14, paddingTop: 4 }}>
        <div className="tp-qr">
          <canvas ref={canvas} role="img" aria-label="Wallet address QR code" />
        </div>
        <div className="tp-center" style={{ gap: 4 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{wallet?.name}</span>
          <span className="tp-full">{wallet?.address}</span>
        </div>
      </div>
      <div className="tp-two">
        <button className="tp-btn pri" onClick={copy}>
          {copied ? "Copied" : "Copy address"}
        </button>
        <button className="tp-btn" onClick={save}>
          Save QR
        </button>
      </div>
    </div>
  );
}

function Locked({
  snap,
  state,
  act,
  sites,
}: {
  snap: TraySnapshot;
  state: TrayState;
  act: Act;
  sites: SiteQueueState;
}) {
  const [usePw, setUsePw] = useState(!snap.biometric);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const { phase, lookDeg, leanX } = useMascot(anchor, working);

  const unlock = useCallback(async () => {
    if (!password || working) return;
    setWorking(true);
    setError("");
    try {
      await invoke("tray_unlock", { password });
      setPassword("");
    } catch (e) {
      const msg = errText(e);
      setError(msg.includes("Too many") ? msg : "Wrong password");
    } finally {
      setWorking(false);
    }
  }, [password, working]);

  const touch = async () => {
    setWorking(true);
    try {
      await act({ type: "unlockBiometric" });
    } finally {
      setTimeout(() => setWorking(false), 1600);
    }
  };

  return (
    <div className="tp-pad">
      <div className="tp-row" style={{ justifyContent: "flex-end", height: 28 }}>
        <MoreMenu snap={snap} state={state} act={act} />
      </div>
      <div ref={anchor} className="tp-center tp-grow" style={{ gap: 6 }}>
        <Mascot id="tray" phase={phase} size={56} lookDeg={lookDeg} leanX={leanX} />
        <span style={{ fontSize: 15, fontWeight: 600, marginTop: 10 }}>0xio is locked</span>
      </div>
      <LockedSiteRow items={sites.items} />
      {usePw ? (
        <div className="tp-actions">
          <div>
            <div className={`tp-field pw${error ? " err" : ""}`}>
              <input
                id="tp-pw"
                type={show ? "text" : "password"}
                value={password}
                autoFocus
                placeholder="Your wallet password"
                aria-label="Password"
                aria-invalid={!!error}
                aria-describedby="tp-pw-err"
                disabled={working}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void unlock()}
              />
              <button className="tp-link" onClick={() => setShow(!show)}>
                {show ? "Hide" : "Show"}
              </button>
            </div>
            <div id="tp-pw-err" className="tp-err" role="alert">
              {error}
            </div>
          </div>
          <button
            className="tp-btn pri"
            disabled={!password || working}
            onClick={() => void unlock()}
          >
            {working ? "Unlocking" : "Unlock"}
          </button>
          <button
            className="tp-link plain"
            style={{ alignSelf: "center", visibility: snap.biometric ? "visible" : "hidden" }}
            onClick={() => setUsePw(false)}
          >
            Use Touch ID
          </button>
        </div>
      ) : (
        <div className="tp-actions">
          <button className="tp-btn pri" disabled={working} onClick={() => void touch()}>
            Unlock with Touch ID
          </button>
          <button
            className="tp-link plain"
            style={{ alignSelf: "center" }}
            onClick={() => setUsePw(true)}
          >
            Use password
          </button>
        </div>
      )}
    </div>
  );
}
