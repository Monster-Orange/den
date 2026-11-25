/**
 * `edge up [--take-over] [--rotate-proof] | down | status | trust | untrust | routes | route --for <proxy>`
 *
 * `route --for nginx|caddy|traefik` (issue 455): the block another proxy
 * that already owns port 80 needs so Den's name reaches Den. Printed for
 * the person to paste; Den never edits another project's files.
 *
 * This org's edge: routes at `<name>.<edge.domain>`, TLS as `edge.tls` says
 * (none, mkcert or files). `trust` / `untrust` exist only under mkcert.
 * `routes` lists Den's own routes, then the routers in the included
 * dynamic files, each with its source file, then the stacks' routers
 * (`stack-*.yml`, 0.3.0-dev.32), each marked "stack" with its file.
 */
import chalk from "chalk";
import { readBrand } from "../../shared/brand.js";
import { readEdgeConfig, readWebPort } from "../../shared/edge/config.js";
import {
  edgeDomains,
  edgeNames,
  routeUrl,
  webRouteHosts,
} from "../../shared/edge/render.js";
import {
  caDir,
  caTrusted,
  edgeDown,
  trustCa,
  untrustCa,
} from "../../shared/edge/runtime.js";
import {
  includedRouters,
  stackRouters,
  routerUrls,
  type IncludedRouter,
} from "../../shared/edge/included.js";
import {
  edgeRoutes,
  edgeStatus,
  withHttpsServing,
} from "../../shared/edge/status.js";
import { tlsYaml } from "../../shared/edge/tls.js";
import { runEdgeUp } from "../../shared/edge/up.js";
import {
  PROXIES,
  isProxyKind,
  proxyRoute,
  upstreamHostFor,
} from "../../shared/edge/proxy-route.js";
import { portOwner } from "../../shared/edge/port-owner.js";
import { addressWord } from "../../shared/edge/address-words.js";
import { cliLanguage } from "../../shared/edge/address-check.js";
import { readWebUrl, type WebUrl } from "../../shared/web-url.js";
import { isLoopbackUrl } from "../../shared/web-url-check.js";

/**
 * `edge route`'s target: Den's own route on the edge (`edgeHost`, on the
 * edge's http port). Issue 666: a loopback web.url is never the address,
 * so the route is never built on it (`loopback` says one was set).
 */
export function denRouteTarget(
  w: WebUrl | null,
  edgeHost: string,
  httpPort: number,
): { host: string; listen: number; loopback: boolean } {
  return {
    host: edgeHost,
    listen: httpPort,
    loopback: isLoopbackUrl(w?.url),
  };
}
import { product } from "../../shared/product.js";

/** `edge route --for <proxy>`'s proxy, from `--for x` or `--for=x`. */
export function routeFor(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--for") return args[i + 1] ?? null;
    if (args[i].startsWith("--for=")) return args[i].slice(6);
  }
  return null;
}

/** An included router's URLs (the hosts its rule names), else its name. */
function includedUrl(r: IncludedRouter): string {
  return r.hosts.length ? routerUrls(r).join(", ") : r.name;
}

