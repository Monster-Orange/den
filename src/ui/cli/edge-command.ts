/**
 * `edge up | down | status | trust | untrust | routes`
 *
 * This org's HTTPS edge: own CA + cert, routes at `<name>.<edge.domain>`.
 */
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { readBrand } from "../../shared/brand.js";
import { readEdgeConfig } from "../../shared/edge/config.js";
import { edgeDomains, edgeNames, routeUrl } from "../../shared/edge/render.js";
import {
  caDir,
  caTrusted,
  containerState,
  edgeDown,
  edgeUp,
  trustCa,
  untrustCa,
} from "../../shared/edge/runtime.js";

export async function cmdEdge(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  const cfg = readEdgeConfig();
  const n = edgeNames(cfg.org);
  const published = cfg.ports
    ? `host :${cfg.ports.http} / :${cfg.ports.https}`
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
      if (caTrusted(cfg) === false)
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
      for (const [name, url] of Object.entries(cfg.routes))
        console.log(`${routeUrl(name, cfg).padEnd(52)} → ${url}`);
      return;
    case "status": {
      console.log(chalk.bold(`${readBrand().name} edge — ${cfg.org}`));
      console.log(
        `  container  ${n.container}: ${containerState(n.container)}`,
      );
      console.log(`  ports      ${published}`);
      console.log(
        `  domains    ${edgeDomains(cfg).join(", ")} (+ every subdomain)`,
      );
      const trusted = caTrusted(cfg);
      console.log(
        `  CA         ${caDir(cfg)} — ${trusted === null ? "unknown" : trusted ? "trusted" : "NOT trusted"}`,
      );
      const stamp = path.join(cfg.stateDir, "certs", "names.txt");
      if (fs.existsSync(stamp))
        console.log(
          `  cert       ${fs.readFileSync(stamp, "utf-8").split("\n").join(", ")}`,
        );
      return;
    }
    default:
      throw new Error(
        `Unknown edge command "${sub}". Use: up | down | status | trust | untrust | routes`,
      );
  }
}
