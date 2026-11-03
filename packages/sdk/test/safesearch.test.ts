import { describe, expect, it } from "vitest";
import { safeSearchVerdict, type SafeSearchRatings } from "../src/index.js";

const calm: SafeSearchRatings = { adult: "VERY_UNLIKELY", violence: "UNLIKELY", racy: "POSSIBLE", medical: "LIKELY", spoof: "VERY_LIKELY" };

describe("safeSearchVerdict", () => {
  it("passes a calm photo, whatever medical and spoof say", () => {
    expect(safeSearchVerdict(calm)).toBe("pass");
    expect(safeSearchVerdict({ ...calm, racy: "LIKELY" })).toBe("pass");
  });

  it("refuses very likely adult or violent content", () => {
    expect(safeSearchVerdict({ ...calm, adult: "VERY_LIKELY" })).toBe("refuse");
    expect(safeSearchVerdict({ ...calm, violence: "VERY_LIKELY" })).toBe("refuse");
  });

  it("holds likely adult or violent, very likely racy, and unchecked photos for a person", () => {
    expect(safeSearchVerdict({ ...calm, adult: "LIKELY" })).toBe("hold");
    expect(safeSearchVerdict({ ...calm, violence: "LIKELY" })).toBe("hold");
    expect(safeSearchVerdict({ ...calm, racy: "VERY_LIKELY" })).toBe("hold");
    expect(safeSearchVerdict("unchecked")).toBe("hold");
  });
});
