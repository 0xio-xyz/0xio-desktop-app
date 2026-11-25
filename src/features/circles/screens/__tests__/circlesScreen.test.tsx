// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const WALLET = `oct${"A".repeat(44)}`;
const OTHER = `oct${"B".repeat(44)}`;
const CIRCLE = `oct${"C".repeat(44)}`;
const OLDER = `oct${"R".repeat(44)}`;
const m = vi.hoisted(() => ({
  navigate: vi.fn(),
  auth: vi.fn(),
  deploy: vi.fn(),
  check: vi.fn(),
  batchCheck: vi.fn(),
  confirm: vi.fn(),
  build: vi.fn(),
  broadcast: vi.fn(),
  toast: vi.fn(),
  chosen: vi.fn(),
  both: true,
  info: vi.fn(),
  passphrase: vi.fn(),
  wallet: { id: "w1", name: "Main", address: "" },
  networkId: "devnet",
}));
m.wallet.address = WALLET;

vi.mock("src/i18n/react", () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o && Object.keys(o).length ? `${k} ${JSON.stringify(o)}` : k,
  }),
}));
vi.mock("src/lib/router", () => ({ useNavigate: () => m.navigate }));
vi.mock("src/features/circles/services/circleDrop", async (actual) => ({
  ...(await actual<typeof import("src/features/circles/services/circleDrop")>()),
  get CHOOSES_BOTH() {
    return m.both;
  },
  chosenFiles: (...a: unknown[]) => m.chosen(...a),
}));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({ activeWallet: m.wallet, networkId: m.networkId }),
}));
const quote = {
  status: "ok",
  fee: { minimum: "1000", recommended: "1000", fast: "2000" },
  last: null,
  retry: () => {},
};
vi.mock("src/hooks/transactions/useFees", () => ({
  useReviewFee: () => ({
    quote,
    ou: "1000",
    setOU: () => {},
    recheck: { checking: false, error: "", setError: () => {}, check: m.check },
  }),
}));
vi.mock("src/features/circles/hooks/useCircleBatchFee", () => ({
  useCircleBatchFee: (_op: string, lens: number[]) => ({
    quote,
    ou: String(lens.length * 1000),
    parts: lens.map(() => "1000"),
    setOU: () => {},
    recheck: { checking: false, error: "", setError: () => {}, check: m.batchCheck },
  }),
}));
vi.mock("src/hooks/transactions/useTransactionAuth", () => ({
  useTransactionAuth: () => ({
    isOpen: false,
    title: "",
    requestAuth: (...a: unknown[]) => m.auth(...a),
    handleResult: vi.fn(),
  }),
}));
vi.mock("src/hooks/wallet/useTokenPrice", () => ({
  useTokenPrice: () => ({ getUsdValue: () => "" }),
}));
vi.mock("src/hooks/privacy/useProofQueue", () => ({ useNow: () => 0 }));
vi.mock("src/services/notices/activity", () => ({ toast: (...a: unknown[]) => m.toast(...a) }));
vi.mock("src/services/network/networkService", () => ({
  captureScope: (address: string) => ({ address, networkId: m.networkId }),
}));
vi.mock("src/services/network/transactionBuilder", () => ({
  buildHfheTx: (...a: unknown[]) => m.build(...a),
  broadcastSignedTx: (...a: unknown[]) => m.broadcast(...a),
}));
vi.mock("src/features/circles/services/circleDeploy", () => ({
  circleAssetB64Len: (size: number) => Math.ceil(size / 3) * 4,
  deployCircle: (...a: unknown[]) => m.deploy(...a),
  confirmCircleTx: (...a: unknown[]) => m.confirm(...a),
}));
vi.mock("src/features/dapp/services/circleRead", () => ({
  fetchCircleInfo: (...a: unknown[]) => m.info(...a),
}));
vi.mock("src/features/circles/services/circleUnlock", () => ({
  checkPassphrase: (...a: unknown[]) => m.passphrase(...a),
}));
vi.mock("src/shared/layout/TopBar", () => ({ default: () => null }));
vi.mock("src/shared/ui/FeePicker", () => ({ default: () => null }));
vi.mock("src/shared/ui/Mascot", () => ({ default: () => null }));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/features/wallet/components/TransactionAuthModal", () => ({ default: () => null }));

