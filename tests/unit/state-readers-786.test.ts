/**
 * Issue 786 part 2b: the readers that still reset silently. Each one
 * read a JSON state file and, when it couldn't parse it, started from its
 * default, so the next save wrote over what was left. Now each reads
 * through readStateJson: it still starts from its default, but the file
 * is kept in <state>/backup/ first (doctor row, bell item).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  agentTokenLive,
  actorTokensPath,
} from "../../src/shared/actor-token.js";
import {
  apiOnlyFiles,
  apiOnlyNames,
} from "../../src/shared/agents/api-only.js";
import {
  ACCOUNTS_FILE,
  listAccounts,
} from "../../src/shared/agents/signin-accounts.js";
import {
  bridgeStateFile,
  readBridgeState,
} from "../../src/shared/edge/bridge-listen.js";
import {
  HUB_NAMES_CHECK_FILE,
  readHubNamesCheck,
} from "../../src/shared/hub-project-names.js";
import {
  hostRefreshFile,
  readHostRefreshState,
} from "../../src/shared/sessions/host-refresh-state.js";
import { readKept } from "../../src/shared/state-backup.js";
import {
  readCheckState,
  updateCheckFile,
} from "../../src/shared/update-check-state.js";
import { readLatest } from "../../src/shared/verify/changes.js";
import { readWebOwner, webOwnerPath } from "../../src/shared/web-owner.js";
import {
  readUpdateState,
  updateStateFile,
} from "../../src/ui/server/den-update.js";
import {
  pinRecordFile,
  readPinRecord,
} from "../../src/ui/server/pin-commit.js";
import {
  fixturePinsFile,
  readFixturePins,
} from "../../src/ui/server/shell-prefs.js";
import {
  PushSubscriptions,
  SUBSCRIPTIONS_FILE,
  VAPID_FILE,
  vapidKeys,
} from "../../src/ui/server/web-push.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const stateDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-786-readers-"));
  tmps.push(d);
  return d;
};

/** Write a file Den can't parse where the reader looks. */
function corrupt(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"half": ', { mode: 0o600 });
}

const CASES: [
  string,
  (s: string) => string,
  (s: string) => unknown,
  unknown,
][] = [
  ["actor tokens", actorTokensPath, (s) => agentTokenLive(s, "a1"), false],
  ["api-only rules", (s) => apiOnlyFiles(s).rules, apiOnlyNames, []],
  [
    "sign-in accounts",
    (s) => path.join(s, ACCOUNTS_FILE),
    (s) => listAccounts(s, "den-claude"),
    [{ id: "1" }],
  ],
  ["bridge state", bridgeStateFile, readBridgeState, null],
  [
    "Hub names check",
    (s) => path.join(s, HUB_NAMES_CHECK_FILE),
    readHubNamesCheck,
    {},
  ],
  [
    "sessions host refresh",
    hostRefreshFile,
    (s) => readHostRefreshState(s),
    null,
  ],
  ["update check", updateCheckFile, readCheckState, null],
  [
    "verify latest",
    (s) => path.join(s, "verify", "north", "latest.json"),
    (s) => readLatest(s, "north"),
    {},
  ],
  ["web owner", (s) => webOwnerPath(s), (s) => readWebOwner(s), null],
  ["Den update state", updateStateFile, readUpdateState, null],
  ["pin record", pinRecordFile, readPinRecord, null],
  ["fixture pins", fixturePinsFile, readFixturePins, []],
  [
    "push subscriptions",
    (s) => path.join(s, SUBSCRIPTIONS_FILE),
    (s) => new PushSubscriptions(s).list(),
    [],
  ],
];

