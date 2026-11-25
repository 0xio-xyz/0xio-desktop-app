import { describe, expect, it } from "vitest";
import { cn } from "src/lib/cn";

describe("cn", () => {
  it("joins truthy values and nested arrays", () => {
    expect(cn("a", false, null, undefined, 0, ["b", ["c"]], "")).toBe("a b c");
  });

  it("drops repeated classes", () => {
    expect(cn("flex flex", "flex")).toBe("flex");
  });

  it("lets a later width and padding win (popover content)", () => {
    expect(cn("z-50 w-72 rounded-[14px] p-4", "w-auto p-0")).toBe("z-50 rounded-[14px] w-auto p-0");
  });

  it("p clears every side, px clears left and right only", () => {
    expect(cn("px-3 pt-2 pl-1", "p-0")).toBe("p-0");
    expect(cn("pl-1 pt-2", "px-4")).toBe("pt-2 px-4");
    expect(cn("px-4", "pl-1")).toBe("px-4 pl-1");
  });

  it("keeps text size, alignment and colour apart", () => {
    expect(cn("text-[0.8125rem] text-content", "text-content-muted")).toBe(
      "text-[0.8125rem] text-content-muted",
    );
    expect(cn("text-body text-left text-content", "text-meta")).toBe(
      "text-left text-content text-meta",
    );
    expect(cn("text-xs", "text-center")).toBe("text-xs text-center");
  });

  it("resolves background colour per variant (switch checked colour)", () => {
    expect(
      cn("data-[state=checked]:bg-positive bg-surface", "data-[state=checked]:bg-accent"),
    ).toBe("bg-surface data-[state=checked]:bg-accent");
    expect(cn("hover:bg-surface-highlight", "bg-accent")).toBe(
      "hover:bg-surface-highlight bg-accent",
    );
    expect(cn("bg-cover bg-accent", "bg-(--bg-3)")).toBe("bg-cover bg-(--bg-3)");
  });

  it("keeps arbitrary variants with colons intact", () => {
    expect(cn("[&_.x:hover]:bg-a", "[&_.x:hover]:bg-b", "[&_.y]:bg-c")).toBe(
      "[&_.x:hover]:bg-b [&_.y]:bg-c",
    );
  });

  it("treats important utilities as their own layer", () => {
    expect(cn("!w-4 w-2", "w-3")).toBe("!w-4 w-3");
  });

  it("size clears width and height", () => {
    expect(cn("w-4 h-4", "size-5")).toBe("size-5");
  });
});
