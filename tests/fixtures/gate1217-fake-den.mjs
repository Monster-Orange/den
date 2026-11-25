// A fake bed for gate/1217.mjs (tests/unit/test-infra/gate-1217-clauses.test.ts): a page and an
// API over a fake Den with two projects, no browser.
//   north  shop, shop/db, common
//   south  blog, common
// `policy` is how the fake Den loads an old id-only pin:
//   "good":      issue 1217: a pin in each project whose repos include its repo, else none;
//   "one-owner": 0.4.85: the one owner's project, else none (a repo in two projects loses both);
//   "no-doctor": as "good", but doctor lists no pin kept with no project.
// Invented names only.

const WORKSPACES = {
  north: { services: { shop: {}, "shop/db": {}, common: {} } },
  south: { services: { blog: {}, common: {} } },
};

export function fakeBed({ policy = "good" } = {}) {
  let scope = "all";
  let pins = [];
  const ownersOf = (item) => {
    const repo = item.split("/")[0];
    return Object.keys(WORKSPACES).filter((ws) =>
      Object.keys(WORKSPACES[ws].services).some(
        (k) => k.split("/")[0] === repo,
      ),
    );
  };
  const migrate = (p) => {
    if (typeof p !== "string")
      return [{ item: p.item, project: p.project ?? null }];
    const o = ownersOf(p);
    if (policy === "one-owner")
      return [{ item: p, project: o.length === 1 ? o[0] : null }];
    return o.length
      ? o.map((project) => ({ item: p, project }))
      : [{ item: p, project: null }];
  };
  const page = {
    project: null,
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes("getState"))
        return { loaded: true, project: page.project };
      if (src.includes("den-rail"))
        return [
          ...new Set(
            pins
              .filter((p) => !page.project || p.project === page.project)
              .map((p) => p.item),
          ),
        ];
      throw new Error(`fake page: no evaluate for ${src.slice(0, 80)}`);
    },
  };
  const ctx = {
    page,
    browser: "chromium",
    width: 1280,
    async api(path, init) {
      const body = init?.body ? JSON.parse(init.body) : null;
      if (path === "/api/settings") {
        if (body) {
          pins = body.shell.pins.flatMap(migrate);
          return { ok: true };
        }
        return { shell: { pins: pins.map((p) => ({ ...p })) } };
      }
      if (path === "/api/scope") {
        if (body) scope = body.scope;
        return { scope };
      }
      if (path === "/api/workspaces")
        return { workspaces: WORKSPACES, active: ["north", "south"] };
      return null;
    },
    async goto(p) {
      p.project = scope === "all" ? null : scope;
    },
    cli(args) {
      if (args[0] !== "doctor") return { code: 2, out: "", err: "no such" };
      const kept =
        policy === "no-doctor"
          ? []
          : pins.filter((p) => p.project === null).map((p) => p.item);
      const lines = kept.map(
        (k) => `  kept, no project  ·  ${k} (shown under All)`,
      );
      return {
        code: 0,
        out: ["Den doctor: Pins", ...lines].join("\n"),
        err: "",
      };
    },
    async until(f) {
      for (let i = 0; i < 20; i++) if (await f()) return i;
      return null;
    },
    async shot() {},
  };
  return {
    ctx,
    scope: () => scope,
    pins: () => pins.map((p) => ({ ...p })),
    seed: (list) => {
      pins = list.map((p) => ({ ...p }));
    },
  };
}
