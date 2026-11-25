import i18n from "src/i18n/core";
import en from "src/i18n/locales/en.json";

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "zh", label: "简体中文" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
] as const;

const locales = import.meta.glob<Record<string, string>>(
  ["./locales/*.json", "!./locales/en.json"],
  { import: "default" },
);

async function loadLanguage(lang: string): Promise<void> {
  if (i18n.hasResourceBundle(lang, "translation")) return;
  const load = locales[`./locales/${lang}.json`];
  if (load) i18n.addResourceBundle(lang, "translation", await load());
}

i18n.init({ resources: { en }, lng: "en", fallbackLng: "en" });

export async function switchLanguage(lang: string): Promise<void> {
  await loadLanguage(lang);
  await i18n.changeLanguage(lang);
}

/** Resolves once the saved language is ready, so the first render is already in it. */
export async function loadSavedLanguage(): Promise<void> {
  try {
    const saved = localStorage.getItem("app_language");
    if (saved && saved !== i18n.language) await switchLanguage(saved);
  } catch {}
}

export async function setLanguage(lang: string): Promise<void> {
  await switchLanguage(lang);
  localStorage.setItem("app_language", lang);
}

export default i18n;
