import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import vectors from "src/test/fixtures/stealth-scan-vectors.json";

vi.mock("src/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    pvacOp: vi.fn(),
    timed: vi.fn(async (_tag: string, _label: string, fn: () => Promise<unknown>) => fn()),
  },
}));

vi.mock("src/shared/dev/debugLogs", () => ({ logPvacTiming: vi.fn() }));

interface Sent {
  id: number;
  eph_pub: string;
  stealth_tag: string;
  enc_amount: string;
}
interface Match {
  id: number;
  amount: string;
  claim_secret: string;
  blinding: string;
}

const rust = vi.hoisted(() => ({
  calls: [] as { walletId: string; expectAddress: string; outputs: unknown[] }[],
  matcher: (_outputs: unknown[]): unknown[] => [],
  refuse: null as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== "stealth_match_outputs") throw `unexpected ${cmd}`;
    rust.calls.push(args as (typeof rust.calls)[number]);
    if (rust.refuse) throw rust.refuse;
    return rust.matcher(args.outputs as unknown[]);
  }),
}));

const chain = vi.hoisted(() => ({
  head: 5000 as number | null,
  complete: true,
  from: [] as number[],
}));

vi.mock("src/services/network/networkService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("src/services/network/networkService")>();
  const getStealthOutputs = vi.fn();
  return {
    ...actual,
    getStealthOutputs,
    getChainHead: vi.fn(async () => chain.head),
    scanStealthOutputs: vi.fn(async (from: number, networkId: string) => {
      chain.from.push(from);
      return { outputs: await getStealthOutputs(from, networkId), complete: chain.complete };
    }),
  };
});

import * as networkService from "src/services/network/networkService";
import { logger } from "src/lib/logger";
import {
  getStealthOutputs,
  resetStealthScanCache,
  suggestedScanIntervalMs,
} from "src/features/privacy/services/privacyService";

const ns = vi.mocked(networkService);
type NodeOutput = Awaited<ReturnType<typeof networkService.getStealthOutputs>>[number];

const WALLET = "wallet-1";
const SAFE_END = 2 ** 53;

function legacyAmount(exact: bigint): number {
  let amount = 0;
  for (let i = 7; i >= 0; i--) amount = amount * 256 + Number((exact >> BigInt(8 * i)) & 0xffn);
  return amount;
}

function nodeRecord(v: Sent, extra: Partial<NodeOutput> = {}): NodeOutput {
  return {
    id: v.id,
    eph_pub: v.eph_pub,
    stealth_tag: v.stealth_tag,
    enc_amount: v.enc_amount,
    claimed: 0,
    epoch_id: 1000 + v.id,
    sender_addr: `oct${"S".repeat(44)}`,
    ...({ amount_commitment: "commitment", delta_cipher_stored: "x".repeat(2000) } as object),
    ...extra,
  };
}

function replay(wallet: (typeof vectors.wallets)[number]) {
  const byId = new Map(wallet.outputs.map((o) => [o.id, o]));
  return (outputs: unknown[]): Match[] =>
    (outputs as Sent[]).flatMap((o) => {
      const v = byId.get(o.id);
      const same =
        v &&
        v.eph_pub === o.eph_pub &&
        v.stealth_tag === o.stealth_tag &&
        v.enc_amount === o.enc_amount;
      if (!same || !v.expect) return [];
      return [
        {
          id: o.id,
          amount: v.expect.amount,
          claim_secret: v.expect.claim_secret,
          blinding: v.expect.blinding,
        },
      ];
    });
}

beforeEach(() => {
  rust.calls = [];
  rust.matcher = () => [];
  rust.refuse = null;
  chain.head = 5000;
  chain.complete = true;
  chain.from = [];
  localStorage.clear();
  resetStealthScanCache();
  ns.getStealthOutputs.mockReset();
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
});

