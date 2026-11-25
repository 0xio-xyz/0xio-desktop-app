import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "src/i18n/react";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { scopeLabelKey } from "src/features/dapp/services/siteScopes";
import { NETWORKS } from "src/services/network/config";
import { FeeValue, MessageSlot, feeLabel } from "./parts";
import type { TraySendProgress } from "./protocol";
import {
  ageMinutes,
  amountOf,
  browserName,
  groupBySite,
  hostOf,
  initialView,
  isDirect,
  kindOf,
  nextView,
  rowKey,
  titleKey,
  verbKey,
  type RelayReview,
  type SiteItem,
  type SiteView,
} from "./siteQueue";
import type { SiteQueueState } from "./useSiteQueue";

const middle = (a: string, head = 8, tail = 8) =>
  a.length > head + tail + 1 ? `${a.slice(0, head)}...${a.slice(-tail)}` : a;

const netName = (id: string) => NETWORKS[id]?.name ?? id;

const Back = () => (
  <svg width="7" height="11" viewBox="0 0 8 13" aria-hidden="true">
    <path
      d="M6.5 1.5L1.5 6.5l5 5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const Next = () => (
  <svg width="6" height="10" viewBox="0 0 8 13" aria-hidden="true">
    <path
      d="M1.5 1.5l5 5-5 5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function SiteMark({ origin }: { origin: string }) {
  return (
    <span className="tp-sitel" aria-hidden="true">
      {hostOf(origin)
        .replace(/^www\./, "")
        .charAt(0)}
    </span>
  );
}

function SiteHead({ item }: { item: SiteItem }) {
  return (
    <div className="tp-site">
      <SiteMark origin={item.origin} />
      <span className="tp-site-t">
        <b>{hostOf(item.origin)}</b>
        <small className="tp-mono">{item.origin}</small>
      </span>
    </div>
  );
}

/** Text a review signs, in full: it scrolls inside its box, never cut. */
function SignedText({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <span className="tp-label">{label}</span>
      <div className="tp-msgbox tp-mono">{text}</div>
    </div>
  );
}

function SequenceSteps({ steps }: { steps: NonNullable<RelayReview["steps"]> }) {
  const { t } = useTranslation();
  return (
    <div className="tp-steps">
      {steps.map((s, i) => (
        <section key={i} className="tp-step" aria-label={t("relay.step", { n: i + 1 })}>
          <span className="tp-label">{t("relay.step", { n: i + 1 })}</span>
          <div className="tp-recess tp-skvs">
            <div className="tp-skv">
              <span>{t("relay.contractAddress")}</span>
              <span className="tp-mono">{middle(s.contract)}</span>
            </div>
            <div className="tp-skv">
              <span>{t("relay.method")}</span>
              <span className="tp-mono">{s.method}</span>
            </div>
            <div className="tp-skv">
              <span>{t("relay.amount")}</span>
              <span>{s.amount}</span>
            </div>
          </div>
          <div className="tp-msgbox tp-mono">{s.args}</div>
        </section>
      ))}
    </div>
  );
}

function WalletValue({ wallet }: { wallet: { name: string; address: string } }) {
  return (
    <span className="tp-wv">
      <WalletAvatar address={wallet.address} size={18} />
      <span>
        <span>{wallet.name}</span>
        <small className="tp-mono">{middle(wallet.address)}</small>
      </span>
    </span>
  );
}

export function LockedSiteRow({ items }: { items: SiteItem[] }) {
  const { t } = useTranslation();
  const first = items[0];
  if (!first) return null;
  return (
    <div className="tp-lockrow">
      <SiteHead item={first} />
      <span className="tp-cap-t">{t(rowKey(first))}</span>
    </div>
  );
}

/** Every review has Reject and its verb; nothing is approved any other way. */
export default function SiteRequests({
  sites,
  progress,
}: {
  sites: SiteQueueState;
  progress: TraySendProgress | null;
}) {
  const { t } = useTranslation();
  const { items, focus, focusSite, outcome, dismissOutcome, answer, reject } = sites;
  const [view, setView] = useState<SiteView>(() => initialView(items, focus));
  const [error, setError] = useState("");
  const shown = nextView(view, items);

  if (outcome) {
    return (
      <div className="tp-pad">
        <div className="tp-cap">
          <span>{hostOf(outcome.origin)}</span>
        </div>
        <span className="tp-h">{t("relay.notDone")}</span>
        <MessageSlot text={outcome.message} />
        <button className="tp-btn" onClick={dismissOutcome}>
          {items.length ? t("relay.backToRequests") : t("relay.close")}
        </button>
      </div>
    );
  }

  const item = shown.kind === "review" ? items.find((i) => i.id === shown.id) : undefined;
  if (!item) {
    return (
      <RequestList
        items={items}
        focusSite={focusSite}
        onOpen={(id) => setView({ kind: "review", id })}
        onRejectAll={(ids) => void reject(ids)}
      />
    );
  }

  const toList = items.length > 1 ? () => setView({ kind: "list" }) : undefined;
  const live = progress?.requestId === item.id ? progress : null;
  if (item.stage === "approved") {
    return <Approving item={item} progress={live} onCancel={() => void reject([item.id])} />;
  }

  return (
    <Review
      item={item}
      count={items.length}
      error={error || item.review?.error || ""}
      onBack={toList}
      onReject={() => {
        setError("");
        void reject([item.id]);
      }}
      onVerb={() => {
        setError("");
        answer(item.id).catch(() => setError(t("relay.didNotGoThrough")));
      }}
    />
  );
}

