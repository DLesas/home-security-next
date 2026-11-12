import { describe, expect, test } from "bun:test";
import { isEnumValue, Role, SirenAction, TransmitResultCode } from "../src/index.ts";

describe("isEnumValue", () => {
  test("accepts listed values and refuses others", () => {
    expect([0, 1, 2, 3].every((value) => isEnumValue(SirenAction, value))).toBe(true);
    expect(isEnumValue(SirenAction, 4)).toBe(false);
    expect(isEnumValue(Role, 0)).toBe(false);
    expect(isEnumValue(TransmitResultCode, 4)).toBe(true);
    expect(isEnumValue(TransmitResultCode, 255)).toBe(false);
  });

  test("narrows to the enumeration's value type", () => {
    const value = Number("2");
    if (!isEnumValue(SirenAction, value)) throw new Error("expected a siren action");
    const action: SirenAction = value;
    expect(action).toBe(SirenAction.Test);
  });
});
