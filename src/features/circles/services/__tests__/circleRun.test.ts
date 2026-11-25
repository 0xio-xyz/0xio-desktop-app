// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  build: vi.fn(),
  broadcast: vi.fn(),
  deploy: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/notices/activity", () => ({ toast: (...a: unknown[]) => m.toast(...a) }));
vi.mock("src/services/network/transactionBuilder", () => ({
  buildHfheTx: (...a: unknown[]) => m.build(...a),
  broadcastSignedTx: (...a: unknown[]) => m.broadcast(...a),
}));
vi.mock("src/features/circles/services/circleDeploy", () => ({
  deployCircle: (...a: unknown[]) => m.deploy(...a),
  confirmCircleTx: (...a: unknown[]) => m.confirm(...a),
}));

import { TxSubmitError, UnclearSubmitError } from "src/services/network/submitErrors";
import {
  addCircle,
  putFile,
  readLibrary,
  resetLibraryCache,
} from "src/features/circles/services/circleLibrary";
import {
  checkAgain,
  CIRCLE_BATCH_MAX,
  circleKey,
  getCircleRun,
  resetCircleRun,
  runBatch,
  runDeploy,
  showBatch,
  showDeploy,
  stagedRows,
  stageFiles,
  type StagedFile,
} from "src/features/circles/services/circleRun";

const WALLET = `oct${"A".repeat(44)}`;
const CIRCLE = `oct${"C".repeat(44)}`;
const scope = { networkId: "devnet", address: WALLET };
const key = circleKey(scope, CIRCLE);

const sized = (name: string, size: number, type = "") => {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
};
const text = (name: string, body: string) => new File([body], name, { type: "" });
const stage = (...files: [File, string][]) =>
  stageFiles(
    scope,
    CIRCLE,
    files.map(([file, path]) => ({ file, path })),
  );
const staged = (): StagedFile[] => getCircleRun().staged[key] ?? [];
const circle = () => readLibrary(scope).find((c) => c.id === CIRCLE)!;
const batch = (sealed = false) => {
  const rows = stagedRows(staged(), circle(), sealed).filter((r) => r.path);
  return runBatch({
    scope,
    walletId: "w1",
    circleId: CIRCLE,
    sealed,
    passphrase: "",
    files: rows.map((row) => ({ row, ou: "1000", len: Math.ceil(row.size / 3) * 4 })),
  });
};

beforeEach(() => {
  localStorage.clear();
  resetLibraryCache();
  resetCircleRun();
  for (const f of Object.values(m)) f.mockReset();
  m.build.mockImplementation(async (p: { message: string }) => ({ signed: p.message }));
  let n = 0;
  m.broadcast.mockImplementation(async () => `hash${++n}`);
  m.confirm.mockResolvedValue({ status: "confirmed" });
  addCircle(scope, { id: CIRCLE, sealed: false, deployTx: "dd", status: "confirmed" });
});

describe("files waiting for a review", () => {
  it("refuses a file in its row and marks a path already published as a replace", () => {
    putFile(scope, CIRCLE, {
      path: "/index.html",
      size: 5,
      type: "text/html",
      at: 1,
      tx: "t",
      status: "confirmed",
    });
    stage(
      [sized("index.html", 10), " index.html "],
      [sized("new.css", 10), "/new.css"],
      [sized("big.mp4", 33554433), "/big.mp4"],
      [sized("mid.bin", 2097153), "/mid.bin"],
      [sized("up.txt", 10), "/a/../up.txt"],
      [sized("res.txt", 10), "/.octra/chunks/x"],
      [sized("esc.txt", 10), "/bad%zz"],
      [sized("dup.css", 10), "//new.css"],
      [sized("none.txt", 0), "/none.txt"],
    );
    const rows = stagedRows(staged(), circle(), false);
    expect(rows.map((r) => [r.path, r.replace, r.refusal])).toEqual([
      ["/index.html", true, null],
      ["/new.css", false, null],
      [null, false, "over32"],
      [null, false, "over2"],
      [null, false, "path"],
      [null, false, "reserved"],
      [null, false, "path"],
      [null, false, "duplicate"],
      [null, false, "empty"],
    ]);
    expect(stagedRows(staged(), circle(), true)[3]).toMatchObject({ path: "/mid.bin" });
  });

  it("takes at most one batch of files into a review", () => {
    stage(
      ...Array.from(
        { length: CIRCLE_BATCH_MAX + 3 },
        (_, i) => [sized(`f${i}`, 10), `/f${i}`] as [File, string],
      ),
    );
    const rows = stagedRows(staged(), circle(), false);
    expect(rows.filter((r) => r.path)).toHaveLength(CIRCLE_BATCH_MAX);
    expect(rows.slice(CIRCLE_BATCH_MAX).map((r) => r.refusal)).toEqual(["full", "full", "full"]);
  });
});

