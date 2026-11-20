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
Den on).

Settings › CI runner tokens lists the tokens (names and dates,
never a token). Revoke one there; it answers 401 at once.

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

gate() {  # gate <ask|renew|release> <json>
  curl -fsS -X POST "$DEN_URL/api/gate-slots/$1" \
    -H "Authorization: Bearer $GATE_TOKEN" \
    -H "Content-Type: application/json" -d "$2"
}
field() { sed -n "s/.*\"$1\":\\([^,}]*\\).*/\\1/p" | tr -d '"'; }

answer=$(gate ask "{\"kind\":\"$KIND\",\"estimate_minutes\":$ESTIMATE,\"label\":\"$LABEL\",\"wait_seconds\":20}")
SLOT=$(printf '%s' "$answer" | field id)
RENEW=$(printf '%s' "$answer" | field renew_seconds)

# Give the slot back however the job ends.
RENEWER=""
release() { gate release "{\"id\":\"$SLOT\"}" >/dev/null 2>&1 || true; }
trap 'release; [ -n "$RENEWER" ] && kill "$RENEWER" 2>/dev/null; true' EXIT INT TERM

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

A person can still end a runner's slot early on the Agents page or with
`den gate end <id>`, as for any holder.
