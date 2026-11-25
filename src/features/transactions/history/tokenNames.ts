import { networkCapabilities } from "src/services/network/config";
import { knownOctraContract, WOCT } from "./callReading";
import { chainOf } from "./sides";

// The same spam rules as the extension and the oracle: no links, no bait words, and no OCT or
// WOCT on a contract that is not the network's own wrapped OCT.

// Control, soft hyphen, zero-width and bidi characters.
const HIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|͏/g;

const LOOKALIKE: ReadonlyMap<string, string> = new Map(
  (
    [
      ["аα", "a"],
      ["АΑ", "A"],
      ["ВΒ", "B"],
      ["сϲ", "c"],
      ["СϹ", "C"],
      ["еε", "e"],
      ["ЕΕ", "E"],
      ["һ", "h"],
      ["НΗ", "H"],
      ["іιı", "i"],
      ["ІΙӀ", "I"],
      ["ј", "j"],
      ["κк", "k"],
      ["КΚ", "K"],
      ["МΜ", "M"],
      ["Ν", "N"],
      ["ηп", "n"],
      ["оο", "o"],
      ["ОΟ", "O"],
      ["рρ", "p"],
      ["РΡ", "P"],
      ["ѕ", "s"],
      ["Ѕ", "S"],
      ["тτ", "t"],
      ["ТΤ", "T"],
      ["υ", "u"],
      ["ν", "v"],
      ["ԝω", "w"],
      ["хχ", "x"],
      ["ХΧ", "X"],
      ["уγ", "y"],
      ["УΥҮ", "Y"],
      ["Ζ", "Z"],
    ] as const
  ).flatMap(([from, to]) => [...from].map((c) => [c, to] as [string, string])),
);
const DOTS = new Set(["․", "。", "｡", "﹒"]);

function foldConfusables(text: string): string {
  let out = "";
  for (const c of text.replace(HIDDEN, "")) {
    const cp = c.codePointAt(0) ?? 0;
    if (cp >= 0xff01 && cp <= 0xff5e) out += String.fromCodePoint(cp - 0xfee0);
    else if (DOTS.has(c)) out += ".";
    else out += LOOKALIKE.get(c) ?? c;
  }
  return out;
}

const ALNUM = /[\p{Alphabetic}\p{N}]/u;
const ALPHA = /\p{Alphabetic}/u;
const LOWER = /\p{Lowercase}/u;
const UPPER = /\p{Uppercase}/u;

/** A web address: http, www., or a dot after a letter or digit followed by 2 to 10 letters. */
function hasLink(text: string): boolean {
  const s = foldConfusables(text).toLowerCase();
  if (s.includes("http") || s.includes("www.")) return true;
  const chars = [...s];
  return chars.some((c, i) => {
    if (c !== "." || i === 0 || !ALNUM.test(chars[i - 1])) return false;
    let tld = 0;
    while (tld < 11 && /^[a-z]$/.test(chars[i + 1 + tld] ?? "")) tld++;
    return tld >= 2 && tld <= 10;
  });
}

function words(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let prev: string | null = null;
  for (const c of foldConfusables(text)) {
    const boundary =
      prev !== null && ((LOWER.test(prev) && UPPER.test(c)) || ALPHA.test(prev) !== ALPHA.test(c));
    const alnum = ALNUM.test(c);
    if ((!alnum || boundary) && cur) {
      out.push(cur.toLowerCase());
      cur = "";
    }
    if (alnum) {
      cur += c;
      prev = c;
    } else prev = null;
  }
  if (cur) out.push(cur.toLowerCase());
  return out;
}

const BAIT_WORDS = [
  "claim",
  "reward",
  "rewards",
  "airdrop",
  "visit",
  "free",
  "voucher",
  "bonus",
  "gift",
  "redeem",
  "eligible",
];
const BAIT_ANYWHERE = ["airdrop", "voucher", "eligible"];

function hasBait(text: string): boolean {
  const lower = foldConfusables(text).toLowerCase();
  if (BAIT_ANYWHERE.some((w) => lower.includes(w))) return true;
  return words(text).some((w) =>
    BAIT_WORDS.some(
      (b) => w === b || (w.length === b.length + 1 && w.startsWith(b) && w.endsWith("s")),
    ),
  );
}

function impersonatesOctra(network: string, symbol: string, contract: string): boolean {
  const sym = foldConfusables(symbol).replace(/\s+/gu, "").toLowerCase();
  if (sym !== "oct" && sym !== "woct") return false;
  const known = WOCT[chainOf(network)];
  return !known || contract !== known;
}

export function tokenSpamReason(
  network: string,
  contract: string,
  input: { symbol?: string | null; name?: string | null },
): "link" | "bait" | "impersonation" | null {
  const texts = [input.symbol, input.name].filter((t): t is string => !!t);
  if (texts.some(hasLink)) return "link";
  if (texts.some(hasBait)) return "bait";
  if (input.symbol && impersonatesOctra(network, input.symbol, contract)) return "impersonation";
  return null;
}

export interface ListedToken {
  network?: string;
  address: string;
  symbol: string;
  name?: string;
}

export interface TokenFacts {
  symbol?: string | null;
  name?: string | null;
}

export function octraContractName(
  network: string,
  address: string,
  facts?: TokenFacts | null,
  listed?: readonly ListedToken[] | null,
): string | null {
  const known = knownOctraContract(network, address);
  if (known) return known.name;
  if (WOCT[chainOf(network)] === address) return "WOCT";
  const tag = networkCapabilities(network).tokenListTag;
  const entry = tag ? listed?.find((t) => t.network === tag && t.address === address) : undefined;
  if (entry?.symbol) return entry.symbol;
  const name = (facts?.symbol || facts?.name || "").trim();
  if (!name || name.length > 32) return null;
  return tokenSpamReason(network, address, facts ?? {}) ? null : name;
}
