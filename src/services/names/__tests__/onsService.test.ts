import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

const { rpc, list, network } = vi.hoisted(() => ({
  rpc: vi.fn(),
  list: vi.fn(),
  network: { id: "mainnet" },
}));
vi.mock("src/features/nft/services/discovery", () => ({ getJson: list }));
vi.mock("src/services/network/networkService", () => ({
  jsonRpcCallOn: rpc,
  getNetwork: () => network.id,
}));

import {
  ONS_BUSY_CODE,
  ONS_NAME_MAX,
  ONS_PAGE_SIZE,
  ONS_YEARS_MAX,
  ONS_YEARS_MIN,
  emptyTargetReason,
  isNameInput,
  isNameService,
  normalizeName,
  onsErrorCode,
  onsListNetwork,
  parseCount,
  parseFeed,
  parseKind,
  parseName,
  parseNameInfo,
  parseNameList,
  parseNames,
  parsePrice,
  parseResolve,
  parseStatus,
  parseTarget,
} from "src/services/names/ons";
import {
  ONS_FORWARD_TTL_MS,
  ONS_LAST_GOOD_PREFIX,
  ONS_LIST_TTL_MS,
  ONS_LIST_URL,
  ONS_PRIMARY_TTL_MS,
  ONS_RETRY_MS,
  clearOnsCache,
  forgetOnsContracts,
  loadOnsContract,
  namesOf,
  onsBusyRetry,
  onsContract,
  onsContractFor,
  openCircle,
  primaryName,
  priceOf,
  resolveCircle,
  resolveWallet,
  subscribeOnsContract,
} from "src/services/names/onsService";
import { RpcError } from "src/services/network/submitErrors";

const VECTORS_SHA256 = "6c4058f9e9c4b9e578c4c5997fe204841136b014ef73079b09a2798054bed4ff";

const copy = resolve(__dirname, "../../../test/fixtures/ons-vectors.json");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const vectors = JSON.parse(readFileSync(copy, "utf8"));

const DEVNET = "devnet";
const MAINNET = "mainnet";
const CONTRACT = vectors.contracts.devnet as string;
const BUSY = { code: ONS_BUSY_CODE, message: "Program view busy" };
const INFO = vectors.parse.nameService[0].raw as string;
const listing = (address: string, network = "devnet") => ({
  services: [{ network, address, name: "Octra Name System", symbol: "ONS", suffix: ".oct" }],
});

interface Reply {
  method: string;
  params: string[];
  result?: string;
  error?: { code?: number; message: string };
}

function script(replies: Reply[]): Reply[] {
  const queue = [...replies];
  rpc.mockImplementation(async () => {
    const next = queue.shift();
    if (!next) throw new Error("no reply scripted");
    if (next.error) throw new RpcError(next.error.message, { code: next.error.code });
    return { result: next.result };
  });
  return queue;
}

const calls = () =>
  rpc.mock.calls.map(([, , params]) => ({ method: params[1], params: params[2] }));

const run = (call: string, args: unknown[], networkId: string): Promise<unknown> => {
  const [first, second] = args as [string, number];
  switch (call) {
    case "resolveWallet":
      return resolveWallet(first, { networkId });
    case "resolveCircle":
      return resolveCircle(first, { networkId });
    case "primaryName":
      return primaryName(first, { networkId });
    case "priceOf":
      return priceOf(first, second, { networkId });
    case "namesOf":
      return namesOf(first, { networkId });
    default:
      throw new Error(`unknown call ${call}`);
  }
};

const savedDelays = onsBusyRetry.delaysMs;

async function prime(...networks: string[]): Promise<void> {
  list.mockResolvedValue(listing(CONTRACT));
  rpc.mockResolvedValue({ result: INFO });
  for (const networkId of networks) await loadOnsContract(networkId);
  rpc.mockReset();
}

beforeEach(async () => {
  rpc.mockReset();
  list.mockReset();
  localStorage.clear();
  network.id = MAINNET;
  clearOnsCache();
  forgetOnsContracts();
  onsBusyRetry.delaysMs = savedDelays.map(() => 0);
  await prime(DEVNET, "devnet2");
});

afterEach(() => {
  onsBusyRetry.delaysMs = savedDelays;
  vi.useRealTimers();
});

