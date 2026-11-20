// A fake bed for gate/307.mjs (tests/unit/test-infra/gate-307-runner.test.ts):
// Den's rail as the kit draws it, with pins, a link into Hub, collapse and
// ⌘K. The person has no pin to start with; project "north" has service
// "web/api". `den`:
//   "good":      as Den is;
//   "noTag":     a pinned service has no kind tag;
//   "hostTitle": collapsed, a pin's tooltip is the host's own words;
//   "noProjects": ⌘K lists no projects;
//   "machine":   a tag names the machine;
//   "english":   es and ja tags stay English;
//   "noHub":     no Hub address, so no Hub link;
//   "pinned":    the person has a pin already (the check pins nothing).
// Invented names only.
const WORDS = {
  en: { service: "Service", hub: "Hub" },
  es: { service: "Servicio", hub: "Hub" },
  ja: { service: "サービス", hub: "Hub" },
};
const MACHINE = "studio-7";

export function fakeBed({ den = "good" } = {}) {
  const st = {
    lang: "en",
    pins: den === "pinned" ? ["web/admin"] : [],
    collapsed: false,
    palette: false,
    typed: "",
    sets: [],
  };
  const w = () => (den === "english" ? WORDS.en : WORDS[st.lang]);

  function entry(pin) {
    const kindWord = den === "machine" ? MACHINE : w().service;
    const named = `${pin} · ${kindWord}`;
    return {
      nav: `pin-${pin}`,
      pin,
      kind: den === "noTag" ? null : "service",
      tag: den === "noTag" ? null : kindWord,
      tagLast: den !== "noTag",
      label: pin,
      labelShown: !st.collapsed,
      aria: den === "noTag" ? null : named,
      title: st.collapsed && den === "hostTitle" ? `Open ${pin}` : named,
    };
  }
  function readRail() {
    const hub =
      den === "noHub"
        ? []
        : [
            {
              nav: "hub",
              pin: null,
              kind: "hub",
              tag: "Hub",
              tagLast: true,
              label: "Acme Co",
              labelShown: !st.collapsed,
              aria: "Acme Co · Hub",
              title: "Acme Co · Hub",
            },
          ];
    return {
      lang: st.lang,
      collapsed: st.collapsed,
      entries: [
        ...st.pins.map(entry),
        {
          nav: "agents",
          pin: null,
          kind: null,
          tag: null,
          tagLast: false,
          label: "Agents",
          labelShown: !st.collapsed,
          aria: null,
          title: "Agents",
        },
        ...hub,
      ],
    };
  }

  const page = {
    async waitForSelector(sel) {
      if (sel === "#den-pal-q" && !st.palette) throw new Error("closed");
    },
    async click(sel) {
      if (sel === "#den-search") st.palette = true;
    },
    async fill(_sel, v) {
      st.typed = v;
    },
    async waitForTimeout() {},
    keyboard: {
      async press(k) {
        if (k === "Escape") st.palette = false;
      },
    },
    async evaluate(fn) {
      if (fn.name === "readRail") return readRail();
      return den === "noProjects"
        ? [{ label: "Services", kind: "Page" }]
        : [
            { label: `Go to project ${st.typed}`, kind: "Project" },
            { label: "Services", kind: "Page" },
          ];
    },
  };

  const ctx = {
    url: "http://bed.invalid",
    newPage: () => page,
    async goto() {},
    async shot() {},
    async until(f) {
      for (let i = 0; i < 20; i++) if (await f()) return i * 100;
      return null;
    },
    async fetch(path, init) {
      const body = init?.body ? JSON.parse(init.body) : null;
      if (path === "/api/settings" && !body)
        return {
          status: 200,
          body: {
            language: st.lang,
            shell: { pins: st.pins, collapsed: st.collapsed },
            machine_name: MACHINE,
          },
        };
      if (path === "/api/settings") {
        st.sets.push(body);
        if ("language" in body) st.lang = body.language ?? "en";
        if (body.shell?.pins) st.pins = body.shell.pins;
        if (body.shell && "collapsed" in body.shell)
          st.collapsed = body.shell.collapsed;
        return { status: 200, body: { ok: true } };
      }
      if (path === "/api/workspaces")
        return {
          status: 200,
          body: { workspaces: { north: { services: { "web/api": {} } } } },
        };
      return { status: 404, body: null };
    },
  };
  return {
    ctx,
    state: () => ({ lang: st.lang, pins: st.pins, collapsed: st.collapsed }),
  };
}
