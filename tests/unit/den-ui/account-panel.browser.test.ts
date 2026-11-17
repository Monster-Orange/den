/**
 * den-ui 0.7.4 (issue 310): accountPanelHtml, the person's own block on
 * Settings › Access, drawn by the kit from data in every product. The host
 * passes data; the kit owns every word and format:
 *
 *   accountPanelHtml({ name?, login?, role?, how, signOut?, lang? })
 *
 * In this order:
 * 1. a heading: the name, else @login, else the kit's "Local";
 * 2. @login and the role, in the kit's words for the role's key
 *    ("@login · Owner"); @login left out when it is the heading;
 * 3. how this browser is signed in (how: github | local | paired), in the
 *    kit's words;
 * 4. Sign out: a form post to signOut.url with signOut.csrf in a hidden
 *    field, and the kit's word. None without signOut.
 * Every value escaped; es and ja words.
 *
 * On a bare page built from the kit's own files, in Chromium and WebKit.
 * DEN_PW_WS: Den's own Playwright server instead of a local browser.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = process.env.DEN_PW_WS
        ? await kind.connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await kind.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

const STYLES = ["tokens", "fonts", "base", "shell"];

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${STYLES.map((s) => `<link rel="stylesheet" href="/kit/${s}.css">`).join("\n")}
</head>
<body><main id="host"></main>
<script type="module">
import DenUI from "/kit/kit.js";
window.DenUI = DenUI;
window.ready = true;
</script>
</body></html>`;

/** What reached /out (the panel's Sign out post): "METHOD body". */
const posts: string[] = [];

