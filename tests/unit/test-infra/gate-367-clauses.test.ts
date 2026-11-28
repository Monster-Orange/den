import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const NO_PHONE =
  "no phone has push alerts on yet. When one does, it needs an https address: Settings › Den's address (/settings?q=web.url)";
const ROWS = [
  {
    id: "notifications.push_timeout",
    shown: true,
    value: 30,
    min: 1,
    max: 3600,
  },
  {
    id: "notifications.push_ttl",
    shown: true,
    value: 86400,
    min: 0,
    max: 2419200,
  },
];

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function rows(push: string | null): Row[] {
  const cells = [
    {
      cell: { browser: "chromium", width: 1280 },
      result: { push, rows: ROWS },
    },
  ];
  const js = `const g = await import("./gate/367.mjs"); console.log(JSON.stringify(g.expect(${JSON.stringify(cells)})));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as Row[];
}

describe("gate/367.mjs: doctor's push line", () => {
  it("no phone with push on yet: the contact row waits for one, and the line says what to set", () => {
    const r = rows(NO_PHONE);
    expect(r[1]).toMatchObject({ ok: null, skip: "needs-push-subscription" });
    expect(r[2]).toMatchObject({ ok: true, detail: NO_PHONE });
  });

  it("an https contact passes, and the no-address row skips", () => {
    const r = rows(
      "push services are given https://den.example.test as the contact",
    );
    expect(r[1].ok).toBe(true);
    expect(r[2]).toMatchObject({ ok: null, skip: "needs-no-https-address" });
  });

  it("the mailto fallback passes only when it says what to set", () => {
    const fb =
      "push alerts may not reach phones: with no https address, push services are given mailto:den@example.test as the contact, and some refuse it. Set one in Settings › Den's address (/settings?q=web.url), or run `den web url https://<address>`";
    const r = rows(fb);
    expect(r[1].ok).toBe(true);
    expect(r[2].ok).toBe(true);
  });

  it("no push line at all FAILs the contact row", () => {
    const r = rows(null);
    expect(r[1]).toMatchObject({
      ok: false,
      detail: "doctor has no push line",
    });
  });
});
