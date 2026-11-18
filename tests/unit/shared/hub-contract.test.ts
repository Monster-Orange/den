/**
 * Issue 521: docs/hub-contract/den-<release>/ holds the shape of each
 * request Den makes to Hub, written by scripts/hub-contract-export.mjs
 * from the same code that builds the requests. The folder is named for
 * the version without its pre-release part (0.4.71-dev.3 → den-0.4.71),
 * so a dev bump doesn't need a new export. This test builds the requests
 * again and compares their shapes with that folder: a request whose shape
 * changed without a new export fails here. X-Den-Version and the
 * manifest's den_version keep the exact version; the compare checks
 * their format and release, not the value.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  HUB_CONTRACT_CALLS,
  buildHubContract,
  contractDrift,
  contractFolderName,
  readContractFolder,
} from "../../../src/shared/hub-contract.js";

const ROOT = path.join(process.cwd(), "docs", "hub-contract");
const PKG = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
) as { version: string };
const DIR = path.join(ROOT, contractFolderName(PKG.version));
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

  it("the folder is named for the release: the pre-release part is dropped", () => {
    expect(contractFolderName("0.4.71-dev.1")).toBe("den-0.4.71");
    expect(contractFolderName("0.4.71-dev.3")).toBe("den-0.4.71");
    expect(contractFolderName("0.4.71")).toBe("den-0.4.71");
    expect(contractFolderName("1.2.3-rc.1+build.5")).toBe("den-1.2.3");
  });

  /** A copy of the folder with every exact version replaced by `v`. */
  function folderAt(v: string, rel: string): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-521-at-"));
    const dir = path.join(tmp, `den-${rel}`);
    fs.mkdirSync(dir);
    const exact = JSON.parse(
      fs.readFileSync(path.join(DIR, "manifest.json"), "utf-8"),
    ).den_version as string;
    for (const f of fs.readdirSync(DIR))
      fs.writeFileSync(
        path.join(dir, f),
        fs.readFileSync(path.join(DIR, f), "utf-8").split(exact).join(v),
      );
    return dir;
  }

  it("a dev bump (0.4.71-dev.1) against den-0.4.71 exported at another dev: no drift", async () => {
    const built = await buildHubContract();
    // The first: the folder only renamed, its exact version the one it
    // was exported at (the merge renames den-0.4.68 to den-0.4.71).
    const exported = JSON.parse(
      fs.readFileSync(path.join(DIR, "manifest.json"), "utf-8"),
    ).den_version as string;
    for (const v of [exported, "0.4.71-dev.1", "0.4.71-dev.3", "0.4.71"]) {
      const dir = folderAt(v, "0.4.71");
      try {
        expect(
          contractDrift(built, readContractFolder(dir), "0.4.71-dev.1"),
        ).toEqual([]);
      } finally {
        fs.rmSync(path.dirname(dir), { recursive: true, force: true });
      }
    }
  });

  it("X-Den-Version and den_version are checked by format only", async () => {
    const built = await buildHubContract();
    const bad = folderAt("not-a-version", "0.4.71");
    try {
      const d = contractDrift(built, readContractFolder(bad), "0.4.71-dev.1");
      expect(d.join("\n")).toContain("X-Den-Version");
      expect(d.join("\n")).toContain("den_version");
    } finally {
      fs.rmSync(path.dirname(bad), { recursive: true, force: true });
    }
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
    expect(String(m.den_version)).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
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