import CirclesScreen from "src/features/circles/screens/CirclesScreen";
import { TxSubmitError } from "src/services/network/submitErrors";
import {
  addCircle,
  putFile,
  readLibrary,
  resetLibraryCache,
} from "src/features/circles/services/circleLibrary";
import { resetCircleRun } from "src/features/circles/services/circleRun";

const scope = { networkId: "devnet", address: WALLET };
const route = (id: string) => `/browser?url=${encodeURIComponent(`oct://${id}/index.html`)}`;
const count = (key: string, n: number) => `${key} {"count":${n}}`;

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const ui = () => (
    <QueryClientProvider client={qc}>
      <CirclesScreen />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { ...view, again: () => view.rerender(ui()) };
}

const pick = async (...files: File[]) => {
  m.chosen.mockResolvedValueOnce(files.map((file) => ({ file, path: `/${file.name}` })));
  const button = screen.queryByText("circles.chooseFiles") ?? screen.getByText("circles.addFiles");
  await act(async () => {
    fireEvent.click(button);
  });
};
const sized = (name: string, size: number) => {
  const file = new File(["x"], name, { type: "" });
  Object.defineProperty(file, "size", { value: size });
  return file;
};
const text = (name: string, body: string) => new File([body], name, { type: "" });
const published = (path: string, status: "confirmed" | "pending" = "confirmed") =>
  putFile(scope, CIRCLE, { path, size: 5, type: "text/html", at: 1, tx: `tx${path}`, status });
const have = (sealed: boolean | null = false) =>
  addCircle(scope, { id: CIRCLE, sealed, deployTx: "dd", status: "confirmed" });

async function createCircle(sealed = false) {
  if (sealed) {
    fireEvent.click(screen.getByRole("button", { name: "circlesPage.encrypted" }));
    fireEvent.change(screen.getByLabelText("circles.sealed.passphrase"), {
      target: { value: "open sesame" },
    });
    fireEvent.change(screen.getByLabelText("circles.repeatPassphrase"), {
      target: { value: "open sesame" },
    });
  }
  fireEvent.click(screen.getByText("circlesPage.reviewDeploy"));
  fireEvent.click(await screen.findByRole("button", { name: "circles.deploy" }));
}

beforeEach(() => {
  localStorage.clear();
  resetLibraryCache();
  resetCircleRun();
  for (const f of [m.navigate, m.toast, m.info]) f.mockReset();
  m.auth.mockReset().mockResolvedValue(true);
  m.check.mockReset().mockResolvedValue(null);
  m.batchCheck.mockReset().mockResolvedValue(null);
  m.deploy.mockReset().mockResolvedValue({ circleId: CIRCLE, hash: "ab".repeat(32) });
  m.confirm.mockReset().mockResolvedValue({ status: "confirmed" });
  m.build.mockReset().mockResolvedValue({ signed: true });
  let n = 0;
  m.broadcast.mockReset().mockImplementation(async () => `hash${++n}`);
  m.passphrase.mockReset().mockResolvedValue("ok");
  m.wallet = { id: "w1", name: "Main", address: WALLET };
  m.networkId = "devnet";
});
afterEach(cleanup);

describe("first visit", () => {
  it("holds New circle only, with no guide, no recent list and nothing to open", () => {
    show();
    expect(screen.getAllByText("circles.newCircle")).toHaveLength(2);
    expect(screen.getByText("circlesPage.reviewDeploy")).toBeTruthy();
    expect(screen.queryByText("circles.openInBrowser")).toBeNull();
    expect(screen.queryByText("circles.howItWorks")).toBeNull();
    expect(screen.queryByText("circles.recent")).toBeNull();
    expect(screen.queryByText(/Keys and policies/)).toBeNull();
    expect((screen.getByLabelText("circles.sealed.passphrase") as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it("an encrypted circle needs the passphrase twice before its review", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "circlesPage.encrypted" }));
    const review = screen.getByText("circlesPage.reviewDeploy") as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("circles.sealed.passphrase"), {
      target: { value: "one" },
    });
    fireEvent.change(screen.getByLabelText("circles.repeatPassphrase"), {
      target: { value: "two" },
    });
    expect(screen.getByText("circles.passphraseMismatch")).toBeTruthy();
    expect(review.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("circles.repeatPassphrase"), {
      target: { value: "one" },
    });
    expect(review.disabled).toBe(false);
  });
});

