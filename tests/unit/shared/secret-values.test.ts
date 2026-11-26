import { afterEach, describe, expect, it } from "@jest/globals";
import {
  forgetSecretValues,
  maskSecretLine,
  rememberSecretValues,
} from "../../../src/shared/secret-values.js";

afterEach(() => forgetSecretValues());

describe("a log line Den writes to its files and stdout", () => {
  it("is left as it is, colours and all, when it holds no secret value", () => {
    rememberSecretValues(["pa55-word"]);
    const line = "\x1b[32m  ✓ north/api up\x1b[0m";
    expect(maskSecretLine(line)).toBe(line);
  });

  it("is masked, plain, when a value shows only once colours are stripped", () => {
    rememberSecretValues(["pa55-word"]);
    expect(maskSecretLine("  north: pa55\x1b[1m-word\x1b[0m set")).toBe(
      "  north: [REDACTED] set",
    );
    expect(maskSecretLine("\x1b[31mpa55-word\x1b[0m")).toBe("[REDACTED]");
  });
});
