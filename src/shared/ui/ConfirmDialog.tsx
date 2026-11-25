import React from "react";
import { useTranslation } from "src/i18n/react";
import Modal from "src/shared/ui/Modal";
import Button from "src/shared/ui/Button";
import { feeText } from "src/services/transactions/feeText";

interface DetailRow {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}

interface ConfirmDialogProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  details: DetailRow[];
  confirmLabel?: string;
  loading?: boolean;
  /** The verb stays off until what it signs is known, e.g. a live fee. */
  confirmDisabled?: boolean;
  /** A line above the buttons. Pass "" to reserve it so a message never moves them. */
  error?: string;
}

export default React.memo(function ConfirmDialog({
  isOpen,
  onConfirm,
  onCancel,
  title,
  details,
  confirmLabel = "Confirm",
  loading,
  confirmDisabled,
  error,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={title} hideClose>
      <div className="space-y-3 mb-5">
        {details.map((d) => (
          <div key={d.label} className="flex justify-between items-start gap-4">
            <span className="text-sm text-content-secondary shrink-0">{d.label}</span>
            <span
              className={`text-sm text-content text-right break-all ${d.mono ? "font-mono" : ""}`}
            >
              {d.value}
            </span>
          </div>
        ))}
      </div>
      {error !== undefined && (
        <p role={error ? "alert" : undefined} className="min-h-5 mb-3 text-meta text-danger">
          {feeText(error)}
        </p>
      )}
      <div className="flex gap-3">
        <Button variant="secondary" fullWidth onClick={onCancel} disabled={loading}>
          {t("common.reject")}
        </Button>
        <Button
          variant="primary"
          fullWidth
          onClick={onConfirm}
          loading={loading}
          disabled={confirmDisabled}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
});
