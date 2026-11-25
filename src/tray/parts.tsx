import { formatOCT } from "src/lib/format";
import type { FeeRead } from "./protocol";
import { feeText } from "src/services/transactions/feeText";

export const feeLabel = (ou: number) =>
  `${ou.toLocaleString("en-US")} OU (about ${formatOCT(ou)} OCT)`;

export function FeeValue({
  fee,
  label = feeLabel,
}: {
  fee: FeeRead;
  label?: (ou: number) => string;
}) {
  if (fee.state === "ok") return <span>{label(fee.ou)}</span>;
  if (fee.state === "error") return <span className="tp-muted">Unavailable</span>;
  return <span className="tp-skel" role="status" aria-label="Checking the network fee" />;
}

/** The one line above the actions: always there, so a message never moves the buttons. */
export function MessageSlot({
  text,
  onRetry,
  label = "Retry",
}: {
  text: string;
  onRetry?: () => void;
  label?: string;
}) {
  return (
    <div className="tp-msg" role="alert">
      {text && <span>{feeText(text)}</span>}
      {text && onRetry && (
        <button className="tp-link" onClick={onRetry}>
          {label}
        </button>
      )}
    </div>
  );
}

export function StatusSlot({ lines }: { lines: string[] }) {
  return (
    <div className="tp-status" role="status" aria-live="polite">
      {lines.map((line) => (
        <span key={line} className="tp-muted">
          {line}
        </span>
      ))}
    </div>
  );
}
