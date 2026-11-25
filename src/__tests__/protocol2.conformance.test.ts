/** Runs only with scripts/conformance.sh (the Rust test server) and 0xio-sdk checked out beside this repo. */
import { readFileSync } from "node:fs";
import { afterAll, describe, it, vi } from "vitest";
import { Control, createDesktopAdapter, DESKTOP_FEATURES } from "./conformance/desktopAdapter";

const file = process.env.DESKTOP_CONFORMANCE_FILE;

if (!file) {
  describe.skip("wallet protocol 2: 0xio Desktop (no test server)", () => {
    it("needs scripts/conformance.sh", () => {});
  });
} else {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  const suitePath = new URL("../../../0xio-sdk/conformance/suite.ts", import.meta.url).pathname;
  const { defineConformanceSuite } = await import(/* @vite-ignore */ suitePath);
  const { control: port } = JSON.parse(readFileSync(file, "utf8"));
  const control = await Control.open(port);
  afterAll(() => control.close());
  defineConformanceSuite({
    name: "0xio Desktop (direct)",
    features: DESKTOP_FEATURES,
    create: () => createDesktopAdapter(control),
  });
}
