import { describe, it, expect } from "vitest";
import { computeTxHash, formatTimestamp, txHashJson } from "src/services/network/txHash";

// Produced by the reference tx_builder.hpp (hash_json and tx_hash) for a fixed signed tx.
const VECTORS = [
  {
    name: "standard",
    tx: {
      from: "oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB",
      to_: "oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F",
      amount: "1000000",
      nonce: 7,
      ou: "1000",
      timestamp: 1762300000.123,
      signature:
        "VBORX2a2r6uAlv2W0EPFqTp4sNf2+QL0CzPyAaqTrjYbe8qczkMrpqXMqMLFmEA02yiUIe26DqdmWcs2LQNCCw==",
      op_type: "standard",
      public_key: "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=",
    },
    json: '{"from":"oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB","to_":"oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F","amount":"1000000","nonce":7,"ou":"1000","timestamp":1762300000.123,"signature":"VBORX2a2r6uAlv2W0EPFqTp4sNf2+QL0CzPyAaqTrjYbe8qczkMrpqXMqMLFmEA02yiUIe26DqdmWcs2LQNCCw==","op_type":"standard","public_key":"ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=","message":null,"encrypted_data":null}',
    hash: "f802c9eed1384aa62879c871ab3ccba84f536866dfa5373dd09f549a77aed8d9",
  },
  {
    name: "memo_whole_second",
    tx: {
      from: "oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB",
      to_: "oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F",
      amount: "2500",
      nonce: 7,
      ou: "10000",
      timestamp: 1762300000,
      signature:
        "LEvmQfbKjHaFpwEI82uhnmsUq7LQZNLveMRBTg/06u7IQn7y8l5cZULJjKUch4pCYdIdJKnFMXZRYddId8zqCw==",
      op_type: "standard",
      public_key: "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=",
      message: 'hi "there"\n\u0001\u007f end',
    },
    json: '{"from":"oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB","to_":"oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F","amount":"2500","nonce":7,"ou":"10000","timestamp":1762300000.0,"signature":"LEvmQfbKjHaFpwEI82uhnmsUq7LQZNLveMRBTg/06u7IQn7y8l5cZULJjKUch4pCYdIdJKnFMXZRYddId8zqCw==","op_type":"standard","public_key":"ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=","message":"hi \\"there\\"\\n\\u0001\\u007f end","encrypted_data":null}',
    hash: "d639ac7d82d255c6dbce33c349e987232823c70cb7c9efccdcbe7dcffe5573df",
  },
  {
    name: "call_no_public_key",
    tx: {
      from: "oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB",
      to_: "oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F",
      amount: "0",
      nonce: 9,
      ou: "1000",
      timestamp: 1762300123.456,
      signature:
        "hzhehT3p9IZuYR4tYW5IULKUvTYixE4lT/CPLg1Zth5RPHMamq7Fh7vVZi1ZvDTRVqHhFAWGaz4YaXlk/P9cDQ==",
      op_type: "call",
      message: '["oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F",12345678901234567890123]',
      encrypted_data: "transfer",
    },
    json: '{"from":"oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB","to_":"oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F","amount":"0","nonce":9,"ou":"1000","timestamp":1762300123.456,"signature":"hzhehT3p9IZuYR4tYW5IULKUvTYixE4lT/CPLg1Zth5RPHMamq7Fh7vVZi1ZvDTRVqHhFAWGaz4YaXlk/P9cDQ==","op_type":"call","public_key":null,"message":"[\\"oct8UYokvM1DR2QpEVM7oCLvJLPvJqvvvjv5aDVAhSmuE3F\\",12345678901234567890123]","encrypted_data":"transfer"}',
    hash: "d22ed2337af82b12784fd85300ee3964552b54ff10643c7ec3480112f1d3480a",
  },
  {
    name: "decrypt_encrypted_data",
    tx: {
      from: "oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB",
      to_: "oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB",
      amount: "0",
      nonce: 10,
      ou: "5000",
      timestamp: 1762300200.5,
      signature:
        "SDZQ9wRd5nAEk4JpHpPK5sJO1KaA015wl3YbULyHkehvxbV2jqNCVq4p+F8kJyIEK30C0fnRkDb0UdgUd1itBg==",
      op_type: "decrypt",
      public_key: "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=",
      encrypted_data: '{"cipher":"hfhe_v1|AAAA","amount":"100"}',
    },
    json: '{"from":"oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB","to_":"oct7r3ANFFNoFyQJAtiK7JdF65mT62dXLPas7d1CEDmNvEB","amount":"0","nonce":10,"ou":"5000","timestamp":1762300200.5,"signature":"SDZQ9wRd5nAEk4JpHpPK5sJO1KaA015wl3YbULyHkehvxbV2jqNCVq4p+F8kJyIEK30C0fnRkDb0UdgUd1itBg==","op_type":"decrypt","public_key":"ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=","message":null,"encrypted_data":"{\\"cipher\\":\\"hfhe_v1|AAAA\\",\\"amount\\":\\"100\\"}"}',
    hash: "8936223d550f640bfd099b3dbff97e0bd721ab4f400238e62b4002ff03b2ee38",
  },
];

