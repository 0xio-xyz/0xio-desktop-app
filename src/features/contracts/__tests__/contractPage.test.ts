import { beforeEach, describe, expect, it } from "vitest";
import { fieldsFromJson, jsonParamsError } from "src/features/contracts/components/InteractTab";
import { freeName, openSourceInBuild } from "src/features/contracts/components/editor/openInBuild";
import { loadWorkspace, saveWorkspace } from "src/features/contracts/components/editor/fileStore";
import {
  markContractVerified,
  readContractSource,
  saveContractSource,
} from "src/features/contracts/sourceStore";
import type { AbiMethod } from "src/types/contract";

const transfer: AbiMethod = {
  name: "transfer_token",
  params: [
    { name: "to", type: "address" },
    { name: "amount", type: "u128" },
  ],
  mutates: true,
};

describe("JSON parameters", () => {
  it("accepts enc() values and checks the count", () => {
    expect(jsonParamsError('["oct1", enc(5000)]', transfer)).toBeNull();
    expect(jsonParamsError('["oct1"]', transfer)).toBe("count");
    expect(jsonParamsError('["oct1", 5', transfer)).toBe("invalid");
    expect(jsonParamsError('{"to":1}', transfer)).toBe("invalid");
  });

  it("reads back into fields with Encrypt on", () => {
    expect(fieldsFromJson('["oct1", enc(5000)]', transfer)).toEqual({
      values: { 0: "oct1", 1: "5000" },
      enc: { 1: true },
    });
    expect(fieldsFromJson('["oct1", 7]', transfer)).toEqual({
      values: { 0: "oct1", 1: "7" },
      enc: {},
    });
    expect(fieldsFromJson("[1]", transfer)).toBeNull();
  });
});

describe("contract source store", () => {
  beforeEach(() => localStorage.clear());

  it("is scoped to network and address", () => {
    saveContractSource("mainnet", "octA", {
      source: "Program A {}",
      file: "a.aml",
      language: "aml",
      origin: "deployed",
      verified: false,
    });
    expect(readContractSource("mainnet", "octA")?.file).toBe("a.aml");
    expect(readContractSource("devnet", "octA")).toBeNull();
    expect(readContractSource("mainnet", "octB")).toBeNull();
  });

  it("marks verified and ignores malformed entries", () => {
    saveContractSource("mainnet", "octA", {
      source: "x",
      file: "a.aml",
      language: "aml",
      origin: "deployed",
      verified: false,
    });
    markContractVerified("mainnet", "octA", true);
    expect(readContractSource("mainnet", "octA")?.verified).toBe(true);
    localStorage.setItem("contract_source_v1_mainnet_octC", '{"source":1}');
    expect(readContractSource("mainnet", "octC")).toBeNull();
  });
});

describe("open in Build", () => {
  beforeEach(() => localStorage.clear());

  it("never reuses a taken name", () => {
    expect(freeName("token.aml", new Set())).toBe("token.aml");
    expect(freeName("token.aml", new Set(["token.aml", "token-2.aml"]))).toBe("token-3.aml");
  });

  it("adds a new active file and keeps the others", async () => {
    saveWorkspace({ files: { "token.aml": "mine" }, active: "token.aml" });
    const name = await openSourceInBuild("Token", "Program Token {}", "aml");
    expect(name).toBe("token-2.aml");
    const ws = loadWorkspace();
    expect(ws.files["token.aml"]).toBe("mine");
    expect(ws.files[name]).toBe("Program Token {}");
    expect(ws.active).toBe(name);
  });
});