async function open(b: Browser): Promise<Page> {
  const ctx = await b.newContext({ viewport: { width: 900, height: 700 } });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    if (u.pathname === "/out") {
      posts.push(`${r.request().method()} ${r.request().postData() ?? ""}`);
      return r.fulfill({ contentType: "text/html", body: "signed out" });
    }
    const f = u.pathname.replace(/^\/kit\//, "");
    const file = path.join(SRC, f);
    if (u.pathname.startsWith("/kit/") && fs.existsSync(file))
      return r.fulfill({
        contentType: f.endsWith(".css")
          ? "text/css"
          : f.endsWith(".woff2")
            ? "font/woff2"
            : "text/javascript",
        body: fs.readFileSync(file),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(
    () => (window as { ready?: boolean }).ready === true,
    undefined,
    { timeout: 10_000 },
  );
  return p;
}

interface Drawn {
  html: string;
  /** Each child of the panel, in order: its kind and its text. */
  parts: { kind: string; text: string }[];
  heading: string | null;
  who: string | null;
  how: string | null;
  form: {
    method: string;
    action: string;
    hidden: { name: string; value: string }[];
    button: string;
  } | null;
  /** Elements inside the panel that came from the data (none expected). */
  injected: number;
  /** Any inline colour in the panel's markup. */
  colours: boolean;
}

/** Draws the panel from `data` into the page and reads it back. */
async function draw(p: Page, data: object): Promise<Drawn> {
  return p.evaluate((d) => {
    const k = (
      window as unknown as {
        DenUI: { accountPanelHtml?: (o: object) => string };
      }
    ).DenUI;
    if (typeof k.accountPanelHtml !== "function")
      throw new Error("DenUI.accountPanelHtml is missing");
    const html = k.accountPanelHtml(d);
    const host = document.getElementById("host")!;
    host.innerHTML = html;
    const panel = host.querySelector("[data-den-account-panel]");
    if (!panel) throw new Error("no [data-den-account-panel]");
    const tx = (s: string) =>
      (panel.querySelector(s)?.textContent ?? null)
        ?.replace(/\s+/g, " ")
        .trim() ?? null;
    const kindOf = (el: Element) =>
      el.matches("h1,h2,h3,h4,h5,h6")
        ? "heading"
        : el.matches(".den-acctp-who")
          ? "who"
          : el.matches(".den-acctp-how")
            ? "how"
            : el.matches("form")
              ? "signout"
              : el.tagName.toLowerCase();
    const f = panel.querySelector("form");
    return {
      html,
      parts: [...panel.children].map((el) => ({
        kind: kindOf(el),
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      })),
      heading: tx("h1,h2,h3,h4,h5,h6"),
      who: tx(".den-acctp-who"),
      how: tx(".den-acctp-how"),
      form: f
        ? {
            method: (f.getAttribute("method") ?? "").toLowerCase(),
            action: f.getAttribute("action") ?? "",
            hidden: [
              ...f.querySelectorAll<HTMLInputElement>('input[type="hidden"]'),
            ].map((i) => ({ name: i.name, value: i.value })),
            button: (
              f.querySelector('button[type="submit"]')?.textContent ?? ""
            ).trim(),
          }
        : null,
      injected: panel.querySelectorAll("script, img, b.evil, [onerror]").length,
      colours: /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(html),
    };
  }, data);
}

for (const name of ["chromium", "webkit"]) {
  describe(`accountPanelHtml (${name})`, () => {
    const b = () => browsers[name];

    it("with a name: the name, then @login · Owner, then how, then Sign out", async () => {
      if (!b()) return;
      const p = await open(b()!);
      const d = await draw(p, {
        name: "Odette Lead",
        login: "octo-lead",
        role: "owner",
        how: "github",
        signOut: { url: "/out", csrf: "tok-123" },
        lang: "en",
      });
      expect(d.parts.map((x) => x.kind)).toEqual([
        "heading",
        "who",
        "how",
        "signout",
      ]);
      expect(d.heading).toBe("Odette Lead");
      expect(d.who).toBe("@octo-lead · Owner");
      expect(d.how).toBe("Signed in with GitHub");
      expect(d.form).toEqual({
        method: "post",
        action: "/out",
        hidden: [{ name: "csrf", value: "tok-123" }],
        button: "Sign out",
      });
      expect(d.colours).toBe(false);
      // Sign out posts the form, csrf and all, with no script.
      posts.length = 0;
      await Promise.all([
        p.waitForURL(`${ORIGIN}/out`),
        p.click("[data-den-account-panel] button[type=submit]"),
      ]);
      expect(posts).toEqual(["POST csrf=tok-123"]);
      await p.context().close();
    }, 60_000);

    it("no name: @login is the heading, the role on its own", async () => {
      if (!b()) return;
      const p = await open(b()!);
      const d = await draw(p, {
        login: "@octo-lead",
        role: "member",
        how: "github",
        signOut: { url: "/out", csrf: "t" },
      });
      expect(d.parts.map((x) => x.kind)).toEqual([
        "heading",
        "who",
        "how",
        "signout",
      ]);
      expect(d.heading).toBe("@octo-lead");
      expect(d.who).toBe("Member");
      expect(d.html).not.toContain("@@");
      await p.context().close();
    }, 60_000);

    it("local: no Sign out at all, and how says this computer", async () => {
      if (!b()) return;
      const p = await open(b()!);
      const d = await draw(p, {
        name: "Odette Lead",
        login: "octo-lead",
        role: "owner",
        how: "local",
      });
      expect(d.parts.map((x) => x.kind)).toEqual(["heading", "who", "how"]);
      expect(d.who).toBe("@octo-lead · Owner");
      expect(d.how).toBe("On this computer: no sign-in needed");
      expect(d.form).toBeNull();
      expect(d.html).not.toMatch(/<form|Sign out/);
      // No identity known at all: the kit's Local, nothing else.
      const bare = await draw(p, { how: "local" });
      expect(bare.parts.map((x) => x.kind)).toEqual(["heading", "how"]);
      expect(bare.heading).toBe("Local");
      await p.context().close();
    }, 60_000);

    it("paired: the kit's Local, how says a one-time link or code, Sign out", async () => {
      if (!b()) return;
      const p = await open(b()!);
      const d = await draw(p, {
        how: "paired",
        signOut: { url: "/out", csrf: "t" },
      });
      expect(d.parts.map((x) => x.kind)).toEqual(["heading", "how", "signout"]);
      expect(d.heading).toBe("Local");
      expect(d.how).toBe("Signed in with a one-time link or code");
      expect(d.form?.button).toBe("Sign out");
      await p.context().close();
    }, 60_000);

    it("es and ja: the kit's own words for the role, how and Sign out", async () => {
      if (!b()) return;
      const p = await open(b()!);
      const data = {
        name: "Odette Lead",
        login: "octo-lead",
        role: "owner",
        how: "github",
        signOut: { url: "/out", csrf: "t" },
      };
      const es = await draw(p, { ...data, lang: "es" });
      expect(es.who).toBe("@octo-lead · Propietario");
      expect(es.how).toBe("Has entrado con GitHub");
      expect(es.form?.button).toBe("Salir");
      const ja = await draw(p, { ...data, lang: "ja" });
      expect(ja.who).toBe("@octo-lead · オーナー");
      expect(ja.how).toBe("GitHub でサインイン中");
      expect(ja.form?.button).toBe("サインアウト");
      const esLocal = await draw(p, { how: "local", lang: "es" });
      expect(esLocal.how).toBe("En este ordenador: no hace falta entrar");
      const jaPaired = await draw(p, { how: "paired", lang: "ja" });
      expect(jaPaired.heading).toBe("ローカル");
      expect(jaPaired.how).toBe("ワンタイムリンクまたはコードでサインイン中");
      await p.context().close();
    }, 60_000);

    it("escapes everything: a hostile name, login, role and Sign out", async () => {
      if (!b()) return;
      const p = await open(b()!);
      const evil = `<img src=x onerror="window.pwned=1"><script>window.pwned=2</script><b class="evil">x</b>`;
      const d = await draw(p, {
        name: evil,
        login: `x"><b class="evil">`,
        role: `<b class="evil">boss</b>`,
        how: "github",
        signOut: {
          url: `/out" onclick="window.pwned=3`,
          csrf: `"><b class="evil">`,
        },
      });
      expect(d.injected).toBe(0);
      expect(d.heading).toBe(evil);
      expect(d.form?.action).toBe(`/out" onclick="window.pwned=3`);
      expect(d.form?.hidden).toEqual([
        { name: "csrf", value: `"><b class="evil">` },
      ]);
      expect(
        await p.evaluate(() => (window as { pwned?: number }).pwned ?? 0),
      ).toBe(0);
      await p.context().close();
    }, 60_000);
  });
}
