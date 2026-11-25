import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import type { TFunction } from "src/i18n/core";
import type { DappAuthState, PendingApproval } from "src/features/dapp/hooks/useDappBridge";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import { deployReviewError } from "src/features/dapp/services/deployRequest";
import ConnectBody from "src/features/dapp/components/ConnectBody";
import {
  Fact,
  ReviewDialog,
  ReviewNote,
  SignerRow,
  middleCut,
} from "src/features/dapp/components/ReviewParts";
import { parseBaseUnits, rawOctLabel } from "src/features/dapp/services/siteAmounts";
import { scopeLabelKey } from "src/features/dapp/services/siteScopes";

function prettyParam(v: unknown): string {
  if (typeof v === "string" && v.startsWith("oct") && v.length > 20) return middleCut(v, 10, 8);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * What a method does, in the user's terms. Only methods whose meaning is unambiguous get a line;
 * the call data is the source of truth for everything else.
 */
const METHOD_INTENT: Record<string, string> = {
  approve: "dappReview.intentApprove",
  setApprovalForAll: "dappReview.intentApproveAll",
  revoke: "dappReview.intentRevoke",
  transfer: "dappReview.intentTransfer",
  transferFrom: "dappReview.intentTransfer",
};

const formatOu = (ou: string) => {
  const n = Number(ou);
  return `${n.toLocaleString()} OU (${Number((n / 1_000_000).toFixed(6))} OCT)`;
};

const formatRawOct = (raw: string) => {
  const units = parseBaseUnits(raw);
  return units == null ? raw : rawOctLabel(units);
};

/** Text a review signs, in full: it scrolls inside its card, never cut. */
function SignedText({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-2xl bg-surface-card px-4 py-3">
      <p className="text-micro font-semibold uppercase tracking-wider text-content-muted mb-1.5">
        {label}
      </p>
      <pre className="text-meta text-content font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
        {text}
      </pre>
    </div>
  );
}

function SequenceFacts({ approval, t }: { approval: PendingApproval; t: TFunction }) {
  const d = approval.details;
  return (
    <>
      {d?.steps?.map((s, i) => (
        <section key={i} aria-label={t("dappReview.step", { n: i + 1 })} className="space-y-1.5">
          <p className="text-meta text-content-secondary px-1">
            {t("dappReview.step", { n: i + 1 })}
          </p>
          <div className="rounded-2xl bg-surface-card px-4 py-1.5">
            <Fact label={t("dappReview.contract")}>
              <span className="font-mono" title={s.contract}>
                {prettyParam(s.contract)}
              </span>
            </Fact>
            <Fact label={t("dappReview.method")}>
              <span className="font-mono">{s.method}</span>
            </Fact>
            <Fact label={t("dappReview.amount")}>{s.amount}</Fact>
          </div>
          <SignedText label={t("dappReview.callData")} text={s.args} />
        </section>
      ))}
      {d?.ou && (
        <div className="rounded-2xl bg-surface-card px-4 py-1.5">
          <Fact label={t("dappReview.totalFee")}>{formatOu(d.ou)}</Fact>
        </div>
      )}
    </>
  );
}

function ClaimFacts({ approval, t }: { approval: PendingApproval; t: TFunction }) {
  const d = approval.details;
  const c = d?.claims;
  if (!c) return null;
  const ou = Number(d?.ou ?? 0);
  return (
    <>
      <div className="rounded-2xl bg-surface-card px-4 py-1.5">
        <Fact label={t("dappReview.claimAmount")}>{formatRawOct(c.totalRaw)}</Fact>
        <Fact label={t("dappReview.claimCount")}>{c.count.toLocaleString()}</Fact>
        {d?.ou && (
          <Fact label={t("dappReview.fee")}>
            {c.count > 1 ? t("dappReview.feeEach", { fee: formatOu(d.ou) }) : formatOu(d.ou)}
          </Fact>
        )}
        {d?.ou && c.count > 1 && (
          <Fact label={t("dappReview.totalFee")}>{formatOu(String(ou * c.count))}</Fact>
        )}
      </div>
      {c.outputs && c.outputs.length > 1 && (
        <div className="rounded-2xl bg-surface-card px-4 py-1.5">
          {c.outputs.map((o, i) => (
            <Fact key={o.id} label={t("dappReview.claimItem", { n: i + 1 })}>
              {formatRawOct(o.amountRaw)}
            </Fact>
          ))}
        </div>
      )}
      {c.remaining > 0 && (
        <ReviewNote>{t("dappReview.claimRemaining", { count: c.remaining })}</ReviewNote>
      )}
    </>
  );
}

function TransactionFacts({ approval, t }: { approval: PendingApproval; t: TFunction }) {
  const d = approval.details;
  if (d?.claims) return <ClaimFacts approval={approval} t={t} />;
  if (d?.steps) return <SequenceFacts approval={approval} t={t} />;
  const method = d?.method;
  const amount = d?.amount ?? "0 OCT";
  const movesValue = !/^0(\.0+)?(\s|$)/.test(amount) && /OCT/.test(amount);
  const intent = method && METHOD_INTENT[method] ? t(METHOD_INTENT[method]) : null;
  return (
    <>
      {d?.networkMismatch && <ReviewNote>{d.networkMismatch}</ReviewNote>}
      <div className="rounded-2xl bg-surface-card px-4 py-1.5">
        {d?.to && (
          <Fact label={d.contract ? t("dappReview.contract") : t("dappReview.to")}>
            <span className="font-mono" title={d.to}>
              {prettyParam(d.to)}
            </span>
          </Fact>
        )}
        {method && method !== "sign_only" && (
          <Fact label={t("dappReview.method")}>
            <span className="font-mono">{method}</span>
          </Fact>
        )}
        {!movesValue && amount && amount !== "0" && (
          <Fact label={t("dappReview.value")}>{amount}</Fact>
        )}
        {d?.ou && <Fact label={t("dappReview.fee")}>{formatOu(d.ou)}</Fact>}
      </div>
      {intent && <ReviewNote>{intent}</ReviewNote>}
      {d?.message && <SignedText label={t("dappReview.memo")} text={d.message} />}
      {d?.args != null && <SignedText label={t("dappReview.callData")} text={d.args} />}
    </>
  );
}

function transactionHeading(approval: PendingApproval, t: TFunction): string {
  const d = approval.details;
  const amount = d?.amount ?? "0 OCT";
  const movesValue = !/^0(\.0+)?(\s|$)/.test(amount) && /OCT/.test(amount);
  if (d?.method === "sign_only") return t("dappReview.signTxHeading");
  if (d?.method === "claim_private") return t("dappReview.claimHeading");
  if (d?.method === "register_view_key") return t("dappReview.registerHeading");
  if (movesValue) return amount;
  if (d?.steps) return t("dappReview.sequenceHeading");
  return d?.method ? t("dappReview.callHeading", { method: d.method }) : t("dappReview.txHeading");
}

export default function DappApprovalModal({
  approval,
  onApprove,
  onReject,
  auth,
}: {
  approval: PendingApproval | null;
  onApprove: (selectedAddress?: string) => void;
  onReject: () => void;
  auth?: DappAuthState;
}) {
  return (
    <>
      {approval && (
        <ApprovalReview
          key={`${approval.origin}:${approval.request.id}`}
          approval={approval}
          onApprove={onApprove}
          onReject={onReject}
        />
      )}
      {auth && (
        <TransactionAuthModal
          isOpen={auth.isOpen}
          onResult={auth.handleResult}
          title={auth.title}
        />
      )}
    </>
  );
}

function ApprovalReview({
  approval,
  onApprove,
  onReject,
}: {
  approval: PendingApproval;
  onApprove: (selectedAddress?: string) => void;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  const [pick, setPick] = useState<string | null>(approval.connect?.open.address ?? null);
  const reject = t("dappReview.reject");

  if (approval.type === "connect" && approval.connect) {
    return (
      <ReviewDialog
        open
        caps={t("dappReview.connectCaps")}
        origin={approval.origin}
        heading={t("dappReview.connectHeading")}
        reject={reject}
        action={t("dappReview.connect")}
        onReject={onReject}
        onAction={() => pick && onApprove(pick)}
        disabled={!pick}
      >
        <ConnectBody
          open={approval.connect.open}
          choices={approval.connect.choices}
          selected={pick}
          onPick={setPick}
        />
        {approval.connect.permissions.length > 0 && (
          <div className="rounded-2xl bg-surface-card px-4 py-1.5">
            <Fact label={t("dappReview.access")}>
              <span className="flex flex-col items-end gap-0.5">
                {approval.connect.permissions.map((s) => (
                  <span key={s}>{t(scopeLabelKey(s))}</span>
                ))}
              </span>
            </Fact>
          </div>
        )}
      </ReviewDialog>
    );
  }

  if (approval.type === "sign") {
    return (
      <ReviewDialog
        open
        caps={t("dappReview.signCaps")}
        origin={approval.origin}
        heading={t("dappReview.signHeading")}
        reject={reject}
        action={t("dappReview.sign")}
        onReject={onReject}
        onAction={() => onApprove()}
      >
        <div className="rounded-2xl bg-surface-card px-4 py-3">
          <p className="text-micro font-semibold uppercase tracking-wider text-content-muted mb-1.5">
            {t("dappReview.message")}
          </p>
          <pre className="text-meta text-content font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
            {approval.details?.message ?? ""}
          </pre>
        </div>
        {approval.signer && <SignerRow wallet={approval.signer} />}
      </ReviewDialog>
    );
  }

  if (approval.type === "deploy" && approval.deploy) {
    const d = approval.deploy;
    const invalid = deployReviewError(d);
    return (
      <ReviewDialog
        open
        caps={t("dappReview.deployCaps")}
        origin={approval.origin}
        heading={t("dappReview.deployHeading")}
        reject={reject}
        action={t("dappReview.deploy")}
        onReject={onReject}
        onAction={() => onApprove()}
        disabled={!!invalid}
        error={invalid ? t("dappReview.deployInvalid") : undefined}
      >
        <div className="rounded-2xl bg-surface-card px-4 py-1.5">
          <Fact label={t("dappReview.contractAddress")}>
            <span className="font-mono">{d.contractAddress}</span>
          </Fact>
          <Fact label={t("dappReview.codeSize")}>
            {t("dappReview.kib", { size: (d.codeBytes / 1024).toFixed(1) })}
          </Fact>
          <Fact label={t("dappReview.fee")}>{formatOu(d.ou)}</Fact>
        </div>
        <div className="rounded-2xl bg-surface-card px-4 py-3">
          <p className="text-micro font-semibold uppercase tracking-wider text-content-muted mb-1.5">
            {t("dappReview.constructorParams")}
          </p>
          {d.constructorParams ? (
            <pre className="text-meta text-content font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
              {d.constructorParams}
            </pre>
          ) : (
            <p className="text-meta text-content-secondary">{t("dappReview.none")}</p>
          )}
        </div>
        <ReviewNote>{t("dappReview.deployNote")}</ReviewNote>
        {approval.signer && <SignerRow wallet={approval.signer} />}
      </ReviewDialog>
    );
  }

  if (approval.type === "network") {
    return (
      <ReviewDialog
        open
        caps={t("dappReview.networkCaps")}
        origin={approval.origin}
        heading={t("dappReview.networkHeading", { to: approval.details?.toName ?? "" })}
        reject={reject}
        action={t("dappReview.switch")}
        onReject={onReject}
        onAction={() => onApprove()}
      >
        <div className="rounded-2xl bg-surface-card px-4 py-1.5">
          <Fact label={t("dappReview.from")}>{approval.details?.fromName ?? ""}</Fact>
          <Fact label={t("dappReview.to")}>{approval.details?.toName ?? ""}</Fact>
        </div>
        <ReviewNote>{t("dappReview.networkNote")}</ReviewNote>
      </ReviewDialog>
    );
  }

  const signOnly = approval.details?.method === "sign_only";
  return (
    <ReviewDialog
      open
      caps={t("dappReview.txCaps")}
      origin={approval.origin}
      heading={transactionHeading(approval, t)}
      reject={reject}
      action={
        signOnly
          ? t("dappReview.sign")
          : approval.details?.claims
            ? t("dappReview.claim")
            : t("dappReview.send")
      }
      onReject={onReject}
      onAction={() => onApprove()}
    >
      <TransactionFacts approval={approval} t={t} />
      {approval.signer && <SignerRow wallet={approval.signer} />}
    </ReviewDialog>
  );
}