describe("creating a circle", () => {
  it("goes through the review and the fee check before it signs, then shows the circle", async () => {
    show();
    fireEvent.click(screen.getByText("circlesPage.reviewDeploy"));
    const review = await screen.findByRole("dialog", { name: "circles.deployCircle" });
    expect(within(review).getByText("circles.publicCircle")).toBeTruthy();
    expect(within(review).getByText("deploy_circle")).toBeTruthy();
    expect(within(review).queryByText("circles.passphraseWarning")).toBeNull();
    expect(m.deploy).not.toHaveBeenCalled();
    expect(m.auth).not.toHaveBeenCalled();
    fireEvent.click(within(review).getByRole("button", { name: "circles.deploy" }));
    await screen.findByText("circles.openInBrowser");
    expect(m.check).toHaveBeenCalledWith("devnet", "1000");
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.deploy).toHaveBeenCalledWith({
      walletId: "w1",
      scope,
      sealed: false,
      ou: "1000",
    });
    expect(m.confirm).toHaveBeenCalledWith("ab".repeat(32), "devnet");
    expect(m.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "activity.circleDeployed" }),
    );
    expect(readLibrary(scope)[0]).toMatchObject({ id: CIRCLE, sealed: false, status: "confirmed" });
    expect(screen.getByText("circles.dropFiles")).toBeTruthy();
  });

  it("the encrypted review keeps the one warning, and the new circle is unlocked", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "circlesPage.encrypted" }));
    fireEvent.change(screen.getByLabelText("circles.sealed.passphrase"), {
      target: { value: "open sesame" },
    });
    fireEvent.change(screen.getByLabelText("circles.repeatPassphrase"), {
      target: { value: "open sesame" },
    });
    fireEvent.click(screen.getByText("circlesPage.reviewDeploy"));
    const review = await screen.findByRole("dialog", { name: "circles.deployCircle" });
    expect(within(review).getByText("circles.passphraseWarning")).toBeTruthy();
    expect(within(review).getByText("circles.passphraseSet")).toBeTruthy();
    fireEvent.click(within(review).getByRole("button", { name: "circles.deploy" }));
    await screen.findByText("circles.dropFiles");
    expect(m.deploy.mock.calls[0][0].sealed).toBe(true);
    expect(screen.queryByText("circles.unlock")).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain("open sesame");
  });

  it("a rejected deploy shows its reason and leaves no circle", async () => {
    m.confirm.mockResolvedValue({ status: "rejected", reason: "unknown browser mode: native" });
    show();
    await createCircle();
    const sheet = await screen.findByRole("dialog", { name: "circles.deployRejected" });
    expect(within(sheet).getByText("unknown browser mode: native")).toBeTruthy();
    expect(readLibrary(scope)).toEqual([]);
    expect(screen.queryByText("circles.openInBrowser")).toBeNull();
    fireEvent.click(within(sheet).getByText("common.back"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("circlesPage.reviewDeploy")).toBeTruthy();
  });

  it("an unconfirmed deploy offers only a check again", async () => {
    m.confirm.mockResolvedValue({ status: "pending" });
    show();
    await createCircle();
    expect(await screen.findByText("circles.deployPending")).toBeTruthy();
    expect(screen.queryByText("circles.dropFiles")).toBeNull();
    expect((screen.getByText("circles.openInBrowser") as HTMLButtonElement).disabled).toBe(true);
    m.confirm.mockResolvedValue({ status: "confirmed" });
    fireEvent.click(screen.getByText("circles.checkAgain"));
    expect(await screen.findByText("circles.dropFiles")).toBeTruthy();
    expect(m.deploy).toHaveBeenCalledTimes(1);
  });
});