describe("stealth scan through the Rust matcher", () => {
  it("lists every vector match with the amount the old scan gave below 2^53", async () => {
    let below = 0;
    for (const wallet of vectors.wallets) {
      resetStealthScanCache();
      rust.matcher = replay(wallet);
      ns.getStealthOutputs.mockResolvedValue(wallet.outputs.map((o) => nodeRecord(o)));
      const found = await getStealthOutputs(WALLET, wallet.address, "devnet");
      const want = wallet.outputs.filter((o) => o.expect);
      expect(found.map((f) => f.id)).toEqual(want.map((o) => o.id));
      for (const o of want) {
        const f = found.find((x) => x.id === o.id)!;
        expect(f.claimSecret).toBe(o.expect!.claim_secret);
        expect(f.blinding).toBe(o.expect!.blinding);
        expect(f.epoch).toBe(1000 + o.id);
        expect(f.sender).toBe(`oct${"S".repeat(44)}`);
        expect(Object.keys(f).sort()).toEqual(
          ["amount", "blinding", "claimSecret", "epoch", "id", "sender"].sort(),
        );
        expect(f.amount).toBe(Number(o.expect!.amount));
        expect(legacyAmount(BigInt(o.expect!.amount))).toBe(o.expect!.legacy_amount);
        if (BigInt(o.expect!.amount) < BigInt(SAFE_END)) {
          expect(f.amount).toBe(o.expect!.legacy_amount);
          expect(String(f.amount)).toBe(o.expect!.amount);
          below++;
        }
      }
    }
    expect(below).toBe(17);
  });

  it("reads a decimal string below 2^53 as the number the byte loop gave", () => {
    const edges = [1n, 255n, 256n, 65_535n, 2n ** 32n, 2n ** 52n, 2n ** 53n - 2n, 2n ** 53n - 1n];
    let state = 0x9e3779b97f4a7c15n;
    const next = () => {
      state ^= state << 13n;
      state ^= state >> 7n;
      state ^= state << 17n;
      state &= 2n ** 64n - 1n;
      return state;
    };
    const values = [...edges];
    for (let i = 0; i < 20_000; i++) values.push(next() >> BigInt(11 + (i % 53)));
    for (const v of values) {
      expect(v < 2n ** 53n).toBe(true);
      expect(Number(v.toString())).toBe(legacyAmount(v));
    }
  });

  it("keeps the old number only by chance above 2^53", () => {
    const above = vectors.wallets[0].outputs.filter(
      (o) => o.expect && BigInt(o.expect.amount) >= BigInt(SAFE_END),
    );
    expect(
      above.map((o) => [o.expect!.amount, Number(o.expect!.amount), o.expect!.legacy_amount]),
    ).toEqual([
      ["9007199254740992", 9007199254740992, 9007199254740992],
      ["9007199254740993", 9007199254740992, 9007199254740992],
      ["2842611830637863251", 2842611830637863400, 2842611830637863000],
      ["18446744073709551615", 18446744073709552000, 18446744073709552000],
    ]);
  });

  it("sends the four fields of each unclaimed output and nothing else", async () => {
    const wallet = vectors.wallets[0];
    ns.getStealthOutputs.mockResolvedValue(wallet.outputs.map((o) => nodeRecord(o)));
    await getStealthOutputs(WALLET, wallet.address, "devnet");
    expect(rust.calls[0]).toEqual({ walletId: WALLET, expectAddress: wallet.address, outputs: [] });
    expect(rust.calls).toHaveLength(2);
    expect(Object.keys(rust.calls[1]).sort()).toEqual(["expectAddress", "outputs", "walletId"]);
    expect(rust.calls[1].outputs).toEqual(
      wallet.outputs.map((o) => ({
        id: o.id,
        eph_pub: o.eph_pub,
        stealth_tag: o.stealth_tag,
        enc_amount: o.enc_amount,
      })),
    );
    for (const sent of rust.calls[1].outputs) {
      expect(Object.keys(sent as object).sort()).toEqual(
        ["enc_amount", "eph_pub", "id", "stealth_tag"].sort(),
      );
    }
    expect(JSON.stringify(rust.calls)).not.toMatch(/commitment|delta_cipher|sender|epoch|claimed/);
  });

  it("checks the wallet before the fetch and fetches nothing when it is refused", async () => {
    for (const refusal of ["Wallet is locked", "Wallet does not match the expected address"]) {
      rust.refuse = refusal;
      await expect(getStealthOutputs(WALLET, vectors.wallets[0].address, "devnet")).rejects.toBe(
        refusal,
      );
    }
    expect(ns.getStealthOutputs).not.toHaveBeenCalled();
  });

  it("fails the scan when a lock lands between batches, keeping the last list", async () => {
    const wallet = vectors.wallets[1];
    rust.matcher = replay(wallet);
    ns.getStealthOutputs.mockResolvedValue(wallet.outputs.map((o) => nodeRecord(o)));
    const first = await getStealthOutputs(WALLET, wallet.address, "devnet");
    expect(first).toHaveLength(2);
    const later = { ...wallet.outputs[0], id: 9_000 };
    ns.getStealthOutputs.mockResolvedValue([...wallet.outputs, later].map((o) => nodeRecord(o)));
    rust.matcher = () => {
      throw "Wallet is locked";
    };
    await expect(getStealthOutputs(WALLET, wallet.address, "devnet")).rejects.toBe(
      "Wallet is locked",
    );
    rust.matcher = replay(wallet);
    ns.getStealthOutputs.mockResolvedValue([]);
    expect(await getStealthOutputs(WALLET, wallet.address, "devnet")).toEqual(first);
  });

  it("batches a long list in order and keeps every match", async () => {
    const base = vectors.wallets[1].outputs[0];
    const records = Array.from({ length: 700 }, (_, i) => nodeRecord({ ...base, id: i + 1 }));
    ns.getStealthOutputs.mockResolvedValue(records);
    rust.matcher = (outputs) =>
      (outputs as Sent[])
        .filter((o) => o.id % 7 === 0)
        .map((o) => ({ id: o.id, amount: String(o.id * 10), claim_secret: "cs", blinding: "bl" }));
    const found = await getStealthOutputs(WALLET, vectors.wallets[1].address, "devnet");
    expect(rust.calls.map((c) => c.outputs.length)).toEqual([0, 256, 256, 188]);
    expect(rust.calls.flatMap((c) => (c.outputs as Sent[]).map((o) => o.id))).toEqual(
      records.map((r) => r.id),
    );
    expect(found.map((f) => f.id)).toEqual(records.map((r) => r.id).filter((id) => id % 7 === 0));
    expect(found.every((f) => f.amount === f.id * 10)).toBe(true);
  });

  it("leaves out claimed and already matched outputs", async () => {
    const wallet = vectors.wallets[2];
    rust.matcher = replay(wallet);
    const records = wallet.outputs.map((o) => nodeRecord(o));
    ns.getStealthOutputs.mockResolvedValue(records);
    const first = await getStealthOutputs(WALLET, wallet.address, "devnet");
    const matched = first.map((f) => f.id);
    expect(matched).toHaveLength(2);

    rust.calls = [];
    const claimedId = matched[0];
    ns.getStealthOutputs.mockResolvedValue(
      records.map((r) => (r.id === claimedId ? { ...r, claimed: 1 } : r)),
    );
    const second = await getStealthOutputs(WALLET, wallet.address, "devnet");
    expect(second.map((f) => f.id)).toEqual(matched.slice(1));
    const resent = rust.calls.flatMap((c) => (c.outputs as Sent[]).map((o) => o.id));
    expect(resent).toEqual(records.map((r) => r.id).filter((id) => !matched.includes(id)));
  });

  it("keeps two records that share an id, as the old scan did", async () => {
    const base = vectors.wallets[1].outputs[0];
    ns.getStealthOutputs.mockResolvedValue([
      nodeRecord(base, { epoch_id: 1 }),
      nodeRecord(base, { epoch_id: 2 }),
    ]);
    rust.matcher = (outputs) =>
      (outputs as Sent[]).map((o) => ({
        id: o.id,
        amount: "5",
        claim_secret: "cs",
        blinding: "bl",
      }));
    const found = await getStealthOutputs(WALLET, vectors.wallets[1].address, "devnet");
    expect(found.map((f) => f.epoch)).toEqual([1, 2]);
  });

  it("never sends a record the matcher could not read", async () => {
    const good = vectors.wallets[1].outputs[0];
    const bad = [
      { ...good, id: 101, eph_pub: null },
      { ...good, id: 102, eph_pub: 7 },
      { ...good, id: 103, stealth_tag: undefined },
      { ...good, id: 104, enc_amount: ["a"] },
      { ...good, id: 105, eph_pub: "\ud800" },
      { ...good, id: 106, stealth_tag: "é".repeat(32) },
      { ...good, id: 1.5 },
      { ...good, id: -1 },
      { ...good, id: "7" },
      { ...good, id: 2 ** 53 },
    ] as unknown as Sent[];
    ns.getStealthOutputs.mockResolvedValue([...bad.map((o) => nodeRecord(o)), nodeRecord(good)]);
    rust.matcher = replay(vectors.wallets[1]);
    const found = await getStealthOutputs(WALLET, vectors.wallets[1].address, "devnet");
    expect(rust.calls[1].outputs).toEqual([
      {
        id: good.id,
        eph_pub: good.eph_pub,
        stealth_tag: good.stealth_tag,
        enc_amount: good.enc_amount,
      },
    ]);
    expect(found.map((f) => f.id)).toEqual([good.id]);
  });

  it("logs no part of a claim secret or a blinding", async () => {
    const wallet = vectors.wallets[0];
    rust.matcher = replay(wallet);
    ns.getStealthOutputs.mockResolvedValue(wallet.outputs.map((o) => nodeRecord(o)));
    await getStealthOutputs(WALLET, wallet.address, "devnet");
    const logged = JSON.stringify([
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.warn).mock.calls,
      vi.mocked(logger.debug).mock.calls,
    ]);
    for (const o of wallet.outputs) {
      if (!o.expect) continue;
      expect(logged).not.toContain(o.expect.claim_secret.slice(0, 8));
      expect(logged).not.toContain(o.expect.blinding.slice(0, 8));
    }
  });
});

