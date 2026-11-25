import { beforeEach, describe, expect, it } from "vitest";
import {
  AMOUNT_BAD,
  NAME_REFUSED,
  VERBS,
  badAmount,
  matchVerb,
  parseAmount,
  parseLine,
  parseSend,
} from "../commands";
import type { FeeRead, TraySnapshot } from "../protocol";

const ok = (ou: number): FeeRead => ({ state: "ok", ou });
const addr = (c: string) => `oct${c.repeat(44)}`;

const snap = (over: Partial<TraySnapshot> = {}): TraySnapshot => ({
  locked: false,
  hasPassword: true,
  biometric: false,
  wallets: [{ id: "w1", name: "Main", address: addr("A") }],
  activeId: "w1",
  network: "devnet",
  networks: [{ id: "devnet", name: "Devnet" }],
  privacy: true,
  canSign: true,
  privateReadiness: { state: "ok" },
  publicMicro: 500_000_000,
  privateMicro: 3_000_000,
  claims: 0,
  fees: {
    public: ok(1_000),
    private: ok(1_000_000),
    encrypt: ok(1_000_000),
    decrypt: ok(1_000_000),
    refresh: ok(2_000_000),
  },
  ...over,
});

beforeEach(() => {
  localStorage.setItem(
    "0xio_address_book_devnet",
    JSON.stringify([
      { id: "c1", label: "Bob", address: addr("B"), tags: [], createdAt: 1 },
      { id: "c2", label: "Bank of Mom", address: addr("C"), tags: [], createdAt: 1 },
    ]),
  );
});

describe("amounts", () => {
  it("reads the forms the help promises", () => {
    expect(parseAmount("10")).toEqual({ kind: "exact", micro: 10_000_000 });
    expect(parseAmount("0.1")).toEqual({ kind: "exact", micro: 100_000 });
    expect(parseAmount(".5")).toEqual({ kind: "exact", micro: 500_000 });
    expect(parseAmount("5.")).toEqual({ kind: "exact", micro: 5_000_000 });
    expect(parseAmount("1,250.5")).toEqual({ kind: "exact", micro: 1_250_500_000 });
    expect(parseAmount("10oct")).toEqual({ kind: "exact", micro: 10_000_000 });
    expect(parseAmount("1.5k")).toEqual({ kind: "exact", micro: 1_500_000_000 });
    expect(parseAmount("0.000001")).toEqual({ kind: "exact", micro: 1 });
    expect(parseAmount("max")).toEqual({ kind: "max" });
    expect(parseAmount("25%")).toEqual({ kind: "fraction", f: 0.25 });
  });

  it("never truncates a seventh decimal into a smaller amount", () => {
    expect(parseAmount("0.1234567")).toBeNull();
    expect(parseAmount("0.0000001")).toBeNull();
  });

  it("does not read a decimal comma as a thousands separator", () => {
    expect(parseAmount("1,5")).toBeNull();
    expect(parseAmount("12,34.5")).toBeNull();
  });

  it("refuses amounts past what a number holds exactly", () => {
    expect(parseAmount("99999999999999999")).toBeNull();
  });

  it("knows a number that is not an amount", () => {
    for (const t of ["0", "-5", "1e3", "1,5", "0.0000001", "0%", "150%"])
      expect(badAmount(t)).toBe(true);
    for (const t of ["10", "bob", "2pac", "max"]) expect(badAmount(t)).toBe(false);
  });
});

describe("send parsing", () => {
  it("says the amount is wrong instead of reading it as a name", () => {
    for (const bad of ["-5", "0", "1e3", "0.0000001", "1,5"]) {
      const s = parseSend([bad, "to", "bob"], snap());
      expect(s.to?.address).toBe(addr("B"));
      expect(s.issues).toEqual([AMOUNT_BAD]);
    }
  });

  it("finds a contact whose name has a filler word in it", () => {
    const s = parseSend(["5", "to", "bank", "of", "mom"], snap());
    expect(s.to?.address).toBe(addr("C"));
    expect(s.issues).toEqual([]);
  });

  it("reads send max and a private send", () => {
    expect(parseSend(["max", "to", "bob"], snap()).micro).toBe(500_000_000 - 1_000);
    const p = parseSend(["1", "to", "bob", "privately"], snap());
    expect(p.mode).toBe("private");
    expect(p.issues).toEqual([]);
  });
});

describe("names", () => {
  it("refuses a .oct name and never hands it on as a recipient", () => {
    for (const words of [
      ["5", "to", "0xio.oct"],
      ["5", "0xio.oct", "privately"],
      ["5", "to", "0Xio.OCT"],
    ]) {
      const s = parseSend(words, snap());
      expect(s.to).toBeNull();
      expect(s.issues).toContain(NAME_REFUSED);
    }
  });
});

describe("verbs", () => {
  it("quits only on the whole word", () => {
    for (const w of ["q", "qu", "qui", "quiet", "quiz", "exi", "exot"])
      expect(matchVerb(w, true)?.verb).not.toBe("quit");
    expect(matchVerb("quit", true)?.verb).toBe("quit");
    expect(matchVerb("exit", true)?.verb).toBe("quit");
  });

  it("runs every word the help lists", () => {
    for (const v of VERBS) for (const w of v.words) expect(matchVerb(w, true)?.verb).toBe(v.verb);
    expect(parseLine("0xio --help", null, true).verb?.verb).toBe("help");
    expect(parseLine("/bal", null, true).verb?.verb).toBe("balance");
    expect(parseLine("sned 5 to bob", snap(), true).verb?.verb).toBe("send");
    expect(parseLine("  send   5   to   bob  ", snap(), true).send?.issues).toEqual([]);
  });
});
