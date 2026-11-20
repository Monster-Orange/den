// A fake bed for gate/267.mjs (tests/unit/test-infra/gate-267-runner.test.ts):
// Settings › Hub on a Den with no Hub address. The page's Save writes
// hub.url to user.yml and restarts Den (a new pid), Clear removes it.
// `den`:
//   "built":      as Den is: the section names docs/hub.md in its text, no link;
//   "fixed":      the same, with a "What is Hub?" link to the doc;
//   "noRestart":  Save writes the address, and Den never restarts;
//   "noInline":   the page doesn't check the address as it is typed;
//   "oldSection": Hub's bell rows are still under Notifications;
//   "hubSet":     the bed has a Hub address already (the writes aren't run);
//   "heldOff":    the bed turned held writes off.
// Invented names only.
const NAV = [
  "appearance",
  "editor",
  "navigation",
  "graph",
  "workspace",
  "agents",
  "hub",
  "notifications",
  "access",
  "embed",
  "secrets",
  "server",
  "cli",
  "distribution",
];
const WORDS = {
  en: {
    description:
      "Den Hub is where your company's docs, mocks, comments and approvals live. See docs/hub.md in Den's docs.",
    connectNote: "Connect also links each project here to its Hub project.",
    saveLabel: "Save",
    empty: "No Hub yet. Type your company's Hub address, then Connect.",
    agentsHub: "Connect this install. Every agent then gets Hub's tools.",
    saved: "Saved. Den restarted with Hub's new address.",
    cleared: "Cleared. Den restarted without Hub.",
  },
  es: {
    description: "Den Hub es donde viven los documentos de tu empresa.",
    connectNote: "Conectar también vincula cada proyecto.",
    saveLabel: "Guardar",
    empty: "Aún no hay Hub.",
    agentsHub: "Cada agente obtiene las herramientas de Hub.",
  },
  ja: {
    description: "Den Hub は、会社のドキュメントが集まる場所です。",
    connectNote: "接続すると、各プロジェクトもリンクされます。",
    saveLabel: "保存",
    empty: "Hub はまだありません。",
    agentsHub: "すべてのエージェントが Hub のツールを使えます。",
  },
};
const PROBLEM =
  "Hub's address must be https (http only to this machine): http://gate-267.invalid";

const HUB_MD = `# Den Hub

Den Hub is a hosted service your company shares.

## What you get

## Connect

Everything happens in **Settings › Hub**.

### Disconnect

## What agents get

## Notifications from Hub

## Troubleshooting
`;

export function fakeBed({ den = "built" } = {}) {
  const st = {
    lang: "en",
    url: den === "hubSet" ? "https://hub.example.test" : null,
    pid: 100,
    typed: "",
    flash: null,
    busy: false,
    approvals: [],
    restarts: 0,
  };
  const problemOf = (v) => (/^https:\/\//.test(v) || !v ? null : PROBLEM);
  const restart = () => {
    st.pid++;
    st.restarts++;
  };
  const userYml = () =>
    st.url
      ? `language: ${st.lang}\nhub:\n  url: ${st.url}\n`
      : `language: ${st.lang}\n`;
  const w = () => WORDS[st.lang];

  function read() {
    const rows = [
      "agents.hub",
      "agents.hub_link_all",
      ...(den === "oldSection"
        ? []
        : ["notifications.hub", "notifications.pick", "notifications.shared"]),
    ];
    return {
      lang: st.lang,
      nav: den === "oldSection" ? NAV.filter((c) => c !== "hub") : NAV,
      section: true,
      title: "Hub",
      description: w().description,
      links:
        den === "fixed"
          ? [
              {
                href: "https://docs.example.test/docs/hub.md",
                text: "What is Hub?",
              },
            ]
          : [],
      rows,
      agentsHub: w().agentsHub,
      address: st.typed,
      connect: "Connect",
      disconnect: false,
      saveLabel: w().saveLabel,
      clear: !!st.url,
      empty: st.url ? null : w().empty,
      connectNote: w().connectNote,
      state: null,
      flash: st.flash ? { ok: "ok", text: st.flash } : null,
      error: null,
    };
  }

  function press(action) {
    st.busy = true;
    if (action === "save-url") {
      st.url = st.typed;
      if (den !== "noRestart") restart();
      st.flash = WORDS.en.saved;
    } else if (action === "clear-url") {
      st.url = null;
      st.typed = "";
      restart();
      st.flash = WORDS.en.cleared;
    } else return false;
    return true;
  }

  const page = {
    async evaluate(_fn, { op, arg }) {
      if (op === "type") {
        st.typed = arg;
        const p = den === "noInline" ? null : problemOf(arg);
        return { problem: p, saveDisabled: den === "noInline" ? false : !!p };
      }
      if (op === "press") return press(arg);
      if (op === "busy") return st.busy;
      return read();
    },
    async waitForSelector() {},
  };

  const ctx = {
    url: "http://bed.invalid",
    newPage: () => page,
    async goto() {
      st.flash = null;
      st.busy = false;
      st.typed = st.url ?? "";
    },
    async shot() {},
    async until(f) {
      for (let i = 0; i < 20; i++) if (await f()) return i * 100;
      return null;
    },
    async fetch(path, init) {
      const body = init?.body ? JSON.parse(init.body) : null;
      if (path === "/api/server-info")
        return { status: 200, body: { pid: st.pid, startedAt: `t${st.pid}` } };
      if (path === "/api/hub")
        return {
          status: 200,
          body: st.url
            ? {
                configured: true,
                url: st.url,
                connected: false,
                state: "no_token",
              }
            : { configured: false },
        };
      if (path === "/api/settings" && !body)
        return { status: 200, body: { language: st.lang } };
      if (path === "/api/settings") {
        if ("language" in body) st.lang = body.language ?? "en";
        if ("hub_url" in body) {
          const p = problemOf(body.hub_url ?? "");
          if (p) return { status: 400, body: PROBLEM };
          st.url = body.hub_url || null;
        }
        return { status: 200, body: { ok: true } };
      }
      if (path === "/api/web/restart") {
        restart();
        return { status: 200, body: {} };
      }
      if (path === "/api/approvals") {
        if (den === "heldOff")
          return {
            status: 403,
            body: { ok: false, code: "approvals_off", error: "off" },
          };
        const p = problemOf(body.args?.url ?? "");
        if (p)
          return {
            status: 400,
            body: { ok: false, code: "invalid_args", error: PROBLEM },
          };
        st.approvals.push(body);
        return { status: 202, body: { ok: true, id: "a".repeat(16) } };
      }
      return { status: 404, body: null };
    },
    readBed(rel) {
      if (rel === "config/local/user.yml") return userYml();
      if (rel === "package.json")
        return JSON.stringify({ dependencies: { "@acme/den": "1.0.0" } });
      if (!rel.startsWith("node_modules/@acme/den/")) return null;
      if (rel.endsWith("/docs/hub.md")) return HUB_MD;
      if (rel.endsWith("/README.md")) return "[Den Hub](docs/hub.md) (connect)";
      if (rel.endsWith("/docs/reference.md"))
        return "see [docs/hub.md](hub.md).";
      if (rel.endsWith("/server.md"))
        return "- `hub_connect`: set, change or clear Hub's address.";
      return null;
    },
  };
  return {
    ctx,
    state: () => ({
      url: st.url,
      lang: st.lang,
      approvals: st.approvals.length,
      restarts: st.restarts,
    }),
  };
}
