// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  APPEARANCE_KEY,
  loadAppearance,
  saveAppearance,
} from "src/features/settings/services/appearance";

const save = (accentHex: string | null) =>
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ accentHex }));

describe("retired accent presets", () => {
  beforeEach(() => localStorage.clear());

  it("drops a saved orange or purple preset back to the theme accent", () => {
    save("#e07b00");
    expect(loadAppearance().accentHex).toBeNull();
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!).accentHex).toBeNull();
    localStorage.clear();
    save("#A78BFA");
    expect(loadAppearance().accentHex).toBeNull();
  });

  it("keeps every other accent", () => {
    save("#7aa2ff");
    expect(loadAppearance().accentHex).toBe("#7aa2ff");
  });

  it("falls back only once, so the colour can be chosen again as custom", () => {
    save("#e07b00");
    loadAppearance();
    saveAppearance({ ...loadAppearance(), accentHex: "#e07b00" });
    expect(loadAppearance().accentHex).toBe("#e07b00");
  });
});
