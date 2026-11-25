import { getContacts, isValidAddress } from "src/services/storage/addressBookService";
import { isNameInput } from "src/services/names/ons";
import { formatOCT, parseOCTInput } from "src/lib/format";
import { FEE_SHORT } from "src/services/transactions/feeCopy";
import { feeValue, type KeyUpdateMode, type TraySnapshot } from "./protocol";

export type Verb =
  | "send"
  | "receive"
  | "qr"
  | "encrypt"
  | "decrypt"
  | "private"
  | "claim"
  | "migrate"
  | "lock"
  | "unlock"
  | "touchid"
  | "balance"
  | "status"
  | "wallets"
  | "use"
  | "network"
  | "login"
  | "theme"
  | "open"
  | "quit"
  | "clear"
  | "help";

interface VerbInfo {
  verb: Verb;
  words: string[];
  usage: string;
  help: string;
  /** Only in the CLI theme; the panel has its own controls for these. */
  cliOnly?: boolean;
  /** Only the whole word: no prefix or typo runs it. */
  exact?: boolean;
}

export const VERBS: VerbInfo[] = [
  {
    verb: "send",
    words: ["send", "pay", "transfer", "give", "tip"],
    usage: "send <amount> to <who> [privately]",
    help: "Send OCT to an address, a contact or one of your wallets",
  },
  {
    verb: "receive",
    words: ["receive", "address", "addr", "deposit"],
    usage: "receive",
    help: "Show and copy your address",
  },
  { verb: "qr", words: ["qr"], usage: "qr", help: "Your address as a QR code", cliOnly: true },
  {
    verb: "encrypt",
    words: ["encrypt", "shield", "hide"],
    usage: "encrypt <amount>",
    help: "Move public OCT into your private balance",
  },
  {
    verb: "decrypt",
    words: ["decrypt", "unshield", "reveal"],
    usage: "decrypt <amount>",
    help: "Move private OCT back to public",
  },
  {
    verb: "private",
    words: ["private"],
    usage: "private",
    help: "Private balance status and actions",
  },
  {
    verb: "claim",
    words: ["claim"],
    usage: "claim",
    help: "Claim private transfers in 0xio Desktop",
  },
  {
    verb: "migrate",
    words: ["migrate", "refresh", "turnon"],
    usage: "migrate",
    help: "Refresh, migrate or turn on the private balance when it is due",
    cliOnly: true,
  },
  { verb: "lock", words: ["lock"], usage: "lock", help: "Lock the wallet" },
  {
    verb: "unlock",
    words: ["unlock", "login"],
    usage: "unlock",
    help: "Unlock with your password",
    cliOnly: true,
  },
  {
    verb: "touchid",
    words: ["touchid", "biometric"],
    usage: "touchid",
    help: "Unlock with Touch ID",
    cliOnly: true,
  },
  {
    verb: "balance",
    words: ["balance", "bal"],
    usage: "balance",
    help: "Public and private balance",
    cliOnly: true,
  },
  {
    verb: "status",
    words: ["status", "st"],
    usage: "status",
    help: "Engine, extension, claims and private balance",
    cliOnly: true,
  },
  {
    verb: "wallets",
    words: ["wallets", "ls", "accounts"],
    usage: "wallets",
    help: "List your wallets",
    cliOnly: true,
  },
  {
    verb: "use",
    words: ["use", "switch"],
    usage: "use <wallet name or number>",
    help: "Switch the active wallet",
    cliOnly: true,
  },
  {
    verb: "network",
    words: ["network", "net"],
    usage: "network [name]",
    help: "Show or switch the network",
    cliOnly: true,
  },
  {
    verb: "login",
    words: ["startup", "autostart"],
    usage: "startup on|off",
    help: "Open at login",
    cliOnly: true,
  },
  {
    verb: "theme",
    words: ["theme"],
    usage: "theme <name>",
    help: "Change the menu bar theme",
    cliOnly: true,
  },
  { verb: "open", words: ["open", "app"], usage: "open", help: "Open 0xio Desktop" },
  {
    verb: "quit",
    words: ["quit", "exit"],
    usage: "quit",
    help: "Quit 0xio Desktop",
    cliOnly: true,
    exact: true,
  },
  {
    verb: "clear",
    words: ["clear", "cls"],
    usage: "clear",
    help: "Clear the screen",
    cliOnly: true,
  },
  { verb: "help", words: ["help", "?"], usage: "help", help: "This list", cliOnly: true },
];

