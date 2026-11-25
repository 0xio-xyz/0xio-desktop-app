import { describe, expect, it } from "vitest";
import { frameSignedMessage } from "../signedMessage";

describe("frameSignedMessage", () => {
  it("prefixes the tag and the UTF-8 byte length", () => {
    expect(frameSignedMessage("hello")).toBe("Octra Signed Message:\n5\nhello");
  });

  it("counts bytes, not characters", () => {
    const msg = "héllo ✓";
    expect(frameSignedMessage(msg)).toBe(`Octra Signed Message:\n10\n${msg}`);
  });

  it("never starts with '{', so it can never be a transaction pre-image", () => {
    expect(frameSignedMessage('{"from":"oct1"}').startsWith("{")).toBe(false);
  });
});
