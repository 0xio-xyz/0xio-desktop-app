import { describe, expect, it } from "vitest";
import { monthDayYear, toMs } from "src/lib/dates";

describe("dates", () => {
  it("formats a medium date like date-fns MMM d, yyyy", () => {
    expect(monthDayYear(new Date(2026, 10, 5))).toBe("Nov 5, 2026");
    expect(monthDayYear(new Date(2027, 0, 31))).toBe("Jan 31, 2027");
    expect(monthDayYear(new Date(2026, 8, 1))).toBe("Sep 1, 2026");
  });

  it("reads chain seconds and local milliseconds", () => {
    expect(toMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});
