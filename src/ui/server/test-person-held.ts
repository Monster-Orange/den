/**
 * Issue 816: the held write test_person_setup. On your own Den, it sets up
 * the test person of a test install announced on this computer. Only your
 * own Allow runs it (personOnly).
 *
 * At the ask and again at the Allow: the announcement is found (listed only
 * after its checks, test-install-grant.ts), its port answers as that
 * install (the identity probe under its own web.secret), and that install
 * says it is a test install still waiting for setup.
 *
 * At the Allow, in one step: its pid is alive and the probe passes again,
 * right before the send; then a one-use grant and that install's person
 * bearer go once to 127.0.0.1:<port>, with a fresh challenge it must answer
 * as itself. The grant and the bearer live only in this call: never
 * returned, stored, logged, or put in the review or an activity row.
 */
import * as path from "path";
import {
  identityAnswer,
  identityKey,
  newChallenge,
} from "../../shared/den-identity.js";
import { line, reviewLines } from "../../shared/review-lines.js";
import {
  mintSetupGrant,
  type Announced,
} from "../../shared/test-install-grant.js";
import { personToken } from "../../shared/web-secret.js";
import type { HeldAction, HeldCheck } from "./approval-routes.js";

export const TEST_PERSON_SETUP_PATH = "held write test_person_setup";

export interface TestPersonSetupDeps {
  /** This Den's own install id (installIdOf its state folder). */
  ownId: string;
  /** The person's home, for ~/ paths. */
  home: string;
  /** The checked announcements (listAnnounced). */
  list: () => Announced[];
  alive: (pid: number) => boolean;
  /** Whether 127.0.0.1:<port> answers as the install that holds this folder. */
  probe: (a: Announced) => Promise<boolean>;
  /** Whether that install says it is a test install still waiting. */
  waiting: (a: Announced) => Promise<boolean>;
  /** That install's web.secret, or null. */
  readSecret: (stateDir: string) => Buffer | null;
  /** web.test_grant_seconds. */
  ttlSeconds: () => number;
  /** POST http://127.0.0.1:<port>/api/web/fixture-person/grant, once. */
  post: (
    port: number,
    bearer: string,
    body: string,
  ) => Promise<{ status: number; json: Record<string, unknown> }>;
  /** An activity row: no grant, bearer or secret path in it. */
  audit: (row: {
    verb: string;
    detail: string;
    outcome?: "refused";
    reason?: string;
  }) => void;
}

const ID_RE = /^[0-9a-f]{16}$/;

export function shortPath(p: string, home: string): string {
  const rel = path.relative(home, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : p;
}

export function testPersonSetupAction(d: TestPersonSetupDeps): HeldAction {
  const find = (args: Record<string, unknown>): Announced | string => {
    const id = typeof args.id === "string" ? args.id : "";
    if (!ID_RE.test(id)) return "name a test install by its id";
    const a = d.list().find((x) => x.id === id);
    return a ?? `no test install ${id} is waiting on this computer`;
  };
  /** Found, alive, answering as itself, and still waiting; or why not. */
  const ready = async (args: Record<string, unknown>) => {
    const a = find(args);
    if (typeof a === "string") return a;
    if (!d.alive(a.pid)) return `test install ${a.id} isn't running`;
    if (!(await d.probe(a)))
      return `test install ${a.id}'s port doesn't answer as that install`;
    if (!(await d.waiting(a)))
      return `test install ${a.id} isn't a test install waiting for setup any more`;
    return a;
  };
  return {
    async check(args): Promise<HeldCheck> {
      const a = await ready(args);
      if (typeof a === "string") return { ok: false, error: a };
      const where = shortPath(a.stateDir, d.home);
      return {
        ok: true,
        personOnly: true,
        args: { id: a.id },
        summary: `set up the test person on test install ${a.id} (${where})`,
        params: { id: a.id, where },
        ...reviewLines([
          line(
            `Test install ${a.id}, state folder ${where}, on this computer.`,
            "ap.det.test_person_setup.which",
            { id: a.id, where },
          ),
          line(
            "Its live checks can then sign in there as its test person. It can't sign in anywhere else.",
            "ap.det.test_person_setup.what",
          ),
        ]),
      };
    },

    async run(args) {
      const a = await ready(args);
      const fail = (detail: string, reason: string) => {
        d.audit({
          verb: "test-person-setup",
          detail,
          outcome: "refused",
          reason,
        });
        return { ok: false, error: detail };
      };
      if (typeof a === "string") return fail(a, "not_ready");
      const where = shortPath(a.stateDir, d.home);
      const secret = d.readSecret(a.stateDir);
      if (!secret)
        return fail(
          `test install ${a.id} (${where}) has no web secret`,
          "no_secret",
        );
      const challenge = newChallenge();
      let res: { status: number; json: Record<string, unknown> };
      try {
        const grant = mintSetupGrant({
          secret,
          id: a.id,
          from: d.ownId,
          ttlSeconds: d.ttlSeconds(),
        });
        res = await d.post(
          a.port,
          personToken(secret),
          JSON.stringify({ grant, challenge }),
        );
      } catch {
        return fail(
          `couldn't reach test install ${a.id} (${where})`,
          "unreachable",
        );
      }
      const want = identityAnswer(identityKey(secret), challenge);
      if (!want || res.json.answer !== want)
        return fail(
          `test install ${a.id} (${where}) didn't answer as that install`,
          "wrong_answer",
        );
      if (res.status !== 200 || res.json.ok !== true) {
        const code =
          typeof res.json.code === "string" ? res.json.code : "refused";
        return fail(
          `test install ${a.id} (${where}) refused the setup: ${code}`,
          code,
        );
      }
      d.audit({
        verb: "test-person-setup",
        detail: `set up the test person on test install ${a.id} (${where})`,
      });
      return { ok: true, id: a.id, ready: true };
    },
  };
}