export async function cmdEdge(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  const cfg = readEdgeConfig();
  const n = edgeNames(cfg.org);
  const published = cfg.ports
    ? cfg.tls.strategy === "none"
      ? `host :${cfg.ports.http} (http only)`
      : `host :${cfg.ports.http} / :${cfg.ports.https}`
    : `not published (reach it on Docker network ${n.network})`;
  switch (sub) {
    case "up": {
      // --take-over: the only way to replace an edge another state dir
      // owns (0.3.0-dev.40); never implied.
      // --rotate-proof (H1): a new edge proof; the old one stops working
      // at once. Den's web app picks the new one up with no restart.
      const rotateProof = args.includes("--rotate-proof");
      // The same function Settings' Start the edge runs (issue 395); it
      // prints what it did (#385), and running stacks rejoin the edge's
      // networks so their routes stay up.
      const { certs } = await runEdgeUp({
        cfg,
        takeOver: args.includes("--take-over"),
        rotateProof,
      });
      console.log(
        chalk.green(
          `✓ ${n.container} up — ${edgeDomains(cfg)
            .map((d) => `*.${d}`)
            .join(", ")}`,
        ),
      );
      console.log(`  ports  ${published}`);
      if (rotateProof)
        console.log("  proof  rotated: the old one no longer works");
      if (certs.issued)
        console.log(`  cert   issued for ${certs.names.join(", ")}`);
      if (cfg.tls.strategy === "mkcert" && caTrusted(cfg) === false)
        console.log(
          chalk.yellow(
            "  CA not trusted yet — run `edge trust` (asks for your password once)",
          ),
        );
      for (const name of Object.keys(cfg.routes))
        console.log(`  ${routeUrl(name, cfg)}`);
      return;
    }
    case "down":
      edgeDown(cfg);
      console.log(chalk.green(`✓ ${n.container} down`));
      return;
    case "trust":
      process.exitCode = trustCa(cfg);
      return;
    case "untrust":
      process.exitCode = untrustCa(cfg);
      return;
    case "route": {
      const kind = (routeFor(args.slice(1)) ?? "").toLowerCase();
      const lang = cliLanguage();
      if (!isProxyKind(kind))
        throw new Error(
          addressWord(lang, "routeUnknown", { cli: product().cli }),
        );
      const webPort = readWebPort();
      const w = readWebUrl();
      const { host, listen, loopback } = denRouteTarget(
        w,
        webRouteHosts(cfg, new Set([webPort]))[0]?.host ??
          `${product().cli}.${cfg.domain}`,
        cfg.ports?.http ?? 80,
      );
      if (loopback && w)
        process.stderr.write(
          `${w.url} names this machine only, so it is not this install's address: the route is for ${host}. Set the address: ${product().cli} web url https://${host}\n`,
        );
      const owner = portOwner(listen);
      process.stderr.write(
        addressWord(lang, "routeHelp", {
          host,
          port: webPort,
          title: readBrand().name,
        }) + "\n",
      );
      console.log(
        proxyRoute(kind, {
          host,
          listen,
          upstreamHost: upstreamHostFor(owner?.kind ?? null),
          upstreamPort: webPort,
          name: product().cli,
        }),
      );
      return;
    }
    case "routes": {
      for (const r of edgeRoutes(cfg))
        console.log(`${r.url.padEnd(52)} → ${r.upstream}`);
      // Routers in the included dynamic files: Traefik serves them too.
      const inc = includedRouters(cfg);
      for (const r of inc.routers)
        console.log(
          `${includedUrl(r).padEnd(52)} → ${r.upstream || "?"}  (${r.file})`,
        );
      // Routers the stacks wrote (stack up): neither Den's nor included.
      const stk = stackRouters(cfg);
      for (const r of stk.routers)
        console.log(
          `${includedUrl(r).padEnd(52)} → ${r.upstream || "?"}  (stack: ${r.file})`,
        );
      for (const e of [...inc.errors, ...stk.errors])
        console.log(chalk.yellow(`${e.file}: not read (${e.error})`));
      return;
    }
    case "status": {
      const st = await withHttpsServing(edgeStatus(cfg), cfg);
      console.log(chalk.bold(`${readBrand().name} edge — ${st.org}`));
      console.log(`  container  ${st.container}: ${st.state}`);
      console.log(`  ports      ${published}`);
      console.log(`  domains    ${st.domains.join(", ")} (+ every subdomain)`);
      console.log(
        `  tls        ${tlsYaml(cfg.tls).replace(/^tls: /, "")}${cfg.tlsFrom === "implicit" ? " (implicit: edge.tls is not set)" : ""}`,
      );
      if (cfg.tls.strategy !== "none")
        console.log(
          // Fronted (edge.publish: false): the proxy in front owns
          // browser trust (BOOT-1), so this machine's trust is moot.
          `  CA         ${caDir(cfg)} — ${!st.ports ? "not needed: fronted" : st.caTrusted === null ? "unknown" : st.caTrusted ? "trusted" : "NOT trusted"}`,
        );
      if (st.certIssuedByDen)
        console.log(`  cert       ${st.certNames.join(", ")}`);
      else if (st.https.certs === "distribution")
        console.log(
          "  cert       the distribution's (tls: files): not minted by Den",
        );
      // MCP-2.5: whether HTTPS is actually serving, not only configured.
      console.log(
        `  https      ${st.https.serving === null ? "not probed" : st.https.serving ? "serving" : "NOT serving"} — ${st.https.detail}`,
      );
      // #63: the masked access log, and whether Den is keeping up with it.
      console.log(
        `  access log ${st.accessLog.enabled ? `on — masked into ${st.accessLog.log}` : "off (edge.access_log)"}`,
      );
      for (const w of st.accessLog.warnings)
        console.log(chalk.yellow(`  ⚠  ${w}`));
      return;
    }
    default:
      throw new Error(
        `Unknown edge command "${sub}". Use: up [--take-over] [--rotate-proof] | down | status | trust | untrust | routes | route --for ${PROXIES.join("|")}`,
      );
  }
}
