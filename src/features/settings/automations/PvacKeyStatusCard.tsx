import { useState } from "react";
import { useQuery } from "src/lib/query";
import { useTranslation } from "src/i18n/react";
import { useWallet } from "src/contexts/useWallet";
import { Group, Row, TextAction, Value } from "src/features/settings/components/parts";
import { clearPendingKeySwitch } from "src/features/privacy/services/keySwitchService";
import { keyStatusQuery } from "src/features/privacy/services/keyUpdate";
import { timeAgo, truncateAddress } from "src/lib/format";

export default function PvacKeyStatusCard() {
  const { t } = useTranslation();
  const { activeWallet, networkId } = useWallet();
  const address = activeWallet?.address;
  const [copied, setCopied] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    ...keyStatusQuery({ id: activeWallet?.id ?? "", address: address ?? "" }, networkId),
    enabled: !!address,
  });

  const handleCopy = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const rotation = data?.rotation;
  const shown = rotation && rotation.kind !== "none" ? rotation : null;

  let label = t("auto.key.checking");
  let bad = false;
  if (!isLoading && data) {
    if (rotation?.kind === "pending") {
      label = t("auto.key.pending");
    } else if (rotation?.kind === "stuck") {
      label = t("auto.key.stuck");
      bad = true;
    } else if (data.matches) {
      label = t("auto.key.registered");
    } else if (data.registered) {
      label = t("auto.key.mismatch");
      bad = true;
    } else {
      label = t("auto.key.notRegistered");
    }
  }

  const migration = data?.migration;
  const migrationLabel = !migration
    ? null
    : migration.can_key_switch
      ? t("auto.key.rotationAllowed")
      : migration.cipher_class === "v3" || migration.cipher_class === "key_bound"
        ? t("auto.key.keyBoundBlocked")
        : t("auto.key.migrationRequired", { cls: migration.cipher_class ?? "?" });

  return (
    <Group caption={t("auto.key.title")}>
      <Row label={t("auto.key.registration")}>
        <Value>
          <span className={bad ? "text-danger" : "text-content"}>{label}</span>
        </Value>
      </Row>
      {migration && (
        <Row
          label={t("auto.key.migration")}
          sub={
            migration.can_key_switch
              ? undefined
              : `${migration.legacy_public_replay?.reason ?? migration.reason}${
                  migration.can_v3_migrate ? ` ${t("auto.key.networkMigration")}` : ""
                }`
          }
        >
          <Value>{migrationLabel}</Value>
        </Row>
      )}
      <Row label={t("auto.key.lastSwitch")}>
        <Value muted>{shown ? timeAgo(shown.submittedAt) : t("auto.never")}</Value>
      </Row>
      {shown && (
        <Row
          label={
            <span className={shown.kind === "stuck" ? "text-danger" : "text-content"}>
              {shown.kind === "stuck" ? t("auto.key.stuckNote") : t("auto.key.pendingNote")}
            </span>
          }
          sub={<span className="font-mono">{truncateAddress(shown.txHash, 12, 8)}</span>}
        >
          <TextAction onClick={() => handleCopy(shown.txHash)}>
            {copied ? t("common.copied") : t("auto.copy")}
          </TextAction>
          <TextAction
            onClick={() => {
              if (address) clearPendingKeySwitch(networkId, address);
              refetch();
            }}
          >
            {t("auto.key.clear")}
          </TextAction>
        </Row>
      )}
    </Group>
  );
}
