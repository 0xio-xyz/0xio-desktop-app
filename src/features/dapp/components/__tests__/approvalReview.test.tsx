// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("src/features/wallet/components/TransactionAuthModal", () => ({ default: () => null }));

// jsdom's TextEncoder hands tweetnacl a Uint8Array from another realm; the picture is not under test.
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));

import "src/i18n";
import DappApprovalModal from "src/features/dapp/components/DappApprovalModal";
import type { PendingApproval } from "src/features/dapp/hooks/useDappBridge";

const MAIN = { id: "w1", name: "Main", address: `oct${"A".repeat(44)}`, wallet_type: "mnemonic" };
const SPEND = {
  id: "w2",
  name: "Spending",
  address: `oct${"B".repeat(44)}`,
  wallet_type: "private_key",
};
const COLD = { id: "w3", name: "Cold", address: `oct${"C".repeat(44)}`, wallet_type: "watch" };
const base = {
  origin: "https://dapp.example",
  request: { id: "1", method: "x", params: {}, timestamp: 0 },
  networkId: "mainnet",
};

afterEach(cleanup);

describe("site reviews", () => {
  it("connect with a watch-only open wallet says so and offers wallets that can sign", () => {
    const onApprove = vi.fn();
    render(
      <DappApprovalModal
        approval={{
          ...base,
          type: "connect",
          connect: { open: COLD, choices: [MAIN, SPEND], permissions: [] },
        }}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("The open wallet is watch-only.")).toBeTruthy();
    fireEvent.click(screen.getByText("Spending"));
    fireEvent.click(screen.getByText("Connect"));
    expect(onApprove).toHaveBeenCalledWith(SPEND.address);
  });

  it("uses Reject beside the verb, and an outside click or Escape rejects", () => {
    const onReject = vi.fn();
    const approval: PendingApproval = {
      ...base,
      type: "sign",
      signer: MAIN,
      details: { to: MAIN.address, amount: "0", message: "hello" },
    };
    render(<DappApprovalModal approval={approval} onApprove={vi.fn()} onReject={onReject} />);
    expect(screen.getByText("Reject")).toBeTruthy();
    expect(screen.getByText("Sign")).toBeTruthy();
    expect(screen.queryByText("Deny")).toBeNull();
    expect(screen.getByText("Signing with")).toBeTruthy();
    expect(screen.getByText("Main")).toBeTruthy();
    fireEvent.click(screen.getByTestId("review-backdrop"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onReject).toHaveBeenCalledTimes(2);
  });

  it("a send names the amount and the wallet that signs", () => {
    render(
      <DappApprovalModal
        approval={{
          ...base,
          type: "transaction",
          signer: SPEND,
          details: { to: MAIN.address, amount: "1.5 OCT" },
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("1.5 OCT")).toBeTruthy();
    expect(screen.getByText("Send")).toBeTruthy();
    expect(screen.getByText("Spending")).toBeTruthy();
  });

  it("a deploy shows the contract address, params and fee, and Deploy", () => {
    const onApprove = vi.fn();
    render(
      <DappApprovalModal
        approval={{
          ...base,
          type: "deploy",
          signer: MAIN,
          deploy: {
            codeBytes: 2048,
            contractAddress: `oct${"D".repeat(44)}`,
            constructorParams: '["a"]',
            ou: "203000",
          },
        }}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText(`oct${"D".repeat(44)}`)).toBeTruthy();
    expect(screen.getByText('["a"]')).toBeTruthy();
    expect(screen.getByText(/203,000 OU/)).toBeTruthy();
    fireEvent.click(screen.getByText("Deploy"));
    expect(onApprove).toHaveBeenCalled();
  });

  it("a deploy review with an invalid fee cannot be approved", () => {
    const onApprove = vi.fn();
    render(
      <DappApprovalModal
        approval={{
          ...base,
          type: "deploy",
          signer: MAIN,
          deploy: {
            codeBytes: 10,
            contractAddress: `oct${"D".repeat(44)}`,
            constructorParams: "",
            ou: "90000000",
          },
        }}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Deploy"));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("a claim review shows the total amount, the count, each output and the fee", () => {
    const onApprove = vi.fn();
    render(
      <DappApprovalModal
        approval={{
          ...base,
          type: "transaction",
          signer: MAIN,
          details: {
            to: MAIN.address,
            amount: "3.5 OCT (private)",
            method: "claim_private",
            ou: "3000",
            claims: {
              count: 2,
              totalRaw: "3500000",
              remaining: 0,
              outputs: [
                { id: 4, amountRaw: "1000000" },
                { id: 9, amountRaw: "2500000" },
              ],
            },
          },
        }}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("Claim private transfers")).toBeTruthy();
    expect(screen.getByText("3.5 OCT")).toBeTruthy();
    expect(screen.getByText("Transfers")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Transfer 1")).toBeTruthy();
    expect(screen.getByText("2.5 OCT")).toBeTruthy();
    expect(screen.getByText("3,000 OU (0.003 OCT) each")).toBeTruthy();
    expect(screen.getByText("6,000 OU (0.006 OCT)")).toBeTruthy();
    fireEvent.click(screen.getByText("Claim"));
    expect(onApprove).toHaveBeenCalled();
  });

  it("a long claim batch shows the count and how many wait for a later claim", () => {
    render(
      <DappApprovalModal
        approval={{
          ...base,
          type: "transaction",
          signer: MAIN,
          details: {
            to: MAIN.address,
            amount: "25 OCT (private)",
            method: "claim_private",
            ou: "3000",
            claims: { count: 25, totalRaw: "25000000", remaining: 4 },
          },
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("25 OCT")).toBeTruthy();
    expect(screen.getByText("25")).toBeTruthy();
    expect(screen.queryByText("Transfer 1")).toBeNull();
    expect(screen.getByText("4 more transfers stay for a later claim.")).toBeTruthy();
  });
});

describe("site reviews show what is signed or granted, in full", () => {
  const LONG = `["${SPEND.address}","5",7,"${"q".repeat(300)}"]`;

  it("connect lists each scope it grants, private ones too", () => {
    render(
      <DappApprovalModal
        approval={{
          ...base,
          type: "connect",
          connect: {
            open: MAIN,
            choices: [MAIN],
            permissions: ["accounts", "private_transfers", "private_proofs"],
          },
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("Access")).toBeTruthy();
    expect(screen.getByText("Address and balance")).toBeTruthy();
    expect(screen.getByText("Private transfers")).toBeTruthy();
    expect(screen.getByText("Private proofs")).toBeTruthy();
  });

  it("a contract call shows its exact args, uncut", () => {
    render(
      <DappApprovalModal
        approval={{
          ...base,
          type: "transaction",
          signer: SPEND,
          details: {
            to: MAIN.address,
            contract: MAIN.address,
            method: "transfer",
            amount: "0 OCT",
            args: LONG,
          },
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("Call data")).toBeTruthy();
    expect(screen.getByText(LONG)).toBeTruthy();
  });

  it("a sequence shows every step and the total", () => {
    render(
      <DappApprovalModal
        approval={{
          ...base,
          type: "transaction",
          signer: SPEND,
          details: {
            to: "",
            amount: "1.5 OCT",
            ou: "2000",
            steps: [
              { contract: MAIN.address, method: "approve", args: LONG, amount: "1 OCT" },
              { contract: COLD.address, method: "swap", args: "[true]", amount: "0.5 OCT" },
            ],
          },
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("1.5 OCT")).toBeTruthy();
    const one = screen.getByRole("region", { name: "Step 1" });
    expect(within(one).getByText("approve")).toBeTruthy();
    expect(within(one).getByText("1 OCT")).toBeTruthy();
    expect(within(one).getByText(LONG)).toBeTruthy();
    const two = screen.getByRole("region", { name: "Step 2" });
    expect(within(two).getByText("swap")).toBeTruthy();
    expect(within(two).getByText("[true]")).toBeTruthy();
    expect(screen.getByText("Total fee")).toBeTruthy();
  });

  it("a signed transaction shows its memo", () => {
    render(
      <DappApprovalModal
        approval={{
          ...base,
          type: "transaction",
          signer: SPEND,
          details: {
            to: MAIN.address,
            amount: "1 OCT",
            method: "sign_only",
            message: "invoice 42",
          },
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("Memo")).toBeTruthy();
    expect(screen.getByText("invoice 42")).toBeTruthy();
  });
});
