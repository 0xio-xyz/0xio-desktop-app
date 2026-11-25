import { invoke } from "@tauri-apps/api/core";

const VAULT_HINT_KEY = "0xio_boot_vault";

export const loadLockScreen = () => import("src/features/security/screens/LockScreen");
export const loadOnboarding = () => import("src/features/security/screens/OnboardingScreen");
export const loadHome = () => import("src/features/wallet/screens/HomeScreen");
export const loadSidebar = () => import("src/shared/layout/Sidebar");
export const loadCommandPalette = () => import("src/shared/layout/CommandPalette");
export const loadNoticeSources = () => import("src/shared/layout/NoticeSources");
export const loadPairingReview = () => import("src/features/dapp/components/PairingReview");
export const loadKeySwitchOverlay = () =>
  import("src/features/privacy/components/KeySwitchOverlay");
export const loadDappApproval = () => import("src/features/dapp/components/DappApprovalModal");

const marks = { script: 0, vault: 0 };
let shown = false;
let flushed = false;
const deferred: (() => void)[] = [];
let shell: Promise<void> | null = null;

export interface Shell {
  Sidebar: Awaited<ReturnType<typeof loadSidebar>>["default"];
}
let loaded: Shell | null = null;

/** Rendered directly so it never suspends at unlock and shifts the screen. */
export const shellLoaded = (): Shell | null => loaded;

export function markStartup(step: keyof typeof marks): void {
  marks[step] = performance.now();
}

/** Read by the skeleton in index.html, so the first frame already matches the screen to come. */
export function rememberVault(initialized: boolean): void {
  try {
    localStorage.setItem(VAULT_HINT_KEY, initialized ? "1" : "0");
  } catch {}
}

export function shellReady(): Promise<void> {
  shell ??= Promise.all([
    loadHome(),
    loadSidebar(),
    loadCommandPalette(),
    loadNoticeSources(),
    loadPairingReview(),
    loadKeySwitchOverlay(),
    loadDappApproval(),
  ])
    .then(([, sidebar]) => {
      loaded = { Sidebar: sidebar.default };
    })
    .catch(() => {});
  return shell;
}

function flush(): void {
  if (flushed) return;
  flushed = true;
  for (const task of deferred.splice(0)) task();
}

export function afterFirstScreen(task: () => void): void {
  if (flushed) setTimeout(task, 0);
  else deferred.push(task);
}

export function firstScreenShown(screen: string): void {
  if (shown) return;
  shown = true;
  document.getElementById("boot")?.remove();
  const ms = (t: number) => `${Math.round(t)} ms`;
  void invoke("frontend_log", {
    level: "info",
    message: `[boot] script ${ms(marks.script)}, vault ${ms(marks.vault)}, ${screen} ${ms(performance.now())}`,
  }).catch(() => {});
  requestAnimationFrame(() => setTimeout(flush, 0));
  setTimeout(flush, 500);
}