describe("scan pacing", () => {
  afterEach(() => vi.useRealTimers());

  async function scanTaking(ms: number) {
    resetStealthScanCache();
    ns.getStealthOutputs.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + ms);
      return [];
    });
    await getStealthOutputs(WALLET, vectors.wallets[0].address, "devnet");
    return suggestedScanIntervalMs();
  }

  it("waits twelve scan lengths, five minutes at least", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await scanTaking(1_000)).toBe(5 * 60_000);
    expect(await scanTaking(58_000)).toBe(58_000 * 12);
  });

  it("does not stretch to days when the computer slept through a scan", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await scanTaking(8 * 60 * 60_000)).toBe(60 * 60_000);
    expect(await scanTaking(58_000)).toBe(58_000 * 12);
  });
});

describe("scan cursor", () => {
  afterEach(() => vi.useRealTimers());

  const wallet = vectors.wallets[0];
  const records = () => wallet.outputs.map((o) => nodeRecord(o));
  const scan = () => getStealthOutputs(WALLET, wallet.address, "devnet");
  const oldestMatch = () =>
    Math.min(...wallet.outputs.filter((o) => o.expect).map((o) => 1000 + o.id));

  it("scans everything the first time, then only from just behind the head", async () => {
    ns.getStealthOutputs.mockResolvedValue(records());
    await scan();
    chain.head = 5200;
    await scan();
    await scan();
    expect(chain.from).toEqual([0, 4990, 5190]);
  });

  it("starts at the oldest transfer still waiting, so a claim elsewhere is seen", async () => {
    rust.matcher = replay(wallet);
    ns.getStealthOutputs.mockResolvedValue(records());
    const found = await scan();
    expect(found.length).toBeGreaterThan(0);
    await scan();
    expect(chain.from).toEqual([0, oldestMatch()]);
  });

  it("finds a waiting transfer again after a lock cleared the list", async () => {
    rust.matcher = replay(wallet);
    ns.getStealthOutputs.mockResolvedValue(records());
    const before = await scan();
    resetStealthScanCache();
    const after = await scan();
    expect(chain.from).toEqual([0, oldestMatch()]);
    expect(after.map((f) => f.id)).toEqual(before.map((f) => f.id));
  });

  it("keeps cursors apart by network and address", async () => {
    ns.getStealthOutputs.mockResolvedValue([]);
    await scan();
    await getStealthOutputs(WALLET, wallet.address, "mainnet");
    await getStealthOutputs("wallet-2", vectors.wallets[1].address, "devnet");
    await scan();
    expect(chain.from).toEqual([0, 0, 0, 4990]);
  });

  it("does not move after a scan that stopped short", async () => {
    ns.getStealthOutputs.mockResolvedValue([]);
    chain.complete = false;
    await scan();
    chain.complete = true;
    await scan();
    await scan();
    expect(chain.from).toEqual([0, 0, 4990]);
  });

  it("does not move when the wallet is refused", async () => {
    ns.getStealthOutputs.mockResolvedValue(records());
    rust.refuse = "Wallet is locked";
    await expect(scan()).rejects.toBeTruthy();
    rust.refuse = null;
    await scan();
    expect(chain.from).toEqual([0]);
  });

  it("starts over when the chain was reset under the cursor", async () => {
    ns.getStealthOutputs.mockResolvedValue([]);
    await scan();
    chain.head = 40;
    await scan();
    await scan();
    expect(chain.from).toEqual([0, 0, 30]);
  });

  it("scans everything while the chain head cannot be read", async () => {
    ns.getStealthOutputs.mockResolvedValue([]);
    await scan();
    chain.head = null;
    await scan();
    chain.head = 5000;
    await scan();
    expect(chain.from).toEqual([0, 0, 0]);
  });

  it("scans everything again once a day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    ns.getStealthOutputs.mockResolvedValue([]);
    await scan();
    vi.setSystemTime(Date.now() + 23 * 60 * 60_000);
    await scan();
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    await scan();
    await scan();
    expect(chain.from).toEqual([0, 4990, 0, 4990]);
  });
});
