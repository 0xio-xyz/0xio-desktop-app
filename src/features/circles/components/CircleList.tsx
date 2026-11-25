import { useTranslation } from "src/i18n/react";
import OutlineTag from "src/shared/ui/OutlineTag";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { ScrollArea } from "src/shared/ui/flat";
import { Caps, EASE, FOCUS, Skel } from "src/shared/ui/look";
import { isTestnetId } from "src/features/transactions/history/sides";
import { circleTitle, type CircleRecord } from "src/features/circles/services/circleLibrary";
import { cutId, fileDay } from "src/features/circles/services/circleFormat";

export const NEW_CIRCLE = "new";

const ROW = `grid w-full cursor-pointer items-center gap-3.5 rounded-[14px] px-3.5 text-left ${EASE} ${FOCUS}`;
const fill = (on: boolean) => (on ? "bg-surface-highlight" : "hover:bg-(--hover)");

export default function CircleList({
  circles,
  picked,
  onPick,
  wallet,
  networkId,
  loading,
}: {
  circles: CircleRecord[];
  picked: string;
  onPick: (id: string) => void;
  wallet: { name: string; address: string } | null;
  networkId: string;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("circles.myCircles")} className="flex min-h-0 min-w-0 flex-col">
      <Caps
        className="px-3.5 pb-2.5"
        right={
          wallet && (
            <>
              <WalletAvatar address={wallet.address} size={18} />
              <span className="min-w-0 truncate font-medium">{wallet.name}</span>
              {isTestnetId(networkId) && <OutlineTag label={t("history.testnet")} />}
            </>
          )
        }
      >
        {t("circles.myCircles")}
      </Caps>
      <ScrollArea fade>
        <div className="flex flex-col gap-0.5 pb-5">
          <button
            type="button"
            aria-current={picked === NEW_CIRCLE ? "true" : undefined}
            onClick={() => onPick(NEW_CIRCLE)}
            className={`${ROW} min-h-11.5 text-[0.90625rem] text-content ${picked === NEW_CIRCLE ? "font-semibold" : "font-medium"} ${fill(picked === NEW_CIRCLE)}`}
          >
            {t("circles.newCircle")}
          </button>
          {loading &&
            ["w-28", "w-24", "w-20"].map((w) => (
              <div
                key={w}
                aria-hidden="true"
                className="grid min-h-14.5 grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 px-3.5"
              >
                <span className="flex flex-col gap-2.25">
                  <Skel w={w} />
                  <Skel w="w-37" />
                </span>
                <Skel w="w-10" />
              </div>
            ))}
          {circles.map((c) => {
            const on = c.id === picked;
            const title = circleTitle(c);
            const day = fileDay(Math.max(c.createdAt, ...c.files.map((f) => f.at)));
            return (
              <button
                key={c.id}
                type="button"
                aria-current={on ? "true" : undefined}
                aria-label={title || c.id}
                onClick={() => onPick(c.id)}
                className={`${ROW} min-h-14.5 grid-cols-[minmax(0,1fr)_auto] py-2.25 ${fill(on)}`}
              >
                <span className="min-w-0">
                  <span
                    className={`flex items-center gap-2 text-[0.90625rem] text-content ${on ? "font-semibold" : "font-medium"}`}
                  >
                    <span className={`truncate ${title ? "" : "font-mono font-medium"}`}>
                      {title || cutId(c.id)}
                    </span>
                    {c.sealed && <OutlineTag label={t("circlesPage.encrypted")} />}
                  </span>
                  <span
                    className={`mt-0.75 block truncate text-meta text-content-muted ${title && c.status === "confirmed" ? "font-mono" : ""}`}
                  >
                    {c.status === "pending"
                      ? t("circles.state.pending")
                      : title
                        ? cutId(c.id)
                        : t("circles.noIndex")}
                  </span>
                </span>
                <span className="text-right text-body font-medium whitespace-nowrap text-content tabular-nums">
                  {t("circles.files", { count: c.files.length })}
                  <span className="mt-0.75 block min-h-4.5 text-meta font-normal text-content-muted">
                    {day.today ? t("history.today") : day.text}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </nav>
  );
}