describe("ONS shared vectors", () => {
  it("is the same file every client runs", () => {
    expect(sha256(copy)).toBe(VECTORS_SHA256);
  });

  it("carries the contract table and the limits", () => {
    for (const [network, contract] of Object.entries(vectors.contracts))
      expect(onsContract(network), network).toBe(contract);
    expect(onsContract("devnet2")).toBe(CONTRACT);
    expect(onsContract("custom_1")).toBeNull();
    expect(onsContract("constructor")).toBeNull();
    expect(ONS_LIST_URL).toBe(vectors.nameList.url);
    for (const [network, listedAs] of Object.entries(vectors.nameList.listedAs))
      expect(onsListNetwork(network), network).toBe(listedAs);
    expect(ONS_NAME_MAX).toBe(vectors.limits.nameMax);
    expect(ONS_PAGE_SIZE).toBe(vectors.limits.pageSize);
    expect(ONS_YEARS_MIN).toBe(vectors.limits.yearsMin);
    expect(ONS_YEARS_MAX).toBe(vectors.limits.yearsMax);
    expect(ONS_YEARS_MAX).toBe(5);
    expect(ONS_BUSY_CODE).toBe(vectors.limits.busyCode);
    expect(ONS_FORWARD_TTL_MS).toBe(vectors.limits.forwardTtlMs);
    expect(ONS_PRIMARY_TTL_MS).toBe(vectors.limits.primaryTtlMs);
    expect(savedDelays).toEqual(vectors.limits.busyRetryDelaysMs);
  });

  it("reads the name list strictly", () => {
    for (const v of vectors.nameList.parse)
      expect(parseNameList(v.list), JSON.stringify(v.list)).toEqual(v.expect);
  });

  it("normalises names", () => {
    for (const v of vectors.normalize) {
      const expected = "name" in v ? { ok: true, name: v.name } : { ok: false, invalid: v.invalid };
      expect(normalizeName(v.input), JSON.stringify(v.input)).toEqual(expected);
    }
  });

  it("tells name input from other text", () => {
    for (const v of vectors.isNameInput)
      expect(isNameInput(v.input), JSON.stringify(v.input)).toBe(v.expect);
  });

  it("parses each reply", () => {
    const parsers: Record<string, (raw: string) => unknown> = {
      status: parseStatus,
      kind: parseKind,
      target: parseTarget,
      name: parseName,
      nameInfo: parseNameInfo,
      names: parseNames,
      nameService: isNameService,
      resolve: parseResolve,
      count: parseCount,
      price: parsePrice,
      feed: parseFeed,
    };
    expect(Object.keys(vectors.parse).sort()).toEqual(Object.keys(parsers).sort());
    for (const [kind, cases] of Object.entries<{ raw: string; expect: unknown }[]>(vectors.parse))
      for (const v of cases)
        expect(parsers[kind](v.raw), `${kind} ${JSON.stringify(v.raw)}`).toEqual(v.expect);
  });

  it("explains an empty target", () => {
    for (const v of vectors.emptyTargetReason)
      expect(emptyTargetReason(v.target, v.status, v.kind), JSON.stringify(v)).toBe(v.expect);
  });

  it("maps node and contract errors", () => {
    for (const v of vectors.errors)
      expect(onsErrorCode(v.message, v.code), JSON.stringify(v)).toBe(v.expect);
  });

  for (const s of vectors.scenarios) {
    it(`scenario: ${s.name}`, async () => {
      const left = script(s.replies);
      const at = s.network === "devnet" ? DEVNET : MAINNET;
      expect(await run(s.call, s.args, at)).toEqual(s.expect);
      expect(calls()).toEqual(
        s.replies.map((r: Reply) => ({ method: r.method, params: r.params })),
      );
      expect(left).toEqual([]);
      for (const [networkId, method, params] of rpc.mock.calls) {
        expect(networkId).toBe(at);
        expect(method).toBe("contract_call");
        expect([params[0], params[3]]).toEqual([CONTRACT, CONTRACT]);
      }
    });
  }
});

