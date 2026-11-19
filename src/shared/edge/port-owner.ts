/**
 * Issue 455: who holds a host port, when Den can see it. First a Docker
 * container publishing it (`docker ps --filter publish=<port>`), named by
 * its image ("nginx") and its container name; else a process listening on
 * it (`lsof`), named by its command and pid. Null when neither says: the
 * words then say "something Den cannot name".
 *
 * Read only: Den never stops, edits or signals what it finds.
 */
import { EDGE_ROOT_LABEL } from "./render.js";
import { sh } from "./exec.js";

export interface PortOwner {
  /** What it is, shortly: an image's name ("nginx") or a command. */
  owner: string;
  kind: "container" | "process";
  /** The container's name, or the process's pid. */
  name: string;
  /** A container that is an old Den edge (it carries the edge's label). */
  denEdge: boolean;
}

export type Run = (
  cmd: string,
  args: string[],
) => { code: number; out: string };

const runSafe: Run = (cmd, args) => {
  try {
    const r = sh(cmd, args);
    return { code: r.code, out: r.out };
  } catch {
    return { code: 127, out: "" }; // not installed
  }
};

/** "registry.example/library/nginx:1.27@sha256:…" → "nginx". */
export function imageShortName(image: string): string {
  const noDigest = image.split("@")[0] ?? image;
  const last = noDigest.split("/").pop() ?? noDigest;
  return last.split(":")[0] || image;
}

/** The container publishing `port`, from `docker ps`. */
export function containerOnPort(
  port: number,
  run: Run = runSafe,
): PortOwner | null {
  const r = run("docker", [
    "ps",
    "--filter",
    `publish=${port}`,
    "--format",
    `{{.Names}}\t{{.Image}}\t{{.Label "${EDGE_ROOT_LABEL}"}}`,
  ]);
  if (r.code !== 0) return null;
  const line = r.out.split("\n").find((l) => l.trim());
  if (!line) return null;
  const [name, image, label] = line.split("\t");
  if (!name) return null;
  return {
    owner: imageShortName(image ?? name),
    kind: "container",
    name: name.trim(),
    denEdge: !!label && label.trim() !== "" && label.trim() !== "<no value>",
  };
}

/** The process listening on `port`, from `lsof` (macOS, most Linux). */
export function processOnPort(
  port: number,
  run: Run = runSafe,
): PortOwner | null {
  const r = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  if (r.code !== 0) return null;
  let pid = "";
  let cmd = "";
  for (const l of r.out.split("\n")) {
    if (l.startsWith("p") && !pid) pid = l.slice(1).trim();
    else if (l.startsWith("c") && !cmd) cmd = l.slice(1).trim();
  }
  if (!pid || !cmd) return null;
  return { owner: cmd, kind: "process", name: pid, denEdge: false };
}

/** Who holds `port`, when it can be seen; null when not. */
export function portOwner(port: number, run: Run = runSafe): PortOwner | null {
  return containerOnPort(port, run) ?? processOnPort(port, run);
}
