import { bootVault } from "src/features/security/services/bootSession";
import { prefetchLockChecks } from "src/features/security/services/lockChecks";
import {
  afterFirstScreen,
  loadLockScreen,
  loadOnboarding,
  markStartup,
  shellReady,
} from "src/services/app/startup";

markStartup("script");

void bootVault().then(
  (initialized) => {
    markStartup("vault");
    if (initialized) {
      prefetchLockChecks();
      void loadLockScreen().catch(() => {});
    } else {
      void loadOnboarding().catch(() => {});
    }
  },
  () => {},
);

afterFirstScreen(() => void shellReady());
