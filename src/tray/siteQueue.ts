import type { ApprovalType } from "src/features/dapp/services/dappRequest";

type SiteStage = "unlock" | "review" | "approved";

/** What a review shows, built by the main window from the wallet's own dApp handler. */
export interface RelayReview {
  type: ApprovalType;
  wallet: { name: string; address: string } | null;
  to?: string;
  amount?: string;
  method?: string;
  message?: string;
  contract?: string;
  /** A contract call: its arguments exactly as signed. */
  args?: string;
  /** A sequence: every call, in order, with its own amount; `amount` is their total. */
  steps?: { contract: string; method: string; args: string; amount: string }[];
  /** The fee that is signed, in OU, read live when the request came. */
  ou?: string;
  fromName?: string;
  toName?: string;
  claims?: { count: number; totalRaw: string; remaining: number };
  networkMismatch?: string;
  deploy?: { codeBytes: number; contractAddress: string; ou: string; constructorParams?: string };
  scopes?: string[];
  error?: string;
}

export interface SiteItem {
  id: string;
  origin: string;
  topOrigin: string | null;
  framed: boolean;
  browser: "chrome" | "firefox" | "web";
  clientId: string;
  network: string;
  method: string;
  createdAt: number;
  stage: SiteStage;
  review: RelayReview | null;
  tabs: number;
}

interface SiteGroup {
  origin: string;
  browser: SiteItem["browser"];
  items: SiteItem[];
}

export type SiteView = { kind: "list" } | { kind: "review"; id: string };

export const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export const browserName = (b: SiteItem["browser"]): string =>
  b === "firefox" ? "Firefox" : "Chrome";

export const isDirect = (b: SiteItem["browser"]): boolean => b === "web";

/** The requests by site, each site where its first request arrived. */
export function groupBySite(items: SiteItem[]): SiteGroup[] {
  const groups: SiteGroup[] = [];
  for (const item of [...items].sort((a, b) => a.createdAt - b.createdAt)) {
    const g = groups.find((x) => x.origin === item.origin && x.browser === item.browser);
    if (g) g.items.push(item);
    else groups.push({ origin: item.origin, browser: item.browser, items: [item] });
  }
  return groups;
}

export function initialView(items: SiteItem[], focus?: string | null): SiteView {
  if (focus && items.some((i) => i.id === focus)) return { kind: "review", id: focus };
  if (items.length === 1) return { kind: "review", id: items[0].id };
  return { kind: "list" };
}

export function nextView(view: SiteView, items: SiteItem[]): SiteView {
  if (view.kind === "review" && items.some((i) => i.id === view.id)) return view;
  return { kind: "list" };
}

export const closesPanel = (items: SiteItem[], answeredHere: boolean, failed: boolean): boolean =>
  items.length === 0 && answeredHere && !failed;

type Kind =
  | "connect"
  | "send"
  | "privateSend"
  | "sign"
  | "signTx"
  | "switch"
  | "claim"
  | "deploy"
  | "call"
  | "sequence"
  | "register";

export function kindOf(item: Pick<SiteItem, "method" | "review">): Kind {
  const r = item.review;
  const m = r?.method;
  switch (r?.type) {
    case "connect":
      return "connect";
    case "sign":
      return "sign";
    case "network":
      return "switch";
    case "deploy":
      return "deploy";
  }
  if (m === "sign_only") return "signTx";
  if (m === "claim_private") return "claim";
  if (m === "private_transfer") return "privateSend";
  if (m === "register_view_key") return "register";
  if (item.method === "send_contract_transaction_sequence") return "sequence";
  if (r?.contract || item.method === "call_contract" || item.method === "callContract")
    return "call";
  if (item.method === "connect") return "connect";
  if (item.method === "signMessage") return "sign";
  if (item.method === "switch_network") return "switch";
  return "send";
}

const VERB: Record<Kind, string> = {
  connect: "relay.verbConnect",
  send: "relay.verbSend",
  privateSend: "relay.verbSend",
  sign: "relay.verbSign",
  signTx: "relay.verbSign",
  switch: "relay.verbSwitch",
  claim: "relay.verbClaim",
  deploy: "relay.verbDeploy",
  call: "relay.verbConfirm",
  sequence: "relay.verbConfirm",
  register: "relay.verbRegister",
};

const ROW: Record<Kind, string> = {
  connect: "relay.rowConnect",
  send: "relay.rowSend",
  privateSend: "relay.rowPrivateSend",
  sign: "relay.rowSign",
  signTx: "relay.rowSignTx",
  switch: "relay.rowSwitch",
  claim: "relay.rowClaim",
  deploy: "relay.rowDeploy",
  call: "relay.rowCall",
  sequence: "relay.rowSequence",
  register: "relay.rowRegister",
};

const TITLE: Record<Kind, string> = {
  connect: "relay.titleConnect",
  send: "relay.titleSend",
  privateSend: "relay.titlePrivateSend",
  sign: "relay.titleSign",
  signTx: "relay.titleSignTx",
  switch: "relay.titleSwitch",
  claim: "relay.titleClaim",
  deploy: "relay.titleDeploy",
  call: "relay.titleCall",
  sequence: "relay.titleSequence",
  register: "relay.titleRegister",
};

const NOTICE: Record<Kind, string> = {
  connect: "relay.noticeConnect",
  send: "relay.noticeSend",
  privateSend: "relay.noticePrivateSend",
  sign: "relay.noticeSign",
  signTx: "relay.noticeSignTx",
  switch: "relay.noticeSwitch",
  claim: "relay.noticeClaim",
  deploy: "relay.noticeDeploy",
  call: "relay.noticeCall",
  sequence: "relay.noticeSequence",
  register: "relay.noticeRegister",
};

export const verbKey = (item: Pick<SiteItem, "method" | "review">) => VERB[kindOf(item)];
export const rowKey = (item: Pick<SiteItem, "method" | "review">) => ROW[kindOf(item)];
export const titleKey = (item: Pick<SiteItem, "method" | "review">) => TITLE[kindOf(item)];
export const noticeKey = (item: Pick<SiteItem, "method" | "review">) => NOTICE[kindOf(item)];

export function amountOf(review: RelayReview | null): { value: string; unit: string } | null {
  const m = /^\s*([\d.,]+)\s*([A-Za-z]+)?/.exec(review?.amount ?? "");
  if (!m) return null;
  if (Number(m[1].replace(/,/g, "")) === 0) return null;
  return { value: m[1], unit: m[2] ?? "OCT" };
}

export function ageMinutes(createdAt: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - createdAt) / 60_000));
}