describe("issue 786 part 2b: a state file Den can't read is kept, not reset", () => {
  it.each(CASES)(
    "%s: the default as before, and the file in backup",
    (_name, fileOf, read, fallback) => {
      const s = stateDir();
      const file = fileOf(s);
      corrupt(file);
      expect(read(s)).toEqual(fallback);
      expect(fs.existsSync(file)).toBe(false);
      const kept = readKept(s);
      expect(kept.map((k) => k.file)).toEqual([path.relative(s, file)]);
      expect(
        fs.readFileSync(path.join(s, "backup", kept[0]!.saved), "utf8"),
      ).toBe('{"half": ');
    },
  );

  it.each(CASES)("%s: no file is not a broken file", (_n, fileOf, read, d) => {
    const s = stateDir();
    expect(read(s)).toEqual(d);
    expect(readKept(s)).toEqual([]);
    expect(fs.existsSync(fileOf(s))).toBe(false);
  });

  it("push keys: a broken key file is kept before new keys are made, never written over", () => {
    const s = stateDir();
    const file = path.join(s, VAPID_FILE);
    corrupt(file);
    const keys = vapidKeys(s);
    expect(typeof keys.publicKey).toBe("string");
    const kept = readKept(s);
    expect(kept.map((k) => k.file)).toEqual([VAPID_FILE]);
    expect(
      fs.readFileSync(path.join(s, "backup", kept[0]!.saved), "utf8"),
    ).toBe('{"half": ');
  });
});

/**
 * The modules PR 1081 listed as resetting silently, now each kept (the pin
 * record's reader moved to src/shared/pin-record.ts on next/queue).
 */
const MOVED = [
  "src/shared/actor-token.ts",
  "src/shared/agents/api-only.ts",
  "src/shared/agents/hub-mcp-connect.ts",
  "src/shared/agents/signin-accounts.ts",
  "src/shared/cli-tabs.ts",
  "src/shared/crash-loop.ts",
  "src/shared/den-procs.ts",
  "src/shared/edge/bridge-listen.ts",
  "src/shared/environment-manager/service-runner.ts",
  "src/shared/gates/runner-tokens.ts",
  "src/shared/github-watch/watcher.ts",
  "src/shared/hub-binding.ts",
  "src/shared/hub-links-seen.ts",
  "src/shared/hub-project-names.ts",
  "src/shared/hub-tools.ts",
  "src/shared/pin-record.ts",
  "src/shared/sessions/host-refresh-state.ts",
  "src/shared/update-check-state.ts",
  "src/shared/verify/changes.ts",
  "src/shared/verify/records.ts",
  "src/shared/web-owner.ts",
  "src/shared/web-session.ts",
  "src/ui/server/app-feed-service.ts",
  "src/ui/server/den-update.ts",
  "src/ui/server/embed-server-keys.ts",
  "src/ui/server/index.ts",
  "src/ui/server/pin-commit.ts",
  "src/ui/server/request-ledger.ts",
  "src/ui/server/shell-prefs.ts",
  "src/ui/server/web-push.ts",
];

/**
 * The reads left as they were, each with why. Every other JSON read of a
 * file in these modules goes through readStateJson.
 */
const LEFT: Record<string, { count: number; why: string }> = {
  "src/shared/actor-token.ts": {
    count: 1,
    why: "sessionPid reads the sessions host's own record: never this module's to move",
  },
  "src/shared/den-procs.ts": {
    count: 1,
    why: "an unreadable pid file answers 'can't tell' (null), never an empty list: nothing resets",
  },
  "src/ui/server/index.ts": {
    count: 2,
    why: "/api/app-url reads a project's environment config, and the version reads Den's package.json: neither is state",
  },
  "src/ui/server/app-feed-service.ts": {
    count: 1,
    why: "one event file that can't be read is skipped; the rest of the feed stands",
  },
};

describe("issue 786 part 2b: a gate keeps them so", () => {
  const RAW = /JSON\.parse\(\s*fs\.readFileSync\(/g;
  const root = path.resolve(__dirname, "../..");

  it.each(MOVED)("%s parses no state file but through readStateJson", (f) => {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    expect({ f, raw: (src.match(RAW) ?? []).length }).toEqual({
      f,
      raw: LEFT[f]?.count ?? 0,
    });
  });
});