describe("a batch of uploads", () => {
  it("sends one transaction per file in order and ends with Uploaded", async () => {
    stage(
      [text("index.html", "<title>0xio notes</title>"), "/index.html"],
      [text("a.css", "body{}"), "/a.css"],
    );
    await batch();
    expect(m.build).toHaveBeenCalledTimes(2);
    expect(m.build.mock.calls[0][0]).toEqual({
      from: WALLET,
      to: CIRCLE,
      amount: "0",
      opType: "circle_asset_put",
      encryptedData: btoa("<title>0xio notes</title>"),
      walletId: "w1",
      ou: "1000",
      message: '{"path":"/index.html","content_type":"text/html; charset=utf-8"}',
      scope,
    });
    expect(m.confirm.mock.calls.map((c) => c[0])).toEqual(["hash1", "hash2"]);
    expect(circle().files.map((f) => [f.path, f.status, f.tx])).toEqual([
      ["/a.css", "confirmed", "hash2"],
      ["/index.html", "confirmed", "hash1"],
    ]);
    expect(circle().files[1].title).toBe("0xio notes");
    expect(staged()).toEqual([]);
    expect(getCircleRun().batch).toBeNull();
    expect(m.toast).toHaveBeenCalledTimes(1);
    expect(m.toast).toHaveBeenCalledWith({
      title: "activity.circleUploaded",
      values: { count: 2 },
      view: { hash: "hash2", network: "devnet" },
      scope,
    });
  });

  it("stops at a file the chain rejects, with its reason, and sends nothing after it", async () => {
    stage([text("a", "a"), "/a"], [text("b", "b"), "/b"], [text("c", "c"), "/c"]);
    m.confirm
      .mockResolvedValueOnce({ status: "confirmed" })
      .mockResolvedValueOnce({ status: "rejected", reason: "circle owner required" });
    await batch();
    expect(m.build).toHaveBeenCalledTimes(2);
    const run = getCircleRun().batch!;
    expect(run.status).toBe("stopped");
    expect(run.files.map((f) => [f.path, f.state, f.reason])).toEqual([
      ["/a", "confirmed", undefined],
      ["/b", "rejected", "circle owner required"],
      ["/c", "unsent", undefined],
    ]);
    expect(circle().files.map((f) => f.path)).toEqual(["/a"]);
    expect(staged().map((f) => f.path)).toEqual(["/b", "/c"]);
    expect(m.toast).not.toHaveBeenCalled();
  });

  it("a file the network refuses outright stays for a fresh review with the rest", async () => {
    stage([text("a", "a"), "/a"], [text("b", "b"), "/b"]);
    m.broadcast.mockRejectedValueOnce(new TxSubmitError("rejected", "fee too low"));
    await batch();
    expect(m.confirm).not.toHaveBeenCalled();
    expect(getCircleRun().batch!.files.map((f) => [f.state, f.reason])).toEqual([
      ["refused", "fee too low"],
      ["unsent", undefined],
    ]);
    expect(circle().files).toEqual([]);
    expect(staged().map((f) => f.path)).toEqual(["/a", "/b"]);
  });

  it("a file sent and not confirmed is recorded, never offered again, and stops the batch", async () => {
    stage([text("a", "a"), "/a"], [text("b", "b"), "/b"]);
    m.confirm.mockResolvedValueOnce({ status: "pending" });
    await batch();
    expect(m.build).toHaveBeenCalledTimes(1);
    expect(getCircleRun().batch!.files.map((f) => f.state)).toEqual(["pending", "unsent"]);
    expect(circle().files.map((f) => [f.path, f.status, f.tx])).toEqual([
      ["/a", "pending", "hash1"],
    ]);
    expect(staged().map((f) => f.path)).toEqual(["/b"]);
  });

  it("an unclear submit is followed by its hash instead of being sent again", async () => {
    stage([text("a", "a"), "/a"]);
    m.broadcast.mockRejectedValueOnce(new UnclearSubmitError("local1", new Error("timed out")));
    await batch();
    expect(m.broadcast).toHaveBeenCalledTimes(1);
    expect(m.confirm).toHaveBeenCalledWith("local1", "devnet");
    expect(circle().files[0]).toMatchObject({ path: "/a", status: "confirmed", tx: "local1" });
  });

  it("a timeout with no hash to follow is left unconfirmed and out of the next review", async () => {
    stage([text("a", "a"), "/a"], [text("b", "b"), "/b"]);
    m.broadcast.mockRejectedValueOnce(new Error("Transaction timed out after 60s"));
    await batch();
    expect(getCircleRun().batch!.files.map((f) => f.state)).toEqual(["pending", "unsent"]);
    expect(staged().map((f) => f.path)).toEqual(["/b"]);
  });

  it("refuses a file that changed after the review", async () => {
    const file = text("a", "abc");
    stage([file, "/a"]);
    const rows = stagedRows(staged(), circle(), false);
    await runBatch({
      scope,
      walletId: "w1",
      circleId: CIRCLE,
      sealed: false,
      passphrase: "",
      files: [{ row: { ...rows[0], size: 99 }, ou: "1000", len: 132 }],
    });
    expect(m.build).not.toHaveBeenCalled();
    expect(getCircleRun().batch!.files[0]).toMatchObject({
      state: "refused",
      reason: "A file changed since the review",
    });
  });

  it("reports as a toast when the page is not showing it", async () => {
    stage([text("a", "a"), "/a"]);
    m.confirm.mockImplementationOnce(async () => {
      showBatch(false);
      return { status: "rejected", reason: "nope" };
    });
    await batch();
    expect(m.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });
});

describe("check again", () => {
  it("only reads the chain, and settles what it learns", async () => {
    putFile(scope, CIRCLE, {
      path: "/a",
      size: 1,
      type: "text/plain",
      at: 1,
      tx: "h1",
      status: "pending",
    });
    m.confirm.mockResolvedValueOnce({ status: "pending" });
    await checkAgain(scope, CIRCLE);
    expect(circle().files[0].status).toBe("pending");
    expect(m.toast).not.toHaveBeenCalled();
    m.confirm.mockResolvedValueOnce({ status: "confirmed" });
    await checkAgain(scope, CIRCLE);
    expect(circle().files[0].status).toBe("confirmed");
    expect(m.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "activity.circleUploaded", values: { count: 1 } }),
    );
    expect(m.build).not.toHaveBeenCalled();
    expect(m.broadcast).not.toHaveBeenCalled();
    expect(m.deploy).not.toHaveBeenCalled();
  });
});

