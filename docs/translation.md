# Translation

0xio Desktop ships in English, Bahasa Indonesia, Simplified Chinese, Japanese and Korean. Translation runs on 0xio's own small translator (`src/i18n/core.ts`, with `useTranslation` and `Trans` in `src/i18n/react.tsx`), set up in `src/i18n/index.ts`.

## Where the code lives

| Path | What it holds |
|------|---------------|
| `src/i18n/locales/<code>.json` | One flat JSON file per language: `en`, `id`, `zh`, `ja`, `ko` |
| `src/i18n/index.ts` | `LANGUAGES` (code and label shown in Settings), loading, `setLanguage`, `loadSavedLanguage` |
| `src/main.tsx`, `src/tray/main.tsx` | Load the saved language before the first render of the main window and the menu bar panel |

## How it works

- Keys are flat strings with dots, for example `"addressBook.addContact": "Add contact"`.
- English is bundled; the other languages load on demand when picked.
- A key missing from a language falls back to English.
- Values take `{{name}}` placeholders: `t('addressBook.imported', { count: 3 })`.
- Plurals use the suffixes `_one` and `_other` (plus `_zero` and the other forms a language needs), picked by `Intl.PluralRules`.
- The chosen language is stored as `app_language` in `localStorage`. The menu bar panel follows a change made in the main window.

## Add or change a string

1. Add the key to `src/i18n/locales/en.json`.
2. Add the same key to the other locale files. A key left out shows English in that language.
3. Use it in the component with `const { t } = useTranslation();` and `t('area.key')`.

## Add a language

1. Copy `src/i18n/locales/en.json` to `src/i18n/locales/<code>.json` and translate the values. Keep the keys and the `{{placeholders}}` unchanged.
2. Add `{ code, label }` to `LANGUAGES` in `src/i18n/index.ts`. The label is the language's own name. The file is picked up from `locales/` on its own.
3. Add the plural forms the language needs.
4. Run `npm test` and check the screens at the narrowest window (800 px) and in the menu bar panel: translated text may run longer than English.

## Writing rules

- Sentence case. No taglines or helper text; errors and changing status only.
- Keep product and token names as they are (0xio, Octra, OCT).
