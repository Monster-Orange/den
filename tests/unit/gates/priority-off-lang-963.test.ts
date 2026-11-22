/**
 * Issue 963 follow-up: the two lines that say release priority is off
 * (`gate status`'s last line, and `gate run --priority release`'s notice)
 * are in the person's language (en, es, ja), as the --yes warning is.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { UiLanguage } from "../../../src/shared/gates/browser-container.js";
import {
  PRIORITY_OFF_RUN,
  PRIORITY_OFF_STATUS,
} from "../../../src/shared/gates/meanings.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function deps(lang: UiLanguage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate963l-"));
  tmps.push(dir);
  const out: string[] = [];
  const err: string[] = [];
  const d: GateDeps = {
    store: new GateStore({ platform: "linux", dir, alive: () => true }),
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: () => ({ pid: 5151, kill: () => {}, done: Promise.resolve(0) }),
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
    lang,
  };
  d.store.writeSettings({ priority_max: 0 }, "a test");
  return { d, out, err };
}

const LANGS: UiLanguage[] = ["en", "es", "ja"];

describe("issue 963: release priority off, in the person's language", () => {
  it("each line has en, es and ja, and they differ", () => {
    for (const m of [PRIORITY_OFF_STATUS, PRIORITY_OFF_RUN]) {
      expect(Object.keys(m).sort()).toEqual([...LANGS].sort());
      for (const l of LANGS) expect(m[l]).toContain("priority_max 0");
      expect(new Set(LANGS.map((l) => m[l])).size).toBe(3);
    }
  });

  it.each(LANGS)("gate status ends with it (%s)", async (lang) => {
    const t = deps(lang);
    await cmdGate(["status"], t.d);
    expect(t.out.at(-1)).toBe(PRIORITY_OFF_STATUS[lang]);
  });

  it.each(LANGS)(
    "a release ask says it runs as an ordinary run (%s)",
    async (lang) => {
      const t = deps(lang);
      expect(
        await cmdGate(
          [
            "run",
            "--kind",
            "cpu",
            "--priority",
            "release",
            "--reason",
            "a person waits",
            "--",
            "true",
          ],
          t.d,
        ),
      ).toBe(0);
      expect(t.err).toContain(`gate: ${PRIORITY_OFF_RUN[lang]}`);
    },
  );
});
