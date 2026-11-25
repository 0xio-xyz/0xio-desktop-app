import { describe, expect, it } from "vitest";
import {
  checksFor,
  closeMatch,
  detectSecret,
  replaceWord,
} from "src/features/security/onboarding/readSecret";

const WORDS = ["abandon", "ability", "able", "about", "above", "absent", "zoo"];
const checks = checksFor(WORDS);
const PHRASE = `${"abandon ".repeat(11)}about`;
const KEY = `${"A".repeat(43)}=`;
const ADDRESS = `oct${"1".repeat(44)}`;

describe("detectSecret", () => {
  it("tells a phrase, a key and an address apart", () => {
    expect(detectSecret(PHRASE, checks)).toEqual({ kind: "phrase", words: PHRASE.split(" ") });
    expect(detectSecret(KEY, checks)).toEqual({ kind: "key", key: KEY });
    expect(detectSecret(ADDRESS, checks)).toEqual({ kind: "address", address: ADDRESS });
  });

  it("reads a phrase in any case and spacing", () => {
    const d = detectSecret(`  ${PHRASE.toUpperCase().replace(/ /g, "   ")}  `, checks);
    expect(d.kind).toBe("phrase");
  });

  it("names EVM keys and 0x addresses instead of calling them wrong", () => {
    expect(detectSecret(`0x${"a".repeat(64)}`, checks).kind).toBe("evmKey");
    expect(detectSecret(`0x${"a".repeat(40)}`, checks).kind).toBe("evmAddress");
  });

  it("counts words while a phrase is typed and lets the last word finish", () => {
    expect(detectSecret("abandon abandon ab", checks)).toEqual({
      kind: "typing",
      count: 3,
      target: 12,
    });
    expect(detectSecret("abandon ", checks)).toEqual({ kind: "typing", count: 1, target: 12 });
  });

  it("flags a mistyped word and offers the one close match", () => {
    const typo = `${"abandon ".repeat(5)}abandn ${"abandon ".repeat(5)}about`;
    const d = detectSecret(typo, checks);
    expect(d).toEqual({ kind: "badWord", word: "abandn", index: 5, suggestion: "abandon" });
    const fixed = replaceWord(typo, 5, "abandon");
    expect(detectSecret(fixed, checks).kind).toBe("phrase");
  });

  it("offers no fix when two words are equally close", () => {
    expect(closeMatch("abl", ["able", "abs"])).toBeNull();
    expect(closeMatch("xyz", WORDS)).toBeNull();
  });

  it("refuses more than 24 words", () => {
    expect(detectSecret("abandon ".repeat(25), checks).kind).toBe("tooMany");
  });

  it("keeps the spacing when it swaps a word", () => {
    expect(replaceWord("one  two\nthree", 1, "TWO")).toBe("one  TWO\nthree");
  });
});
