import { describe, expect, it } from "vitest";
import {
  DEPLOY_MAX_OU,
  deployBaseOu,
  deployFee,
  deployReviewError,
  parseDeployRequest,
} from "src/features/dapp/services/deployRequest";

const CODE = btoa("contract bytes!!");

describe("deploy request", () => {
  it("needs strict base64 code within 512 KB", () => {
    expect(parseDeployRequest({}).ok).toBe(false);
    expect(parseDeployRequest({ bytecode: "not base64!" }).ok).toBe(false);
    const big = btoa("x".repeat(512 * 1024 + 3));
    expect(parseDeployRequest({ bytecode: big }).ok).toBe(false);
    const r = parseDeployRequest({ bytecode: CODE });
    expect(r.ok && r.request.codeBytes).toBe(16);
  });

  it("takes constructor params as JSON text or an array", () => {
    const a = parseDeployRequest({ bytecode: CODE, params: ["x", 1] });
    expect(a.ok && a.request.constructorParams).toBe('["x",1]');
    expect(parseDeployRequest({ bytecode: CODE, params: "{bad" }).ok).toBe(false);
    expect(parseDeployRequest({ bytecode: CODE, params: 5 }).ok).toBe(false);
    expect(parseDeployRequest({ bytecode: CODE, params: '"\u0001"' }).ok).toBe(false);
    expect(parseDeployRequest({ bytecode: CODE, params: '"\ud800"' }).ok).toBe(false);
    expect(parseDeployRequest([{ bytecode: CODE }]).ok).toBe(true);
  });

  it("lets a site set at most 10,000,000 OU", () => {
    const ok = parseDeployRequest({ bytecode: CODE, ou: "10000000" });
    expect(ok.ok && ok.request.ou).toBe(DEPLOY_MAX_OU);
    expect(DEPLOY_MAX_OU).toBe(10_000_000n);
    expect(parseDeployRequest({ bytecode: CODE, ou: "10000001" }).ok).toBe(false);
    expect(parseDeployRequest({ bytecode: CODE, ou: 0 }).ok).toBe(false);
    expect(parseDeployRequest({ bytecode: CODE, ou: "1.5" }).ok).toBe(false);
  });

  it("prices like webcli: the size base, or the node minimum at 1, 2 or 5 times it", () => {
    const payload = "A".repeat(2048 + 4);
    expect(deployBaseOu(payload.length)).toBe(203_000n);
    expect(deployFee(payload, "1000")).toBe(203_000n);
    expect(deployFee(payload, undefined)).toBe(203_000n);
    expect(deployFee(payload, "203000")).toBe(203_000n);
    expect(deployFee(payload, "406000")).toBe(406_000n);
    expect(deployFee(payload, 1_015_000)).toBe(1_015_000n);
    expect(deployFee(payload, "609000")).toBe(203_000n);
    expect(deployFee(payload, "900000")).toBe(203_000n);
    const huge = "A".repeat(2_100_000);
    expect(deployFee(huge, String(deployBaseOu(huge.length) * 5n))).toBe(deployBaseOu(huge.length));
  });

  it("refuses a review without a contract address or a valid fee", () => {
    const good = {
      codeBytes: 16,
      contractAddress: `oct${"A".repeat(44)}`,
      constructorParams: "",
      ou: "200000",
    };
    expect(deployReviewError(good)).toBeNull();
    expect(deployReviewError({ ...good, contractAddress: "" })).not.toBeNull();
    expect(deployReviewError({ ...good, ou: "10000001" })).not.toBeNull();
    expect(deployReviewError({ ...good, codeBytes: 0 })).not.toBeNull();
  });
});
