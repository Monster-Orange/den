import { describe, expect, it } from "@jest/globals";
import {
  formatHealthDot,
  formatHealthLabel,
  formatHealthReason,
  healthLabelText,
  healthReasonText,
} from "../../../src/ui/cli/health-display.js";

describe("CLI health display", () => {
  it("renders internal error health as down for users", () => {
    expect(healthLabelText("error")).toBe("down");
    expect(formatHealthLabel("error")).toBe("● down");
    expect(formatHealthLabel("error")).not.toContain("error");
  });

  it("keeps ok and unknown labels unchanged", () => {
    expect(healthLabelText("ok")).toBe("ok");
    expect(healthLabelText("unknown")).toBe("unknown");
    expect(formatHealthLabel("ok")).toBe("● ok");
    expect(formatHealthLabel("unknown")).toBe("● unknown");
  });

  it("keeps compact health dots label-free", () => {
    expect(formatHealthDot("ok")).toBe("●");
    expect(formatHealthDot("error")).toBe("●");
    expect(formatHealthDot("unknown")).toBe("●");
  });

  it("hides reasons for healthy services", () => {
    expect(healthReasonText({ health: "ok" })).toBe("");
    expect(formatHealthReason({ health: "ok" })).toBe("");
  });

  it("normalizes HTTP health failures", () => {
    expect(
      healthReasonText({ health: "error", healthDetail: "fetch failed" }),
    ).toBe("health URL unreachable");
    expect(healthReasonText({ health: "error", healthDetail: "timeout" })).toBe(
      "health URL timeout",
    );
    expect(
      healthReasonText({ health: "error", healthDetail: "http 500" }),
    ).toBe("health URL returned HTTP 500");
  });

  it("normalizes shell health failures", () => {
    expect(healthReasonText({ health: "error", healthDetail: "exit 1" })).toBe(
      "health command failed: exit 1",
    );
    expect(
      healthReasonText({ health: "error", healthDetail: "exit 127" }),
    ).toBe("health command missing dependency (exit 127)");
  });

  it("normalizes configuration and workspace gaps", () => {
    expect(
      healthReasonText({
        health: "unknown",
        healthDetail: "no health check configured",
      }),
    ).toBe("missing health check");
    expect(
      healthReasonText({
        health: "unknown",
        healthDetail: "no .den.yml",
      }),
    ).toBe("missing .den.yml");
    expect(
      healthReasonText({
        health: "error",
        healthDetail: "repo path does not exist — run den setup",
      }),
    ).toBe("repo path missing");
  });
});
