/**
 * Issue 819 (tests first), point 6: each wait and refusal on the way to
 * approving a new device says in plain words what to do next, in en, es
 * and ja (en is shell.js's MESSAGES.en; es and ja are public/i18n/).
 *
 * The keys are the screens the issue adds:
 *  - the pairing screen a sign-in link lands on, and its wait;
 *  - the device was denied; the request ended;
 *  - first run is finished on the Den computer itself;
 *  - the setup link was used once the install is set up;
 *  - approving needs a signed-in browser (the CLI, an agent, a fixture).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

type Table = Record<string, string>;
const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");

function catalogs(): Record<string, Table> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of ["i18n/es.js", "i18n/ja.js", "shell.js"]) {
    try {
      vm.runInContext(read(f), ctx, { filename: f });
    } catch {
      // shell.js stops at its first DOM use; its catalog is set before it.
    }
  }
  return window.denMessages as Record<string, Table>;
}

/** Each key, and what its English must name so the next step is clear. */
const KEYS: Record<string, RegExp> = {
  // The pairing screen a `web login` (or any) link lands on.
  "err.signin.pairLinkLead": /Settings › Access/,
  "err.signin.pairLinkWaiting": /approve/i,
  "err.signin.pairLinkDenied": /sign in|approve/i,
  "err.signin.pairLinkEnded": /new code|again/i,
  // First run: finished on the Den computer itself.
  "err.signin.firstRunHere": /\{host\}/,
  // The setup link, once the install is set up.
  "err.signin.claimSetUp": /Settings › Access/,
  // Approving a device: only a signed-in person's browser.
  "set.access.approveNeedsBrowser": /signed-in browser/,
  "set.access.approveNotAgent": /person/i,
};

const M = catalogs();

describe("issue 819: the new device's waits and refusals, in every language", () => {
  it.each(Object.keys(KEYS))("%s is in en, es and ja", (key) => {
    expect({
      en: typeof M.en?.[key],
      es: typeof M.es?.[key],
      ja: typeof M.ja?.[key],
    }).toEqual({ en: "string", es: "string", ja: "string" });
  });

  it.each(Object.entries(KEYS))(
    "%s says in English what to do next",
    (key, want) => {
      expect(M.en?.[key] ?? "").toMatch(want);
    },
  );

  it.each(Object.keys(KEYS))("%s is translated, not English", (key) => {
    expect([M.es?.[key] === M.en?.[key], M.ja?.[key] === M.en?.[key]]).toEqual([
      false,
      false,
    ]);
  });
});
