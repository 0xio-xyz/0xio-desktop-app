import i18n from "src/i18n/core";
import { shortDate } from "src/lib/dates";
import { truncateAddress } from "src/lib/format";

const one = (n: number) => (n < 100 ? n.toFixed(1) : String(Math.round(n)));

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${one(bytes / 1024)} KB`;
  return `${one(bytes / 1048576)} MB`;
}

export function fileDay(ms: number, now = Date.now()): { today: boolean; text: string } {
  if (!ms) return { today: false, text: "" };
  const at = new Date(ms);
  if (at.toDateString() !== new Date(now).toDateString())
    return { today: false, text: shortDate(ms) };
  const lang = i18n.isInitialized ? i18n.language : "en";
  return {
    today: true,
    text: at.toLocaleTimeString(lang === "en" ? "en-GB" : lang, {
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

export const cutId = (id: string, wide = false) =>
  wide ? truncateAddress(id, 16, 14) : truncateAddress(id, 9, 8);

export const circleUrl = (id: string) => `oct://${id}/index.html`;
