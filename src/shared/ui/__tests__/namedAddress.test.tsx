// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const ADDR = "octkj7UCF12TYNsUtivfccTnUyNY2xnRtuVGqjejzo5kcRF";

const m = vi.hoisted(() => ({ primary: vi.fn(), network: "devnet" }));

vi.mock("src/contexts/useWallet", () => ({ useWallet: () => ({ networkId: m.network }) }));
vi.mock("src/services/names/onsService", () => ({
  ONS_FORWARD_TTL_MS: 60_000,
  ONS_PRIMARY_TTL_MS: 600_000,
  ONS_LIST_TTL_MS: 600_000,
  ONS_RETRY_MS: 60_000,
  loadOnsContract: async () => ({
    state: "on",
    address: "oct91H1swTpzRnN91cW5EdMtcBBL4mPQADsKZcNWihowjLN",
  }),
  onsContract: (networkId: string) =>
    networkId === "devnet" ? "oct91H1swTpzRnN91cW5EdMtcBBL4mPQADsKZcNWihowjLN" : null,
  subscribeOnsContract: () => () => {},
  primaryName: (...a: unknown[]) => m.primary(...a),
  resolveWallet: vi.fn(),
}));

import NamedAddress from "src/shared/ui/NamedAddress";

function show(networkId?: string) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <NamedAddress address={ADDR} networkId={networkId}>
        octkj7UC...o5kcRF
      </NamedAddress>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  m.network = "devnet";
  m.primary.mockReset().mockResolvedValue({ ok: true, name: "0xio" });
});
afterEach(cleanup);

describe("Name and address together", () => {
  it("shows the primary name whole, in front of the cut address", async () => {
    const view = show();
    expect(view.container.textContent).toBe("octkj7UC...o5kcRF");
    await waitFor(() => expect(screen.getByTestId("primary-name").textContent).toBe("0xio.oct"));
    expect(view.container.textContent).toBe("0xio.octoctkj7UC...o5kcRF");
    expect(m.primary).toHaveBeenCalledWith(ADDR, { networkId: "devnet" });
  });

  it.each([
    ["no primary name", { ok: true, name: null }],
    ["a busy node", { ok: false, reason: "busy" }],
    ["a failed read", { ok: false, reason: "unavailable" }],
    ["a reply it cannot read", { ok: false, reason: "bad_reply" }],
  ])("shows the address alone with %s", async (_, reply) => {
    m.primary.mockResolvedValue(reply);
    const view = show();
    await waitFor(() => expect(m.primary).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("primary-name")).toBeNull();
    expect(view.container.textContent).toBe("octkj7UC...o5kcRF");
  });

  it("asks nothing on a network without the name contract", async () => {
    const view = show("mainnet");
    await new Promise((r) => setTimeout(r, 0));
    expect(m.primary).not.toHaveBeenCalled();
    expect(view.container.textContent).toBe("octkj7UC...o5kcRF");
  });

  it("asks on the row's own network, not the active one", async () => {
    m.network = "mainnet";
    show("devnet");
    await waitFor(() => expect(m.primary).toHaveBeenCalledWith(ADDR, { networkId: "devnet" }));
  });

  it("waits until the row has been on screen", async () => {
    let seen: (e: { isIntersecting: boolean }[]) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: typeof seen) {
          seen = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      show();
      await new Promise((r) => setTimeout(r, 0));
      expect(m.primary).not.toHaveBeenCalled();
      seen([{ isIntersecting: true }]);
      await waitFor(() => expect(m.primary).toHaveBeenCalledTimes(1));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
