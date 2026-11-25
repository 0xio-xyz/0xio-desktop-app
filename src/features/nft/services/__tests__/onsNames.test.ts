import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ONS = "oct91H1swTpzRnN91cW5EdMtcBBL4mPQADsKZcNWihowjLN";
const OTHER = `oct${"B".repeat(44)}`;
const ME = "octkj7UCF12TYNsUtivfccTnUyNY2xnRtuVGqjejzo5kcRF";

const m = vi.hoisted(() => ({
  network: "devnet",
  view: vi.fn(),
  names: vi.fn(),
  contract: vi.fn(),
  xpectrum: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => m.invoke(...a) }));

vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/network/networkService", () => ({
  getNetwork: () => m.network,
  jsonRpcCall: async (method: string, params: unknown[]) => {
    if (method === "octra_contractAbi") return { methods: [] };
    const [contract, name, args] = params as [string, string, unknown];
    return { result: await m.view(contract, name, Array.isArray(args) ? args : []) };
  },
  jsonRpcCallOn: vi.fn(),
  sanitizeDisplay: (s: string) => s,
}));
vi.mock("src/services/names/onsService", () => ({
  namesOf: (...a: unknown[]) => m.names(...a),
  onsContractFor: async (networkId: string) => m.contract(networkId),
}));
vi.mock("src/features/nft/services/xpectrum", () => ({
  resolveXpectrumToken: (...a: unknown[]) => m.xpectrum(...a),
}));
vi.mock("src/features/circles/services/circleAsset", () => ({
  bytesToB64: () => "",
  resolveCircleAsset: async () => null,
}));

import {
  fetchTokenDetails,
  keepArt,
  nameTraits,
  readNameToken,
  resolveNftTraits,
} from "src/features/nft/services/data";

const HOST = "https://names.example/token/7.json";
const ART = "https://names.example/art/7.svg";
const ART_DATA = "data:image/svg+xml;base64,PHN2Zy8+";
const fetched = vi.fn();
const host = {
  meta: "" as string | Error,
  art: ART_DATA as string | Error,
};
const metadata = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "Shape",
    description: "A name",
    image: ART,
    attributes: [
      { trait_type: "Length", value: 4 },
      { trait_type: "Points to", value: ME },
      { trait_type: "Expires", value: 1836432000 },
      { trait_type: "Owner", value: ME },
      { trait_type: "Status", value: "Active" },
    ],
    ...over,
  });
const asked = () => m.invoke.mock.calls.map(([, args]) => [args.url, args.kind]);
const revert = (text: string) => new Error(`execution reverted [${text}]`);

function chain(over: Record<string, (args: unknown[]) => unknown> = {}) {
  const views: Record<string, (args: unknown[]) => unknown> = {
    owner_of: () => ME,
    name_of_token: () => "0xio",
    status_of: () => "1",
    get_name_info: () => `7|0xio|${ME}|1836432000|2||${ME}|0`,
    token_uri: () => HOST,
    ...over,
  };
  m.view.mockImplementation(async (_c: string, name: string, args: unknown[]) => {
    if (!views[name]) throw revert("no such view");
    return views[name](args);
  });
}

beforeEach(() => {
  m.network = "devnet";
  m.view.mockReset();
  m.names.mockReset();
  m.contract.mockReset();
  m.contract.mockImplementation((networkId: string) => (networkId === "devnet" ? ONS : null));
  m.xpectrum.mockReset();
  m.xpectrum.mockResolvedValue(null);
  fetched.mockReset();
  fetched.mockResolvedValue({ ok: false });
  vi.stubGlobal("fetch", fetched);
  host.meta = metadata();
  host.art = ART_DATA;
  m.invoke.mockReset();
  m.invoke.mockImplementation(async (command: string, args: { url: string; kind: string }) => {
    if (command !== "nft_fetch") throw new Error(command);
    const reply = args.kind === "metadata" && args.url === HOST ? host.meta : host.art;
    if (args.kind === "image" && args.url !== ART) throw new Error("HTTP 404");
    if (reply instanceof Error) throw reply;
    return reply;
  });
  chain();
});