const FILLER = new Set([
  "to",
  "for",
  "please",
  "pls",
  "the",
  "of",
  "with",
  "and",
  "a",
  "an",
  "into",
  "from",
  "my",
  "oct",
]);
const PRIVATE_WORDS = new Set([
  "private",
  "privately",
  "secret",
  "secretly",
  "stealth",
  "hidden",
  "shielded",
  "anon",
  "anonymously",
]);
const PUBLIC_WORDS = new Set(["public", "publicly", "open", "plain"]);
const MAX_WORDS = new Set(["max", "all", "everything", "maximum"]);

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
          ? dp[i - 2][j - 2] + 1
          : Infinity,
      );
  return dp[a.length][b.length];
}

/** The verb a word means: exact, a unique prefix, or one typo away ("sned", "recieve"). */
export function matchVerb(word: string, cli: boolean): VerbInfo | null {
  const w = word.toLowerCase();
  if (!w) return null;
  const pool = VERBS.filter((v) => cli || !v.cliOnly);
  const exact = pool.find((v) => v.words.includes(w));
  if (exact) return exact;
  const loose = pool.filter((v) => !v.exact);
  const prefixed = loose.filter((v) => v.words.some((x) => x.startsWith(w)));
  if (prefixed.length === 1 || (prefixed.length > 1 && prefixed.every((v) => v === prefixed[0])))
    return prefixed[0];
  if (prefixed.length) return prefixed.find((v) => v.verb === "send") ?? null;
  if (w.length < 4) return null;
  return loose.find((v) => v.words.some((x) => x.length >= 4 && distance(w, x) <= 1)) ?? null;
}

type AmountSpec =
  | { kind: "exact"; micro: number }
  | { kind: "max" }
  | { kind: "fraction"; f: number };

