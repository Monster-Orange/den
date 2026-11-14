/**
 * FB (den#81): Report an issue, the dialog (report-dialog.js) in the page.
 * The rail's Report button and ⌘⇧F open it, over an open dialog too; the
 * three steps; the preview is the server's exact text with the public
 * warning above Send; F4 (the device code), F5, F6, F7, F8; Esc with text
 * typed asks to keep it; en, es and ja at 390 and 1440; feedback.enabled:
 * false hides it.
 *
 * Every /api/report call is answered by the test (never the real `gh`).
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

// A page load, then the dialog: the first warms the browser up.
jest.setTimeout(30_000);

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

/** What the fake report routes answer, and what they were sent. */
interface Fake {
  sent: Record<string, unknown>[];
  drafts: Record<string, unknown>[];
  /** /api/report/send's answer: [status, body]. */
  send: [number, Record<string, unknown>];
  /** /api/report/github-send's answer, then the flow's polls. */
  app?: Record<string, unknown>;
  polls?: Record<string, unknown>[];
  settings?: Record<string, unknown>;
}

const PREVIEW = {
  ok: true,
  title: "Pane drops at <host-1>",
  body: "**Kind:** bug\n**Title:** Pane drops at <host-1>\n\nIt drops.\n\n_Reported from Den_",
  repo: "acme-eng/engine",
};

async function page(fake: Fake, width = 1440): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  // What's new opens on a new version's first visit, over the rail.
  await p.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const json = (r: Route, status: number, body: unknown) =>
    r.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  await p.route("**/api/report**", async (r) => {
    const u = new URL(r.request().url());
    const body = r.request().postDataJSON?.() ?? null;
    if (u.pathname === "/api/report")
      return json(r, 200, {
        ok: true,
        enabled: true,
        repos: [{ repo: "acme-eng/engine" }],
        github: { signedIn: true, deviceFlow: true },
        maxPerHour: 5,
        sentThisHour: 0,
      });
    if (u.pathname === "/api/report/diagnostics")
      return json(r, 200, {
        ok: true,
        sections: { Den: "acme 9.9.9", Machine: "os: Linux" },
      });
    if (u.pathname === "/api/report/preview") return json(r, 200, PREVIEW);
    if (u.pathname === "/api/report/send") {
      fake.sent.push(body);
      return json(r, fake.send[0], fake.send[1]);
    }
    if (u.pathname === "/api/report/drafts") {
      fake.drafts.push(body);
      return json(r, 200, { ok: true, draft: { id: "0123456789abcdef" } });
    }
    if (u.pathname === "/api/report/github-send") {
      fake.sent.push({ ...body, via: "app" });
      return json(r, 200, fake.app ?? {});
    }
    if (u.pathname.startsWith("/api/report/github-send/"))
      return json(
        r,
        200,
        fake.polls?.shift() ?? { ok: true, flow: { state: "pending" } },
      );
    return json(r, 404, { ok: false });
  });
  if (fake.settings)
    await p.route("**/api/settings", async (r) => {
      if (r.request().method() !== "GET") return r.continue();
      const res = await r.fetch();
      const j = await res.json();
      await r.fulfill({ response: res, json: { ...j, ...fake.settings } });
    });
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  return p;
}

const fresh = (
  send: Fake["send"] = [
    200,
    {
      ok: true,
      url: "https://github.com/acme-eng/engine/issues/42",
      repo: "acme-eng/engine",
      added: false,
    },
  ],
): Fake => ({
  sent: [],
  drafts: [],
  send,
});

const dlg = (p: Page) => p.locator("dialog.fb-dlg");

/** Write a title and go through Include to Review. */
async function toReview(p: Page) {
  await dlg(p)
    .locator('[data-f="title"]')
    .fill("Pane drops at acme.local.example.com");
  await dlg(p).locator('[data-f="description"]').fill("It drops.");
  await dlg(p).locator('[data-act="next"]').click();
  await dlg(p).locator('[data-act="review"]').click();
  await dlg(p)
    .locator("[data-preview]")
    .getByText("Pane drops at <host-1>")
    .first()
    .waitFor();
}

