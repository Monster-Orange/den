/**
 * Issue 521: docs/hub-contract/den-<version>/ holds the shape of each
 * request Den makes to Hub, written by scripts/hub-contract-export.mjs
 * from the same code that builds the requests. This test builds them
 * again and compares them with the folder for the version in
 * package.json: a request whose shape changed without a new export fails
 * here. (A release changes the version; its commit runs the export.)
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  HUB_CONTRACT_CALLS,
  buildHubContract,
  contractDrift,
  readContractFolder,
} from "../../../src/shared/hub-contract.js";

const ROOT = path.join(process.cwd(), "docs", "hub-contract");
const PKG = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
) as { version: string };
const DIR = path.join(ROOT, `den-${PKG.version}`);
const EXPORT = "npm run hub-contract:export";

describe("Hub contract fixtures (issue 521)", () => {
  it(`the folder for ${PKG.version} matches the code (run \`${EXPORT}\` after changing a request)`, async () => {
    expect(fs.existsSync(DIR)).toBe(true);
    const drift = contractDrift(
      await buildHubContract(),
      readContractFolder(DIR),
    );
    expect(drift).toEqual([]);
  });

  it("one request's shape changed without re-exporting: drift names it", async () => {
    const built = await buildHubContract();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-521-contract-"));
    try {
      for (const f of fs.readdirSync(DIR))
        fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
      const file = path.join(tmp, "delivery-ack.request.json");
      const r = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        body: Record<string, unknown>;
      };
      r.body = { ...r.body, extra: "<uuid>" };
      fs.writeFileSync(file, JSON.stringify(r, null, 2));
      const drift = contractDrift(built, readContractFolder(tmp));
      expect(drift.join("\n")).toContain("delivery-ack");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the manifest says the version, protocol and capabilities Den sends", async () => {
    const m = JSON.parse(
      fs.readFileSync(path.join(DIR, "manifest.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(Object.keys(m).sort()).toEqual([
      "capabilities",
      "den_version",
      "exported_at",
      "generator",
      "protocol",
    ]);
    expect(m.den_version).toBe(PKG.version);
    expect(m.generator).toBe("scripts/hub-contract-export.mjs");
    const built = await buildHubContract();
    expect(m.protocol).toBe(built.manifest.protocol);
    expect(m.capabilities).toEqual(built.manifest.capabilities);
  });

  it("only the agreed calls, at most three den-* folders, placeholders only", () => {
    const files = fs.readdirSync(DIR).sort();
    expect(files).toEqual(
      [
        "manifest.json",
        ...HUB_CONTRACT_CALLS.map((c) => `${c}.request.json`),
      ].sort(),
    );
    const dens = fs.readdirSync(ROOT).filter((d) => d.startsWith("den-"));
    expect(dens.length).toBeLessThanOrEqual(3);
    for (const f of files) {
      const text = fs.readFileSync(path.join(DIR, f), "utf-8");
      // No address, token or id of a real thing: only <placeholders>.
      expect(text).not.toMatch(/https?:\/\/(?!<host>)/);
      expect(text).not.toMatch(/Bearer (?!<token>)/);
      expect(text).not.toMatch(/0placeholder|\.invalid/);
    }
  });
});
