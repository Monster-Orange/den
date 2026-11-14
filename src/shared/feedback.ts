/**
 * FB (den#81): what a report may carry, as text. One redactor runs over
 * the diagnostics and the final issue (the preview is exactly what is
 * posted, so the person sees what this left).
 *
 * Always, with no opt-out: secrets and tokens (redact.ts), emails, IP
 * addresses and secret-store references are removed, and the home folder
 * becomes ~. With "Redact names" (on by default): host names and domains
 * become <host-N>, and this install's org, project, repo and service names
 * <org-N>, <ws-N>, <repo-N>, <svc-N>. The screenshot is not text-redacted;
 * the mask tool and the public-repository warning are for it.
 */
import { REDACTED, redactSecrets } from "./redact.js";

/** The names this install knows, to turn into placeholders. */
export interface RedactNames {
  home?: string;
  hosts?: readonly string[];
  orgs?: readonly string[];
  projects?: readonly string[];
  repos?: readonly string[];
  services?: readonly string[];
}

export interface RedactOptions {
  /** "Redact names" (on by default in the dialog). */
  names: boolean;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Full and compressed IPv6 (at least two colons, hex groups). */
const IPV6 =
  /(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){1,6}(?::[0-9A-Fa-f]{1,4}){1,6}(?![\w:])|(?<![\w:])::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}(?![\w:])/g;
/** Secret-store references: op://, doppler://, vault://, keychain:… */
const STORE_REF =
  /\b(?:op|doppler|vault|keychain|bws|infisical|aws-sm|gcp-sm|azure-kv):\/\/[^\s"'`<>)]+/gi;
/**
 * A host name: dotted labels ending in a top-level name. Listed, not any
 * letters, so file names (package.json) and versions stay readable.
 */
const TLDS =
  "com|net|org|io|dev|app|ai|co|us|uk|de|fr|jp|es|ca|au|in|cloud|sh|me|tech|site|online|xyz|info|biz|local|lan|internal|home|corp|test|example|localhost|invalid";
const HOST = new RegExp(
  `(?<![\\w.@<-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+(?:${TLDS})(?![\\w-])(?!\\.[A-Za-z0-9])`,
  "gi",
);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name as a whole word (not inside a longer name or a placeholder). */
const wordRe = (s: string) =>
  new RegExp(`(?<![A-Za-z0-9_<.-])${esc(s)}(?![A-Za-z0-9_-])`, "gi");

/** Redact `text` for a report. */
export function redactReport(
  text: string,
  names: RedactNames,
  opts: RedactOptions,
): string {
  let out = redactSecrets(text);
  out = out.replace(STORE_REF, REDACTED);
  out = out.replace(EMAIL, "<email>");
  out = out.replace(IPV6, "<ip>").replace(IPV4, "<ip>");
  const home = names.home?.replace(/\/+$/, "");
  if (home && home.length > 1)
    out = out.replace(new RegExp(`${esc(home)}(?![A-Za-z0-9_.-])`, "g"), "~");
  if (!opts.names) return out;
  // Known hosts keep their numbers; others get the next ones.
  const hosts = [...(names.hosts ?? [])].filter(Boolean);
  const hostNo = new Map(hosts.map((h, i) => [h.toLowerCase(), i + 1]));
  for (const h of [...hosts].sort((a, b) => b.length - a.length))
    out = out.replace(wordRe(h), `<host-${hostNo.get(h.toLowerCase())}>`);
  out = out.replace(HOST, (m) => {
    const k = m.toLowerCase();
    if (!hostNo.has(k)) hostNo.set(k, hostNo.size + 1);
    return `<host-${hostNo.get(k)}>`;
  });
  const groups: [string, readonly string[] | undefined][] = [
    ["org", names.orgs],
    ["ws", names.projects],
    ["repo", names.repos],
    ["svc", names.services],
  ];
  const all: [string, string][] = [];
  for (const [tag, list] of groups)
    (list ?? []).forEach((n, i) => {
      if (n) all.push([n, `<${tag}-${i + 1}>`]);
    });
  // Longest first, so a name inside another doesn't split it.
  for (const [n, ph] of all.sort((a, b) => b[0].length - a[0].length))
    out = out.replace(wordRe(n), ph);
  return out;
}

export type ReportKind = "bug" | "idea" | "question";

export interface ReportForm {
  kind: ReportKind;
  title: string;
  description: string;
  /** Diagnostics section name → ticked. */
  sections: Record<string, boolean>;
}

const render = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string"))
    return v.length ? "\n" + v.map((x) => `- ${x}`).join("\n") : "none";
  return "\n```json\n" + JSON.stringify(v, null, 2) + "\n```";
};

/** The issue's title, redacted as its body is. */
export function issueTitle(
  form: Pick<ReportForm, "title">,
  names: RedactNames,
  opts: RedactOptions,
): string {
  return redactReport(form.title.replace(/\s+/g, " ").trim(), names, opts);
}

/**
 * The exact issue text: kind, title, the description, then each ticked
 * diagnostics section. Redacted as a whole, after it is put together, so
 * nothing joins up into a value the parts didn't show.
 */
export function issueBody(
  form: ReportForm,
  diagnostics: Record<string, unknown>,
  names: RedactNames,
  opts: RedactOptions,
): string {
  const lines = [
    `**Kind:** ${form.kind}`,
    `**Title:** ${form.title.replace(/\s+/g, " ").trim()}`,
    "",
    form.description.trim(),
    "",
  ];
  for (const [name, v] of Object.entries(diagnostics))
    if (form.sections[name]) lines.push(`**${name}:** ${render(v)}`);
  lines.push("", "_Reported from Den_");
  return redactReport(lines.join("\n"), names, opts);
}