describe("txHash", () => {
  it.each(VECTORS)("matches the reference for $name", async ({ tx, json, hash }) => {
    expect(txHashJson(tx)).toBe(json);
    expect(await computeTxHash(tx)).toBe(hash);
  });

  it("strips leading zeros from amount and fee", () => {
    const tx = { ...VECTORS[0].tx, amount: "0001000000", ou: "01000" };
    expect(txHashJson(tx)).toBe(VECTORS[0].json);
  });

  it("refuses an amount that is not whole digits", () => {
    expect(() => txHashJson({ ...VECTORS[0].tx, amount: "1.5" })).toThrow();
  });

  it("formats timestamps like the node", () => {
    expect(formatTimestamp(1762300000)).toBe("1762300000.0");
    expect(formatTimestamp(1762300000.123)).toBe("1762300000.123");
    expect(formatTimestamp(1762300200.5)).toBe("1762300200.5");
    expect(formatTimestamp(0.1)).toBe("0.1");
    expect(formatTimestamp(1e-5)).toBe("1e-05");
    expect(formatTimestamp(1e20)).toBe("1e+20");
    expect(() => formatTimestamp(Number.NaN)).toThrow();
  });

  it.each([
    {
      name: "an empty message is hashed as the empty string",
      message: "" as string | undefined,
      hash: "e8c57de561589b618874d89a6b495d4275099dae6f066bfa2766c5b892c39568",
    },
    {
      name: "a missing message is null",
      message: undefined,
      hash: "cb59fd73fa7eb81315a87756b147f347ea5939ff9a22dc7c298cf4ddcb3668f3",
    },
    {
      name: "escapes DEL and control characters",
      message: 'a\x7f\x01"\n',
      hash: "79aba7afaed1942c20a3ebc4c0271fb7f76e02b25c0a6c670aac7f72f1e31bac",
    },
  ])("matches the node: $name", async ({ message, hash }) => {
    const tx = {
      from: "octEwb4krH6vW3Pr23hps9r8pTZ78dKpdpdmiY612FynidH",
      to_: "octHd7nZVgp1iUy6rDNywdBEK4C8MsoLFFjE5ukrDGuL8Ra",
      amount: "11000000",
      nonce: 36673,
      ou: "1000",
      timestamp: 1793915581.996,
      signature: "c2lnbmF0dXJl",
      op_type: "standard",
      ...(message !== undefined ? { message } : {}),
    };
    expect(await computeTxHash(tx)).toBe(hash);
    expect(await computeTxHash({ ...tx, message: message ?? null })).toBe(hash);
  });
});
