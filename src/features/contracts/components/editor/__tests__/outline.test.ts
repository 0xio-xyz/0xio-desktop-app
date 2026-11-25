import { describe, expect, it } from "vitest";
import { parseOutline } from "src/features/contracts/components/editor/outline";
import { CONTRACT_TEMPLATES } from "src/features/contracts/components/editor/templates";

const source = (id: string) => CONTRACT_TEMPLATES.find((t) => t.id === id)!.source;

describe("parseOutline", () => {
  it("reads the token template", () => {
    const o = parseOutline(source("token"));
    expect(o.program).toBe("SimpleToken");
    expect(o.state.map((s) => `${s.name} ${s.detail}`)).toEqual([
      "name string",
      "symbol string",
      "total_supply u128",
      "owner address",
      "balances map[address]u128",
    ]);
    expect(o.events).toEqual([{ name: "Transfer", detail: "(from, to, amount)", line: 10 }]);
    expect(o.writes.map((f) => f.name)).toEqual(["transfer_token"]);
    expect(o.writes[0].detail).toBe("(to address, amount u128)");
    expect(o.views).toEqual([
      { name: "balance_of", detail: "(who address) u128", line: expect.any(Number) },
    ]);
  });

  it("points each entry at its own line", () => {
    const src = source("counter");
    const lines = src.split("\n");
    const o = parseOutline(src);
    for (const item of [...o.state, ...o.events, ...o.writes, ...o.views]) {
      expect(lines[item.line - 1]).toContain(item.name);
    }
  });

  it("ignores commented code and returns empty groups for non AML text", () => {
    const o = parseOutline("// fn ghost()\n; assembly only\n");
    expect(o).toEqual({ program: "", state: [], events: [], writes: [], views: [] });
  });
});
