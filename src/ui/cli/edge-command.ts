/**
 * `edge up | down | status | trust | untrust | routes`
 *
 * This org's edge: routes at `<name>.<edge.domain>`, TLS as `edge.tls` says
 * (none, mkcert or files). `trust` / `untrust` exist only under mkcert.
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
import { edgeStatus } from "../../shared/edge/status.js";
import { tlsYaml } from "../../shared/edge/tls.js";

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
    case "routes":
      for (const r of edgeStatus(cfg).routes)
        console.log(`${r.url.padEnd(52)} → ${r.upstream}`);
      return;
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
          `  CA         ${caDir(cfg)} — ${st.caTrusted === null ? "unknown" : st.caTrusted ? "trusted" : "NOT trusted"}`,
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
