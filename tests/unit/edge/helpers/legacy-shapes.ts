/**
 * Edge config shapes that exist in the wild, and everything Den renders or
 * runs for each: the Traefik dynamic and compose files, the cert names, the
 * route URLs, the CA directory, and the exact mkcert call `ensureCerts`
 * makes (arguments and CAROOT). The fixtures under
 * tests/fixtures/edge-legacy/ were written by 0.3.0-dev.24's own code (with
 * DEN_WRITE_EDGE_LEGACY=1) before edge.tls existed; regenerate them only on
 * purpose.
 *
 * mkcert is never the real one: a fake on a minimal PATH records its call
 * and writes dummy cert and key files.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readEdgeConfig } from "../../../../src/shared/edge/config.js";
import {
  withoutOwnerLabels,
  withoutUpstreamTransport,
} from "./owner-labels.js";
import {
  certNames,
  renderEdgeCompose,
  renderEdgeDynamic,
  routeUrl,
} from "../../../../src/shared/edge/render.js";
import {
  caDir,
  ensureCerts,
  sharedCa,
  syncIncluded,
} from "../../../../src/shared/edge/runtime.js";

const BASE = [
  "edge:",
  "  org: acme",
  "  domain: acme.localhost",
  "  aliases: [acme.internal]",
  "  workspaces: [main, pr-12]",
  "  routes:",
  "    api: http://host.docker.internal:3001",
  "    app.shop: http://host.docker.internal:5173",
];
const FILES = [
  "  https_redirect: false",
  "  include: edge/dynamic",
  "  mounts: { edge/certs: /etc/traefik/dynamic/certs }",
];

export interface Shape {
  team: string[];
  user?: string[];
}

/** The legacy shapes, as dev.24 read them. */
export const LEGACY: Record<string, Shape> = {
  "no-tls": { team: BASE },
  "no-tls-unpublished": {
    team: [...BASE, "  publish: false"],
  },
  "no-tls-ports": {
    team: [...BASE, "  http_port: 8080", "  https_port: 8443"],
  },
  caroot: { team: [...BASE, "  caroot: shared-ca"] },
  "issue-cert-false": {
    team: [...BASE, "  issue_cert: false", ...FILES],
  },
  "caroot-issue-cert-false": {
    team: [...BASE, "  caroot: shared-ca", "  issue_cert: false", ...FILES],
  },
  "user-caroot": {
    team: BASE,
    user: ["edge:", "  caroot: shared-ca"],
  },
  "user-issue-cert-false": {
    team: [...BASE, ...FILES],
    user: ["edge:", "  issue_cert: false"],
  },
};

/** The same configs, said with edge.tls: each renders as its legacy shape. */
export const EXPLICIT: Record<string, { legacy: string } & Shape> = {
  "tls-mkcert": {
    legacy: "no-tls",
    team: [...BASE, "  tls: { strategy: mkcert }"],
  },
  "tls-mkcert-ports": {
    legacy: "no-tls-ports",
    team: [
      ...BASE,
      "  http_port: 8080",
      "  https_port: 8443",
      "  tls: { strategy: mkcert }",
    ],
  },
  "tls-mkcert-ca": {
    legacy: "caroot",
    team: [...BASE, "  tls: { strategy: mkcert, ca: shared-ca }"],
  },
  "tls-files": {
    legacy: "issue-cert-false",
    team: [
      ...BASE,
      "  https_redirect: false",
      "  tls:",
      "    strategy: files",
      "    include: edge/dynamic",
      "    mounts: { edge/certs: /etc/traefik/dynamic/certs }",
    ],
  },
  "tls-files-ca": {
    legacy: "caroot-issue-cert-false",
    team: [
      ...BASE,
      "  https_redirect: false",
      "  tls:",
      "    strategy: files",
      "    ca: shared-ca",
      "    include: edge/dynamic",
      "    mounts: { edge/certs: /etc/traefik/dynamic/certs }",
    ],
  },
  "tls-mkcert-user": {
    legacy: "user-caroot",
    team: BASE,
    user: ["edge:", "  tls: { strategy: mkcert, ca: shared-ca }"],
  },
};

export interface Rendered {
  certNames: string[];
  dynamic: string;
  compose: string;
  routeUrls: string[];
  caDir: string;
  sharedCa: boolean;
  included: string[];
  /** The mkcert call ensureCerts made (null: none). */
  mkcert: string | null;
  ensure: { issued: boolean; names: string[] };
  /** The files ensureCerts left in <state>/certs. */
  certFiles: string[];
}

/** Render `shape` in a throwaway root; paths under it read `<ROOT>`. */
export function renderShape(shape: Shape): Rendered {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "edge-legacy-")),
  );
  const state = path.join(root, "state");
  const fakeBin = path.join(root, "fake-bin");
  const log = path.join(root, "mkcert-calls");
  try {
    fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", "den.yml"),
      shape.team.join("\n") + "\n",
    );
    if (shape.user)
      fs.writeFileSync(
        path.join(root, "config", "local", "user.yml"),
        shape.user.join("\n") + "\n",
      );
    fs.mkdirSync(path.join(root, "shared-ca"));
    for (const f of ["rootCA.pem", "rootCA-key.pem"])
      fs.writeFileSync(path.join(root, "shared-ca", f), "dummy\n");
    fs.mkdirSync(path.join(root, "edge", "dynamic"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "edge", "dynamic", "tls.yml"),
      "tls: {}\n",
    );
    fs.mkdirSync(path.join(root, "edge", "certs"), { recursive: true });
    fs.mkdirSync(fakeBin);
    // Records the call; writes dummy files where -cert-file/-key-file say.
    fs.writeFileSync(
      path.join(fakeBin, "mkcert"),
      [
        "#!/bin/sh",
        `echo "CAROOT=$CAROOT mkcert $*" >> "${log}"`,
        'while [ $# -gt 0 ]; do case "$1" in',
        '  -cert-file|-key-file) echo dummy > "$2"; shift 2;;',
        "  *) shift;;",
        "esac; done",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const saved = { PATH: process.env.PATH, EDGE: process.env.DEN_EDGE_DIR };
    process.env.PATH = [fakeBin, "/usr/bin", "/bin"].join(path.delimiter);
    process.env.DEN_EDGE_DIR = state;
    try {
      const cfg = readEdgeConfig(root);
      const out = (s: string) => s.split(root).join("<ROOT>");
      const ensure = ensureCerts(cfg);
      const certDir = path.join(state, "certs");
      return {
        certNames: certNames(cfg),
        dynamic: out(withoutUpstreamTransport(renderEdgeDynamic(cfg))),
        compose: out(withoutOwnerLabels(renderEdgeCompose(cfg))),
        routeUrls: ["edge", ...Object.keys(cfg.routes)].map((n) =>
          routeUrl(n, cfg),
        ),
        caDir: out(caDir(cfg)),
        sharedCa: sharedCa(cfg),
        included: syncIncluded(cfg),
        mkcert: fs.existsSync(log) ? out(fs.readFileSync(log, "utf-8")) : null,
        ensure,
        certFiles: fs.existsSync(certDir) ? fs.readdirSync(certDir).sort() : [],
      };
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.EDGE === undefined) delete process.env.DEN_EDGE_DIR;
      else process.env.DEN_EDGE_DIR = saved.EDGE;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export const FIXTURES = path.join(__dirname, "../../../fixtures/edge-legacy");