/** "10", "1,250.5", "10oct", "1.5k", "max", "half", "25%". At most 6 decimals. */
export function parseAmount(token: string): AmountSpec | null {
  const t = token.toLowerCase().replace(/oct$/, "");
  if (MAX_WORDS.has(t)) return { kind: "max" };
  if (t === "half") return { kind: "fraction", f: 0.5 };
  if (t === "quarter") return { kind: "fraction", f: 0.25 };
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(t);
  if (pct) {
    const f = Number(pct[1]) / 100;
    return f > 0 && f <= 1 ? { kind: "fraction", f } : null;
  }
  const m = /^(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?(k|m)?$/.exec(t);
  if (!m || (!m[1] && !m[2]) || (m[2] ?? "").length > 6) return null;
  const scale = m[3] === "k" ? 1_000 : m[3] === "m" ? 1_000_000 : 1;
  const micro = Math.round(parseOCTInput(`${m[1].replace(/,/g, "") || "0"}.${m[2] ?? ""}`) * scale);
  return micro > 0 && Number.isSafeInteger(micro) ? { kind: "exact", micro } : null;
}

/** A number that is not an amount OCT can send: "0", "-5", "1e3", "1,5", "0.0000001". */
export const badAmount = (token: string) =>
  !parseAmount(token) && /^[-+]?[\d.,]*\d[\d.,]*(e[-+]?\d+)?[km]?%?(oct)?$/i.test(token);
export const AMOUNT_BAD = "That amount does not look right";

export function resolveAmount(spec: AmountSpec, available: number): number {
  if (spec.kind === "exact") return spec.micro;
  if (spec.kind === "max") return available;
  return Math.floor(available * spec.f);
}

interface Recipient {
  address: string;
  label?: string;
  source: "address" | "wallet" | "contact";
}

export function knownRecipients(snap: TraySnapshot): Recipient[] {
  const wallets: Recipient[] = snap.wallets
    .filter((w) => w.id !== snap.activeId)
    .map((w) => ({ address: w.address, label: w.name, source: "wallet" }));
  let contacts: Recipient[] = [];
  try {
    contacts = getContacts(snap.network)
      .filter((c) => !wallets.some((w) => w.address === c.address))
      .map((c) => ({ address: c.address, label: c.label, source: "contact" }));
  } catch {}
  return [...wallets, ...contacts];
}

export const NAME_REFUSED = "A .oct name cannot be used here. Send to a name from 0xio Desktop";

type RecipientMatch =
  | { kind: "one"; to: Recipient }
  | { kind: "many"; options: Recipient[] }
  | { kind: "none" };

/** A full address, an address prefix you know, or a name (exact, then prefix, then contains). */
function resolveRecipient(query: string, snap: TraySnapshot): RecipientMatch {
  const q = query.trim();
  if (!q || isNameInput(q)) return { kind: "none" };
  const known = knownRecipients(snap);
  if (isValidAddress(q)) {
    const hit = known.find((r) => r.address === q);
    return { kind: "one", to: hit ?? { address: q, source: "address" } };
  }
  const lower = q.toLowerCase();
  if (lower.startsWith("oct") && q.length >= 6) {
    const byPrefix = known.filter((r) => r.address.toLowerCase().startsWith(lower));
    if (byPrefix.length === 1) return { kind: "one", to: byPrefix[0] };
    if (byPrefix.length > 1) return { kind: "many", options: byPrefix };
  }
  const named = known.filter((r) => r.label);
  const exact = named.filter((r) => r.label!.toLowerCase() === lower);
  if (exact.length === 1) return { kind: "one", to: exact[0] };
  const prefix = named.filter((r) => r.label!.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return { kind: "one", to: prefix[0] };
  const contains = prefix.length
    ? prefix
    : named.filter((r) => r.label!.toLowerCase().includes(lower));
  if (contains.length === 1) return { kind: "one", to: contains[0] };
  if (contains.length > 1) return { kind: "many", options: contains.slice(0, 5) };
  const typo = named.filter(
    (r) => r.label!.length >= 4 && distance(lower, r.label!.toLowerCase()) <= 1,
  );
  if (typo.length === 1) return { kind: "one", to: typo[0] };
  return { kind: "none" };
}

export const shortAddr = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}...${a.slice(-6)}` : a);
export const whoLabel = (r: Recipient) =>
  r.label ? `${r.label} (${shortAddr(r.address)})` : shortAddr(r.address);

interface SendIntent {
  to: Recipient | null;
  toQuery: string;
  toOptions: Recipient[];
  amount: AmountSpec | null;
  micro: number;
  mode: "public" | "private";
  modeAsked: boolean;
  available: number;
  /** What stops this from going to review, in the order to fix it. Empty = ready. */
  issues: string[];
}

/** Read a send in any word order: "send 10 to 0xio privately", "pay oct8Hk.. half", "5 to bob". */
export function parseSend(words: string[], snap: TraySnapshot): SendIntent {
  let amount: AmountSpec | null = null;
  let bad = false;
  let mode: "public" | "private" | null = null;
  const nameWords: string[] = [];
  const spelled: string[] = [];
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (PRIVATE_WORDS.has(w)) mode = "private";
    else if (PUBLIC_WORDS.has(w)) mode = "public";
    else if (!amount && parseAmount(raw)) amount = parseAmount(raw);
    else if (!amount && badAmount(raw)) bad = true;
    else {
      if (spelled.length || !FILLER.has(w)) spelled.push(raw);
      if (!FILLER.has(w)) nameWords.push(raw);
    }
  }
  const canPrivate = snap.privacy && snap.canSign;
  const chosen = mode ?? "public";
  const feeOu = feeValue(chosen === "private" ? snap.fees.private : snap.fees.public);
  const available =
    chosen === "private"
      ? (snap.privateMicro ?? 0)
      : Math.max(0, (snap.publicMicro ?? 0) - (feeOu ?? 0));
  const feeShort = feeOu !== null && snap.publicMicro !== null && snap.publicMicro < feeOu;
  let toQuery = nameWords.join(" ");
  let match = resolveRecipient(toQuery, snap);
  if (match.kind === "none" && spelled.length > nameWords.length) {
    const full = resolveRecipient(spelled.join(" "), snap);
    if (full.kind !== "none") [toQuery, match] = [spelled.join(" "), full];
  }
  const micro = amount ? resolveAmount(amount, available) : 0;
  const issues: string[] = [];
  if (mode === "private" && !canPrivate) issues.push("Private sends are not available here");
  if (!toQuery) issues.push("Who to? Add an address, a contact or a wallet name");
  else if (isNameInput(toQuery) || spelled.some(isNameInput)) issues.push(NAME_REFUSED);
  else if (match.kind === "none")
    issues.push(
      toQuery.toLowerCase().startsWith("oct")
        ? "That address does not look complete"
        : `No contact or wallet called "${toQuery}"`,
    );
  else if (match.kind === "many")
    issues.push(
      `"${toQuery}" matches ${match.options.map((o) => o.label ?? shortAddr(o.address)).join(", ")}`,
    );
  if (chosen === "private" && canPrivate && feeShort) issues.push(FEE_SHORT);
  if (!amount) issues.push(bad ? AMOUNT_BAD : "How much? Add an amount, max, half or a percent");
  else if (micro <= 0) issues.push(`Nothing ${chosen === "private" ? "private " : ""}to send`);
  else if (micro > available)
    issues.push(
      `Insufficient balance (${formatOCT(available)} OCT ${chosen === "private" ? "private" : "public"} available)`,
    );
  if (
    match.kind === "one" &&
    snap.wallets.find((w) => w.id === snap.activeId)?.address === match.to.address
  )
    issues.push("That is this wallet");
  return {
    to: match.kind === "one" ? match.to : null,
    toQuery,
    toOptions: match.kind === "many" ? match.options : [],
    amount,
    micro,
    mode: chosen,
    modeAsked: mode !== null,
    available,
    issues,
  };
}

export interface Parsed {
  verb: VerbInfo | null;
  args: string[];
  send?: SendIntent;
}

/** One line of input. A line with no verb but an amount and a name reads as a send. */
export function parseLine(input: string, snap: TraySnapshot | null, cli: boolean): Parsed {
  const words = input
    .trim()
    .replace(/^\//, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^(--?help|-h|-\?)$/i.test(w) ? "help" : w));
  if (words[0]?.toLowerCase() === "0xio") {
    words.shift();
    if (!words.length) words.push("help");
  }
  if (!words.length) return { verb: null, args: [] };
  let verb = matchVerb(words[0], cli);
  let args = words.slice(1);
  if (!verb && words.some((w) => parseAmount(w)) && words.length > 1) {
    verb = VERBS.find((v) => v.verb === "send")!;
    args = words;
  }
  const out: Parsed = { verb, args };
  if (verb?.verb === "send" && snap) out.send = parseSend(args, snap);
  return out;
}

export function describeSend(s: SendIntent): string {
  const who = s.to ? whoLabel(s.to) : s.toQuery || "...";
  const amt = s.amount ? `${formatOCT(s.micro)} OCT` : "...";
  return `Send ${amt}${s.mode === "private" ? " privately" : ""} to ${who}`;
}

/** Tab: finish the verb, then a recipient name after "to", then "privately". */
export function complete(input: string, snap: TraySnapshot | null, cli: boolean): string | null {
  const endsSpace = /\s$/.test(input);
  const words = input.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (words.length === 1 && !endsSpace) {
    const w = words[0].toLowerCase();
    const hit = VERBS.filter((v) => cli || !v.cliOnly)
      .flatMap((v) => v.words)
      .find((x) => x.startsWith(w) && x !== w);
    return hit ? `${hit} ` : null;
  }
  if (!snap) return null;
  const verb = matchVerb(words[0], cli);
  const last = endsSpace ? "" : words[words.length - 1];
  const head = endsSpace ? input : input.slice(0, input.length - last.length);
  if (verb?.verb === "send") {
    const names = knownRecipients(snap)
      .map((r) => r.label)
      .filter((l): l is string => !!l && !l.includes(" "));
    const lo = last.toLowerCase();
    const hit = lo
      ? names.find((n) => n.toLowerCase().startsWith(lo) && n.toLowerCase() !== lo)
      : null;
    if (hit) return `${head}${hit} `;
    const pv = last && "privately".startsWith(last.toLowerCase()) && last !== "privately";
    if (pv) return `${head}privately `;
  }
  if (verb?.verb === "use") {
    const hit = snap.wallets.find(
      (w) => last && w.name.toLowerCase().startsWith(last.toLowerCase()),
    );
    if (hit) return `${head}${hit.name}`;
  }
  if (verb?.verb === "network") {
    const hit = snap.networks.find(
      (n) => last && n.name.toLowerCase().startsWith(last.toLowerCase()),
    );
    if (hit) return `${head}${hit.name.toLowerCase()}`;
  }
  return null;
}

export function keyUpdateCopy(mode: KeyUpdateMode, amountMicro: number) {
  const moves = mode === "legacy_public_migration" || mode === "key_bound_migration";
  if (moves)
    return {
      title: "Migrate balance",
      action: "Migrate",
      working: "Migrating",
      done: "Migrated",
      status: "Your private balance needs to move to your current encryption key",
      what: `Moves your ${formatOCT(amountMicro)} OCT private balance to your current encryption key`,
      confirm:
        "I understand my encryption key is registered again and my private balance moves with it in one transaction.",
    };
  return {
    title: "Update encryption key",
    action: "Update",
    working: "Updating the key",
    done: "Key updated",
    status: "This wallet's encryption key needs an update on the network",
    what:
      mode === "legacy_zero_reset"
        ? "Registers your current encryption key. Your private balance is empty, so nothing moves"
        : "Registers your current encryption key on the network",
    confirm: "I understand my encryption key is registered again on the network.",
  };
}
