/**
 * A typo under `agents:` or `sessions:` is a ConfigError naming its key
 * (the web server answers it 422 with the config page, not a 500), and the
 * issue leaves the value out ("(got …)"): issues name keys, never values.
 */
import { describe, expect, it } from "@jest/globals";
import { isConfigError } from "../../../src/shared/config-error.js";
import {
  readAgentsConfig,
  readSessionsConfig,
  type DenConfig,
} from "../../../src/shared/den-config.js";

const issueOf = (read: () => unknown) => {
  try {
    read();
  } catch (e) {
    return isConfigError(e) ? e.issues : `plain: ${String(e)}`;
  }
  return "no error";
};

describe("agents: and sessions: problems are ConfigErrors", () => {
  it.each([
    [
      "sessions.max_concurrent",
      { sessions: { max_concurrent: "hunter2" } },
      readSessionsConfig,
    ],
    ["sessions.cap", { sessions: { cap: 3 } }, readSessionsConfig],
    [
      "sessions.close_grace_seconds",
      { sessions: { close_grace_seconds: -1 } },
      readSessionsConfig,
    ],
    [
      "agents.max_concurrent",
      { agents: { max_concurrent: "hunter2" } },
      readAgentsConfig,
    ],
    [
      "agents.helpers.collapse_done",
      { agents: { helpers: { collapse_done: 5 } } },
      readAgentsConfig,
    ],
  ] as const)("%s", (key, config, read) => {
    const issues = issueOf(() => read(config as unknown as DenConfig));
    expect(Array.isArray(issues)).toBe(true);
    const [one] = issues as { key: string; text: string; file: string }[];
    expect(one.key).toBe(key);
    expect(one.text.startsWith(`${key}: `)).toBe(true);
    expect(one.text).not.toContain("hunter2");
    expect(one.text).not.toMatch(/\(got /);
  });

  it("a good config still reads", () => {
    expect(
      readSessionsConfig({ sessions: { max_concurrent: 3 } } as DenConfig)
        .maxConcurrent,
    ).toBe(3);
  });

  it("sessions.close_grace_seconds: 5 by default; 0 to 300", () => {
    expect(readSessionsConfig({} as DenConfig).closeGraceSeconds).toBe(5);
    expect(
      readSessionsConfig({
        sessions: { close_grace_seconds: 0.5 },
      } as unknown as DenConfig).closeGraceSeconds,
    ).toBe(0.5);
  });
});
