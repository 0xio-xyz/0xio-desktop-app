// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("src/i18n/react", () => ({
  useTranslation: () => ({
    t: (k: string, o?: { amount?: string }) => (o?.amount ? `${k}:${o.amount}` : k),
  }),
}));
vi.mock("src/hooks/wallet/useTokenPrice", () => ({
  useTokenPrice: () => ({ getUsdValue: () => "< $0.01" }),
}));

import FeePicker, { customFee, feeModeOf } from "src/shared/ui/FeePicker";
import ReviewPopup from "src/shared/ui/ReviewPopup";
import type { FeeQuote } from "src/hooks/transactions/useFees";

const FEES = { minimum: "1000", recommended: "10000", fast: "20000" };
const quote = (status: FeeQuote["status"]): FeeQuote => ({
  status,
  fee: status === "ok" ? FEES : null,
  last: null,
  retry: vi.fn(),
});

afterEach(cleanup);

describe("network fee choice", () => {
  it("names the live preset a fee matches, else Custom", () => {
    expect(feeModeOf("1000", FEES)).toBe("slow");
    expect(feeModeOf("10000", FEES)).toBe("normal");
    expect(feeModeOf("20000", FEES)).toBe("fast");
    expect(feeModeOf("15000", FEES)).toBe("custom");
  });

  it("names a fee Normal when Slow and Normal are the same amount", () => {
    expect(feeModeOf("10000", { minimum: "10000", recommended: "10000", fast: "20000" })).toBe(
      "normal",
    );
  });

  it("opens upward when there is no room under it", () => {
    render(<FeePicker quote={quote("ok")} ou="10000" onChange={vi.fn()} />);
    const button = screen.getByRole("button", { name: "sendFlow.networkFee" });
    const at = (top: number) =>
      vi
        .spyOn(button.parentElement!, "getBoundingClientRect")
        .mockReturnValue({ top, bottom: top + 30 } as DOMRect);
    at(window.innerHeight - 60);
    fireEvent.click(button);
    expect(screen.getByRole("listbox").className).toContain("bottom-[calc(100%+6px)]");
    fireEvent.click(button);
    at(40);
    fireEvent.click(button);
    expect(screen.getByRole("listbox").className).toContain("top-[calc(100%+6px)]");
  });

  it("refuses a Custom fee under the live minimum and takes one at or above it", () => {
    expect(customFee("0.0005", 1000)).toEqual({ ou: null, error: "min" });
    expect(customFee("0.001", 1000)).toEqual({ ou: 1000, error: null });
    expect(customFee("", 1000)).toEqual({ ou: null, error: null });
  });

  it("lists Slow, Normal and Fast with the chosen one filled, and picks one", () => {
    const onChange = vi.fn();
    render(<FeePicker quote={quote("ok")} ou="10000" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "sendFlow.networkFee" }));
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    fireEvent.click(options[2]);
    expect(onChange).toHaveBeenCalledWith("20000", "fast");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("hides only Fast when the quote has none", () => {
    const noFast: FeeQuote = {
      status: "ok",
      fee: { minimum: "1000", recommended: "10000" },
      last: null,
      retry: vi.fn(),
    };
    render(<FeePicker quote={noFast} ou="10000" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "sendFlow.networkFee" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByText("fee.fast")).toBeNull();
    expect(screen.getByText("fee.custom")).toBeTruthy();
    expect(feeModeOf("20000", noFast.fee)).toBe("custom");
  });

  it("says At least the minimum for a Custom fee under it and signs nothing new", () => {
    const onChange = vi.fn();
    render(<FeePicker quote={quote("ok")} ou="10000" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "sendFlow.networkFee" }));
    const input = screen.getByLabelText("fee.customOct");
    fireEvent.change(input, { target: { value: "0.0001" } });
    expect(screen.getByText("fee.atLeast:0.001")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "0.015" } });
    expect(onChange).toHaveBeenCalledWith("15000", "custom");
  });

  it("holds the same slot while the fee loads and offers Try again when it failed", () => {
    const { rerender } = render(<FeePicker quote={quote("loading")} ou="" onChange={() => {}} />);
    expect(screen.getByRole("status", { name: "fee.checking" })).toBeTruthy();
    const failed = quote("error");
    rerender(<FeePicker quote={failed} ou="" onChange={() => {}} />);
    expect(screen.getByText("fee.unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "fee.tryAgain" }));
    expect(failed.retry).toHaveBeenCalled();
  });
});

describe("review pop-up", () => {
  function popup(extra: Partial<React.ComponentProps<typeof ReviewPopup>> = {}) {
    const onReject = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ReviewPopup
        open
        label="Review send"
        caption="Send"
        verb="Send"
        onReject={onReject}
        onConfirm={onConfirm}
        {...extra}
      >
        <span>rows</span>
      </ReviewPopup>,
    );
    return { onReject, onConfirm };
  }

  it("opens over the window with the verb focused, so Enter confirms", () => {
    const { onConfirm } = popup();
    const dialog = screen.getByRole("dialog", { name: "Review send" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const verb = screen.getByRole("button", { name: "Send" });
    expect(document.activeElement).toBe(verb);
    fireEvent.click(verb);
    expect(onConfirm).toHaveBeenCalled();
  });

  it("Reject, Escape and the scrim each close it", () => {
    const { onReject } = popup();
    fireEvent.click(screen.getByRole("button", { name: "common.reject" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(document.querySelector("[aria-hidden='true']")!);
    expect(onReject).toHaveBeenCalledTimes(3);
  });

  it("stays while the fee is read again before signing", () => {
    const { onReject } = popup({ busy: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onReject).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders nothing while closed", () => {
    render(
      <ReviewPopup
        open={false}
        label="x"
        caption="x"
        verb="Send"
        onReject={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
