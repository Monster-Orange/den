/**
 * `edge up | down | status | trust | untrust | routes`
 *
 * This org's edge: routes at `<name>.<edge.domain>`, TLS as `edge.tls` says
 * (none, mkcert or files). `trust` / `untrust` exist only under mkcert.
 * `routes` lists Den's own routes, then the routers in the included
 * dynamic files, each with its source file, then the stacks' routers
 * (`stack-*.yml`, 0.3.0-dev.32), each marked "stack" with its file.
 */
import chalk from "chalk";
import { readBrand } from "../../shared/brand.js";
import { readEdgeConfig } from "../../shared/edge/config.js";
import { edgeDomains, edgeNames, routeUrl } from "../../shared/edge/render.js";
import {
  caDir,
  caTrusted,
  edgeDown,
  edgeUp,
  trustCa,
  untrustCa,
} from "../../shared/edge/runtime.js";
import {
  includedRouters,
  stackRouters,
  type IncludedRouter,
} from "../../shared/edge/included.js";
import { edgeRoutes, edgeStatus } from "../../shared/edge/status.js";
import { tlsYaml } from "../../shared/edge/tls.js";

/** An included router's URLs (the hosts its rule names), else its name. */
function includedUrl(r: IncludedRouter): string {
  const scheme = r.tls ? "https://" : "http://";
  return r.hosts.length ? r.hosts.map((h) => scheme + h).join(", ") : r.name;
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
      const { certs } = await edgeUp(cfg);
      console.log(
        chalk.green(
          `✓ ${n.container} up — ${edgeDomains(cfg)
            .map((d) => `*.${d}`)
            .join(", ")}`,
        ),
      );
      console.log(`  ports  ${published}`);
      if (certs.issued)
        console.log(`  cert   issued for ${certs.names.join(", ")}`);
      if (cfg.tls.strategy === "mkcert" && caTrusted(cfg) === false)
        console.log(
          chalk.yellow(
            "  CA not trusted yet — run `edge trust` (asks for your password once)",
          ),
        );
      for (const name of ["edge", ...Object.keys(cfg.routes)])
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
    case "routes": {
      for (const r of edgeRoutes(cfg))
        console.log(`${r.url.padEnd(52)} → ${r.upstream}`);
      // Routers in the included dynamic files: Traefik serves them too.
      const inc = includedRouters(cfg);
      for (const r of inc.routers)
        console.log(
          `${includedUrl(r).padEnd(52)} → ${r.service || "?"}  (${r.file})`,
        );
      // Routers the stacks wrote (stack up): neither Den's nor included.
      const stk = stackRouters(cfg);
      for (const r of stk.routers)
        console.log(
          `${includedUrl(r).padEnd(52)} → ${r.service || "?"}  (stack: ${r.file})`,
        );
      for (const e of [...inc.errors, ...stk.errors])
        console.log(chalk.yellow(`${e.file}: not read (${e.error})`));
      return;
    }
    case "status": {
      const st = edgeStatus(cfg);
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
      if (st.certIssued) console.log(`  cert       ${st.certNames.join(", ")}`);
      return;
    }
    default:
      throw new Error(
        `Unknown edge command "${sub}". Use: up | down | status | trust | untrust | routes`,
      );
  }
}
