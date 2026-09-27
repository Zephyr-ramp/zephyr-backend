import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, TERMINAL_STATUSES, transitionsFor } from "../src/sep24/state.js";
import { TRANSACTION_STATUSES } from "../src/store/types.js";

describe("state machine", () => {
  it("uses only SEP-24 status names", () => {
    expect(TRANSACTION_STATUSES).toEqual([
      "incomplete",
      "pending_user_transfer_start",
      "pending_user_transfer_complete",
      "pending_external",
      "pending_anchor",
      "pending_stellar",
      "pending_trust",
      "pending_user",
      "completed",
      "refunded",
      "expired",
      "no_market",
      "too_small",
      "too_large",
      "error",
    ]);
    for (const kind of ["deposit", "withdrawal"] as const) {
      for (const mode of ["standard", "escrow"] as const) {
        for (const [from, tos] of Object.entries(transitionsFor(kind, mode))) {
          expect(TRANSACTION_STATUSES).toContain(from);
          for (const to of tos!) expect(TRANSACTION_STATUSES).toContain(to);
        }
      }
    }
  });

  it.each([
    [
      "deposit",
      undefined,
      ["incomplete", "pending_user_transfer_start", "pending_anchor", "pending_stellar", "completed"],
    ],
    [
      "withdrawal",
      "standard",
      ["incomplete", "pending_user_transfer_start", "pending_anchor", "pending_external", "completed"],
    ],
    [
      "withdrawal",
      "escrow",
      [
        "incomplete",
        "pending_user_transfer_start",
        "pending_anchor",
        "pending_external",
        "pending_stellar",
        "completed",
      ],
    ],
  ] as const)("allows the %s (%s) happy path", (kind, mode, path) => {
    for (let i = 1; i < path.length; i++) {
      expect(canTransition(kind, mode, path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  it("lets every non-terminal state fall to error", () => {
    for (const kind of ["deposit", "withdrawal"] as const) {
      for (const mode of ["standard", "escrow"] as const) {
        for (const from of Object.keys(transitionsFor(kind, mode))) {
          expect(canTransition(kind, mode, from as never, "error")).toBe(true);
        }
      }
    }
  });

  it("never leaves a terminal state", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of TRANSACTION_STATUSES) {
        if (to === from) continue;
        expect(canTransition("withdrawal", "escrow", from, to)).toBe(false);
        expect(canTransition("deposit", undefined, from, to)).toBe(false);
      }
    }
  });

  it("only escrow withdrawals can be refunded", () => {
    expect(canTransition("withdrawal", "escrow", "pending_external", "refunded")).toBe(true);
    expect(canTransition("withdrawal", "standard", "pending_external", "refunded")).toBe(false);
    expect(canTransition("deposit", undefined, "pending_anchor", "refunded")).toBe(false);
  });

  it("rejects skipping steps", () => {
    expect(canTransition("deposit", undefined, "incomplete", "completed")).toBe(false);
    expect(canTransition("deposit", undefined, "pending_user_transfer_start", "pending_stellar")).toBe(false);
    expect(canTransition("withdrawal", "standard", "pending_anchor", "completed")).toBe(false);
    expect(canTransition("withdrawal", "escrow", "pending_external", "completed")).toBe(false);
  });

  it("treats a no-op as allowed and throws 409 for invalid transitions", () => {
    expect(canTransition("deposit", undefined, "completed", "completed")).toBe(true);
    expect(() => assertTransition({ id: "t", kind: "deposit", status: "completed" }, "pending_anchor")).toThrow(
      /invalid transition completed -> pending_anchor/,
    );
  });
});
