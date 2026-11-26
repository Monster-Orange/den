import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { ROUTES } from "../../../src/ui/server/route-classes.js";
import { serveUiAsset } from "../../../src/ui/server/ui-assets.js";

const ROOT = path.join(__dirname, "../../..");
const PUBLIC = path.join(ROOT, "src/ui/server/public");
const RULE = path.join(ROOT, "src/shared/health/rollup-rule.js");

function fakeRes() {
  const r = {
    status: 0,
    headers: {} as Record<string, string>,
    body: Buffer.alloc(0),
    writeHead(s: number, h?: Record<string, string>) {
      r.status = s;
      Object.assign(r.headers, h ?? {});
      return r;
    },
    end(b?: Buffer | string) {
      if (b) r.body = Buffer.from(b);
      return r;
    },
  };
  return r;
}

function get(pathname: string) {
  const res = fakeRes();
  const handled = serveUiAsset(
    res as unknown as Parameters<typeof serveUiAsset>[0],
    pathname,
    PUBLIC,
  );
  return { handled, ...res };
}

describe("/health-rollup.js, the rollup rule the browser and the CLI share", () => {
  it("is the file in src/shared, byte for byte", () => {
    const r = get("/health-rollup.js");
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body.equals(fs.readFileSync(RULE))).toBe(true);
  });

  it("has the headers every other page module has", () => {
    const rule = get("/health-rollup.js").headers;
    expect(rule["Content-Type"]).toMatch(/javascript/);
    expect(rule).toEqual(get("/graph-model.js").headers);
  });

  it("is a read-only route, as the page's other modules are", () => {
    expect(ROUTES.find((r) => r.path === "/health-rollup.js")?.cls).toBe(
      "readonly",
    );
  });

  it("the browser's copy and the CLI's are one module", async () => {
    const browser =
      await import("../../../src/ui/server/public/health-rollup.js");
    const cli = await import("../../../src/shared/health/rollup-rule.js");
    expect(browser.rollupRepo).toBe(cli.rollupRepo);
    expect(Object.keys(browser).sort()).toEqual(Object.keys(cli).sort());
  });
});
