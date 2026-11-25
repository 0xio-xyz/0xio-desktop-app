import { useMemo, useState } from "react";
import { useQuery } from "src/lib/query";
import { useTranslation } from "src/i18n/react";
import { Btn, Caps, EASE, FOCUS, KV, PillSwitch } from "src/shared/ui/look";
import { useWallet } from "src/contexts/useWallet";
import * as contractService from "src/services/contracts/contractService";
import { loadWorkspace } from "src/features/contracts/components/editor/fileStore";
import {
  listWorkspace,
  readWorkspaceFile,
} from "src/features/contracts/components/editor/workspaceFs";
import { saveContractSource } from "src/features/contracts/sourceStore";

type From = "build" | "paste";

interface Props {
  address: string;
}

export default function VerifyTab({ address }: Props) {
  const { t } = useTranslation();
  const { networkId } = useWallet();
  const [from, setFrom] = useState<From>("build");
  const [pasted, setPasted] = useState("");
  const [file, setFile] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<{ verified: boolean; message?: string } | null>(null);

  const dir = localStorage.getItem("contract_workspace_dir");
  const local = useMemo(() => loadWorkspace().files, []);
  const disk = useQuery({
    queryKey: ["verifyWorkspace", dir],
    queryFn: async () => {
      const entries = await listWorkspace(dir!);
      return entries.filter((e) => !e.is_dir && /\.(aml|oasm)$/i.test(e.rel)).map((e) => e.rel);
    },
    enabled: !!dir,
  });
  const files = dir ? (disk.data ?? []) : Object.keys(local).sort();
  const chosen = file && files.includes(file) ? file : (files[0] ?? "");

  const diskSource = useQuery({
    queryKey: ["verifyWorkspaceFile", dir, chosen],
    queryFn: () => readWorkspaceFile(dir!, chosen),
    enabled: !!dir && !!chosen && from === "build",
  });
  const source = from === "paste" ? pasted : dir ? (diskSource.data ?? "") : (local[chosen] ?? "");
  const fileName = from === "paste" ? "pasted.aml" : chosen;

  const verify = async () => {
    if (!source.trim()) return;
    setVerifying(true);
    setResult(null);
    try {
      const res = await contractService.verifyContract(address, source);
      setResult(res);
      if (res.verified) {
        saveContractSource(networkId, address, {
          source,
          file: fileName,
          language: /\.oasm$/i.test(fileName) ? "assembly" : "aml",
          origin: "verified",
          verified: true,
        });
      }
    } catch (err) {
      setResult({
        verified: false,
        message: err instanceof Error ? err.message : t("contracts.verify.failed"),
      });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <div className="look-raise flex w-75 shrink-0 flex-col overflow-hidden rounded-[22px] bg-surface-card p-3">
        <PillSwitch<From>
          label={t("contracts.verify.from")}
          value={from}
          onChange={(v) => {
            setFrom(v);
            setResult(null);
          }}
          options={[
            { value: "build", label: t("contracts.verify.fromBuild") },
            { value: "paste", label: t("contracts.verify.paste") },
          ]}
        />
        {from === "build" && (
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto scrollbar-hide">
            {files.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => {
                  setFile(f);
                  setResult(null);
                }}
                aria-pressed={f === chosen}
                className={`flex h-10 w-full cursor-pointer items-center rounded-xl px-3 text-left font-mono text-[0.8125rem] text-content ${EASE} ${FOCUS} ${f === chosen ? "bg-(--bg-3)" : "hover:bg-surface-highlight"}`}
              >
                <span className="truncate">{f}</span>
              </button>
            ))}
            {files.length === 0 && (
              <p className="px-3 py-3 text-meta text-content-muted">
                {t("contracts.verify.noFiles")}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="look-raise flex min-w-0 flex-1 flex-col gap-4 overflow-hidden rounded-[22px] bg-surface-card px-6 py-5">
        <Caps
          right={<span className="font-mono normal-case">{from === "build" ? chosen : ""}</span>}
        >
          {t("contracts.compile.source")}
        </Caps>
        {from === "paste" ? (
          <textarea
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value);
              setResult(null);
            }}
            aria-label={t("contracts.compile.source")}
            spellCheck={false}
            className="min-h-40 flex-1 resize-none rounded-xl bg-surface-highlight px-3.5 py-3 font-mono text-meta text-content focus:outline-none"
          />
        ) : (
          <pre className="min-h-40 flex-1 overflow-auto rounded-xl bg-surface-highlight px-3.5 py-3 font-mono text-meta whitespace-pre text-content-secondary scrollbar-hide">
            {source}
          </pre>
        )}
        <div className="flex items-center gap-4">
          <Btn weight="primary" onClick={verify} disabled={verifying || !source.trim()}>
            {verifying ? t("contracts.verify.checking") : t("contracts.hub.verify")}
          </Btn>
        </div>
        <div className="min-h-16 max-w-160">
          {result && (
            <div className="rounded-2xl bg-surface-highlight px-5 py-3">
              <KV label={t("contracts.interact.status")}>
                <span className={result.verified ? "text-positive" : "text-danger"}>
                  {result.verified ? t("contracts.verify.matches") : t("contracts.verify.mismatch")}
                </span>
              </KV>
              {!result.verified && result.message && (
                <p className="pb-1 text-meta wrap-break-word text-danger">{result.message}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
