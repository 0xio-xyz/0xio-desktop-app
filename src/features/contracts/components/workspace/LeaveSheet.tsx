import { useTranslation } from "src/i18n/react";
import { PopupShell } from "src/shared/ui/ReviewPopup";
import { Btn } from "src/shared/ui/look";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";
import type { LeaveChoice } from "src/features/contracts/components/editor/buffers";
import type { LeaveTarget } from "src/features/contracts/hooks/useWorkspaceGuards";

interface Props {
  open: boolean;
  target: LeaveTarget;
  files: string[];
  busy: boolean;
  onChoose: (choice: LeaveChoice) => void;
}

const TITLE: Record<LeaveTarget, string> = {
  page: "contracts.ws.leaveTitle",
  project: "contracts.ws.leaveProject",
  close: "contracts.ws.leaveClose",
};

export default function LeaveSheet({ open, target, files, busy, onChoose }: Props) {
  const { t } = useTranslation();
  useEscapeKey(open && !busy, () => onChoose("cancel"));
  return (
    <PopupShell
      open={open}
      label={t(TITLE[target])}
      onScrim={busy ? undefined : () => onChoose("cancel")}
    >
      <h2 className="text-[17px] font-semibold text-content" data-t="leave">
        {t(TITLE[target])}
      </h2>
      <div className="mt-4 flex max-h-60 flex-col gap-0.5 overflow-y-auto rounded-[14px] bg-surface-highlight p-1.5 scrollbar-hide">
        {files.map((f) => (
          <div
            key={f}
            className="flex h-8.5 shrink-0 items-center gap-2.5 px-3 font-mono text-[13px] text-content"
          >
            <span aria-hidden="true" className="size-1.75 shrink-0 rounded-full bg-content" />
            <span className="min-w-0 truncate">{f}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Btn onClick={() => onChoose("discard")} disabled={busy} data-t="dontsave">
          {t("contracts.ws.dontSave")}
        </Btn>
        <span className="flex-1" />
        <Btn weight="text" onClick={() => onChoose("cancel")} disabled={busy}>
          {t("common.cancel")}
        </Btn>
        <Btn
          weight="primary"
          data-autofocus
          onClick={() => onChoose("save")}
          disabled={busy}
          className="look-key"
          data-t="saveall"
        >
          {t("contracts.ws.saveAll")}
        </Btn>
      </div>
    </PopupShell>
  );
}
