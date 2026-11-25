import { describe, it, expect } from "vitest";
import { isLivingProgramUri } from "src/features/nft/services/euint/protocol";

const CIRCLE = "octGetzo7EZL5YTTea2PGf4HYR1vVGxcVEvdMkFfbLovZpa";

describe("isLivingProgramUri", () => {
  it("rejects empty and non-oct URIs", () => {
    expect(isLivingProgramUri(null)).toBe(false);
    expect(isLivingProgramUri(undefined)).toBe(false);
    expect(isLivingProgramUri("")).toBe(false);
    expect(isLivingProgramUri("ipfs://QmAbc/index.html")).toBe(false);
    expect(isLivingProgramUri("https://example.com/index.html")).toBe(false);
    expect(isLivingProgramUri("data:image/svg+xml;base64,AAA")).toBe(false);
  });

  it("accepts explicit html paths", () => {
    expect(isLivingProgramUri(`oct://${CIRCLE}/index.html`)).toBe(true);
    expect(isLivingProgramUri(`oct://${CIRCLE}/art.htm`)).toBe(true);
    expect(isLivingProgramUri(`oct://${CIRCLE}/index.html?seed=abc&i=10`)).toBe(true);
    expect(isLivingProgramUri(`OCT://${CIRCLE}/INDEX.HTML`)).toBe(true);
  });

  it("accepts an oct URI with no path, which resolves to /index.html", () => {
    expect(isLivingProgramUri(`oct://${CIRCLE}`)).toBe(true);
    expect(isLivingProgramUri(`oct://${CIRCLE}/`)).toBe(true);
    expect(isLivingProgramUri(`oct://${CIRCLE}?seed=abc`)).toBe(true);
    expect(isLivingProgramUri(`oct://${CIRCLE}/?seed=abc`)).toBe(true);
    expect(isLivingProgramUri(`oct://${CIRCLE}#frag`)).toBe(true);
  });

  it("does not treat a static circle asset as a living program", () => {
    expect(isLivingProgramUri(`oct://${CIRCLE}/art.png`)).toBe(false);
    expect(isLivingProgramUri(`oct://${CIRCLE}/img/cover.jpg`)).toBe(false);
    expect(isLivingProgramUri(`oct://${CIRCLE}/meta.json`)).toBe(false);
    expect(isLivingProgramUri(`oct://${CIRCLE}/vector.svg`)).toBe(false);
    expect(isLivingProgramUri(`oct://${CIRCLE}/token/4.json`)).toBe(false);
  });

  it("rejects a bare scheme with no circle id", () => {
    expect(isLivingProgramUri("oct://")).toBe(false);
    expect(isLivingProgramUri("oct://?x=1")).toBe(false);
  });
});
