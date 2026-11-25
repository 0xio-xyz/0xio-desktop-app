import { describe, expect, it } from "vitest";
import { buildPaymentRequest, requestAmount } from "src/features/wallet/services/paymentRequest";

const ADDR = `oct${"A".repeat(44)}`;

describe("payment request", () => {
  it("is the bare address with no amount", () => {
    expect(buildPaymentRequest(ADDR, "")).toBe(ADDR);
    expect(buildPaymentRequest(ADDR, "0")).toBe(ADDR);
    expect(buildPaymentRequest(ADDR, "0.000")).toBe(ADDR);
  });

  it("carries a plain decimal amount in the app's format", () => {
    expect(buildPaymentRequest(ADDR, "25")).toBe(`octra:${ADDR}?amount=25`);
    expect(buildPaymentRequest(ADDR, "007.50")).toBe(`octra:${ADDR}?amount=7.5`);
    expect(buildPaymentRequest(ADDR, "12.")).toBe(`octra:${ADDR}?amount=12`);
    expect(buildPaymentRequest(ADDR, "0.000001")).toBe(`octra:${ADDR}?amount=0.000001`);
  });

  it("refuses what OCT cannot hold", () => {
    expect(requestAmount("1.0000001")).toBe("");
    expect(requestAmount("1000000000")).toBe("");
    expect(requestAmount("999999999.999999")).toBe("999999999.999999");
    expect(requestAmount("-1")).toBe("");
    expect(requestAmount("1e3")).toBe("");
  });
});
