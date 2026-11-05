# make/den.mk — Den's make targets, for any distribution.
#
# A distribution's Makefile includes it from the installed package:
#
#   include node_modules/@monster-orange/den/make/den.mk
#
# Den's own Makefile includes it too (include make/den.mk). Recipes run from
# the distribution root (the directory make runs in: config/, manifests/,
# reports/ and results/ live there) and reach Den's own files through
# $(DEN_ENGINE). In Den's checkout the two are the same directory.

# Prefix of the service and setup targets (`make <prefix>-up`, -status, …):
# the distribution's own name. Set it before the include; Den's own is "den".
DEN_TARGET_PREFIX ?= den

# Den's package root: the directory above this file.
DEN_ENGINE ?= $(patsubst %/,%,$(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..))

# The distribution root, and the engine, for every Den process a recipe runs.
DEN_ROOT ?= $(CURDIR)
export DEN_ROOT
DEN_ENGINE_ROOT := $(DEN_ENGINE)
export DEN_ENGINE_ROOT

# Binaries from Den's dependencies: Den's own node_modules (a checkout) or
# the distribution's, where npm hoists them.
den_bin = $(firstword $(wildcard $(DEN_ENGINE)/node_modules/.bin/$(1) $(CURDIR)/node_modules/.bin/$(1)) $(1))
DEN_TSX        ?= $(call den_bin,tsx)
DEN_PLAYWRIGHT ?= $(call den_bin,playwright)
# The CLI (as `den`, or the distribution's own name via its den.yml).
DEN_BIN        ?= $(DEN_ENGINE)/bin/den
DEN_CLI_TS     ?= $(DEN_TSX) $(DEN_ENGINE)/src/ui/cli/index.ts

# ── Globals ───────────────────────────────────────────────────────────────────

# Environment selection — defaults to local.
# Usage: make test-syn-all env=staging
env ?= local
export E2E_ENVIRONMENT=$(env)
OPEN_REPORT ?= 0

# Secrets backend is a strategy chosen in the org config (secrets.provider:
# none | doppler | 1password | env). Override per shell:
#   DEN_SECRETS_PROVIDER=env make up
# Den sets no backend account of its own (no OP_ACCOUNT here): the 1password
# strategy reads secrets.onepassword.account, or your own OP_ACCOUNT.
#
# Backend-specific targets come from make/secrets-<provider>.mk, included
# only when the distribution selects that backend. The selection is read
# (with tsx) only when a config or the shell could name 1password, so a
# distribution that does not use it pays nothing.
ifeq ($(origin DEN_SECRETS_STRATEGY),undefined)
ifneq ($(DEN_SECRETS_PROVIDER)$(shell grep -lsE 'provider: *.?1password' $(CURDIR)/config/*.yml $(CURDIR)/config/local/user.yml 2>/dev/null),)
DEN_SECRETS_STRATEGY := $(shell $(DEN_TSX) $(DEN_ENGINE)/scripts/setup-secrets.ts --provider 2>/dev/null)
else
DEN_SECRETS_STRATEGY :=
endif
endif
export DEN_SECRETS_STRATEGY

# Repo for the smoke and browser pillars — no default: make test-smk-all repo=<repo>
repo ?=

# ── Fragments ─────────────────────────────────────────────────────────────────
include $(DEN_ENGINE)/make/test.mk
include $(DEN_ENGINE)/make/local_dev.mk
include $(DEN_ENGINE)/make/journeys.mk
include $(DEN_ENGINE)/make/security.mk
include $(DEN_ENGINE)/make/demo.mk
ifneq ($(DEN_SECRETS_STRATEGY),)
-include $(DEN_ENGINE)/make/secrets-$(DEN_SECRETS_STRATEGY).mk
endif

# ── Help ──────────────────────────────────────────────────────────────────────
# A distribution gets `make help` from here; Den's own Makefile has a longer
# one and sets DEN_OWN_HELP before including this file.
.PHONY: $(DEN_TARGET_PREFIX)-help
$(DEN_TARGET_PREFIX)-help:
	@printf '\nDen targets (run from this directory)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
	@printf '  make test                  interactive test runner\n'
	@printf '  make web                   the web UI\n'
	@printf '  make $(DEN_TARGET_PREFIX)-up / down         start / stop services\n'
	@printf '  make $(DEN_TARGET_PREFIX)-status            service status\n'
	@printf '  make test-syn-all repo=R   browser tests\n'
	@printf '  make test-int-all          API tests\n'
	@printf '  make test-smk-all repo=R   smoke tests\n'
	@printf '  make test-perf module=M    performance tests\n'
	@printf '  make test-jrn-all          journeys\n'
	@printf '  make test-sec-all          security scans\n\n'

ifndef DEN_OWN_HELP
.PHONY: help
help: $(DEN_TARGET_PREFIX)-help
.DEFAULT_GOAL := help
endif