describe("a deploy", () => {
  const NEW = `oct${"N".repeat(44)}`;
  const input = { scope, walletId: "w1", sealed: true, ou: "1000" };
  const made = () => readLibrary(scope).find((c) => c.id === NEW);

  it("confirmed: joins the library and ends with Deployed", async () => {
    m.deploy.mockResolvedValue({ circleId: NEW, hash: "dh" });
    expect(await runDeploy(input)).toBe(NEW);
    expect(m.deploy).toHaveBeenCalledWith(input);
    expect(made()).toMatchObject({ sealed: true, deployTx: "dh", status: "confirmed" });
    expect(m.toast).toHaveBeenCalledWith({
      title: "activity.circleDeployed",
      view: { hash: "dh", network: "devnet" },
      scope,
    });
    expect(getCircleRun().deploy).toBeNull();
  });

  it("rejected: shows the reason and keeps the circle out of the library", async () => {
    m.deploy.mockResolvedValue({ circleId: NEW, hash: "dh" });
    m.confirm.mockResolvedValue({ status: "rejected", reason: "unknown browser mode: native" });
    expect(await runDeploy(input)).toBeNull();
    expect(made()).toBeUndefined();
    expect(getCircleRun().deploy).toMatchObject({
      status: "rejected",
      reason: "unknown browser mode: native",
    });
    expect(m.toast).not.toHaveBeenCalled();
  });

  it("rejected while hidden: the reason comes as a toast", async () => {
    m.deploy.mockResolvedValue({ circleId: NEW, hash: "dh" });
    m.confirm.mockImplementation(async () => {
      showDeploy(false);
      return { status: "rejected", reason: "no" };
    });
    await runDeploy(input);
    expect(getCircleRun().deploy).toBeNull();
    expect(m.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("not confirmed: the circle is kept as unconfirmed and says so", async () => {
    m.deploy.mockResolvedValue({ circleId: NEW, hash: "dh" });
    m.confirm.mockResolvedValue({ status: "pending" });
    expect(await runDeploy(input)).toBe(NEW);
    expect(made()).toMatchObject({ status: "pending" });
    expect(m.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "activity.circleDeployPending" }),
    );
    m.confirm.mockResolvedValue({ status: "rejected", reason: "late no" });
    await checkAgain(scope, NEW);
    expect(made()).toBeUndefined();
  });

  it("an unclear submit follows the deploy by its hash", async () => {
    const unclear = new UnclearSubmitError("local", new Error("timed out"));
    unclear.contractAddress = NEW;
    m.deploy.mockRejectedValue(unclear);
    expect(await runDeploy(input)).toBe(NEW);
    expect(m.confirm).toHaveBeenCalledWith("local", "devnet");
    expect(m.deploy).toHaveBeenCalledTimes(1);
  });

  it("refused: nothing is recorded", async () => {
    m.deploy.mockRejectedValue(new TxSubmitError("rejected", "fee too low"));
    expect(await runDeploy(input)).toBeNull();
    expect(readLibrary(scope)).toHaveLength(1);
    expect(getCircleRun().deploy).toMatchObject({ status: "failed", reason: "fee too low" });
  });
});
