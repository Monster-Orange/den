// Tiny demo service: GET /healthz, GET / (JSON). If UPSTREAM_URL is set, `/`
// also calls the upstream's `/` and includes its answer, proving the link.
import http from "node:http";

const name = process.env.SERVICE ?? "demo";
const port = Number(process.env.PORT ?? 8080);
const upstream = process.env.UPSTREAM_URL;
const started = new Date().toISOString();

http
  .createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }
    const body = { service: name, started, host: req.headers.host };
    if (upstream) {
      try {
        const r = await fetch(upstream, { signal: AbortSignal.timeout(3000) });
        body.upstream = { url: upstream, status: r.status, body: await r.json() };
      } catch (err) {
        body.upstream = { url: upstream, error: String(err) };
      }
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(body, null, 2) + "\n");
  })
  .listen(port, () => console.log(`${name} listening on :${port}`));