describe("the library", () => {
  it("is back after a restart, per network and wallet", () => {
    have();
    published("/index.html");
    const view = show();
    expect(screen.getByText("circles.publishedHere")).toBeTruthy();
    expect(screen.getByText("/index.html")).toBeTruthy();
    expect(screen.getByText("circles.dropFiles")).toBeTruthy();

    m.networkId = "mainnet";
    view.again();
    expect(screen.queryByText("circles.publishedHere")).toBeNull();
    expect(screen.getByText("circlesPage.reviewDeploy")).toBeTruthy();

    m.networkId = "devnet";
    m.wallet = { id: "w2", name: "Other", address: OTHER };
    view.again();
    expect(screen.queryByText("circles.publishedHere")).toBeNull();
  });

  it("carries the old recent list over and asks the chain whether it is encrypted", async () => {
    localStorage.setItem(`0xio_recent_circles:devnet:${WALLET}`, JSON.stringify([OLDER]));
    m.info.mockResolvedValue({ resource_mode: "sealed_read" });
    show();
    expect(await screen.findByText("circles.unlock")).toBeTruthy();
    expect(readLibrary(scope)[0]).toMatchObject({ id: OLDER, sealed: true });
  });

  it("says so when a carried over circle cannot be read", async () => {
    localStorage.setItem(`0xio_recent_circles:devnet:${WALLET}`, JSON.stringify([OLDER]));
    m.info.mockResolvedValue(null);
    show();
    expect(await screen.findByText("circles.infoFailed", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText("circles.chooseFiles")).toBeNull();
  });

  it("Open in browser routes to the circle's index page, and Copy gives the full id", () => {
    have();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    show();
    expect(screen.queryByText(CIRCLE)).toBeNull();
    fireEvent.click(screen.getByText("circles.openInBrowser"));
    expect(m.navigate).toHaveBeenCalledWith(route(CIRCLE));
    expect(route(CIRCLE)).toBe(`/browser?url=oct%3A%2F%2F${CIRCLE}%2Findex.html`);
    fireEvent.click(screen.getByRole("button", { name: "circles.copy" }));
    expect(writeText).toHaveBeenCalledWith(CIRCLE);
  });

  it("an encrypted circle asks for its passphrase again before files can be added", async () => {
    have(true);
    published("/index.html");
    show();
    expect(screen.queryByText("circles.dropFiles")).toBeNull();
    m.passphrase.mockResolvedValueOnce("wrong");
    fireEvent.change(screen.getByLabelText("circles.sealed.passphrase"), {
      target: { value: "guess" },
    });
    fireEvent.click(screen.getByText("circles.unlock"));
    expect(await screen.findByText("circles.wrongPassphrase")).toBeTruthy();
    expect(screen.queryByText("circles.dropFiles")).toBeNull();
    fireEvent.change(screen.getByLabelText("circles.sealed.passphrase"), {
      target: { value: "open sesame" },
    });
    fireEvent.click(screen.getByText("circles.unlock"));
    expect(await screen.findByText("circles.dropFiles")).toBeTruthy();
    expect(m.passphrase.mock.calls[1][0]).toMatchObject({ passphrase: "open sesame" });
  });
});

describe("adding files", () => {
  it("where one window cannot take both, Choose offers Files or Folder", async () => {
    m.both = false;
    try {
      have();
      show();
      fireEvent.click(screen.getByText("circles.chooseFiles"));
      expect(screen.getByRole("menuitem", { name: "circles.chooseKindFiles" })).toBeTruthy();
      m.chosen.mockResolvedValueOnce([{ file: text("a.txt", "a"), path: "/site/a.txt" }]);
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "circles.chooseKindFolder" }));
      });
      expect(m.chosen).toHaveBeenLastCalledWith("folder");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(await screen.findByDisplayValue("/site/a.txt")).toBeTruthy();
    } finally {
      m.both = true;
    }
  });

  it("refuses a file in its row, marks a replace, and reviews only what can go", async () => {
    have();
    published("/index.html");
    show();
    const big = sized("intro.mp4", 33554433);
    const read = vi.spyOn(big, "arrayBuffer");
    await pick(
      text("index.html", "<p>hi</p>"),
      text("a.css", "body{}"),
      big,
      sized("mid.bin", 2097153),
    );
    expect(screen.getByText("circles.readyToUpload")).toBeTruthy();
    expect(screen.getByText("circles.refuse.over32", { exact: false })).toBeTruthy();
    expect(screen.getByText("circles.refuse.over2", { exact: false })).toBeTruthy();
    expect(screen.getAllByText("circles.replace")).toHaveLength(1);
    expect(screen.getAllByText("circles.new")).toHaveLength(1);

    fireEvent.click(screen.getByText("circles.reviewUpload"));
    const review = await screen.findByRole("dialog", { name: "circles.reviewUpload" });
    const list = within(review).getByRole("list", { name: "circles.transactions" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("/index.html")).toBeTruthy();
    expect(within(list).getByText("/a.css")).toBeTruthy();
    expect(within(list).getAllByText("circles.replace")).toHaveLength(1);
    expect(within(review).queryByText("/intro.mp4")).toBeNull();
    expect(within(review).getAllByText(count("circles.files", 2)).length).toBeGreaterThan(0);
    expect(read).not.toHaveBeenCalled();
    expect(m.build).not.toHaveBeenCalled();
  });

  it("a bad path is refused while it is typed, and the canonical path is what is signed", async () => {
    have();
    show();
    await pick(text("index.html", "<p>hi</p>"));
    const path = () => screen.getByLabelText("circles.path") as HTMLInputElement;
    expect(path().value).toBe("/index.html");
    for (const [value, refusal] of [
      ["/a/../b.html", "path"],
      ["/.octra/chunks/x", "reserved"],
      ["/bad%zz", "path"],
    ]) {
      fireEvent.change(path(), { target: { value } });
      expect(screen.getByText(`circles.refuse.${refusal}`, { exact: false })).toBeTruthy();
      expect((screen.getByText("circles.reviewUpload") as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(path(), { target: { value: " site//./my%20page.html " } });
    fireEvent.click(screen.getByText("circles.reviewUpload"));
    const review = await screen.findByRole("dialog", { name: "circles.reviewUpload" });
    expect(within(review).getByText("/site/my page.html")).toBeTruthy();
    fireEvent.click(within(review).getByRole("button", { name: "circles.upload" }));
    await waitFor(() => expect(m.broadcast).toHaveBeenCalledTimes(1));
    expect(m.batchCheck).toHaveBeenCalledWith("devnet", ["1000"]);
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.build).toHaveBeenCalledWith({
      from: WALLET,
      to: CIRCLE,
      amount: "0",
      opType: "circle_asset_put",
      encryptedData: btoa("<p>hi</p>"),
      walletId: "w1",
      ou: "1000",
      message: '{"path":"/site/my page.html","content_type":"text/html; charset=utf-8"}',
      scope,
    });
    await waitFor(() =>
      expect(m.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "activity.circleUploaded", values: { count: 1 } }),
      ),
    );
    expect(await screen.findByText("/site/my page.html")).toBeTruthy();
    expect(screen.queryByText("circles.readyToUpload")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("one authorization sends the whole batch, one transaction at a time", async () => {
    have();
    show();
    await pick(text("a.txt", "a"), text("b.txt", "b"), text("c.txt", "c"));
    let release: (v: { status: string }) => void = () => {};
    m.confirm.mockImplementationOnce(() => new Promise((ok) => (release = ok)));
    fireEvent.click(screen.getByText("circles.reviewUpload"));
    fireEvent.click(await screen.findByRole("button", { name: "circles.upload" }));
    const sheet = await screen.findByRole("dialog", { name: count("circles.uploadingN", 3) });
    await waitFor(() => expect(m.broadcast).toHaveBeenCalledTimes(1));
    expect(within(sheet).getAllByText("circles.state.waiting")).toHaveLength(2);
    expect(within(sheet).queryByText(/✓/)).toBeNull();
    fireEvent.click(within(sheet).getByText("activity.hide"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("activity.showProgress")).toBeTruthy();
    await act(async () => release({ status: "confirmed" }));
    await waitFor(() => expect(m.broadcast).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(m.toast).toHaveBeenCalledTimes(1));
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(readLibrary(scope)[0].files).toHaveLength(3);
  });

  it("a rejected file shows its reason and the rest go to a fresh review", async () => {
    have();
    show();
    await pick(text("a.txt", "a"), text("b.txt", "b"), text("c.txt", "c"));
    m.confirm
      .mockResolvedValueOnce({ status: "confirmed" })
      .mockResolvedValueOnce({ status: "rejected", reason: "circle owner required" });
    fireEvent.click(screen.getByText("circles.reviewUpload"));
    fireEvent.click(await screen.findByRole("button", { name: "circles.upload" }));
    const sheet = await screen.findByRole("dialog", {
      name: 'circles.uploadedOf {"done":1,"count":3}',
    });
    expect(within(sheet).getByText("circle owner required")).toBeTruthy();
    expect(within(sheet).getByText("circles.state.rejected")).toBeTruthy();
    expect(within(sheet).getByText("circles.state.unsent")).toBeTruthy();
    expect(m.build).toHaveBeenCalledTimes(2);
    fireEvent.click(within(sheet).getByText(count("circles.reviewRemaining", 2)));
    const review = await screen.findByRole("dialog", { name: "circles.reviewUpload" });
    const items = within(review).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("/b.txt"),
      expect.stringContaining("/c.txt"),
    ]);
    expect(m.build).toHaveBeenCalledTimes(2);
  });

  it("a file the network refuses outright can be reviewed again", async () => {
    have();
    show();
    await pick(text("a.txt", "a"));
    m.broadcast.mockRejectedValueOnce(new TxSubmitError("rejected", "fee too low"));
    fireEvent.click(screen.getByText("circles.reviewUpload"));
    fireEvent.click(await screen.findByRole("button", { name: "circles.upload" }));
    const sheet = await screen.findByRole("dialog", {
      name: 'circles.uploadedOf {"done":0,"count":1}',
    });
    expect(within(sheet).getByText("fee too low")).toBeTruthy();
    expect(within(sheet).getByText("circles.state.refused")).toBeTruthy();
    fireEvent.click(within(sheet).getByText("circles.backToFiles"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByLabelText("circles.path") as HTMLInputElement).value).toBe("/a.txt");
    expect((screen.getByText("circles.reviewUpload") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a file sent and not confirmed offers a check again and never a resend", async () => {
    have();
    show();
    await pick(text("a.txt", "a"), text("b.txt", "b"));
    m.confirm.mockResolvedValueOnce({ status: "pending" });
    fireEvent.click(screen.getByText("circles.reviewUpload"));
    fireEvent.click(await screen.findByRole("button", { name: "circles.upload" }));
    const sheet = await screen.findByRole("dialog", {
      name: 'circles.uploadedOf {"done":0,"count":2}',
    });
    expect(within(sheet).queryByText(/circles.reviewRemaining/)).toBeNull();
    expect(within(sheet).queryByText("circles.backToFiles")).toBeNull();
    expect(within(sheet).getByText("circles.checkAgain")).toBeTruthy();
    fireEvent.click(within(sheet).getByText("activity.hide"));
    expect(screen.queryByText("circles.reviewUpload")).toBeNull();
    expect(screen.getByText(count("circles.filesPending", 1))).toBeTruthy();
    expect(screen.getAllByLabelText("circles.path")).toHaveLength(1);

    m.confirm.mockResolvedValueOnce({ status: "confirmed" });
    fireEvent.click(screen.getByText("circles.checkAgain"));
    expect(await screen.findByText("circles.reviewUpload")).toBeTruthy();
    expect(m.build).toHaveBeenCalledTimes(1);
    expect(m.broadcast).toHaveBeenCalledTimes(1);
    expect(m.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "activity.circleUploaded", values: { count: 1 } }),
    );
  });

  it("an unconfirmed file from an earlier visit locks the review until it is checked", () => {
    have();
    published("/a.txt", "pending");
    show();
    expect(screen.getByText(count("circles.filesPending", 1))).toBeTruthy();
    expect(screen.queryByText("circles.dropFiles")).toBeNull();
    expect(screen.getAllByText("circles.state.pending").length).toBeGreaterThan(0);
  });

  it("nothing is signed when the authorization is declined", async () => {
    have();
    show();
    await pick(text("a.txt", "a"));
    m.auth.mockResolvedValue(false);
    fireEvent.click(screen.getByText("circles.reviewUpload"));
    fireEvent.click(await screen.findByRole("button", { name: "circles.upload" }));
    await waitFor(() => expect(m.auth).toHaveBeenCalledTimes(1));
    expect(m.build).not.toHaveBeenCalled();
    expect(screen.getByText("circles.readyToUpload")).toBeTruthy();
  });
});
