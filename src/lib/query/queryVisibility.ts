import { focusManager } from "src/lib/query/core";
import { subscribeWindowShown } from "src/features/security/services/windowAway";

export function pauseQueriesWhileHidden(): void {
  focusManager.setEventListener((setFocused) => subscribeWindowShown(setFocused));
}
