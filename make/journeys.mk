# make/journeys.mk — Agent-driven E2E journeys (journeys pillar)
#
# Journey specs live in registered service repos (e.g. shop-web) and are
# discovered through their .den.yml `journeys:` block; the runner drives
# a sandboxed @cursor/sdk agent per journey. See src/pillars/journeys/.
#
# Usage:
#   make test-jrn-all env=<env>                 All journeys allowing <env>
#   make test-jrn-<name> env=<env>              Single journey by spec name
#   make test-jrn-<name> env=<env> repo=<repo>  Disambiguate a spec name
#                                               duplicated across repos
#                                               (passes --journey=<repo>/<name>)
#
# The root Makefile declares a global `repo` for the smoke pillar.
# Journeys deliberately ignore that inherited default — only a `repo=` stated
# on the command line ($(origin repo) == "command line") qualifies the spec
# name; otherwise the bare name is resolved across all registered repos.
#
# EXPLICIT-ENV GUARD: the root Makefile sets `env ?= local`, which would
# silently point journeys at local. Journeys are agent-driven runs with
# real side effects, so the env MUST be stated on the command line —
# $(origin env) is "command line" only then; "file" (the ?= default) and
# "environment" (an inherited shell var) are both rejected.
#
# MODEL: each journey spec may declare its own default (`model:` field);
# the JOURNEYS_MODEL env var, when set, overrides every spec (operator
# control, e.g. CI cost pinning). A journey with neither is refused by the
# runner — no default model is ever invented. CURSOR_API_KEY needs no
# export — the runner falls back to a 1Password `op read` when unset.

.PHONY: test-jrn-all .journeys-check-env

.journeys-check-env:
ifeq ($(origin env),command line)
	@true
else
	@echo "❌ Journeys require an explicit env=<name> on the command line."
	@echo "   The Makefile default (env ?= local) is deliberately rejected for"
	@echo "   agent-driven runs. Usage: make test-jrn-all env=local"
	@exit 1
endif

# All journeys whose environments allowlist includes $(env)
test-jrn-all: .journeys-check-env .check-auth
	@echo "🧭 Running ALL journeys..."
	@echo "🌍 Environment: $(env)"
	@echo ""
	@npx tsx src/pillars/journeys/run.ts --env=$(env)

# make test-jrn-<journey-name> env=<env>
test-jrn-%: .journeys-check-env .check-auth
	@JOURNEY_NAME=$(subst test-jrn-,,$@); \
	$(if $(filter command line,$(origin repo)),JOURNEY_NAME="$(repo)/$$JOURNEY_NAME";) \
	echo "🧭 Running journey $$JOURNEY_NAME..."; \
	echo "🌍 Environment: $(env)"; \
	echo ""; \
	npx tsx src/pillars/journeys/run.ts --env=$(env) --journey=$$JOURNEY_NAME
