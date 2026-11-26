import { describe, expect, it } from "@jest/globals";
import {
  forgetSecretValues,
  rememberSecretValues,
} from "../../../src/shared/secret-values.js";
import { createLogRing } from "../../../src/ui/server/log-ring.js";

const TOKEN = `ghp_${"A1b2C3d4E5".repeat(4)}`;

describe("the server log's ring (/api/server-log)", () => {
  it("keeps a line plain and redacted, in its history and its live entries", () => {
    const ring = createLogRing(3);
    const live: string[] = [];
    const stop = ring.subscribe((e) => live.push(e.text));
    ring.push("warn", `\x1b[31mclone failed\x1b[0m with ${TOKEN}`, "agent:a1");
    const [entry] = ring.history();
    expect(entry).toMatchObject({ kind: "warn", actor: "agent:a1" });
    for (const text of [entry!.text, live[0]!]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("\x1b[");
      expect(text).toMatch(/^clone failed with .*REDACTED/);
    }
    stop();
    ring.push("info", "after");
    expect(live).toHaveLength(1);
  });

  it("holds its last lines only, and a broken subscriber stops no one", () => {
    const ring = createLogRing(2);
    const seen: string[] = [];
    ring.subscribe(() => {
      throw new Error("gone");
    });
    ring.subscribe((e) => seen.push(e.text));
    for (const t of ["a", "b", "c"]) ring.push("info", t);
    expect(ring.history().map((e) => e.text)).toEqual(["b", "c"]);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("masks a service's secret values, longest first, after ANSI is stripped, and leaves values under 6 characters", () => {
    forgetSecretValues();
    rememberSecretValues(["pa55-word", "pa55-word-and-more", "true", 7]);
    const ring = createLogRing(5);
    const live: string[] = [];
    ring.subscribe((e) => live.push(e.text));
    ring.push("lifecycle", "  north: db pa55-word-and-more ok true");
    ring.push("lifecycle", "  north: pa55\x1b[1m-word\x1b[0m set");
    const history = ring.history().map((e) => e.text);
    for (const lines of [history, live]) {
      expect(lines).toEqual([
        "  north: db [REDACTED] ok true",
        "  north: [REDACTED] set",
      ]);
    }
    forgetSecretValues();
  });
});
