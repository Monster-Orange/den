/**
 * `<cli> doctor` (0.3.0-dev.25): one row per strategy kind in the registry
 * (secrets, tls) with the selected strategy, whether it was implicit, and
 * detect() with its reason. It never runs a CLI: child_process is mocked
 * and must stay untouched.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

jest.mock("child_process");

import { ROOT } from "./helpers/doctor-root.js";
import * as child from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  doctorRows,
  formatDoctor,
} from "../../../src/ui/cli/doctor-command.js";

const savedPath = process.env.PATH;

function dist(config: string): NodeJS.ProcessEnv {
  fs.writeFileSync(path.join(ROOT, "config", "den.yml"), config);
  return { PATH: "/usr/bin:/bin" };
}

beforeEach(() => {
  // No mkcert, op or doppler on PATH.
  process.env.PATH = "/usr/bin:/bin";
});
afterEach(() => {
  process.env.PATH = savedPath;
});
afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const spawned = () =>
  [child.spawnSync, child.execSync, child.execFileSync, child.spawn].map(
    (f) => (f as unknown as jest.Mock).mock.calls.length,
  );

describe("doctor", () => {
  it("lists secrets and tls, with no edge and no store", () => {
    const rows = doctorRows(dist("secrets:\n  provider: none\n"));
    expect(rows.map((r) => r.kind)).toEqual(["secrets", "tls"]);
    expect(rows[0]).toMatchObject({
      selected: "none",
      implicit: false,
      available: true,
      problem: false,
    });
    expect(rows[1]).toMatchObject({
      selected: "none",
      available: true,
      reason: "no edge: block",
      problem: false,
    });
    expect(spawned()).toEqual([0, 0, 0, 0]);
  });

  it("an edge with no tls: mkcert (implicit), 'mkcert is not installed', a problem", () => {
    const rows = doctorRows(
      dist(
        "secrets:\n  provider: doppler\nedge:\n  org: acme\n  domain: acme.localhost\n",
      ),
    );
    expect(rows[0]).toMatchObject({
      selected: "doppler",
      available: false,
      reason: "The Doppler CLI (doppler) is not on PATH",
      problem: true,
    });
    expect(rows[1]).toMatchObject({
      selected: "mkcert",
      implicit: true,
      available: false,
      reason: "mkcert is not installed",
      problem: true,
      warnings: [
        "edge.tls is not set; defaulting to mkcert with a local CA. Set edge.tls explicitly.",
      ],
    });
    expect(spawned()).toEqual([0, 0, 0, 0]);
  });

  it("the implicit secrets default is never a problem (used only when asked)", () => {
    const [secrets] = doctorRows(dist("environments: [local]\n"));
    expect(secrets).toMatchObject({
      selected: "doppler",
      implicit: true,
      available: false,
      problem: false,
    });
  });

  it("an invalid edge.tls is reported, not thrown", () => {
    const [, tls] = doctorRows(
      dist("edge:\n  org: acme\n  domain: acme.localhost\n  tls: acme\n"),
    );
    expect(tls).toMatchObject({ selected: "", problem: true });
    expect(tls.reason).toMatch(/the built-ins are none, mkcert, files/);
  });

  it("prints one line per kind, and each warning under it", () => {
    const lines = formatDoctor(
      [
        {
          kind: "secrets",
          selected: "none",
          implicit: false,
          available: true,
          reason: "no secrets backend configured",
          problem: false,
          warnings: [],
        },
        {
          kind: "tls",
          selected: "mkcert",
          implicit: true,
          available: false,
          reason: "mkcert is not installed",
          problem: true,
          warnings: ["edge.tls is not set; …"],
        },
      ],
      "Acme",
    );
    expect(lines).toEqual([
      "Acme doctor: strategies",
      "",
      "  secrets  none                 ✓ available: no secrets backend configured",
      "  tls      mkcert (implicit)    ✗ unavailable: mkcert is not installed",
      "    ⚠ edge.tls is not set; …",
    ]);
  });
});