function RequestList({
  items,
  focusSite,
  onOpen,
  onRejectAll,
}: {
  items: SiteItem[];
  focusSite?: string | null;
  onOpen: (id: string) => void;
  onRejectAll: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const nets = [...new Set(items.map((i) => i.network))];
  const groups = groupBySite(items);
  const focused = groups.find((g) => g.origin === focusSite);
  const intoView = useCallback((el: HTMLElement | null) => {
    el?.scrollIntoView?.({ block: "nearest" });
  }, []);
  return (
    <div className="tp-pad">
      <div className="tp-cap">
        <span>{t("relay.requestsCount", { count: items.length })}</span>
        {nets.length === 1 && <span>{netName(nets[0])}</span>}
      </div>
      <span className="tp-h">{t("relay.requests")}</span>
      <div className="tp-groups">
        {groups.map((g) => (
          <section
            key={`${g.browser}|${g.origin}`}
            ref={g === focused ? intoView : undefined}
            aria-label={hostOf(g.origin)}
          >
            <div className="tp-ghead">
              <SiteMark origin={g.origin} />
              <b>{hostOf(g.origin)}</b>
              <span className="tp-faint">
                {isDirect(g.browser) ? t("relay.direct") : browserName(g.browser)}
              </span>
              <button
                className="tp-link plain"
                onClick={() => onRejectAll(g.items.map((i) => i.id))}
              >
                {t("relay.rejectAll")}
              </button>
            </div>
            {g.items.map((i) => (
              <button key={i.id} className="tp-req" onClick={() => onOpen(i.id)}>
                <span>{t(rowKey(i))}</span>
                <span className="tp-faint tp-req-v">
                  <RowValue item={i} />
                  <Next />
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function RowValue({ item }: { item: SiteItem }) {
  const { t } = useTranslation();
  if (item.tabs > 1) return <>{t("relay.tabs", { count: item.tabs })}</>;
  const amount = amountOf(item.review);
  if (amount) return <>{`${amount.value} ${amount.unit}`}</>;
  const mins = ageMinutes(item.createdAt);
  return <>{mins === 0 ? t("relay.ageNow") : t("relay.ageMin", { count: mins })}</>;
}

function Review({
  item,
  count,
  error,
  onBack,
  onReject,
  onVerb,
}: {
  item: SiteItem;
  count: number;
  error: string;
  onBack?: () => void;
  onReject: () => void;
  onVerb: () => void;
}) {
  const { t } = useTranslation();
  const r = item.review;
  const kind = kindOf(item);
  const amount = amountOf(r);
  const ou = r?.deploy?.ou ?? r?.ou;
  const caption =
    kind === "connect" && count === 1 ? t("relay.connectionRequest") : t("relay.siteRequest");
  return (
    <div className="tp-pad">
      <div className="tp-cap">
        {onBack ? (
          <button className="tp-capback" onClick={onBack}>
            <Back />
            {t("relay.requests")}
          </button>
        ) : (
          <span>{caption}</span>
        )}
        <span>{netName(item.network)}</span>
      </div>
      <SiteHead item={item} />
      <span className="tp-h">{t(titleKey(item), { network: r?.toName ?? "" })}</span>
      {amount && (
        <span className="tp-amt">
          {amount.value} <small>{amount.unit}</small>
        </span>
      )}
      {kind === "sign" && r?.message && <div className="tp-msgbox tp-mono">{r.message}</div>}
      {kind !== "sign" && r?.message && <SignedText label={t("relay.memo")} text={r.message} />}
      {r?.args != null && <SignedText label={t("relay.args")} text={r.args} />}
      {r?.deploy?.constructorParams && (
        <SignedText label={t("relay.args")} text={r.deploy.constructorParams} />
      )}
      {r?.steps && <SequenceSteps steps={r.steps} />}
      {kind === "switch" && r && (
        <div className="tp-nets">
          <span className="tp-recess">
            <small>{t("relay.from")}</small>
            <b>{r.fromName}</b>
          </span>
          <Next />
          <span className="tp-recess">
            <small>{t("relay.to")}</small>
            <b>
              {r.toName}
              {r.toName && r.toName !== "Mainnet" && (
                <span className="tp-otag">{t("relay.testnet")}</span>
              )}
            </b>
          </span>
        </div>
      )}
      <div className="tp-recess tp-skvs">
        {item.framed && item.topOrigin && (
          <div className="tp-skv">
            <span>{t("relay.onPage")}</span>
            <span className="tp-mono">{item.topOrigin}</span>
          </div>
        )}
        {r?.to &&
          kind !== "connect" &&
          kind !== "sign" &&
          kind !== "switch" &&
          kind !== "register" && (
            <div className="tp-skv">
              <span>{t("relay.toAddress")}</span>
              <span className="tp-mono">{middle(r.to)}</span>
            </div>
          )}
        {r?.contract && r.method && (
          <div className="tp-skv">
            <span>{t("relay.method")}</span>
            <span className="tp-mono">{r.method}</span>
          </div>
        )}
        {r?.deploy && (
          <div className="tp-skv">
            <span>{t("relay.contractAddress")}</span>
            <span className="tp-mono">{middle(r.deploy.contractAddress)}</span>
          </div>
        )}
        {r?.claims && (
          <div className="tp-skv">
            <span>{t("relay.outputs")}</span>
            <span>{r.claims.count}</span>
          </div>
        )}
        {ou && (
          <div className="tp-skv">
            <span>{t("relay.fee")}</span>
            <FeeValue fee={{ state: "ok", ou: Number(ou) }} label={feeLabel} />
          </div>
        )}
        <div className="tp-skv">
          <span>{t("relay.wallet")}</span>
          {r?.wallet ? (
            <WalletValue wallet={r.wallet} />
          ) : (
            <span className="tp-skel" role="status" aria-label={t("relay.wallet")} />
          )}
        </div>
        {kind === "connect" && (
          <>
            <div className="tp-skv">
              <span>{t("relay.network")}</span>
              <span>{netName(item.network)}</span>
            </div>
            {!!r?.scopes?.length && (
              <div className="tp-skv">
                <span>{t("relay.access")}</span>
                <span className="tp-scopes">
                  {r.scopes.map((s) => (
                    <span key={s}>{t(scopeLabelKey(s))}</span>
                  ))}
                </span>
              </div>
            )}
          </>
        )}
        {isDirect(item.browser) ? (
          <div className="tp-skv">
            <span>{t("relay.connection")}</span>
            <span>{t("relay.direct")}</span>
          </div>
        ) : (
          <div className="tp-skv">
            <span>{t("relay.via")}</span>
            <span>{t("relay.viaExtension", { browser: browserName(item.browser) })}</span>
          </div>
        )}
      </div>
      <MessageSlot text={error || r?.networkMismatch || ""} />
      <div className="tp-two">
        <button className="tp-btn" onClick={onReject}>
          {t("relay.reject")}
        </button>
        <button className="tp-btn pri" disabled={!r || item.stage !== "review"} onClick={onVerb}>
          {t(verbKey(item))}
        </button>
      </div>
    </div>
  );
}

/** After the verb: Touch ID, the password when it is off or was cancelled, then the signing. */
function Approving({
  item,
  progress,
  onCancel,
}: {
  item: SiteItem;
  progress: TraySendProgress | null;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  if (progress?.stage === "needPassword")
    return <PasswordStep requestId={item.id} onCancel={onCancel} />;
  return (
    <div className="tp-pad">
      <div className="tp-cap">
        <span>{hostOf(item.origin)}</span>
        <span>{netName(item.network)}</span>
      </div>
      <div className="tp-center tp-grow">
        <span className="tp-h">
          {progress?.stage === "approving" ? t("relay.touchId") : t("relay.signing")}
        </span>
      </div>
      {progress?.stage === "approving" && (
        <button className="tp-btn" onClick={onCancel}>
          {t("relay.reject")}
        </button>
      )}
    </div>
  );
}

function PasswordStep({ requestId, onCancel }: { requestId: string; onCancel: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const approve = async () => {
    setError("");
    try {
      await invoke("tray_approve_send", { requestId, password });
      setPassword("");
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : "";
      setError(msg.includes("Too many") ? msg : t("relay.wrongPassword"));
    }
  };
  return (
    <div className="tp-pad">
      <div>
        <label className="tp-label" htmlFor="tp-site-pw">
          {t("relay.password")}
        </label>
        <div className={`tp-field pw${error ? " err" : ""}`}>
          <input
            id="tp-site-pw"
            type="password"
            value={password}
            autoFocus
            placeholder={t("relay.passwordPlaceholder")}
            aria-invalid={!!error}
            aria-describedby="tp-site-pw-err"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && password && void approve()}
          />
        </div>
        <div id="tp-site-pw-err" className="tp-err" role="alert">
          {error}
        </div>
      </div>
      <div className="tp-two">
        <button className="tp-btn" onClick={onCancel}>
          {t("relay.reject")}
        </button>
        <button className="tp-btn pri" disabled={!password} onClick={() => void approve()}>
          {t("relay.approve")}
        </button>
      </div>
    </div>
  );
}
