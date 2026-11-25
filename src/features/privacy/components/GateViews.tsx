import { useTranslation } from "src/i18n/react";
import { Btn, KV, LayerDots } from "src/shared/ui/look";
import { NoticeCard } from "src/shared/ui/FormParts";
import type { GateKind } from "src/features/privacy/hooks/usePrivateGate";
import { unprovableLine } from "src/features/privacy/services/trayPrivate";

export interface GateContext {
  gate: GateKind;
  baseLayers: number;
  spendReason?: string;
  onReviewRefresh: () => void;
  onCheckSetup: () => void;
  onReviewKey: () => void;
}

const TITLE: Partial<Record<GateKind, string>> = {
  setupPending: "proofs.gate.confirmingTitle",
  foreign: "proofs.gate.foreignTitle",
  legacy: "proofs.gate.legacyTitle",
  upgrading: "proofs.gate.upgradingTitle",
  awaitMigration: "proofs.gate.awaitTitle",
  migrate: "proofs.gate.migrateTitle",
  refresh: "proofs.gate.refreshTitle",
  unprovable: "proofs.gate.unprovableTitle",
};

export function GateNotice({
  ctx,
  className,
  flat,
}: {
  ctx: GateContext;
  className?: string;
  flat?: boolean;
}) {
  const { t } = useTranslation();
  const title = TITLE[ctx.gate];
  if (!title) return null;
  return (
    <NoticeCard
      className={className}
      flat={flat}
      title={t(title)}
      text={ctx.gate === "unprovable" ? unprovableLine(ctx.spendReason) : undefined}
    >
      {(ctx.gate === "migrate" || ctx.gate === "refresh") && (
        <KV label={t("proofs.layers")}>
          <LayerDots n={ctx.baseLayers} />
        </KV>
      )}
    </NoticeCard>
  );
}

export function hasGateButton(gate: GateKind): boolean {
  return gate !== "ok" && gate !== "setup" && gate !== "hold";
}

export function hasGateNotice(gate: GateKind): boolean {
  return gate !== "ok" && gate !== "checking" && gate !== "setup" && gate !== "hold";
}

export function GateButton({ ctx }: { ctx: GateContext }) {
  const { t } = useTranslation();
  const off = (label: string) => (
    <Btn weight="primary" className="w-full" disabled>
      {label}
    </Btn>
  );
  switch (ctx.gate) {
    case "checking":
      return off(t("proofs.gate.checking"));
    case "setupPending":
      return (
        <Btn className="w-full" onClick={ctx.onCheckSetup}>
          {t("proofs.checkAgain")}
        </Btn>
      );
    case "foreign":
      return (
        <Btn weight="primary" className="w-full" onClick={ctx.onReviewKey}>
          {t("proofs.gate.reviewKey")}
        </Btn>
      );
    case "legacy":
      return off(t("proofs.gate.legacyAction"));
    case "upgrading":
      return off(t("proofs.gate.upgradingAction"));
    case "awaitMigration":
      return off(t("proofs.gate.awaitAction"));
    case "migrate":
      return (
        <Btn weight="primary" className="w-full" onClick={ctx.onReviewRefresh}>
          {t("proofs.gate.reviewMigrate")}
        </Btn>
      );
    case "refresh":
      return (
        <Btn weight="primary" className="w-full" onClick={ctx.onReviewRefresh}>
          {t("proofs.gate.reviewRefresh")}
        </Btn>
      );
    case "unprovable":
      return off(t("proofs.gate.unprovableAction"));
    default:
      return null;
  }
}
