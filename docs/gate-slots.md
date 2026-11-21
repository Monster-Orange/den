# Gate slots

One machine runs heavy test runs for many repos and installs, so they take
turns. A browser suite holds the machine alone. Unit suites share it, 2 at a
time by default. First come, first served. A run is never stopped by another.

On the machine itself, wrap the run:

```sh
den gate run --kind browser --estimate 6m --label "e2e" -- npm run test:e2e
den gate status            # who holds a slot, who waits
```

`gate status`, the Agents page and `GET /api/gate-slots` show every holder,
local or remote.

## A release run a person waits on

```sh
den gate run --kind browser --priority release --reason "the person waits on the candidate" -- npm run test:e2e
```

Use it only for a release run that the person marked, or that is for an
issue the person reported. It goes to the front of its kind's waiting runs.

- It never stops a run that holds a slot. It waits for that run to end.
- One such run per kind has priority at a time (`priority_max`, default 1).
  A second waits behind the first, then takes priority once the first
  starts.
- It never passes a run that has waited `priority_pass_limit_minutes`
  (default 60).
- `priority_agents` (default 1) lets agents ask for it. At 0, only a person
  may. The MCP tool `gate_slot_request` takes `priority: "release"` and a
  `reason` too.
- The slot log (`events.jsonl`) has a `priority` row for each jump: who
  asked (`by`), why (`reason`), and the runs it went ahead of (`passed`).
  A second marked run gets a `priority-waits` row naming the one ahead.
- `gate status` (text and `--json`), and the queue on the Agents page, show
  the priority and its reason.

Change the three settings in Settings › Server, or with
`den gate settings --priority-max N --priority-pass-limit-minutes N --priority-agents 0|1`.

## A CI job in a runner VM

A CI job running in a VM on this machine has no Den and no process Den can
see. It takes a slot over HTTP, with a **runner token** that can do one
thing: ask for, renew and give back gate slots. Every other route answers
403 to it.

### 1. An agent asks for the token; you allow it

Ask Den's own agent (or a project's agent) to set up the runner. It calls
the held write `gate_runner_token_create` with the runner's name:

```
gate_runner_token_create { name: "ci-linux" }
```

Den's Allow dialog shows the runner's name and what the token can do. On
your Allow, Den makes the token and hands it back once, to the agent that
asked, in its tool result. It never goes to the dialog, the bell, a log
or the activity trail. The activity trail records who asked and who
allowed it. Deny makes nothing.

The agent then stores the token as a secret of the CI system (for example
`GATE_TOKEN`), with Den's address (`DEN_URL`, the address the VM reaches
Den on). Beyond this machine, that address is https.

Settings › CI runner tokens lists the tokens (names and dates,
never a token). Revoke one there: it answers 401 at once, and its slots,
held or waiting, are given back at once, so the next in line starts.

### 2. The job: ask, run, release

