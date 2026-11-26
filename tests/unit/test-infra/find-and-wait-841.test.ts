import { describe, expect, it, jest } from "@jest/globals";
import {
  byLabel,
  byRole,
  describeState,
  settled,
  waitFor,
  type FindPage,
} from "../helpers/find.js";

interface FakeResponse {
  url(): string;
  request(): { method(): string };
}
const res = (url: string, method = "GET"): FakeResponse => ({
  url: () => url,
  request: () => ({ method: () => method }),
});

function fakePage(
  o: { visible?: boolean; respond?: boolean; responses?: FakeResponse[] } = {},
) {
  const calls: unknown[][] = [];
  const locator = (what: unknown[]) => ({
    what,
    waitFor: jest.fn(async (opts: { state: string; timeout: number }) => {
      calls.push(["waitFor", ...what, opts]);
      if (o.visible === false)
        throw new Error(`Timeout ${opts.timeout}ms exceeded.`);
    }),
  });
  const page = {
    getByRole: (role: string, opts: { name: string; exact: boolean }) => {
      calls.push(["getByRole", role, opts]);
      return locator(["role", role, opts.name]);
    },
    getByLabel: (label: string, opts: { exact: boolean }) => {
      calls.push(["getByLabel", label, opts]);
      return locator(["label", label]);
    },
    waitForResponse: (
      match: (r: FakeResponse) => boolean,
      opts: { timeout: number },
    ) => {
      calls.push(["waitForResponse", opts]);
      const seen = o.responses ?? [res("http://x/api/agents?ws=a")];
      const hit = o.respond === false ? undefined : seen.find(match);
      return hit
        ? Promise.resolve(hit)
        : Promise.reject(new Error(`Timeout ${opts.timeout}ms exceeded.`));
    },
  };
  return { page: page as unknown as FindPage, calls };
}

describe("finding by role and label (issue 841)", () => {
  it("byRole matches the accessible name exactly", () => {
    const { page, calls } = fakePage();
    byRole(page, "button", "Save");
    expect(calls[0]).toEqual([
      "getByRole",
      "button",
      { name: "Save", exact: true },
    ]);
  });

  it("byLabel matches the label exactly", () => {
    const { page, calls } = fakePage();
    byLabel(page, "Project name");
    expect(calls[0]).toEqual(["getByLabel", "Project name", { exact: true }]);
  });
});

describe("waiting for a named state, never a sleep (issue 841)", () => {
  it("a dialog open: waits for the dialog with that name to be visible", async () => {
    const { page, calls } = fakePage();
    await waitFor(page, { dialog: "Delete project" }, { timeout: 500 });
    expect(calls).toContainEqual([
      "waitFor",
      "role",
      "dialog",
      "Delete project",
      { state: "visible", timeout: 500 },
    ]);
  });

  it("a row present, and a dialog closed", async () => {
    const { page, calls } = fakePage();
    await waitFor(page, { row: "billing" });
    await waitFor(page, { dialogClosed: "Delete project" });
    expect(calls).toContainEqual(
      expect.arrayContaining(["waitFor", "role", "row", "billing"]),
    );
    expect(calls).toContainEqual([
      "waitFor",
      "role",
      "dialog",
      "Delete project",
      expect.objectContaining({ state: "hidden" }),
    ]);
  });

  it("uses the suite's wait (DEN_BROWSER_WAIT_MS) when no timeout is given", async () => {
    const { page, calls } = fakePage();
    await waitFor(page, { row: "billing" });
    const last = calls.at(-1) as unknown[];
    expect((last.at(-1) as { timeout: number }).timeout).toBeGreaterThan(0);
  });

  it("a wait that runs out names the state, the time and the reason", async () => {
    const { page } = fakePage({ visible: false });
    await expect(
      waitFor(page, { dialog: "Delete project" }, { timeout: 250 }),
    ).rejects.toThrow(
      /waited 250 ms for the dialog "Delete project" to open: Timeout 250ms exceeded/,
    );
  });

  it("each state reads as words", () => {
    expect(describeState({ dialog: "A" })).toBe('the dialog "A" to open');
    expect(describeState({ dialogClosed: "A" })).toBe(
      'the dialog "A" to close',
    );
    expect(describeState({ row: "b" })).toBe('a row "b"');
  });
});

describe("a request settled (issue 841)", () => {
  it("arms the wait before the action, so a fast response is never missed", async () => {
    const { page, calls } = fakePage();
    const order: string[] = [];
    const r = await settled(page, "/api/agents", async () => {
      order.push(String(calls.at(-1)?.[0]));
    });
    expect(order).toEqual(["waitForResponse"]);
    expect(r.url()).toContain("/api/agents");
  });

  it("a string is the exact path: a sibling path or a poll that lands first never resolves it", async () => {
    const { page } = fakePage({
      responses: [
        res("http://x/api/agents/stale"),
        res("http://x/api/agents?ws=a", "GET"),
        res("http://x/api/agents", "POST"),
      ],
    });
    const r = await settled<FakeResponse>(
      page,
      "/api/agents",
      async () => undefined,
      {
        method: "POST",
      },
    );
    expect(r.request().method()).toBe("POST");
    const { page: only } = fakePage({
      responses: [res("http://x/api/agents/stale")],
    });
    await expect(
      settled(only, "/api/agents", async () => undefined, { timeout: 50 }),
    ).rejects.toThrow(/waited 50 ms for a response from \/api\/agents/);
  });

  it("the method is matched in any case, and named when nothing comes", async () => {
    const { page } = fakePage({
      responses: [res("http://x/api/agents", "GET")],
    });
    await expect(
      settled(page, "/api/agents", async () => undefined, {
        method: "post",
        timeout: 60,
      }),
    ).rejects.toThrow(/waited 60 ms for a POST response from \/api\/agents/);
  });

  it("a RegExp matches the whole URL, for anything looser", async () => {
    const { page } = fakePage({
      responses: [res("http://x/api/agents/stale")],
    });
    const r = await settled(page, /\/api\/agents/, async () => undefined);
    expect(r.url()).toContain("/api/agents/stale");
  });

  it("a response that never comes names the URL and the time", async () => {
    const { page } = fakePage({ respond: false });
    await expect(
      settled(page, "/api/agents", async () => undefined, { timeout: 300 }),
    ).rejects.toThrow(/waited 300 ms for a response from \/api\/agents/);
  });
});