describe("ONS reads", () => {
  const A = vectors.scenarios[0].expect.address as string;
  const B = vectors.parse.nameInfo[0].expect.wallet as string;
  const walletOf = (address: string): Reply => ({
    method: "resolve",
    params: ["0xio"],
    result: address ? `2|${address}` : "0|",
  });

  it("reads the current network when none is given, and mainnet has no contract", async () => {
    script([]);
    expect(await resolveWallet("0xio.oct")).toEqual({ ok: false, reason: "not_available" });
    expect(await resolveCircle("0xio.oct")).toEqual({ ok: false, reason: "not_available" });
    expect(await primaryName(A)).toEqual({ ok: false, reason: "not_available" });
    expect(await namesOf(A)).toEqual({ ok: false, reason: "not_available" });
    expect(await priceOf("0xio.oct", 1)).toEqual({ ok: false, reason: "not_available" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps a resolution for 60 seconds and no longer", async () => {
    vi.useFakeTimers();
    script([walletOf(A), walletOf(B)]);
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET })).toMatchObject({ address: A });
    vi.advanceTimersByTime(ONS_FORWARD_TTL_MS - 1);
    expect(await resolveWallet("0XIO.oct", { networkId: DEVNET })).toMatchObject({ address: A });
    expect(rpc).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET })).toMatchObject({ address: B });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("asks the node again at confirm and keeps the new answer", async () => {
    script([walletOf(A), walletOf(B)]);
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET })).toMatchObject({ address: A });
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET, fresh: true })).toMatchObject({
      address: B,
    });
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET })).toMatchObject({ address: B });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("a fresh read that fails does not fall back to the kept answer", async () => {
    script([walletOf(A), { method: "resolve", params: ["0xio"], error: { message: "down" } }]);
    await resolveWallet("0xio.oct", { networkId: DEVNET });
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET, fresh: true })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("keeps wallet and Circle lookups of one name apart", async () => {
    script([walletOf(A), { method: "resolve", params: ["0xio"], result: `1|${B}` }]);
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET })).toMatchObject({ address: A });
    expect(await resolveCircle("0xio.oct", { networkId: DEVNET })).toMatchObject({ circleId: B });
  });

  it('keeps a contract answer of "not registered" but never a busy or failed read', async () => {
    script([
      walletOf(""),
      { method: "status_of", params: ["0xio"], result: "0" },
      { method: "resolve", params: ["0xio-labs"], error: BUSY },
      { method: "resolve", params: ["0xio-labs"], error: BUSY },
      { method: "resolve", params: ["0xio-labs"], error: BUSY },
      { method: "resolve", params: ["0xio-labs"], result: `2|${A}` },
    ]);
    const missing = { ok: false, reason: "not_registered" };
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET })).toEqual(missing);
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET })).toEqual(missing);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(await resolveWallet("0xio-labs.oct", { networkId: DEVNET })).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(await resolveWallet("0xio-labs.oct", { networkId: DEVNET })).toMatchObject({
      address: A,
    });
  });

  it("shares one request between identical reads in flight", async () => {
    script([walletOf(A)]);
    const [one, two] = await Promise.all([
      resolveWallet("0xio.oct", { networkId: DEVNET }),
      resolveWallet("0xio.oct", { networkId: DEVNET }),
    ]);
    expect(one).toEqual(two);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("waits one then two seconds before asking a busy node again", async () => {
    vi.useFakeTimers();
    onsBusyRetry.delaysMs = savedDelays;
    script([
      { method: "resolve", params: ["0xio"], error: BUSY },
      { method: "resolve", params: ["0xio"], error: BUSY },
      walletOf(A),
    ]);
    const pending = resolveWallet("0xio.oct", { networkId: DEVNET });
    await vi.advanceTimersByTimeAsync(999);
    expect(rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(rpc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ address: A });
  });

  it("refuses a reply that is not text", async () => {
    rpc.mockResolvedValue({ result: 7 });
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET })).toEqual({
      ok: false,
      reason: "bad_reply",
    });
  });

  it("keeps a primary name, or the lack of one, for ten minutes", async () => {
    vi.useFakeTimers();
    const primaryOf = (address: string, result: string): Reply => ({
      method: "primary_of",
      params: [address],
      result,
    });
    script([primaryOf(A, "0xio"), primaryOf(B, ""), primaryOf(A, "")]);
    expect(await primaryName(A, { networkId: DEVNET })).toEqual({ ok: true, name: "0xio" });
    expect(await primaryName(B, { networkId: DEVNET })).toEqual({ ok: true, name: null });
    vi.advanceTimersByTime(ONS_PRIMARY_TTL_MS - 1);
    expect(await primaryName(A, { networkId: DEVNET })).toEqual({ ok: true, name: "0xio" });
    expect(await primaryName(B, { networkId: DEVNET })).toEqual({ ok: true, name: null });
    expect(rpc).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(await primaryName(A, { networkId: DEVNET })).toEqual({ ok: true, name: null });
  });

  it("follows the current network and never shares an answer across networks", async () => {
    script([walletOf(A), walletOf(B)]);
    network.id = DEVNET;
    expect(await resolveWallet("0xio.oct")).toMatchObject({ address: A });
    expect(await resolveWallet("0xio.oct", { networkId: "devnet2" })).toMatchObject({
      address: B,
    });
    expect(rpc.mock.calls.map(([networkId]) => networkId)).toEqual([DEVNET, "devnet2"]);
    network.id = MAINNET;
    expect(await resolveWallet("0xio.oct")).toEqual({ ok: false, reason: "not_available" });
  });

  it("takes a wallet only from a resolve reply of kind 2", async () => {
    for (const result of ["0|", `1|${A}`, "1|", "2|"]) {
      clearOnsCache();
      script([
        { method: "resolve", params: ["0xio"], result },
        { method: "status_of", params: ["0xio"], result: "1" },
      ]);
      expect((await resolveWallet("0xio.oct", { networkId: DEVNET })).ok, result).toBe(false);
    }
    for (const result of ["", "2", A, `2|${A}|`, `2|${A} `, `4|${A}`, `0|${A}`, "2|0xio"]) {
      clearOnsCache();
      rpc.mockReset();
      script([{ method: "resolve", params: ["0xio"], result }]);
      expect(await resolveWallet("0xio.oct", { networkId: DEVNET }), result).toEqual({
        ok: false,
        reason: "bad_reply",
      });
      expect(rpc).toHaveBeenCalledTimes(1);
    }
  });

  it("never asks the contract for a price beyond five years", async () => {
    script([{ method: "price_of", params: ["0xio", "5"], result: "1208000000" }]);
    expect(await priceOf("0xio.oct", 5, { networkId: DEVNET })).toMatchObject({ ok: true });
    for (const years of [0, 6, 10])
      expect(await priceOf("0xio.oct", years, { networkId: DEVNET })).toEqual({
        ok: false,
        reason: "invalid",
      });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, []],
    [1, ["0"]],
    [50, ["0"]],
    [51, ["0", "50"]],
    [100, ["0", "50"]],
    [101, ["0", "50", "100"]],
  ])("pages %i names 50 at a time", async (count, offsets) => {
    const held = Array.from({ length: count }, (_, i) => `n${i + 1}`);
    script([
      { method: "balance_of", params: [A], result: String(count) },
      ...offsets.map(
        (offset): Reply => ({
          method: "names_of",
          params: [A, offset, "50"],
          result: held.slice(Number(offset), Number(offset) + 50).join(","),
        }),
      ),
      ...held.flatMap((name, i): Reply[] => [
        { method: "get_name_info", params: [name], result: `${i}|${name}|${A}|1825920325|0|||0` },
        { method: "status_of", params: [name], result: "1" },
      ]),
    ]);
    const result = await namesOf(A, { networkId: DEVNET });
    expect(result.ok && result.names.map((n) => n.name)).toEqual(held);
    expect(result.ok && result.names.map((n) => n.tokenId)).toEqual(held.map((_, i) => String(i)));
    expect(calls().filter((c) => c.method === "names_of")).toEqual(
      offsets.map((offset) => ({ method: "names_of", params: [A, offset, "50"] })),
    );
    expect(calls().some((c) => c.method === "name_of_token" || c.method === "tokens_of")).toBe(
      false,
    );
  });

  it("stops paging at an empty or short page, whatever the count says", async () => {
    script([
      { method: "balance_of", params: [A], result: "3" },
      { method: "names_of", params: [A, "0", "50"], result: "" },
    ]);
    expect(await namesOf(A, { networkId: DEVNET })).toEqual({ ok: true, names: [] });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe("ONS contract", () => {
  const OTHER = vectors.parse.nameInfo[0].expect.wallet as string;
  const key = (networkId: string) => `${ONS_LAST_GOOD_PREFIX}${networkId}`;
  const info = (result: string): Reply => ({ method: "get_contract_info", params: [], result });

  beforeEach(() => {
    forgetOnsContracts();
    localStorage.clear();
    list.mockReset();
  });

  it("takes the address from the list, checks it on chain once and keeps it", async () => {
    list.mockResolvedValue(listing(CONTRACT));
    script([info(INFO)]);
    expect(onsContract(DEVNET)).toBeNull();
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "on", address: CONTRACT });
    expect(await onsContractFor(DEVNET)).toBe(CONTRACT);
    expect(onsContract(DEVNET)).toBe(CONTRACT);
    expect(onsContract("devnet2")).toBeNull();
    expect(localStorage.getItem(key(DEVNET))).toBe(CONTRACT);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(ONS_LIST_URL);
    expect(rpc.mock.calls).toEqual([
      [DEVNET, "contract_call", [CONTRACT, "get_contract_info", [], CONTRACT]],
    ]);
  });

  it("checks devnet2 on its own node against the devnet entry", async () => {
    list.mockResolvedValue(listing(CONTRACT));
    script([info(INFO), info("Octra Name System|ONS|0||5")]);
    expect((await loadOnsContract(DEVNET)).state).toBe("on");
    expect((await loadOnsContract("devnet2")).state).toBe("off");
    expect(rpc.mock.calls.map(([networkId]) => networkId)).toEqual([DEVNET, "devnet2"]);
    expect(onsContract("devnet2")).toBeNull();
    expect(localStorage.getItem(key("devnet2"))).toBeNull();
  });

  it.each([
    ["no entry for the network", listing(CONTRACT, "mainnet")],
    [
      "two entries for the network",
      { services: [...listing(CONTRACT).services, ...listing(OTHER).services] },
    ],
    ["a bad address", listing("oct123")],
    ["another suffix", { services: [{ network: "devnet", address: CONTRACT, suffix: ".eth" }] }],
  ])("has no names with %s, whatever was kept before", async (_, body) => {
    localStorage.setItem(key(DEVNET), CONTRACT);
    list.mockResolvedValue(body);
    script([]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "off" });
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET })).toEqual({
      ok: false,
      reason: "not_available",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["another name", "Other Name System|ONS|2||6"],
    ["another interface", "Octra Name System|ONS|2||7"],
    ["four fields", "Octra Name System|ONS|2|6"],
    ["nothing", ""],
  ])("has no names when the contract answers %s", async (_, reply) => {
    list.mockResolvedValue(listing(CONTRACT));
    script([info(reply)]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "off" });
    expect(onsContract(DEVNET)).toBeNull();
    expect(localStorage.getItem(key(DEVNET))).toBeNull();
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "off" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("has no names when the contract refuses the check", async () => {
    list.mockResolvedValue(listing(CONTRACT));
    script([
      {
        method: "get_contract_info",
        params: [],
        error: { code: -32000, message: "execution reverted" },
      },
    ]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "off" });
  });

  it.each([
    ["busy", BUSY, 3],
    ["down", { message: "RPC HTTP error: 502" }, 1],
  ])("does not know yet when the node is %s, and asks again later", async (_, error, asks) => {
    vi.useFakeTimers();
    onsBusyRetry.delaysMs = [0, 0];
    list.mockResolvedValue(listing(CONTRACT));
    rpc.mockRejectedValue(new RpcError(error.message, { code: (error as { code?: number }).code }));
    const first = loadOnsContract(DEVNET);
    await vi.runAllTimersAsync();
    expect(await first).toEqual({ state: "unknown" });
    expect(onsContract(DEVNET)).toBeNull();
    expect(localStorage.getItem(key(DEVNET))).toBeNull();
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(rpc).toHaveBeenCalledTimes(asks);
    script([info(INFO)]);
    vi.advanceTimersByTime(ONS_RETRY_MS - 1);
    expect((await loadOnsContract(DEVNET)).state).toBe("unknown");
    vi.advanceTimersByTime(1);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "on", address: CONTRACT });
  });

  it("uses the last good address when the list cannot be reached, after checking it", async () => {
    localStorage.setItem(key(DEVNET), CONTRACT);
    list.mockRejectedValue(new Error("offline"));
    script([info(INFO)]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "on", address: CONTRACT });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("does not pass a last good address that fails the check", async () => {
    localStorage.setItem(key(DEVNET), CONTRACT);
    list.mockRejectedValue(new Error("offline"));
    script([info("Octra Name System|ONS|0||5")]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "off" });
  });

  it.each([
    ["the list cannot be reached", () => list.mockRejectedValue(new Error("offline"))],
    ["the list is not a list", () => list.mockResolvedValue("not json")],
    [
      "the kept address is not an address",
      () => {
        localStorage.setItem(key(DEVNET), "0xio");
        list.mockRejectedValue(new Error("offline"));
      },
    ],
  ])("has no names when %s and nothing good was kept", async (_, arrange) => {
    arrange();
    script([]);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "off" });
    expect(await primaryName(OTHER, { networkId: DEVNET })).toEqual({
      ok: false,
      reason: "not_available",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads the list once per ten minutes, and sooner after a failed read", async () => {
    vi.useFakeTimers();
    list.mockResolvedValue(listing(CONTRACT));
    script([info(INFO), info(INFO)]);
    await loadOnsContract(DEVNET);
    await loadOnsContract("devnet2");
    vi.advanceTimersByTime(ONS_LIST_TTL_MS - 1);
    await loadOnsContract(DEVNET);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockRejectedValue(new Error("offline"));
    vi.advanceTimersByTime(1);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "on", address: CONTRACT });
    expect(list).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(ONS_RETRY_MS);
    await loadOnsContract(DEVNET);
    expect(list).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("drops the old contract when the list names another, and checks the new one", async () => {
    vi.useFakeTimers();
    list.mockResolvedValue(listing(CONTRACT));
    script([info(INFO), info("Other Name System|ONS|0||6"), info(INFO)]);
    await loadOnsContract(DEVNET);
    list.mockResolvedValue(listing(OTHER));
    vi.advanceTimersByTime(ONS_LIST_TTL_MS);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "off" });
    expect(onsContract(DEVNET)).toBeNull();
    expect(localStorage.getItem(key(DEVNET))).toBe(CONTRACT);
    vi.advanceTimersByTime(ONS_LIST_TTL_MS);
    expect(await loadOnsContract(DEVNET)).toEqual({ state: "on", address: OTHER });
    expect(localStorage.getItem(key(DEVNET))).toBe(OTHER);
    expect(rpc.mock.calls.map(([, , params]) => params[0])).toEqual([CONTRACT, OTHER, OTHER]);
  });

  it("stops a send at confirm when the listed contract changed since the name was typed", async () => {
    vi.useFakeTimers();
    const A = vectors.scenarios[0].expect.address as string;
    const resolved = (): Reply => ({ method: "resolve", params: ["0xio"], result: `2|${A}` });
    list.mockResolvedValue(listing(CONTRACT));
    script([info(INFO), resolved(), info(INFO), resolved(), resolved()]);
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET })).toMatchObject({
      address: A,
      contract: CONTRACT,
    });
    list.mockResolvedValue(listing(OTHER));
    vi.advanceTimersByTime(ONS_LIST_TTL_MS);
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET, fresh: true })).toEqual({
      ok: false,
      reason: "service_changed",
    });
    expect(await resolveWallet("0xio.oct", { networkId: DEVNET, fresh: true })).toMatchObject({
      address: A,
      contract: OTHER,
    });
    expect(rpc.mock.calls.map(([, , params]) => params[0])).toEqual([
      CONTRACT,
      CONTRACT,
      OTHER,
      OTHER,
      OTHER,
    ]);
  });

  it("tells every listener when the contract of a network becomes known or is dropped", async () => {
    const heard = vi.fn();
    const stop = subscribeOnsContract(heard);
    list.mockResolvedValue(listing(CONTRACT));
    script([info(INFO)]);
    await loadOnsContract(DEVNET);
    expect(heard).toHaveBeenCalledTimes(1);
    forgetOnsContracts();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("opening a Circle by name", () => {
  const OWNER = vectors.scenarios[0].expect.address as string;
  const CIRCLE = vectors.parse.nameInfo[0].expect.wallet as string;
  const nothing: Reply[] = [
    { method: "resolve", params: ["ons"], result: "0|" },
    { method: "status_of", params: ["ons"], result: "1" },
  ];
  const nameInfo = (circle: string, status: string): Reply => ({
    method: "get_name_info",
    params: ["ons"],
    result: `1|ons|${OWNER}|1826095818|${circle ? 1 : 0}|${circle}||${status}`,
  });

  for (const s of vectors.scenarios.filter((v: { call: string }) => v.call === "resolveCircle")) {
    it(`scenario: ${s.name}`, async () => {
      const unset = s.expect.reason === "not_set";
      const left = script(unset ? [...s.replies, nameInfo("", "0")] : s.replies);
      expect(await openCircle(s.args[0], { networkId: DEVNET })).toEqual(s.expect);
      expect(calls().map((c) => c.method)).toEqual([
        ...s.replies.map((r: Reply) => r.method),
        ...(unset ? ["get_name_info"] : []),
      ]);
      expect(left).toEqual([]);
    });
  }

  it("tells a Circle that waits for confirmation from no Circle set", async () => {
    script([...nothing, nameInfo(CIRCLE, "1")]);
    expect(await openCircle("ons.oct", { networkId: DEVNET })).toEqual({
      ok: false,
      reason: "circle_waiting",
    });
    expect(calls()).toEqual([
      { method: "resolve", params: ["ons"] },
      { method: "status_of", params: ["ons"] },
      { method: "get_name_info", params: ["ons"] },
    ]);
  });

  it("reads the name info only when the name is active with nothing set", async () => {
    script([{ method: "resolve", params: ["0xio-labs"], result: `1|${CIRCLE}` }]);
    expect(await openCircle("0xio-labs.oct", { networkId: DEVNET })).toMatchObject({
      circleId: CIRCLE,
    });
    script([
      { method: "resolve", params: ["0xio"], result: "0|" },
      { method: "status_of", params: ["0xio"], result: "0" },
    ]);
    expect(await openCircle("0xio.oct", { networkId: DEVNET })).toEqual({
      ok: false,
      reason: "not_registered",
    });
    expect(calls().map((c) => c.method)).toEqual(["resolve", "resolve", "status_of"]);
  });

  it("a busy node is never read as no Circle set, and the next open asks again", async () => {
    const busy: Reply = { method: "get_name_info", params: ["ons"], error: BUSY };
    script([...nothing, busy, busy, busy, nameInfo(CIRCLE, "1")]);
    expect(await openCircle("ons.oct", { networkId: DEVNET })).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(await openCircle("ons.oct", { networkId: DEVNET })).toEqual({
      ok: false,
      reason: "circle_waiting",
    });
    expect(rpc).toHaveBeenCalledTimes(6);
  });

  it("keeps the answer 60 seconds, and a fresh open reads all of it again", async () => {
    vi.useFakeTimers();
    script([
      ...nothing,
      nameInfo(CIRCLE, "1"),
      { method: "resolve", params: ["ons"], result: `1|${CIRCLE}` },
      ...nothing,
      nameInfo("", "0"),
    ]);
    const waiting = { ok: false, reason: "circle_waiting" };
    expect(await openCircle("ons.oct", { networkId: DEVNET })).toEqual(waiting);
    vi.advanceTimersByTime(ONS_FORWARD_TTL_MS - 1);
    expect(await openCircle("ONS.oct", { networkId: DEVNET })).toEqual(waiting);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(await openCircle("ons.oct", { networkId: DEVNET, fresh: true })).toMatchObject({
      circleId: CIRCLE,
    });
    expect(await openCircle("ons.oct", { networkId: DEVNET })).toMatchObject({ circleId: CIRCLE });
    expect(rpc).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(ONS_FORWARD_TTL_MS);
    expect(await openCircle("ons.oct", { networkId: DEVNET })).toEqual({
      ok: false,
      reason: "not_set",
    });
    expect(rpc).toHaveBeenCalledTimes(7);
  });

  it("is off where no name contract is checked, without a call", async () => {
    script([]);
    expect(await openCircle("0xio.oct", { networkId: MAINNET })).toEqual({
      ok: false,
      reason: "not_available",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});
