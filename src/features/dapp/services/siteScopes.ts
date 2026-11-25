/**
 * What a site may do once connected, and how a review names it. A connect grants exactly
 * `grantedScopes(params)`, and every review lists that same list, so nothing is granted unseen.
 */

const PUBLIC_SCOPES = ["accounts", "public_transactions", "contract_calls", "contract_views"];
const PRIVATE_SCOPES = [
  "private_transfers",
  "private_balance_read",
  "private_proofs",
  "private_claims",
];
const ALL_SCOPES = [...PUBLIC_SCOPES, ...PRIVATE_SCOPES];

/** The scopes a connect grants: the known ones the site asked for, else the public ones. */
export function grantedScopes(params: unknown): string[] {
  const p = (params ?? {}) as { requestPermissions?: unknown; permissions?: unknown };
  const asked = p.requestPermissions ?? p.permissions;
  const requested: unknown[] = Array.isArray(asked) ? asked : [];
  if (!requested.length) return PUBLIC_SCOPES;
  return [
    ...new Set(
      requested.filter((s): s is string => typeof s === "string" && ALL_SCOPES.includes(s)),
    ),
  ];
}

const LABEL: Record<string, string> = {
  accounts: "siteScope.accounts",
  public_transactions: "siteScope.publicTransactions",
  contract_calls: "siteScope.contractCalls",
  contract_views: "siteScope.contractViews",
  private_transfers: "siteScope.privateTransfers",
  private_balance_read: "siteScope.privateBalance",
  private_proofs: "siteScope.privateProofs",
  private_claims: "siteScope.privateClaims",
};

export const scopeLabelKey = (scope: string): string => LABEL[scope] ?? scope;
