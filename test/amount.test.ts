import { describe, expect, it } from "vitest";
import { calculateFee, compare, fromStroops, subtract, toStroops } from "../src/lib/amount.js";

describe("amount math", () => {
  it("round-trips 7-decimal amounts exactly", () => {
    expect(fromStroops(toStroops("0.1234567"))).toBe("0.1234567");
    expect(fromStroops(toStroops("10"))).toBe("10.00");
  });

  it("avoids float errors", () => {
    expect(subtract("0.3", "0.1")).toBe("0.20");
  });

  it("computes fixed + percent fees rounded to cents", () => {
    expect(calculateFee("100", "0.50", 1)).toBe("1.50");
    expect(calculateFee("33.33", "0", 1)).toBe("0.33");
    expect(calculateFee("10", "0.25", 0.3)).toBe("0.28");
  });

  it("rejects malformed amounts", () => {
    expect(() => toStroops("1e5")).toThrow();
    expect(() => toStroops("-1")).toThrow();
    expect(() => toStroops("1.12345678")).toThrow();
  });

  it("compares", () => {
    expect(compare("1.0", "1")).toBe(0);
    expect(compare("2", "10")).toBe(-1);
  });
});
