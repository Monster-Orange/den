# Gate slots

One machine runs heavy test runs for many repos and installs, so they take
turns. Unit suites (`cpu`) share it, 2 at a time by default (`cpu_slots`).
Browser and cpu runs wait in separate lines, first come, first served within
each: a cpu run never waits behind a browser run, and a browser run never
waits behind a cpu run. A run is never stopped by another.

## cpu runs beside a browser run

Up to `cpu_slots_beside_browser` cpu runs (default 2, never more than
`cpu_slots`) may run on this machine while a browser run does. At 0, a
browser run runs alone, as before. A browser run on a test box (below) does
not hold this machine, so it doesn't count.

A release-priority browser run uses `cpu_slots_beside_release_browser`
instead (default 0): it runs alone, so other runs don't slow its checks.
While one waits, cpu runs drain to that number and no new ones start; while
one holds this machine, cpu runs wait for it. Other browser runs keep
`cpu_slots_beside_browser`. `gate settings --cpu-slots-beside-release-browser N`
sets it.

Issue 1009: while the machine's 5-minute load average is at or above
`cpu_hold_load` and a release-priority browser run holds a browser slot,
here or on a test box (its app still runs here), cpu asks wait. The default
is the machine's cores × 4 / 3 (24 on 18 cores); 0 turns it off. Holders
are never stopped, and a release-priority cpu ask goes through (a release
run's own next step never waits on it). A plain cpu ask is granted on the next pass once the load
drops or the release run ends. `gate status` and the Gate panel say why:
"waiting: load 38 ≥ 24 while a release run holds the browser slot".
`gate settings --cpu-hold-load N` sets it.

Issue 1048: a plain cpu ask also waits while the 5-minute load is over
`load_hold_per_core` × the cores (default 3: 54 on 18 cores), but only while
another cpu run is going. With none going, the next one starts whatever the
load, so the line slows down and never stops. Release-priority asks and
holders never wait. The reason reads "waiting: this machine's load is 60.0,
over 3 × 18 cores (54), while another unit test run is going; it starts once
the load drops or that run ends". 0 turns it off; `gate settings
--load-hold-per-core N` sets it.

Issue 1274: a new run on this machine (cpu or browser, release ones too)
also waits while its free memory is under `memory_free_min_percent`
(default 10), but only while another run here is going. Test boxes still
take their runs. The reason reads "waiting: this machine has 6% of its
memory free, under 10%, while another run here is going". macOS reads the
kernel's free level (what `memory_pressure` prints); Linux reads
MemAvailable. 0 turns it off; `gate settings --memory-free-min-percent N`
sets it. `DEN_GATE_FREE_MEM` fixes the reading for tests and drills.

New runs here also wait, on the same terms, while swap in use is over
`swap_hold_gb` (default 8): macOS can show plenty of free memory while swap
fills. `gate settings --swap-hold-gb N` sets it (0: off);
`DEN_GATE_SWAP_GB` fixes the reading. `gate status`, its `--json` and the
Gate pop-up show a run waiting on memory or swap, this machine's free memory
and swap, and what running VMs reserve.

An unknown memory reading holds, never grants. If free memory or swap should
be readable here and the read fails, the last good reading stands for
`memory_reading_keep_seconds` (default 30; `gate settings
--memory-reading-keep-seconds N`). After that, new runs here wait while another
run here is going, with the reason "memory reading unavailable". The server
takes one reading when it starts, before it serves, and reads again in the
background after that. Its requests never wait for `sysctl`. On a platform with
no reading (neither macOS nor Linux), memory isn't measured, and memory holds
don't apply. `gate status`, the Gate pop-up and `den doctor` say so.

`den doctor` lists the VMs here (OrbStack machines, and Docker's VM when it
isn't OrbStack's) with the memory and cpus each reserves, and warns when
running VMs promise more than `vm_memory_share` × the machine's RAM
(default 1: more than it has). A runtime it can't read is "not counted".
`gate settings --vm-memory-share N` sets the share (0.1 to 4).

`DEN_GATE_LOAD5` is a test override: when set, the gate reads that number as
the 5-minute load instead of the machine's, for both holds (issues 1009 and
1048). Den's test setup sets it to 0, so a busy machine never holds a test's
own slot, and a drill can set it high. Anything that sets it skips the real
load, so never set it in a service's environment.

Each cpu run on this machine gets `DEN_GATE_WORKERS`: the cores shared by
the cpu slots, at least 2 (9 on 18 cores with 2 slots). Den's jest config
reads it when `DEN_TEST_WORKERS` is unset; any runner can.

A browser run that waits only because more cpu runs hold the machine than
may run beside it is never starved: while it waits, no new cpu run starts
past that number. Once they drop to it, the browser run starts.

```sh
den gate settings --cpu-slots-beside-browser 0   # a browser run runs alone
```

## More than one browser run on this machine

`local_browser_slots` (default 1) is how many browser runs may hold this
machine at once, counted the way a test box's slots are. Each browser run
here is in its own container, so a person may set it higher. A browser run
on a test box doesn't use one. The cpu runs beside them stay at
`cpu_slots_beside_browser` in all, however many browser runs hold. With
more than one, `gate status` guesses a browser waiter's start from the slot
that frees first.

```sh
den gate settings --local-browser-slots 2
```

`gate status`, `gate_slot_status` and the runner route's `place` give a
waiting run's place in its own kind's line (1 is next).

On the machine itself, wrap the run. The browser server at port 3000 is
the one `npm run pw:server` starts in Den's repo: Playwright's image
pinned by its multi-arch digest, so it runs the machine's own build.

```sh
DEN_PW_WS=ws://127.0.0.1:3000/ den gate run --kind browser --estimate 6m --label "e2e" -- npm run test:e2e
den gate status            # who holds a slot, who waits
```

`gate status`, the Agents page and `GET /api/gate-slots` show every holder,
local or remote.

The slot is given back the moment the command ends, however it ends: its
own exit, or any signal (Ctrl-C, `kill`, a hang-up). A signal sent to
`gate run` itself (SIGINT, SIGTERM, SIGHUP or SIGQUIT) is passed to the
command, and the slot is free once the command ends. On Linux a command
that dumps core (SIGQUIT) gives its slot back as the dump starts, not
after it: it can run no more, and a crash handler may take seconds to
read the dump. An agent can also
give back a slot its own `gate run` made with the MCP tool
`gate_slot_release` (its id from `gate status`); giving it back does not
stop the command. Another agent's slot is refused.

## A browser run on a Mac uses a container browser

On a macOS host, a browser slot is refused unless the ask says where its
browser runs. Several WebKit browsers started on a shared Mac can take its
window server down, and every login session on it with them. So the ask
declares one of:

- a container's Playwright server, a `ws://` or `wss://` address:
  `gate run --browser-endpoint ws://127.0.0.1:3000/…`, or `DEN_PW_WS`,
  `HUB_PW_WEBKIT_WS` or `E2E_WEBKIT_WS` in the run's environment (the
  first good one counts). An address given with `--browser-endpoint`
  reaches the run as `DEN_PW_WS`.
