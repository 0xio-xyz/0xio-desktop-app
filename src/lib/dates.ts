import i18n from "src/i18n/core";

/** A chain or local timestamp in milliseconds; the chain sends seconds. */
export function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

export function shortDate(ms: number): string {
  const lang = i18n.isInitialized ? i18n.language : "en";
  return new Date(ms).toLocaleDateString(lang === "en" ? "en-GB" : lang, {
    day: "numeric",
    month: "short",
  });
}

export function fullDate(ms: number): string {
  const lang = i18n.isInitialized ? i18n.language : "en";
  return new Date(ms).toLocaleDateString(lang === "en" ? "en-GB" : lang, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function monthDayYear(d: Date): string {
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}`;
}