describe("FB: Report an issue, the dialog", () => {
  it("the rail's Report button opens it; focus starts on Title", async () => {
    if (skip()) return;
    const p = await page(fresh());
    const btn = p.locator('#den-shell [data-act="report"]');
    await expect(btn.textContent()).resolves.toMatch(/Report an issue/);
    await btn.click();
    await dlg(p).waitFor();
    expect(await dlg(p).getAttribute("aria-label")).toBe("Report an issue");
    expect(
      await p.evaluate(() => document.activeElement?.getAttribute("data-f")),
    ).toBe("title");
    await p.context().close();
  });

  it("⌘⇧F opens it over an open dialog, which stays open", async () => {
    if (skip()) return;
    const p = await page(fresh());
    await p.evaluate(() => {
      const d = document.createElement("dialog");
      d.id = "other";
      d.setAttribute("aria-label", "Change colour");
      d.innerHTML = "<p>colour</p>";
      document.body.append(d);
      d.showModal();
    });
    await p.keyboard.press("ControlOrMeta+Shift+F");
    await dlg(p).waitFor();
    expect(
      await p.locator("#other").evaluate((d) => (d as HTMLDialogElement).open),
    ).toBe(true);
    // The report dialog is the one on top (it takes the clicks).
    await dlg(p).locator('[data-f="title"]').fill("x");
    await p.context().close();
  });

  it("Write, Include, Review: the server's exact text, the public warning just above Send; Send files it (F6)", async () => {
    if (skip()) return;
    const f = fresh();
    const p = await page(f);
    await p.keyboard.press("ControlOrMeta+Shift+F");
    await dlg(p).waitFor();
    // A title is needed first.
    await dlg(p).locator('[data-act="next"]').click();
    await dlg(p).getByRole("alert").getByText("A title is needed.").waitFor();
    await dlg(p)
      .locator('[data-f="title"]')
      .fill("Pane drops at acme.local.example.com");
    await dlg(p).locator('[data-act="next"]').click();
    // Include: each section's exact text, ticked; Den and Machine from the
    // server, Browser and Page from the page.
    for (const n of ["acme", "Machine", "Browser", "Page"])
      await dlg(p).locator("summary b", { hasText: n }).first().waitFor();
    expect(await dlg(p).locator("[data-sec]:checked").count()).toBe(4);
    await dlg(p).locator('[data-act="none"]').click();
    expect(await dlg(p).locator("[data-sec]:checked").count()).toBe(0);
    await dlg(p).locator('[data-act="all"]').click();
    await dlg(p).locator('[data-act="review"]').click();
    await dlg(p)
      .locator("[data-preview]")
      .getByText(/\*\*Kind:\*\* bug/)
      .waitFor();
    const order = await dlg(p).evaluate((d) =>
      [...d.querySelectorAll(".fb-warn, [data-act='send']")].map((e) =>
        e.classList.contains("fb-warn") ? "warn" : "send",
      ),
    );
    expect(order).toEqual(["warn", "send"]);
    await dlg(p).locator('[data-act="send"]').click();
    await dlg(p).getByRole("heading", { name: "Report sent" }).waitFor();
    expect(
      await dlg(p)
        .getByRole("link", { name: "Open the issue" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme-eng/engine/issues/42");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      kind: "bug",
      title: "Pane drops at acme.local.example.com",
      redact: true,
      repo: "acme-eng/engine",
    });
    expect(Object.keys(f.sent[0].client as object).sort()).toEqual([
      "Browser",
      "Page",
    ]);
    await p.context().close();
  });

  it("not signed in to GitHub: F4 shows Den's GitHub App's code, nothing is sent until it is approved", async () => {
    if (skip()) return;
    const f = fresh([
      409,
      {
        ok: false,
        need: "github",
        deviceFlow: true,
        newIssueUrl: "https://github.com/acme-eng/engine/issues/new?title=x",
      },
    ]);
    f.app = {
      ok: true,
      flow: {
        id: "f".repeat(32),
        state: "pending",
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
      },
      newIssueUrl: "https://github.com/acme-eng/engine/issues/new?title=x",
    };
    f.polls = [
      { ok: true, flow: { state: "pending" } },
      {
        ok: true,
        flow: {
          state: "ok",
          result: {
            url: "https://github.com/acme-eng/engine/issues/43",
            added: false,
          },
        },
      },
    ];
    const p = await page(f);
    await p.keyboard.press("ControlOrMeta+Shift+F");
    await toReview(p);
    await dlg(p).locator('[data-act="send"]').click();
    await dlg(p)
      .getByRole("heading", { name: "Sign in with GitHub to send" })
      .waitFor();
    expect((await dlg(p).locator(".fb-code").textContent())?.trim()).toBe(
      "WDJB-MJHT",
    );
    expect(
      await dlg(p)
        .getByRole("link", { name: "Open github.com/login/device" })
        .getAttribute("href"),
    ).toBe("https://github.com/login/device");
    expect(
      await dlg(p)
        .getByRole("link", { name: "Open a filled-in GitHub tab" })
        .getAttribute("href"),
    ).toMatch(/issues\/new\?title=/);
    await dlg(p)
      .getByRole("heading", { name: "Report sent" })
      .waitFor({ timeout: 10_000 });
    expect(
      await dlg(p)
        .getByRole("link", { name: "Open the issue" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme-eng/engine/issues/43");
    await p.context().close();
  });

  it("a sixth in an hour: F7, and Finish later keeps it (F8)", async () => {
    if (skip()) return;
    const f = fresh([
      429,
      {
        ok: false,
        limit: 5,
        nextAt: new Date(Date.now() + 23 * 60_000).toISOString(),
      },
    ]);
    const p = await page(f);
    await p.keyboard.press("ControlOrMeta+Shift+F");
    await toReview(p);
    await dlg(p).locator('[data-act="send"]').click();
    await dlg(p)
      .getByRole("heading", { name: "You have sent 5 reports this hour" })
      .waitFor();
    expect(await dlg(p).getAttribute("role")).toBe("alertdialog");
    await dlg(p)
      .getByText(/Try again in 2[34] minutes/)
      .waitFor();
    await dlg(p).locator('[data-act="later"]').click();
    await dlg(p)
      .getByRole("heading", { name: "Saved. Nothing was sent." })
      .waitFor();
    expect(f.drafts).toHaveLength(1);
    expect(f.drafts[0]).toMatchObject({
      title: "Pane drops at acme.local.example.com",
    });
    await p.context().close();
  });

  it("the same title open: F5; Add to the existing report sends addTo", async () => {
    if (skip()) return;
    const f = fresh([
      409,
      {
        ok: false,
        duplicate: {
          number: 7,
          title: "Pane drops at <host-1>",
          url: "https://github.com/acme-eng/engine/issues/7",
        },
      },
    ]);
    const p = await page(f);
    await p.keyboard.press("ControlOrMeta+Shift+F");
    await toReview(p);
    await dlg(p).locator('[data-act="send"]').click();
    await dlg(p)
      .getByRole("heading", {
        name: "A report with this title is already open",
      })
      .waitFor();
    expect(await dlg(p).getAttribute("role")).toBe("alertdialog");
    f.send = [
      200,
      {
        ok: true,
        url: "https://github.com/acme-eng/engine/issues/7#c",
        added: true,
      },
    ];
    await dlg(p).locator('[data-act="addto"]').click();
    await dlg(p)
      .getByText("Your details were added to the open report.")
      .waitFor();
    expect(f.sent[1]).toMatchObject({ addTo: 7 });
    await p.context().close();
  });

  it("Esc with text typed asks to keep it; Discard closes", async () => {
    if (skip()) return;
    const p = await page(fresh());
    await p.keyboard.press("ControlOrMeta+Shift+F");
    await dlg(p).locator('[data-f="title"]').fill("half a thought");
    await p.keyboard.press("Escape");
    await dlg(p)
      .getByRole("heading", { name: "Keep what you wrote?" })
      .waitFor();
    await dlg(p).locator('[data-act="discard"]').click();
    await dlg(p).waitFor({ state: "detached" });
    // Nothing typed: Esc just closes.
    await p.keyboard.press("ControlOrMeta+Shift+F");
    await dlg(p).waitFor();
    await p.keyboard.press("Escape");
    await dlg(p).waitFor({ state: "detached" });
    await p.context().close();
  });

  it("at 390 px it is a bottom sheet with stacked buttons, the step as 1/3", async () => {
    if (skip()) return;
    const p = await page(fresh(), 390);
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { report(): Promise<unknown> } }
      ).denShell.report(),
    );
    await dlg(p).waitFor();
    const box = await dlg(p).boundingBox();
    expect(Math.round(box!.width)).toBe(390);
    expect(Math.round(box!.y + box!.height)).toBe(900);
    const btns = await dlg(p)
      .locator(".fb-btns button")
      .evaluateAll((bs) =>
        bs.map((b) => Math.round(b.getBoundingClientRect().width)),
      );
    expect(new Set(btns).size).toBe(1);
    expect(await dlg(p).locator(".fb-steps .fb-narrow").isVisible()).toBe(true);
    expect(
      (await dlg(p).locator(".fb-steps .fb-narrow").textContent())?.trim(),
    ).toMatch(/^1\/3 · Write$/);
    await p.context().close();
  });

  it("feedback.enabled: false hides the rail's Report and ⌘⇧F", async () => {
    if (skip()) return;
    const f = fresh();
    f.settings = { feedback_enabled: false };
    const p = await page(f);
    await p
      .locator('#den-shell [data-act="report"]')
      .waitFor({ state: "detached" });
    await p.keyboard.press("ControlOrMeta+Shift+F");
    await p.waitForTimeout(300);
    expect(await dlg(p).count()).toBe(0);
    await p.context().close();
  });

  it("in es and ja (1440 and 390)", async () => {
    if (skip()) return;
    for (const [lang, title, send] of [
      ["es", "Informar de un problema", "Siguiente: Incluir"],
      ["ja", "問題を報告", "次へ: 含める"],
    ] as const) {
      await s!.settings({ language: lang });
      for (const w of [1440, 390]) {
        const p = await page(fresh(), w);
        await p.waitForFunction(
          (l) => document.documentElement.lang === l,
          lang,
        );
        await p.evaluate(() =>
          (
            window as unknown as { denShell: { report(): Promise<unknown> } }
          ).denShell.report(),
        );
        await dlg(p).waitFor();
        expect(await dlg(p).getAttribute("aria-label")).toBe(title);
        expect(
          (await dlg(p).locator('[data-act="next"]').textContent())?.trim(),
        ).toBe(send);
        expect(
          await dlg(p).evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
        ).toBe(true);
        await p.context().close();
      }
    }
    await s!.settings({ language: "en" });
  });

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
