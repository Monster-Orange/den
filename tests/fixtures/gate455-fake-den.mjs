/**
 * A fake bed for gate/455.mjs: the identity route, the address, doctor and
 * the edge routes answer as a working Den does, unless `broken` names one
 * part to break. Pages are Playwright-like stubs. `address` sets what Den's
 * address does: null (it works), "nothing" (nothing answers at it) or
 * "held" (another server answers it).
 */
export function fakeBed({ broken = null, address = null } = {}) {
  const wanted = "http://den.acme.localhost";
  // eslint-disable-next-line no-restricted-syntax -- the address Den gives
  const direct = "http://localhost:7777";
  const unreachable = `Not reachable yet: nothing answers at ${wanted}.`;
  const answer = "a".repeat(64);
  const json = (status, body) => ({ status, body: JSON.stringify(body) });
  const jsonCli = (args) => {
    if (args[0] === "doctor") {
      const details = address
        ? [
            ...(address === "held"
              ? [
                  "Edge: not running. Port 80 is held by nginx. Options: free port 80, or add Den to that proxy (route below).",
                ]
              : broken === "unreachable-cli"
                ? []
                : [unreachable]),
            `Den answers at ${direct}. That address was checked just now: it is this Den.`,
          ]
        : broken === "doctor"
          ? []
          : ["https://den.example.test: checked just now: it is this Den"];
      return {
        code: 0,
        out: JSON.stringify({
          ok: true,
          checks: [
            { id: "node", status: "ok", detail: "Den 0.0.0" },
            ...details.map((detail, i) => ({
              id: i ? "address_reaches" : "address",
              status: "ok",
              detail,
            })),
          ],
        }),
      };
    }
    const kind = args[3];
    const config =
      broken === "routes"
        ? ""
        : {
            nginx:
              "server_name den.example.test;\nlocation / {\n  proxy_pass http://127.0.0.1:1;\n}",
            caddy: "den.example.test {\n  reverse_proxy 127.0.0.1:1\n}",
            traefik: 'rule: "Host(`den.example.test`)"',
          }[kind];
    return {
      code: 0,
      out: JSON.stringify({
        kind,
        host: "den.example.test",
        listen: 80,
        upstream: "http://127.0.0.1:1",
        config,
      }),
      err: "",
    };
  };
  const ctx = {
    async fetch(p) {
      if (p.endsWith("c=nope")) return json(400, { error: "bad challenge" });
      if (broken === "identity")
        return json(200, { den: "identity", answer: "x" });
      return json(200, { den: "identity", answer });
    },
    async api(p) {
      if (p === "/api/edge/address" && address)
        return {
          address: direct,
          wanted,
          wantedAnswer: address === "held" ? "other" : "nothing",
          answeredAs: address === "held" ? "nginx" : null,
          directOk: true,
        };
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
      if (args.includes("--json")) return jsonCli(args);
      if (args[0] === "doctor" && address)
        return {
          code: 0,
          out:
            (address === "held"
              ? "  ! Edge: not running. Port 80 is held by nginx.\n      Options: free port 80, or add Den to that proxy (route below).\n"
              : broken === "unreachable-cli"
                ? ""
                : `  ! ${unreachable}\n`) +
            `      Den answers at ${direct}. That address was checked just now: it is this Den.\n`,
        };
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
    notes: [],
    log(...a) {
      this.notes.push(a.join(" "));
    },
    async goto() {},
    async sleep() {},
    async shot() {},
    newPage() {
      return {
        async waitForSelector() {},
        async evaluate() {
          if (!address) return { card: false, banner: false, hScroll: false };
          const held = address === "held";
          return {
            card: true,
            banner: false,
            hScroll: false,
            cardText: held
              ? "Den's proxy is not running: port 80 is in use"
              : broken === "unreachable-page"
                ? "Den's address doesn't answer yet"
                : `Den's address doesn't answer yet ${unreachable}`,
            sub:
              broken === "sub-running"
                ? "acme / acme-edge · running"
                : held
                  ? "acme / acme-edge · not running: port 80 is in use"
                  : "acme / acme-edge · not reachable yet",
          };
        },
      };
    },
  };
  return { ctx };
}