- `self`: the run starts its own browser container, so there is no
  address yet when it asks (`--browser-endpoint=self`). Its own setup
  keeps the browser in that container.

On a Mac, a run with no `--box` and no browser of its own isn't refused when
a test box can serve it: it waits for a box only, since a box's browser is in a
container.

Over MCP (`gate_slot_request`) and HTTP (`POST /api/gate-slots/ask`) the
field is `browser_endpoint`. A run for a named test box uses that box's
browser and needs none. An address that is given is checked everywhere:
anything but `ws://`, `wss://` or `self` is refused. The slot records what
was declared (`self`, or the address without its path): `gate status`
shows `browser self`, and `--json` and the MCP tools carry
`browserEndpoint`.

The Setting `gate_slots.browser_requires_container` (Settings, "Browser
runs need a container") is on by default on macOS and off elsewhere:

```sh
den gate settings --browser-requires-container 0   # off on this machine
```

## An agent that holds a slot over MCP

An agent can hold a slot across several commands with the MCP tool
`gate_slot_request`. Its MCP server keeps running while the agent is idle,
so the slot is held by a claim and a lease, not by a process:

- Put in line, the agent is told in its session when its slot is granted:
  "Your browser slot is granted: <id>. Call gate_slot_request with this id
  to start …". Den types it only at the agent's input prompt, as it does a
  Hub comment, and holds it otherwise.
- The agent claims it by calling `gate_slot_request` with the id. Not
  claimed within `claim_minutes` (default 3) while someone else waits, it
  goes to the next in line (`passed-unclaimed` in the slot log). The agent
  goes back in line and is told so.
- While it holds the slot, the agent renews it the same way, every
  `mcp_renew_minutes` (default 5). A slot not renewed for
  `mcp_lapse_minutes` (default 15) and past its estimate plus
  `mcp_grace_minutes` (default 15) is taken back (`taken-back-lapsed`), and
  the next in line starts. The bell names it, and the agent's next tool call
  says so.

`gate run` holders are unchanged: they hold while their process runs.
Change the four settings in Settings › Server, or with
`den gate settings --claim-minutes N --mcp-renew-minutes N --mcp-lapse-minutes N --mcp-grace-minutes N`.

## A release run a person waits on

```sh
den gate run --kind browser --priority release --reason "the person waits on the candidate" -- npm run test:e2e
```

Use it only for a release run that the person marked, or that is for an
issue the person reported. It goes to the front of its kind's waiting runs.

- It never stops a run that holds a slot. It waits for that run to end.
- It goes ahead of every plain waiting run of its kind, however long that
  run has waited.
- One such run per kind has priority at a time (`priority_max`, default 1).
  A second waits behind the first, then takes priority once the first
  starts.
- Between marked runs only: it never passes another marked run that has
  waited `priority_pass_limit_minutes`. The default, 0, means it never
  passes another marked run.
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
`--priority-max 0` turns release priority off for every repo on the machine,
so it warns first and changes nothing (exit 1) unless you add `--yes`. A
script that turns it off must pass `--yes`. While it is off, `gate status`
says so on its last line, and a `gate run --priority release` says it is
taken as an ordinary run.
A CI runner may ask for it too (see below; `priority_runners`).

## A waiting run keeps its place across a restart

A Den restart (or its window closing) can end a `gate run` while it waits.
Its place in line is kept for `waiter_return_minutes` (default 10):

- `gate status` shows it as `run gone, place kept until <time>`. It's
  never given a slot while it's gone, so the next live run starts instead.
- The same run asking again (same kind, label, repo and asker, and the
  same `--box` choice) takes its place back: `gate: back in your place
(<id>)`. A different run goes to the end of the line as usual.
- If it doesn't come back in time, the place is let go. The slot log
  records `taken-back-gone` with reason `waiter-gone`, and the next time
  that run asks, it prints `gate: your earlier place (asked <time>) was let
go at <time>`.

Only a hang-up or terminate signal (SIGHUP, SIGTERM) keeps the place.
Ctrl-C (SIGINT) and SIGQUIT give it back at once. A holder whose run ends
frees its slot at once, as before. Agents' MCP asks and CI runners keep
their own leases.

Change it in Settings › Server, or with `den gate settings
--waiter-return-minutes N` (0: a gone waiter loses its place at once).

## What a run leaves behind is stopped

`gate run` starts its command in its own process group, and in a new
session with no terminal. When the run is over, whatever the command
started that is still running is stopped: first asked to stop, then killed
after `reap_grace_seconds` (default 10). That happens when:

- the command ends (gate run waits for its leftovers before it exits);
- the run's folder is deleted while it holds the slot;
- the process that started gate run goes away. A run started with
  `nohup … &` therefore ends when its shell exits;
- gate run itself was killed. The next look at the queue, from anything on
  this machine, stops what it left.

Nothing outside the run's group is ever touched. A group is stopped only
while it is still the one the run started: its leader's start time is
checked first, and a group recorded before the machine restarted is never
stopped. The slot log records `stopped-leftovers` with how many, the
command's name and the run's label, never arguments. `gate status` and the
Gate pop-up list the last hour's.

The command has no terminal, so one that asks for a password on it (an ssh
or git prompt, pinentry) fails at once with "Device not configured"
(ENXIO). Give such a command its password another way.

Change the grace in Settings › Server, or with `den gate settings
--reap-grace-seconds N`.

## No run starts while the machine is overloaded

A run that has its slot doesn't start its command while this machine's
5-minute load average is at or over `max_start_load` (the total, not per
core). It waits, and `gate status`, the Gate pop-up and the run's own output
say so: `waiting for the load (40) to drop under 27`. After
`max_start_wait_minutes` (default 10) it starts anyway, and the slot log
records `started-busy` with the load.

The default is the machine's cores × 1.5 (27 on 18 cores), below where a
machine stalls: an 18-core one reset twice at a 5-minute load of about 34.
0 turns it off. It holds every run, release runs too. It's not
`cpu_hold_load`, which holds only cpu asks, and only during a release
browser run.

Change them in Settings › Server, or with `den gate settings
--max-start-load N --max-start-wait-minutes N` (wait 0: no limit).

## Let one waiting run go ahead of yours

```sh
den gate status                          # find both ids
den gate yield <your-id> --to <their-id>
```

Your waiting run lets another waiting run go just ahead of it, and keeps
its own place otherwise: A, B, C becomes C, A, B when A lets C ahead.
Before this, the only way was to give your place back and ask again at the
back of the queue.

- Only the owner of `<your-id>` can do it: the agent that asked for it (its
  `gate run`, or its MCP ask), or a person for a run no agent asked for. It
  is not a person's only, because it only moves your own place back.
- Never a run that holds a slot. `--to` must name a waiting run behind
  yours.
- A yield never moves a run past one that outranks it: a release-priority
  run, or a run of a higher class (below), between yours and theirs stays
  ahead, and the yield waits until it no longer passes one.
- The slot log has a `yielded` row with both ids (`id`, `to`).
- `gate status` (text and `--json`, `yieldedTo`) and the queue on the
  Agents page show it on your run's line until your run starts.
- The MCP tool `gate_slot_yield` (`id`, `to`) does the same.

## Priority classes per project

Off by default: with no classes set, the queue is first come, exactly as
above. A person sets three lines in Settings › Server, or with
`den gate settings`:

```sh
den gate settings --class-order "release, lane, other" \
  --class-map "den=lane, label:release*=release, *=other" \
  --class-windows "other=22:00-06:00/30"
```

- `class_order`: the classes, highest first. Among waiting runs, a higher
  class starts first. Within a class, first come. A run that holds a slot
  is never taken back. A release-priority run (above) still goes first:
  it moves ahead of waiting runs of any class.
- `class_map`: each project's class. `<project>=<class>` names a project
  (a `gate run`'s repo folder, or an agent's Den project over MCP).
  `label:<pattern>=<class>` matches a run's label (`*` is any text), and
  wins over the project. `*=<class>` is every other project. Without `*`,
  the last class.
- `class_windows` (optional): `<class>=HH:MM-HH:MM/<minutes>`, in the
  machine's local time. Outside its window, a run of that class estimated
  at least that many minutes waits while a run of a higher class holds or
  waits. It waits at the back and blocks no one. With no higher-class run,
  it starts at once. Without `/<minutes>`, every run of the class.
- The class comes from these settings, never from the asker.
- `gate status` (text and `--json`), the queue on the Agents page and the
  slot log (`class` on each row) show each run's class, and a run waiting
  for its window says so.

`""` clears a line (`--class-order ""` turns classes off).

## The order, all together

0. Browser and cpu runs wait in separate lines; this order applies within
   each. Up to `cpu_slots_beside_browser` cpu runs run beside a browser run
   on this machine.
1. A run that holds a slot is never taken back.
2. A release-priority run (a person's, an agent's or a CI runner's) goes
   first in its kind, past any class and any plain run, but never past
   another marked run waiting longer than `priority_pass_limit_minutes`
   (at 0, never past one).
3. Then classes, highest first.
4. Then yields: a run let ahead goes just ahead of the run that let it,
   never past a run that outranks it by 2 or 3.
5. Then first come.

A run its class's window holds waits at the back and blocks no one. Test
box slots and MCP leases apply to whichever run this order starts.

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
- `ask` with `"priority": "release"` and a `"reason"`: a release run a
  person waits on goes ahead of its kind's plain waiting runs, under the
  same rules as `gate run --priority release` (above). The slot log's
  `priority` row names the runner (`by: "runner:<name>"`) and the reason.
  Without a reason: 400 `reason_required`, and nothing is queued. When
  `priority_runners` is 0 (Settings › Server, or
  `den gate settings --priority-runners 0`): 403 `priority_refused`, and
  nothing is queued; ask without priority to wait in the normal queue.
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
- `--pw <version>=ws://…`, repeated: a box with several Playwright servers,
  one per version (`--pw 1.61=ws://box1.example:3931 --pw
1.63=ws://box1.example:3932`). A run gets the one whose version matches
  its own (`1.61` serves any 1.61.x). Use it instead of `--playwright` and
  `--playwright-version`. The box's `--slots` count is the box's, whatever
  version a run takes. In settings.json it is `playwright_endpoints`
  (version → address); a box set before, with one address, reads and runs
  as it did.
- `--slots N`: browser runs the box takes at once (its "one heavy job at a
  time" rule is 1).
- `--hold-file <path>` (needs ssh; relative to the box user's home): while
  this file is on the box, the box takes no new runs. Its running slots
  finish.
- `--time-scale X`: the box's browsers take X times as long as this
  machine's. Its runs' expected ends stretch by it, and the run gets
  `DEN_GATE_TIME_SCALE` to stretch its own timeouts.
- `--window HH:MM-HH:MM`: when the box may be used, in **this machine's
  local time zone** (the gate host's, not the box's). Optional; without
  it, any time.
- `--off`: add the box turned off. `den gate box enable|disable <name>`
  switches it later.
- `--recheck-seconds N`: this box's own `box_recheck_seconds` (below).

### When a box may be used: its window and its switch

Some boxes are free only part of the day: an evening-only box, a Windows
box that is someone's machine by day.

```sh
den gate box add box3 --ssh ci@box3.example --window 00:00-08:00
den gate box add box4 --ssh ci@box4.example --window 22:00-06:00 --off
den gate box enable box4
den gate box disable box3
```

- A window may wrap past midnight (`22:00-06:00`). Times are this
  machine's local time; Settings and `gate box list` say so. The queue
  pop-up shows when a closed box opens in the viewer's own time.
- Outside its window, or turned off, a box gets **no slots and no
  contact**: Den doesn't read its hold file, open a connection to its Playwright server,
  or check it from `doctor` or `gate status`. A run waiting for that box
  by name waits; a `--box any` run takes this machine or another box.
- A run that already holds a slot on a box **finishes** when the window
  closes, or when the box is turned off. No new slot is given after.
- Each box is on unless turned off. An existing `settings.json` with boxes
  loads unchanged: on, no window, the global recheck.
- Turning a box on or off is a person's only (Settings › Server › Test
  boxes, or the CLI), and goes in the audit, like adding or removing one.

`gate status`, the queue pop-up and `den doctor` say why a box is
skipped: "outside its window (opens 00:00)" or "turned off".

### An agent can ask

Changing the boxes is yours: `gate box add|remove` and the boxes routes
refuse an agent. An agent asks instead, with the held writes
`gate_box_set` (the same fields as `gate box add`; `slots` is `--slots`)
and `gate_box_remove`:

```
gate_box_set { name: "box1", ssh: "ci@box1.example", slots: 1 }
gate_box_remove { name: "box1" }
```

Den checks the box at the ask and refuses a bad one (or a remove of a box
it doesn't have) with the same words `gate box add` gives. Nothing changes
until you Allow it in Den's browser dialog, which shows every field it
will set. No approval policy runs these without you. On Allow, Den sets
the box just as your own Settings change does; the activity trail says
who asked and who allowed. Deny changes nothing.

### Which runs go to a box

A browser run with no `--box` takes whichever browser slot frees first:
this machine's, then the first test box with a free slot. A box's browser
reaches the app by the run's `--base-url`; with none, it may reach only
the ports the run opens itself (`http://127.0.0.1:*`, never 80 or 443):

```sh
den gate run --kind browser --base-url http://app.localhost:4100 -- npm run test:e2e
den gate run --kind browser --box local -- npm run test:e2e    # this machine only
den gate run --kind browser --box box1 --base-url http://app.localhost:4100 -- npm run test:e2e
```

`--box local` (or this machine's own name) keeps a run here; `--box <name>`
sends it to that box; `--box any` is the default spelled out. The run is
told what it got: `DEN_GATE_BOX` (the box's name), `DEN_PW_WS` (its
Playwright server, when set), `DEN_PW_EXPOSE` (`<loopback>`, beside
`DEN_PW_WS`: what its client exposes to the box), `DEN_GATE_BOX_SSH` and
`DEN_GATE_TIME_SCALE`.

A run with no `--box` stays on this machine, and says why in one line
(`gate: stays on this machine: …`), when:

- its project or label is host-only (`browser_host_only`, below);
- it brings its own browser: `--browser-endpoint` (an address, or `self`
  for a container it starts), or `DEN_PW_WS`, `HUB_PW_WEBKIT_WS` or
  `E2E_WEBKIT_WS` in its environment naming a container on another host.
  One on this machine's loopback (`ws://127.0.0.1:…`) is what the run uses
  if it stays here; given a box, `DEN_PW_WS` becomes the box's;
- its `--base-url` is one a box can't use;
- its Playwright version is unknown (no `--pw-version`, and none installed
  where it runs): a box's server would refuse it;
- no box can serve it. By default a run skips a box that declares no
  Playwright version (`playwright_version` or `--pw`; its server refuses another
  client version), and a box whose versions don't serve the run's (a
  box's one `playwright_version` matches by major.minor: 1.61.1 serves a
  1.61.0 client). It
  takes a box like that only with `--box <name>`. When some boxes are
  skipped and others aren't, it says which (`gate: skips …`) and takes
  only the others.

It never fails for that: it waits for this machine's slot, as before.
`gate status` shows each held browser slot's machine (`on box box1`, or
`on this machine` with the reason it stayed), and so do `gate status
--json` (`machine`, `hostWhy`) and the slot log's `granted` rows.

Two settings (Settings, or `den gate settings`):

- `browser_box_default`: `any` (the default) or `local`. At `local`, a run
  with no `--box` takes only this machine's slot, as before boxes were the
  default: `den gate settings --browser-box-default local`.
- `browser_host_only`: projects and label patterns whose browser runs
  stay here, comma-separated, as `class_map` names them: a project by
  name, `label:<pattern>` with `*` for any text. For example layout suites
  and WebKit on macOS:
  `den gate settings --browser-host-only "label:layout*, label:*webkit*"`.
  Empty (the default): none.

A test suite that starts its own server on a free port (Den's own browser
suites do) names a loopback host (`127.0.0.1`, `localhost` or
`<name>.localhost`) with `*` for the port. The `*` covers only the ports the
run opened itself, never 80 or 443. A box run pins `localhost` and
`<name>.localhost` to `127.0.0.1`, so the three names are one host: a run
allowed `127.0.0.1:*` reaches `localhost:<its port>` (where Den's test
servers listen), and the reverse. `::1` and the rest of `127.0.0.0/8` are
not the same host:

```sh
den gate run --kind browser --box mini --base-url 'http://127.0.0.1:*' -- npx jest tests/unit/server/x.browser.test.ts
```

Den's browser test helper (`tests/unit/helpers/browser.ts`) then connects
to the box's `DEN_PW_WS`, sharing this machine's loopback with it, and holds
every page to `DEN_GATE_ALLOW`. A `*` port covers the ports a server in the
test process is listening on now, and the ports of child servers a helper
saw answer (`startDenServer` claims its child's with `boxOwnPort(port)`).
A port leaves when its server closes. Any other port on this machine is
refused, and printed as `box guard: refused <url>`. A box run with no base
URLs opens no browser.

A CI runner that runs on a box asks for that box's slot by name
(`"where": "box1"` in its `ask`), so the app, the browser and the tests
all run on the box. The answer says `box` once it holds the slot.

The queue stays first come, first served: a run that waits keeps the slots
it waits for from the runs behind it, and never blocks a slot it can't use.

### Checking a box

A box is checked only when a slot on it is about to be given, never on a
timer. The check is a read: over ssh, one sftp session that lists the
hold file and reads the box's `/proc/meminfo` (the box runs nothing for
it). The file is copied into a new private folder on the gate host (mode
0700), read, and the folder removed, so this works from a macOS gate host
too, whose sftp can't write to a pipe (issue 1381). A macOS box has no `/proc/meminfo`: Den then runs one fixed command
over ssh, `vm_stat` and `sysctl -n hw.pagesize`, and nothing else, and
counts free, inactive and speculative pages as available. A macOS box
added with ssh gets the hold file and the memory floor like a Linux box.
With only a Playwright address, a WebSocket upgrade to that address
(an HTTP GET with `Upgrade: websocket`), closed as soon as it answers.
Only "101 Switching Protocols" counts as open: a relay or port forward in
front of a dead server still accepts a TCP connection, so a bare connect
is never enough.

- **Held** (its hold file is there): no new slot. The next assignment
  after the file is placed sees it.
- **Low on memory**: the box has less available memory than its
  `min_free_mem_mb` (2048 by default; `--min-free-mem-mb`). No new slot,
  and the queue says "box low on memory".
- **Memory unknown**: Den couldn't read the box's free memory (no
  `/proc/meminfo` and no `vm_stat`, or output it can't read). The box is
  skipped with why, never counted as free. A box set with
  `--min-free-mem-mb 0` keeps no free memory, so its memory isn't read.
- **Unreachable** (no answer within `box_check_timeout_seconds`, 8 by
  default, never more than 25): skipped, with why, and the run goes to
  another box or waits. An ssh that connects but stalls before its banner
  is killed at that time and counts as unreachable.
- **Version mismatch**: a box set with `--playwright-version` takes only
  runs whose Playwright client is that version. Any other run skips the
  box, and the queue says "client X ≠ server Y". A box set with `--pw`
  takes a run when one of its versions serves the run's; otherwise the
  queue says "client X: box serves 1.61, 1.63". `gate run` takes the run's
  version from `--pw-version`, else from the Playwright installed in its
  folder's `node_modules` or one above it up to the repo's top folder (a
  workspace with Playwright at the root), else installed for the nearest
  `package.json` below its folder that depends on Playwright (a repo with
  Playwright in `web/`). Only an installed version counts: a range in a
  `package.json` is never read as one. With no version found, a box with
  one address takes the run as before (no version check); a box with
  `--pw` versions refuses it: pass `--pw-version`. `gate status` lists
  each box's versions.

A box slot is one heavy job at a time unless `--slots` says more.

### A box run never reaches this machine's live services

A browser on a box, driving an app here through a tunnel, sees this
machine as its loopback, where ports 80 and 443 may be live services. So:

- `gate run --box …` needs `--base-url`: the app's loopback addresses
  (`localhost`, `*.localhost` or `127.0.0.1`), each with an explicit port
  other than 80 or 443, or `*` for the ports the run opens itself (never
  those two). Anything else is refused.
- The run gets `DEN_GATE_ALLOW` (the allowed `host:port` list). Its
  Playwright setup guards every browser context with Den's
  `shared/gates/pw-guard` module (`guardBrowser`), so only those
  host:ports load, and each blocked request is reported.
- The box's browser reaches this machine's ports only through a client
  that connects with `exposeNetwork: "<loopback>"`. The gate hands a box
  run `DEN_PW_WS` (the box's Playwright server) and `DEN_PW_EXPOSE`
  (`<loopback>`); on this machine it adds neither. Den's own browser
  helper reads both. Another product's client connects with pw-guard's
  `connectGuarded(chromium, process.env.DEN_PW_WS)`, which reads
  `DEN_PW_EXPOSE` itself and returns the browser already guarded by
  `DEN_GATE_ALLOW` (issue 1205): with no allow list nothing loads, so it
  never reaches this machine unguarded. A client that connects itself,
  `chromium.connect(process.env.DEN_PW_WS, { exposeNetwork: process.env.DEN_PW_EXPOSE })`,
  must call `guardBrowser` on the result. Guarding twice is harmless:
  a second guard can only narrow what loads.
  A box run (`DEN_GATE_SLOT_BOX` is a box's name) that connects through
  pw-guard without it is told once: `box run without exposeNetwork
<loopback>: pages on this machine will be refused; pass DEN_PW_EXPOSE
to connect()`.
- The setup calls `pinLoopbackNames()` too: `localhost` and
  `*.localhost` resolve to 127.0.0.1 in the client, never ::1 (the
  tunnel's forwarders listen on IPv4).
- A held or unreachable box is passed over for `box_recheck_seconds` (30
  by default), then checked again the next time a slot on it is wanted.
  A fragile box can set its own `recheck_seconds` (`--recheck-seconds`,
  or Settings): the least time between two contacts while it says no, so
  a queue waiting on it contacts it at most once in that time.

`gate status`, the queue on the Agents page and `den doctor` show each
slot's box and each box's state, with why a box is skipped. The slot log
(`events.jsonl`) names the box on each grant and release. Both settings
are in Settings › Server, or
`den gate settings --box-check-timeout-seconds N --box-recheck-seconds N`.

## Runs inside a held slot

`gate run` gives its command these variables: `DEN_GATE_SLOT` (the
slot's id), `DEN_GATE_SLOT_KIND` (`cpu` or `browser`) and
`DEN_GATE_SLOT_BOX` (`local`, or the test box it runs on), plus
`DEN_GATE_STORE` (see "Throwaway containers go with their run"). A `gate run`
started from inside that command, of the same kind and on the same place,
runs inside the held slot at once: no second entry, no wait behind its
own slot. It must run under the slot's run (its process or a child of
it); a process that only sets `DEN_GATE_SLOT` waits in line as any other.
A nested run of the other kind asks as before. A nested run never
outlives its slot: when the outer run ends and gives the slot back, the
nested command is stopped. Inside a held slot, `--browser-endpoint` is not
used: the held slot's browser is. A slot an agent holds through Den's
tools (not `gate run`) has no command to nest under, so it has no nested
runs.

A project's own lock helper can read the same variables: when
`DEN_GATE_SLOT_KIND` is the kind it would lock, it is already inside a
held slot and should not lock again.

## Throwaway containers go with their run

A test that starts a container of its own (a database, a cache) labels it
so the gate can remove it when the run ends. Add the labels from
`ephemeralLabels(process.env)` (in `src/shared/gates/ephemeral.ts`) to
`docker run`:

| Label            | Value                                                      |
| ---------------- | ---------------------------------------------------------- |
| `den.ephemeral`  | `1`: a throwaway container, never a service                |
| `den.gate.run`   | the run's slot id (`DEN_GATE_SLOT`), inside a gate run     |
| `den.gate.store` | the slot store's tag (`DEN_GATE_STORE`), inside a gate run |

`gate run` gives its command both values, so a helper in any language can
add `--label den.ephemeral=1 --label den.gate.run=$DEN_GATE_SLOT --label
den.gate.store=$DEN_GATE_STORE` (the last two only when `DEN_GATE_SLOT` is
set).

Who removes them:

- `gate run`, as soon as its command ends and its slot is given back.
- Den's server: any throwaway container whose run has no live slot (taken
  back, lapsed, ended by a person, or killed before it could clean up). It
  looks when a slot has ended, once at start (so a container Docker brings
  back after a restart goes), and every 10 minutes otherwise. Each docker
  call has a 5-second limit, and after a failure it waits longer each time.
  A container goes only when two looks at least a minute apart both found
  its run ended, and never when the slots can't be read for sure.

Only a container with all three labels, from this machine's slot store, is
ever removed. One started outside a gate run (no run label) is never
removed: `den doctor` lists it. The slot log records each removal with the
count and the image names, never a command line or environment.
`gate status` (and `--json`, as `removed`) shows the last day's removals,
and `den doctor` warns about any left over from an ended run.

### Kept containers: stopped, never removed

A test database that is slow to make (an extension to install) can be kept
for the checkout instead: label it `den.ephemeral=stop` and
`den.gate.checkout=$DEN_GATE_CHECKOUT`, with `den.gate.run` and
`den.gate.store` as above (`ephemeralLabels(env, { keep: true })` builds
them). `gate run` gives its command `DEN_GATE_CHECKOUT`, a tag for the
checkout it runs in (the folder holding `.git`), and records it on its
slot.

A kept container belongs to its checkout, not to the run that made it: a
container's labels can't change, so a later run reusing it would still
carry the first run's id. It is **stopped**, never removed, when it is
running, no live slot comes from its checkout, and it started before that
checkout's last slot ended: when `gate run` ends, or when the server's
sweeper finds it so on two looks a minute apart. One started after the
checkout's last run ended is someone's own use outside the gate, and is
left alone. One already stopped is left alone. One with no checkout label,
or a `den.ephemeral` value other than `1` or `stop`, is never touched.
`den doctor` counts stopped kept containers apart, and lists one running
with no gate run from its checkout.
