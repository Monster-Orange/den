/**
 * `<cli> sessions` and `<cli> agents` usage (AG-3a) through the real
 * bin/den: every usage error exits 2 with the command's usage line, under
 * the distribution's own CLI name, and starts no session host.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { makeDist, type Dist } from "./helpers/dist.js";

let dist: Dist;

beforeAll(() => {
  dist = makeDist("den-sessions-usage-");
});
afterAll(() => {
  fs.rmSync(dist.tmp, { recursive: true, force: true });
});

const usageErrors: Array<[string, string[], RegExp]> = [
  ["no subcommand", ["sessions"], /acme sessions <start\|list\|attach\|kill/],
  [
    "an unknown subcommand",
    ["sessions", "frob"],
    /unknown sessions command "frob"/,
  ],
  [
    "start without --workspace",
    ["sessions", "start", "--name", "p", "--", "sh"],
    /--workspace/,
  ],
  [
    "start without --name",
    ["sessions", "start", "-w", "north", "--", "sh"],
    /--name/,
  ],
  [
    "start with nothing to run",
    ["sessions", "start", "-w", "north", "--name", "p"],
    /after --/,
  ],
  [
    "start in a workspace that does not exist",
    ["sessions", "start", "-w", "nope", "--name", "p", "--", "sh"],
    /project "nope" does not exist/,
  ],
  [
    "start with a bad name",
    ["sessions", "start", "-w", "north", "--name", "a:b", "--", "sh"],
    /--name/,
  ],
  [
    "start with a cwd that is not a directory",
    [
      "sessions",
      "start",
      "-w",
      "north",
      "--name",
      "p",
      "--cwd",
      "/no/such/dir",
      "--",
      "sh",
    ],
    /--cwd/,
  ],
  ["list with an unknown flag", ["sessions", "list", "--bogus"], /--bogus/],
  ["attach with no target", ["sessions", "attach"], /<name\|id>/],
  [
    "kill with an unknown signal",
    ["sessions", "kill", "p", "--signal", "HUP"],
    /INT\|TERM\|KILL/,
  ],
  ["agents list without -w", ["agents", "list"], /-w <project>/],
  [
    "an unknown agents subcommand",
    ["agents", "frob", "-w", "north"],
    /unknown agents command "frob"/,
  ],
];

describe("usage errors exit 2", () => {
  it.each(usageErrors)("%s", (_label, args, message) => {
    const r = dist.den(args);
    expect(r.out).toMatch(message);
    expect(r.code).toBe(2);
  });

  it("start no session host for a usage error", () => {
    expect(fs.existsSync(path.join(dist.home, "sessions.sock"))).toBe(false);
  });
});

describe("help", () => {
  it("sessions --help names each subcommand under the distribution's CLI", () => {
    const r = dist.den(["sessions", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/acme sessions start --workspace <ws> --name <n>/);
    expect(r.out).toMatch(/ctrl-]/);
    expect(r.out).not.toMatch(/<cli>|\{cli\}/);
  });

  it("agents --help", () => {
    const r = dist.den(["agents", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/acme agents list -w <ws>/);
    expect(r.out).toMatch(
      /acme agents start -w <ws> --persona <p> \[--runtime <r>\] \[--model <m>\] \[--name <name>\] \[--id <id>\]/,
    );
    expect(r.out).toMatch(/acme agents resume <id>/);
    expect(r.out).not.toMatch(/<cli>|\{cli\}/);
  });
});
