import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { afterFirstScreen } from "src/services/app/startup";

type ThemeValue = "dim" | "light" | "octra";

interface ThemeContextType {
  theme: ThemeValue;
  setTheme: (t: ThemeValue) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: "dim",
  setTheme: () => {},
  toggleTheme: () => {},
});

const THEME_KEY = "0xio_theme";
const CYCLE: ThemeValue[] = ["dim", "light", "octra"];

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeValue>(() => {
    return (localStorage.getItem(THEME_KEY) as ThemeValue) || "dim";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
    afterFirstScreen(() => void invoke("window_theme", { theme }).catch(() => {}));
  }, [theme]);

  const setTheme = useCallback((t: ThemeValue) => setThemeState(t), []);
  const toggleTheme = useCallback(() => {
    setThemeState((prev) => CYCLE[(CYCLE.indexOf(prev) + 1) % CYCLE.length]);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
