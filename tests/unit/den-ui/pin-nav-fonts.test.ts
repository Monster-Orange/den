/**
 * Issue 95: the nav inventory's font pin is the kit's (./inventory,
 * pinNavFonts), so every product measures its nav with the same glyphs.
 * It works on any Playwright BrowserContext: here a stand-in that records
 * what it was given. The faces it serves are the kit's own files, read
 * from the package (src/fonts), never from a host's tests.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as inventory from "../../../packages/den-ui/inventory/nav-inventory.js";

const FONTS = path.join(__dirname, "../../../packages/den-ui/src/fonts");

type Handler = (route: {
  request(): { url(): string };
  fulfill(o: {
    contentType?: string;
    body?: string | Buffer;
    status?: number;
  }): Promise<void>;
}) => unknown;

/** A BrowserContext stand-in: the init scripts and routes it was given. */
function fakeContext() {
  const scripts: unknown[] = [];
  const routes: [string, Handler][] = [];
  return {
    scripts,
    routes,
    addInitScript: async (s: unknown) => void scripts.push(s),
    route: async (url: string, h: Handler) => void routes.push([url, h]),
  };
}

/** What a route answers for `url`. */
async function fetchVia(h: Handler, url: string) {
  let got: { contentType?: string; body?: string | Buffer; status?: number } =
    {};
  await h({
    request: () => ({ url: () => url }),
    fulfill: async (o) => void (got = o),
  });
  return got;
}

describe("pinNavFonts (./inventory)", () => {
  it("is exported with the image and theme the reference was taken on", () => {
    const inv = inventory as unknown as Record<string, unknown>;
    expect(typeof inv.pinNavFonts).toBe("function");
    expect(typeof inv.NAV_BROWSER_IMAGE).toBe("string");
    expect(inv.NAV_THEME).toEqual({ id: "den", version: "2.0.1" });
  });

  it("adds the pin stylesheet first on every page, and serves the kit's own faces", async () => {
    const pin = (
      inventory as unknown as {
        pinNavFonts: (c: unknown) => Promise<void>;
      }
    ).pinNavFonts;
    const ctx = fakeContext();
    await pin(ctx);
    // One init script prepends <link href="/__pin-fonts/pin.css">.
    expect(ctx.scripts).toHaveLength(1);
    expect(String(ctx.scripts[0])).toMatch(/__pin-fonts\/pin\.css/);
    expect(String(ctx.scripts[0])).toMatch(/prepend/);
    // One route for /__pin-fonts/*.
    expect(ctx.routes.map(([u]) => u)).toEqual(["**/__pin-fonts/**"]);
    const h = ctx.routes[0]![1];
    const css = await fetchVia(h, "http://host.test/__pin-fonts/pin.css");
    expect(css.contentType).toBe("text/css");
    // The system faces a nav names, pinned to the kit's Rubik and Space Mono.
    expect(String(css.body)).toMatch(
      /font-family:"-apple-system";font-weight:100 449;src:url\(\/__pin-fonts\/rubik-latin-400-normal\.woff2\)/,
    );
    expect(String(css.body)).toMatch(
      /font-family:"ui-monospace";src:url\(\/__pin-fonts\/space-mono-latin-400-normal\.woff2\)/,
    );
    // Each face it names is served, byte for byte, from the package.
    const named = [
      ...String(css.body).matchAll(/__pin-fonts\/([\w.-]+\.woff2)/g),
    ].map((m) => m[1]!);
    expect(new Set(named).size).toBe(3);
    for (const f of new Set(named)) {
      const r = await fetchVia(h, `http://host.test/__pin-fonts/${f}`);
      expect([f, r.contentType]).toEqual([f, "font/woff2"]);
      expect(
        Buffer.compare(r.body as Buffer, fs.readFileSync(path.join(FONTS, f))),
      ).toBe(0);
    }
    // Nothing outside the kit's fonts.
    const out = await fetchVia(h, "http://host.test/__pin-fonts/..%2Fkit.js");
    expect(out.status).toBe(404);
  });
});