The job holds its slot by **lease**. It renews every `renew_seconds` (the
ask's answer says how often; 30 by default). A lease not renewed for
`remote_lapse_seconds` (120 by default) is taken back, and the next in line
starts. Both are Settings rows, or
`den gate settings --remote-renew-seconds N --remote-lapse-seconds N`.

Copy this into the job. It needs only `curl` and `sed`:

```sh
#!/bin/sh
# Takes a gate slot on Den's machine, runs the tests, gives it back.
# Needs DEN_URL and GATE_TOKEN (the runner token) in the environment.
set -eu
KIND=${GATE_KIND:-browser}          # browser or cpu
ESTIMATE=${GATE_ESTIMATE_MIN:-10}   # minutes the run expects to take
LABEL=${GATE_LABEL:-ci}

# The token goes in a header file only this job reads, never on a
# command line (where ps shows it). printf is the shell's own.
HDR=$(mktemp)
chmod 600 "$HDR"
printf 'Authorization: Bearer %s\n' "$GATE_TOKEN" > "$HDR"

gate() {  # gate <ask|renew|release> <json>
  curl -fsS -X POST "$DEN_URL/api/gate-slots/$1" -H @"$HDR" \
    -H "Content-Type: application/json" -d "$2"
}
field() { sed -n "s/.*\"$1\":\\([^,}]*\\).*/\\1/p" | tr -d '"'; }

answer=$(gate ask "{\"kind\":\"$KIND\",\"estimate_minutes\":$ESTIMATE,\"label\":\"$LABEL\",\"wait_seconds\":20}")
SLOT=$(printf '%s' "$answer" | field id)
RENEW=$(printf '%s' "$answer" | field renew_seconds)

# Give the slot back however the job ends.
RENEWER=""
release() { gate release "{\"id\":\"$SLOT\"}" >/dev/null 2>&1 || true; }
trap 'release; [ -n "$RENEWER" ] && kill "$RENEWER" 2>/dev/null; rm -f "$HDR"' EXIT INT TERM

# Wait in line: each renew keeps the place and says where it stands.
while [ "$(printf '%s' "$answer" | field granted)" != "true" ]; do
  echo "gate: waiting, place $(printf '%s' "$answer" | field place)"
  sleep "$RENEW"
  answer=$(gate renew "{\"id\":\"$SLOT\"}")
done

# Hold it while the tests run.
( while sleep "$RENEW"; do gate renew "{\"id\":\"$SLOT\"}" >/dev/null || exit 1; done ) &
RENEWER=$!

npm run test:e2e   # the job's own test command
```

The answers:

- `ask` `{kind, estimate_minutes, label?, wait_seconds?}`: waits up to
  `wait_seconds` (20 by default, at most the lapse time) for the slot, then
  answers `{id, granted, place, renew_seconds, lapse_seconds, …}`. `place`
  is 0 when it holds the slot, else its place in line (1 is next).
- `renew` `{id}`: renews the lease, holding or waiting, and answers the
  same. 404 when the slot is gone (released, ended early, or lapsed): ask
  again.
- `release` `{id}`: gives it back. `{ok: true, released: true}`.
- 401 `token_revoked`: the person revoked the token; its slots are free.
- 429 `too_many_slots` or `too_many_asks`: one runner may have 4 slots
  (held or waiting) and 4 asks waiting at once, by default (Settings, or
  `den gate settings --remote-max-slots N --remote-max-asks N`).
- An ask whose caller hangs up before the answer gives its slot back.

A person can still end a runner's slot early on the Agents page or with
`den gate end <id>`, as for any holder.

## Test boxes: browser slots on other machines

A team often has idle machines that can run browser tests. Set each one
up as a **test box**, and it brings its own browser slots. With no boxes
set (the default), nothing changes.

Set a box in Settings › Server › Test boxes, or:

```sh
den gate box add box1 --ssh ci@box1.example --slots 1 --hold-file heavy.hold
den gate box add box2 --playwright ws://box2.example:3000 --slots 2 --time-scale 1.5
den gate box list
den gate box remove box2
```

- `--ssh user@host` (with `--ssh-port`, `--ssh-identity <key file>`): how
  Den reads the box. Keys only; Den names the key file and never reads it.
- `--playwright ws://…`: the box's Playwright server. A run that gets the
  box is given it as `DEN_PW_WS`.
- `--slots N`: browser runs the box takes at once (its "one heavy job at a
  time" rule is 1).
- `--hold-file <path>` (needs ssh; relative to the box user's home): while
  this file is on the box, the box takes no new runs. Its running slots
  finish.
- `--time-scale X`: the box's browsers take X times as long as this
  machine's. Its runs' expected ends stretch by it, and the run gets
  `DEN_GATE_TIME_SCALE` to stretch its own timeouts.

### Which runs go to a box

A browser run says where it may go:

```sh
den gate run --kind browser --box any --base-url http://app.localhost:4100 -- npm run test:e2e
den gate run --kind browser -- npm run test:e2e             # this machine only
```

`--box any` takes whichever slot frees first: this machine's, then the
first box with a free slot. A run that needs a local browser leaves `--box`
out and takes only this machine's slot. The run is told what it got:
`DEN_GATE_BOX` (the box's name), `DEN_PW_WS` (its Playwright server, when
set), `DEN_GATE_BOX_SSH` and `DEN_GATE_TIME_SCALE`.

A CI runner that runs on a box asks for that box's slot by name
(`"where": "box1"` in its `ask`), so the app, the browser and the tests
all run on the box. The answer says `box` once it holds the slot.

The queue stays first come, first served: a run that waits keeps the slots
it waits for from the runs behind it, and never blocks a slot it can't use.

### Checking a box

A box is checked only when a slot on it is about to be given, never on a
timer. The check is a read: over ssh, one sftp session that lists the
hold file and reads the box's `/proc/meminfo` (the box runs nothing for
it); with only a Playwright address, a TCP connect.

- **Held** (its hold file is there): no new slot. The next assignment
  after the file is placed sees it.
- **Low on memory**: the box has less available memory than its
  `min_free_mem_mb` (2048 by default; `--min-free-mem-mb`). No new slot,
  and the queue says "box low on memory".
- **Unreachable** (no answer within `box_check_timeout_seconds`, 8 by
  default, never more than 25): skipped, with why, and the run goes to
  another box or waits. An ssh that connects but stalls before its banner
  is killed at that time and counts as unreachable.
- **Version mismatch**: a box set with `--playwright-version` takes only
  runs whose Playwright client is that version (`gate run` reads it from
  the run's `node_modules`, or `--pw-version`). Any other run skips the
  box, and the queue says "client X ≠ server Y".

A box slot is one heavy job at a time unless `--slots` says more.

### A box run never reaches this machine's live services

A browser on a box, driving an app here through a tunnel, sees this
machine as its loopback, where ports 80 and 443 may be live services. So:

- `gate run --box …` needs `--base-url`: the app's loopback addresses
  (`localhost`, `*.localhost` or `127.0.0.1`), each with an explicit port
  other than 80 or 443. Anything else is refused.
- The run gets `DEN_GATE_ALLOW` (the allowed `host:port` list). Its
  Playwright setup guards every browser context with Den's
  `shared/gates/pw-guard` module (`guardBrowser`), so only those
  host:ports load, and each blocked request is reported.
- The setup calls `pinLoopbackNames()` too: `localhost` and
  `*.localhost` resolve to 127.0.0.1 in the client, never ::1 (the
  tunnel's forwarders listen on IPv4).
- A held or unreachable box is passed over for `box_recheck_seconds` (30
  by default), then checked again the next time a slot on it is wanted.

`gate status`, the queue on the Agents page and `den doctor` show each
slot's box and each box's state, with why a box is skipped. The slot log
(`events.jsonl`) names the box on each grant and release. Both settings
are in Settings › Server, or
`den gate settings --box-check-timeout-seconds N --box-recheck-seconds N`.
