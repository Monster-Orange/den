/**
 * Issue 1205: pw-guard's connectGuarded returns a browser that's already
 * guarded. A setup that calls it alone, with the loopback exposed
 * (DEN_PW_EXPOSE), must not get a box browser that can load any port on
 * this machine.
 *
 *  1. Exposed: every context it makes (newContext and newPage) loads only
 *     DEN_GATE_ALLOW's host:ports, and each block is reported.
 *  2. Exposed with no DEN_GATE_ALLOW: it blocks everything; never
 *     exposed and unguarded.
 *  3. guardBrowser on the result again changes nothing (one route per
 *     context, the same answers).
 *  Not exposed: the browser is as Playwright gave it.
 *
 * A fake browser with Playwright's shapes: the guard works through route
 * handlers, so no real browser is needed.
 */
import { describe, expect, it } from "@jest/globals";
import {
  connectGuarded,
  guardBrowser,
} from "../../../src/shared/gates/pw-guard.js";

type Handler = (r: {
  request(): { url(): string };
  continue(): Promise<unknown>;
  abort(code?: string): Promise<unknown>;
}) => Promise<void>;

interface FakeCtx {
  options: Record<string, unknown>;
  handlers: Handler[];
  route(p: string, h: Handler): Promise<void>;
  newPage(): Promise<{ context(): FakeCtx; once(): void }>;
  close(): Promise<void>;
}

function fakeCtx(options: Record<string, unknown> = {}): FakeCtx {
  const ctx: FakeCtx = {
    options,
    handlers: [],
    route: (_p, h) => {
      ctx.handlers.push(h);
      return Promise.resolve();
    },
    newPage: () => Promise.resolve({ context: () => ctx, once: () => {} }),
    close: () => Promise.resolve(),
  };
  return ctx;
}

/** Playwright's shapes: newPage makes its own context, not via newContext. */
function fakeBrowser() {
  const made: FakeCtx[] = [];
  const b = {
    made,
    newContext: (o: Record<string, unknown> = {}) => {
      const c = fakeCtx(o);
      made.push(c);
      return Promise.resolve(c);
    },
    newPage: async () => {
      const c = fakeCtx();
      made.push(c);
      return c.newPage();
    },
  };
  return b;
}

/** What the context's route handlers do with `url`. */
async function load(ctx: FakeCtx, url: string): Promise<string> {
  if (!ctx.handlers.length) return "unguarded";
  let out = "";
  for (const h of ctx.handlers) {
    let said = "";
    await h({
      request: () => ({ url: () => url }),
      continue: () => Promise.resolve((said = "continue")),
      abort: () => Promise.resolve((said = "abort")),
    });
    if (said === "abort") return "abort";
    out = said;
  }
  return out;
}

const type = (b: ReturnType<typeof fakeBrowser>) => ({
  connect: (_ws: string, _o: unknown) => Promise.resolve(b),
});

const BOX = {
  DEN_GATE_SLOT_BOX: "b1",
  DEN_PW_EXPOSE: "<loopback>",
  DEN_GATE_ALLOW: "127.0.0.1:4100",
} as NodeJS.ProcessEnv;

