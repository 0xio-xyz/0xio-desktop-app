// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FeeValue, MessageSlot, StatusSlot } from "../parts";

afterEach(cleanup);

describe("reserved slots", () => {
  it("renders the message slot when there is nothing to say", () => {
    const { container } = render(<MessageSlot text="" />);
    const slot = container.querySelector(".tp-msg");
    expect(slot).not.toBeNull();
    expect(slot?.textContent).toBe("");
  });

  it("keeps the same slot for a message and offers the retry", () => {
    const onRetry = vi.fn();
    const { container } = render(
      <MessageSlot text="Network fee unavailable. Try again." onRetry={onRetry} />,
    );
    expect(container.querySelectorAll(".tp-msg")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps the status slot when the lines go away", () => {
    const { container, rerender } = render(
      <StatusSlot lines={["Checking your private balance"]} />,
    );
    expect(container.querySelector(".tp-status")?.textContent).toContain("Checking");
    rerender(<StatusSlot lines={[]} />);
    expect(container.querySelector(".tp-status")).not.toBeNull();
  });
});

describe("fee value", () => {
  it("shows a fixed placeholder while loading, never a number", () => {
    const { container } = render(<FeeValue fee={{ state: "loading" }} />);
    expect(container.querySelector(".tp-skel")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("says unavailable when the read failed", () => {
    render(<FeeValue fee={{ state: "error" }} />);
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });

  it("shows the live fee in OU", () => {
    render(<FeeValue fee={{ state: "ok", ou: 1_000_000 }} />);
    expect(screen.getByText(/1,000,000 OU/)).toBeTruthy();
  });
});
