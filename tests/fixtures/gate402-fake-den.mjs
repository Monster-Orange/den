// A fake bed for gate/402.mjs (tests/unit/test-infra/gate-402-clauses.test.ts): a
// Playwright-like page over a fake Den with two active projects and one inactive, no browser.
//   north  shop, shop/db, common
//   south  blog, common
//   east   (inactive) tools
// `policy` is how the fake Den keeps pins:
//   "good":        (project or none, item), as issue 402's 11-18 model says;
//   "repo-filter": 0.4.66: ids only, and the rail filtered by the item's own project;
//   "one-unpin":   ★ under All unpins one pin of the item, and no Undo;
//   "no-migrate":  an old id-only pin always becomes none.
// `persons` are the person's own pins (old id-only or { item, project }):
// as on a test install (issue 946), a save by the fixture person never
// removes them, and adds nothing already among them.
// The bed's ctx.until answers the ms it took (0 counts) or null, as the real one does.
// Invented names only.

const WORKSPACES = {
  north: { services: { shop: {}, "shop/db": {}, common: {} } },
  south: { services: { blog: {}, common: {} } },
  east: { services: { tools: {} } },
};
const ACTIVE = ["north", "south"];

export function fakeBed({ policy = "good", persons = [] } = {}) {
  let scope = "all";
  let pins = []; // { item, project }
  const den = { policy, saves: 0 };
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
      return { item: p.item, project: p.project ?? null };
    const o = ownersOf(p);
    return {
      item: p,
      project: policy !== "no-migrate" && o.length === 1 ? o[0] : null,
    };
  };
  const dedupe = (list) =>
    list.filter(
      (p, i) =>
        list.findIndex((q) => q.item === p.item && q.project === p.project) ===
        i,
    );
  const own = () => dedupe(persons.map(migrate));
  const store = (list) => {
    den.saves++;
    pins = dedupe([...own(), ...list.map(migrate)]);
    if (policy === "repo-filter")
      pins = dedupe(pins.map((p) => ({ item: p.item, project: null })));
  };

  const page = {
    url: "/",
    project: null,
    toast: null,
    async evaluate(fn, arg) {
      const src = String(fn);
      if (src.includes("getState"))
        return { loaded: true, project: page.project };
      if (src.includes("data-pin-toggle"))
        return inView().map((id) => ({ id, on: isPinned(id) }));
      if (src.includes("den-rail")) return rail();
      if (src.includes("unpin")) return toggle(arg);
      if (src.includes("isPinned")) return isPinned(arg);
      throw new Error(`fake page: no evaluate for ${src.slice(0, 80)}`);
    },
    locator(sel) {
      const pinSel = /^\[data-pin-toggle="([^"]+)"\]$/.exec(sel);
      const here = () =>
        pinSel
          ? inView().includes(pinSel[1])
          : sel === "[data-den-toast] [data-toast-undo]" && !!page.toast;
      const loc = {
        async count() {
          return here() ? 1 : 0;
        },
        first() {
          return loc;
        },
        async click() {
          if (!here()) throw new Error(`fake page: nothing to click at ${sel}`);
          if (pinSel) return toggle(pinSel[1]);
          const back = page.toast;
          page.toast = null;
          store([...pins, ...back]);
        },
      };
      return loc;
    },
  };

  /** The Services page's toggles: the services of the projects in view, each once. */
  function inView() {
    const wss = page.project ? [page.project] : ACTIVE;
    return [
      ...new Set(wss.flatMap((ws) => Object.keys(WORKSPACES[ws].services))),
    ];
  }
  function isPinned(id) {
    if (policy === "repo-filter") return pins.some((p) => p.item === id);
    return pins.some(
      (p) => p.item === id && (!page.project || p.project === page.project),
    );
  }
  function rail() {
    const items =
      policy === "repo-filter"
        ? pins
            .filter(
              (p) => !page.project || ownersOf(p.item).includes(page.project),
            )
            .map((p) => p.item)
        : pins
            .filter((p) => !page.project || p.project === page.project)
            .map((p) => p.item);
    return [...new Set(items)];
  }
  function toggle(id) {
    page.toast = null;
    if (!isPinned(id))
      return store([...pins, { item: id, project: page.project }]);
    if (page.project && policy !== "repo-filter")
      return store(
        pins.filter((p) => !(p.item === id && p.project === page.project)),
      );
    if (policy === "one-unpin" || policy === "repo-filter") {
      const at = pins.findIndex((p) => p.item === id);
      return store(pins.filter((_, i) => i !== at));
    }
    const removed = pins.filter((p) => p.item === id);
    store(pins.filter((p) => p.item !== id));
    page.toast = removed;
  }

  const ctx = {
    page,
    browser: "chromium",
    width: 1280,
    url: "http://bed.invalid",
    async api(path, init) {
      const body = init?.body ? JSON.parse(init.body) : null;
      if (path === "/api/settings") {
        if (body) {
          store(body.shell.pins);
          return { ok: true };
        }
        return { shell: { pins: pins.map((p) => ({ ...p })) } };
      }
      if (path === "/api/scope") {
        if (body) scope = body.scope;
        return { scope };
      }
      if (path === "/api/workspaces")
        return { workspaces: WORKSPACES, active: ACTIVE, focus: "north" };
      return null;
    },
    async goto(p, path) {
      p.url = path;
      p.project = scope === "all" ? null : scope;
      p.toast = null;
    },
    // The real bed's until: the ms it took (0 counts), or null on its time limit.
    async until(f, _ms) {
      for (let i = 0; i < 20; i++) if (await f()) return i;
      return null;
    },
    async sleep() {},
    async shot() {},
  };
  return {
    ctx,
    den,
    scope: () => scope,
    pins: () => pins.map((p) => ({ ...p })),
    seed: (list) => {
      pins = dedupe([...own(), ...list.map((p) => ({ ...p }))]);
    },
  };
}