describe("issue 1205: connectGuarded returns a guarded browser", () => {
  it("1. exposed: a new context loads only DEN_GATE_ALLOW, and each block is reported", async () => {
    const said: string[] = [];
    const b = await connectGuarded(
      type(fakeBrowser()),
      "ws://b1.test:3000",
      {},
      BOX,
      (l) => said.push(l),
    );
    const ctx = (await b.newContext()) as unknown as FakeCtx;
    expect(await load(ctx, "http://127.0.0.1:4100/")).toBe("continue");
    expect(await load(ctx, "http://127.0.0.1:5555/")).toBe("abort");
    expect(await load(ctx, "http://127.0.0.1:80/")).toBe("abort");
    expect(said).toEqual([
      "pw-guard: refused http://127.0.0.1:5555/",
      "pw-guard: refused http://127.0.0.1:80/",
    ]);
    expect(ctx.options.serviceWorkers).toBe("block");
  });

  it("1. exposed: newPage's own context is guarded too", async () => {
    const fb = fakeBrowser();
    const b = await connectGuarded(
      type(fb),
      "ws://b1.test:3000",
      {},
      BOX,
      () => {},
    );
    const page = await b.newPage();
    const ctx = page.context() as FakeCtx;
    expect(await load(ctx, "http://127.0.0.1:5555/")).toBe("abort");
    expect(await load(ctx, "http://127.0.0.1:4100/")).toBe("continue");
  });

  it("1. a caller's own exposeNetwork counts as exposed too", async () => {
    const env = { DEN_GATE_ALLOW: "127.0.0.1:4100" } as NodeJS.ProcessEnv;
    const b = await connectGuarded(
      type(fakeBrowser()),
      "ws://x.test:3000",
      { exposeNetwork: "<loopback>" },
      env,
      () => {},
    );
    const ctx = (await b.newContext()) as unknown as FakeCtx;
    expect(await load(ctx, "http://127.0.0.1:5555/")).toBe("abort");
  });

  it("1. the caller may give its own allow list and block reporter", async () => {
    const blocked: string[] = [];
    const b = await connectGuarded(
      type(fakeBrowser()),
      "ws://b1.test:3000",
      {},
      BOX,
      () => {},
      { allow: ["127.0.0.1:4200"], onBlock: (u) => blocked.push(u) },
    );
    const ctx = (await b.newContext()) as unknown as FakeCtx;
    expect(await load(ctx, "http://127.0.0.1:4200/")).toBe("continue");
    expect(await load(ctx, "http://127.0.0.1:4100/")).toBe("abort");
    expect(blocked).toEqual(["http://127.0.0.1:4100/"]);
  });

  it("2. exposed with no DEN_GATE_ALLOW: everything is blocked, never unguarded", async () => {
    const env = {
      DEN_GATE_SLOT_BOX: "b1",
      DEN_PW_EXPOSE: "<loopback>",
    } as NodeJS.ProcessEnv;
    const b = await connectGuarded(
      type(fakeBrowser()),
      "ws://b1.test:3000",
      {},
      env,
      () => {},
    );
    const ctx = (await b.newContext()) as unknown as FakeCtx;
    for (const u of [
      "http://127.0.0.1:4100/",
      "http://localhost:5555/",
      "https://example.com/",
    ])
      expect(await load(ctx, u)).toBe("abort");
  });

  it("3. guardBrowser on the result again changes nothing", async () => {
    const said: string[] = [];
    const say = (l: string) => said.push(l);
    const b = await connectGuarded(
      type(fakeBrowser()),
      "ws://b1.test:3000",
      {},
      BOX,
      say,
    );
    const again = guardBrowser(b, ["127.0.0.1:4100"]);
    expect(again).toBe(b);
    const ctx = (await b.newContext()) as unknown as FakeCtx;
    expect(ctx.handlers).toHaveLength(1);
    expect(await load(ctx, "http://127.0.0.1:4100/")).toBe("continue");
    expect(await load(ctx, "http://127.0.0.1:5555/")).toBe("abort");
    expect(said).toEqual(["pw-guard: refused http://127.0.0.1:5555/"]);
  });

  it("3. a second guard can only narrow: a wider list never loosens the first", async () => {
    const b = await connectGuarded(
      type(fakeBrowser()),
      "ws://b1.test:3000",
      {},
      BOX,
      () => {},
    );
    guardBrowser(b, ["127.0.0.1:4100", "127.0.0.1:5555"]);
    const ctx = (await b.newContext()) as unknown as FakeCtx;
    expect(ctx.handlers).toHaveLength(1);
    expect(await load(ctx, "http://127.0.0.1:5555/")).toBe("abort");
  });

  it("3. a second guard's reporter hears its blocks", async () => {
    const mine: string[] = [];
    const b = await connectGuarded(
      type(fakeBrowser()),
      "ws://b1.test:3000",
      {},
      BOX,
      () => {},
    );
    guardBrowser(b, ["127.0.0.1:4100"], (u) => mine.push(u));
    const ctx = (await b.newContext()) as unknown as FakeCtx;
    expect(await load(ctx, "http://127.0.0.1:5555/")).toBe("abort");
    expect(mine).toEqual(["http://127.0.0.1:5555/"]);
  });

  it("not exposed: the browser is as Playwright gave it", async () => {
    const fb = fakeBrowser();
    const b = await connectGuarded(
      type(fb),
      "ws://x.test:3000",
      {},
      {},
      () => {},
    );
    expect(b).toBe(fb);
    const ctx = (await b.newContext()) as unknown as FakeCtx;
    expect(ctx.handlers).toHaveLength(0);
  });

  it("if guarding fails after the connect, the browser is closed and the error thrown", async () => {
    let closed = 0;
    // No newContext: guardBrowser cannot wrap it, so guarding throws.
    const broken = { close: () => Promise.resolve(void closed++) };
    await expect(
      connectGuarded(
        { connect: () => Promise.resolve(broken as never) },
        "ws://b1.test:3000",
        {},
        BOX,
        () => {},
      ),
    ).rejects.toThrow();
    expect(closed).toBe(1);
  });
});
