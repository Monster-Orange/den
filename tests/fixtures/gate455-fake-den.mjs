/**
 * A fake bed for gate/455.mjs: the identity route, the address, doctor and
 * the edge routes answer as a working Den does, unless `broken` names one
 * part to break. Pages are Playwright-like stubs.
 */
export function fakeBed({ broken = null } = {}) {
  const answer = "a".repeat(64);
  const json = (status, body) => ({ status, body: JSON.stringify(body) });
  const ctx = {
    async fetch(p) {
      if (p.endsWith("c=nope")) return json(400, { error: "bad challenge" });
      if (broken === "identity")
        return json(200, { den: "identity", answer: "x" });
      return json(200, { den: "identity", answer });
    },
    async api(p) {
      if (p === "/api/edge/address")
        return {
          address: "https://den.example.test",
          wanted: "https://den.example.test",
          wantedAnswer: "den",
          directOk: true,
        };
      return null;
    },
    cli(args) {
      if (args[0] === "doctor")
        return {
          code: 0,
          out:
            broken === "doctor"
              ? "Den 0.0.0\n"
              : "Address https://den.example.test: checked just now: it is this Den\n",
        };
      const kind = args[3];
      const out =
        broken === "routes"
          ? ""
          : {
              nginx:
                "server_name den.example.test;\nlocation / {\n  proxy_pass http://127.0.0.1:1;\n}",
              caddy: "den.example.test {\n  reverse_proxy 127.0.0.1:1\n}",
              traefik: 'rule: "Host(`den.example.test`)"',
            }[kind];
      return { code: 0, out, err: "" };
    },
    async goto() {},
    async sleep() {},
    async shot() {},
    newPage() {
      return {
        async waitForSelector() {},
        async evaluate() {
          return { card: false, banner: false, hScroll: false };
        },
      };
    },
  };
  return { ctx };
}
