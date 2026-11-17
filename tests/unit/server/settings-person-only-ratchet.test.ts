/**
 * Review M5 (0.4.46): every field POST /api/settings accepts says who may
 * change it. A field that widens what agents may do, or names a program
 * Den runs, is a person's: the handler refuses it from an agent even when
 * the route guard (agent tokens never write /api/settings) is bypassed.
 * A new field fails here until it is classified.
 *
 * Reads the handler's accepted fields from its source. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  PERSON_ONLY_SETTINGS,
  SETTINGS_ANYONE,
} from "../../../src/shared/settings-cli-rows.js";

const SRC = fs.readFileSync(
  path.join(__dirname, "../../../src/ui/server/index.ts"),
  "utf-8",
);

/** The fields of POST /api/settings' body, as its type lists them. */
function acceptedFields(): string[] {
  const at = SRC.indexOf(
    'if (req.method === "POST") {',
    SRC.indexOf('pathname === "/api/settings"'),
  );
  const open = SRC.indexOf("as {", at);
  const close = SRC.indexOf("};", open);
  return [...SRC.slice(open, close).matchAll(/^\s+(\w+)\?:/gm)].map(
    (m) => m[1],
  );
}

/** Fields that widen agents' power or name a program Den runs. */
const MUST_BE_PERSON = [
  "hub_allow_tools",
  "agents_default_mode",
  "editor",
  "terminal",
  "editor_overrides",
  "shell",
  "editor_open",
  "local_dev",
  // SRV-P6: auto lets Den update itself unasked.
  "server_agent_self_update",
  // Issue 160: the approval policy itself (an agent asks: approval_policy).
  "approvals_policy",
  "approvals_watch",
  "approvals_critical",
];

describe("every settings field says who may change it", () => {
  it("finds the handler's fields", () => {
    expect(acceptedFields()).toEqual(
      expect.arrayContaining(["hub_allow_tools", "language"]),
    );
  });

  it("each is a person's or anyone's, never both, never neither", () => {
    const person = new Set<string>(PERSON_ONLY_SETTINGS);
    const anyone = new Set(Object.keys(SETTINGS_ANYONE));
    for (const f of acceptedFields())
      expect([f, person.has(f) !== anyone.has(f)]).toEqual([f, true]);
  });

  it("everything that widens agents or names a program is a person's", () => {
    for (const f of MUST_BE_PERSON)
      expect([
        f,
        (PERSON_ONLY_SETTINGS as readonly string[]).includes(f),
      ]).toEqual([f, true]);
  });

  it("anyone's fields each say why", () => {
    for (const [f, why] of Object.entries(SETTINGS_ANYONE))
      expect([f, why.length > 10]).toEqual([f, true]);
  });
});