afterEach(() => vi.unstubAllGlobals());

describe("ONS names as NFTs", () => {
  it("reads the name contract of another network, or one not checked yet, as any collection", async () => {
    for (const arrange of [() => (m.network = "mainnet"), () => m.contract.mockReturnValue(null)]) {
      arrange();
      const [d] = await fetchTokenDetails(ONS, ["7"]);
      expect(d.inactive).toBeUndefined();
      expect(d.metaName).toBe("Shape");
      m.network = "devnet";
    }
  });

  it("reads a name's artwork through token_uri and the app, and its facts from the chain", async () => {
    const [d] = await fetchTokenDetails(ONS, ["7"]);
    expect(d).toMatchObject({
      tokenId: "7",
      metaName: "0xio.oct",
      inactive: false,
      expired: false,
      expires: 1836432000,
      uri: HOST,
      image: ART_DATA,
      animationUrl: null,
      metaFetched: true,
    });
    expect(d.burned).toBeUndefined();
    expect(d.biontAttrs).toBeUndefined();
    expect(m.view.mock.calls.filter((c) => c[1] === "token_uri")).toEqual([
      [ONS, "token_uri", [7]],
    ]);
    expect(asked()).toEqual([
      [HOST, "metadata"],
      [ART, "image"],
    ]);
    expect(fetched).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the app refuses or cannot read the metadata",
      () => (host.meta = new Error("Address not allowed")),
    ],
    ["the metadata is not JSON", () => (host.meta = "<html>")],
    ["the metadata names no image", () => (host.meta = metadata({ image: undefined }))],
    ["the app refuses or cannot read the image", () => (host.art = new Error("Too large"))],
    [
      "the image is at an address that is not https",
      () => (host.meta = metadata({ image: "http://names.example/art/7.svg" })),
    ],
  ])("has no artwork for a name when %s, and keeps its facts", async (_, arrange) => {
    arrange();
    const [d] = await fetchTokenDetails(ONS, ["7"]);
    expect(d).toMatchObject({
      metaName: "0xio.oct",
      inactive: false,
      expired: false,
      metaFetched: true,
    });
    expect(d.image === null || d.image.startsWith("http://")).toBe(true);
    expect(d.burned).toBeUndefined();
  });

  it("never runs a name as a living program", async () => {
    host.meta = metadata({ animation_url: "oct://circle/program.html" });
    const [d] = await fetchTokenDetails(ONS, ["7"]);
    expect(d.animationUrl).toBeNull();
  });

  it("keeps a name whose reads did not answer", async () => {
    chain({
      name_of_token: () => {
        throw new Error("timeout");
      },
      token_uri: () => {
        throw new Error("timeout");
      },
    });
    const [d] = await fetchTokenDetails(ONS, ["7"]);
    expect(d).toMatchObject({ tokenId: "7", metaName: null, image: null, metaFetched: true });
    expect(d.inactive).toBeUndefined();
    expect(d.expired).toBeUndefined();
    expect(d.burned).toBeUndefined();
    expect(m.invoke).not.toHaveBeenCalled();
  });

  it("shows a lapsed name as expired, never burned", async () => {
    chain({
      owner_of: () => {
        throw revert("ons: name lapsed");
      },
      token_uri: () => {
        throw revert("ons: name lapsed");
      },
    });
    const [d] = await fetchTokenDetails(ONS, ["7"]);
    expect(d).toMatchObject({
      tokenId: "7",
      metaName: "0xio.oct",
      inactive: true,
      expired: true,
      image: null,
    });
    expect(d.burned).toBeUndefined();
    expect(m.invoke).not.toHaveBeenCalled();
  });

  it("reads a token_uri revert on the name contract as expired", async () => {
    chain({
      token_uri: () => {
        throw revert("no token");
      },
    });
    const [d] = await fetchTokenDetails(ONS, ["7"]);
    expect(d).toMatchObject({ metaName: "0xio.oct", inactive: true, expired: true, image: null });
    expect(d.burned).toBeUndefined();
  });

  it.each([
    ["grace", "2", 1836432000, true],
    ["available, past its expiry", "0", 1700000000, true],
    ["available", "0", 1836432000, false],
    ["reserved", "3", 1836432000, false],
  ])("reads a name whose status is %s", async (_, status, expires, expired) => {
    chain({ status_of: () => status, get_name_info: () => `7|0xio|${ME}|${expires}|2||${ME}|0` });
    expect(await readNameToken(ONS, "7")).toEqual({
      name: "0xio",
      inactive: true,
      expired,
      expires,
    });
  });

  it("drops the metadata rows that repeat chain facts", async () => {
    const { traits } = await resolveNftTraits(HOST);
    expect(traits.map((t) => t.k)).toEqual(["Length", "Points to", "Expires", "Owner", "Status"]);
    expect(nameTraits(traits)).toEqual([{ k: "Length", v: "4" }]);
    expect(nameTraits([{ k: " EXPIRY ", v: "x" }])).toEqual([]);
    expect(nameTraits(null)).toEqual([]);
  });

  it("keeps the artwork shown when a fresh read brings none, and takes its chain facts", async () => {
    const [shown] = await fetchTokenDetails(ONS, ["7"]);
    host.meta = new Error("Timed out");
    chain({ status_of: () => "2" });
    const [fresh] = await fetchTokenDetails(ONS, ["7"]);
    expect(fresh.image).toBeNull();
    expect(keepArt(shown, fresh)).toMatchObject({
      image: ART_DATA,
      uri: HOST,
      metaName: "0xio.oct",
      inactive: true,
      expired: true,
    });
    expect(keepArt(null, fresh)).toBe(fresh);
    expect(keepArt(fresh, shown)).toBe(shown);
  });

  it("writes no name host in the source", () => {
    const files = import.meta.glob("/src/**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const source = Object.entries(files).filter(([path]) => !path.includes("__tests__"));
    expect(source.length).toBeGreaterThan(100);
    for (const [path, text] of source) expect(/workers\.dev|ons-site/.test(text), path).toBe(false);
  });

  it.each([
    ["has the six fields of the old contract", `0xio|${ME}|1836432000|2||${ME}`],
    ["has a ninth field", `7|0xio|${ME}|1836432000|2||${ME}|0|x`],
    ["names another name", `7|0xio-labs|${ME}|1836432000|2||${ME}|0`],
    ["names another token", `8|0xio|${ME}|1836432000|2||${ME}|0`],
    ["has an unknown Circle status", `7|0xio|${ME}|1836432000|2||${ME}|3`],
  ])("shows no expiry when the name info %s", async (_, info) => {
    chain({ get_name_info: () => info });
    expect(await readNameToken(ONS, "7")).toEqual({
      name: "0xio",
      inactive: false,
      expired: false,
      expires: undefined,
    });
    expect(m.view.mock.calls.some((c) => c[1] === "expires_of")).toBe(false);
  });

  it("does not call a name inactive when the node is busy", async () => {
    chain({
      owner_of: () => {
        throw new Error("Program view busy");
      },
      status_of: () => {
        throw new Error("Program view busy");
      },
    });
    vi.useFakeTimers();
    try {
      const read = readNameToken(ONS, "7");
      await vi.runAllTimersAsync();
      expect(await read).toEqual({ name: "0xio", expires: 1836432000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves other collections as they were", async () => {
    const [d] = await fetchTokenDetails(OTHER, ["1"]);
    expect(d.inactive).toBeUndefined();
    expect(d.expires).toBeUndefined();
    expect(d.uri).toBe(HOST);
    expect(d.metaName).toBe("Shape");
    expect(m.view.mock.calls.map((c) => c[1])).toEqual(["token_uri"]);
    expect(m.xpectrum).toHaveBeenCalledWith(HOST);
    expect(asked()).toEqual([
      [HOST, "metadata"],
      [ART, "image"],
    ]);
    expect(d.image).toBe(ART_DATA);
    expect(fetched).not.toHaveBeenCalled();
  });
});
