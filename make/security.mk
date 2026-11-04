# make/security.mk — OWASP ZAP scanning of our own services (security pillar)
#
# Scan targets are declared in each workspace repo's .den.yml (or the
# den-held manifests/<repo>.den.yml) under `security:`; the runner
# drives ZAP in docker. Every target host must be on the owned-host allowlist
# (config/den.yml `security.owned_hosts`). See src/pillars/security/.
#
# Usage:
#   make test-sec-all env=<env>                      Every target, baseline mode
#   make test-sec-<service> env=<env>                One service (bare name)
#   make test-sec-<service> env=<env> repo=<repo>    Repo-qualified (--service=<repo>/<service>)
#   make test-sec-all env=<env> mode=<m>             m = baseline | api | full | all
#   make test-sec-all env=<env> dry_run=1            Print the docker commands only
#
# Production is passive-only (baseline) and additionally needs
# DEN_ALLOW_PROD=1; the runner enforces both — this file only guards env.
#
# The root Makefile sets a global `repo ?= shop` default for the smoke
# pillar. Security deliberately ignores that inherited default — only a
# `repo=` stated on the command line ($(origin repo) == "command line")
# qualifies the service name.
#
# EXPLICIT-ENV GUARD: the root Makefile sets `env ?= local`, which would
# silently point scans at local. Scans send attack traffic, so the env MUST
# be stated on the command line — $(origin env) is "command line" only then;
# "file" (the ?= default) and "environment" (an inherited shell var) are
# both rejected.

.PHONY: test-sec-all .security-check-env

# Optional pass-through flags (only when stated on the command line)
SEC_FLAGS := $(if $(filter command line,$(origin mode)),--mode=$(mode)) \
             $(if $(filter command line,$(origin dry_run)),--dry-run)

.security-check-env:
ifeq ($(origin env),command line)
	@true
else
	@echo "❌ Security scans require an explicit env=<name> on the command line."
	@echo "   The Makefile default (env ?= local) is deliberately rejected for"
	@echo "   scans that send attack traffic. Usage: make test-sec-all env=local"
	@exit 1
endif

# Every discovered target allowed in $(env)
test-sec-all: .security-check-env
	@echo "🛡️  Running ALL security scans..."
	@echo "🌍 Environment: $(env)"
	@echo ""
	@npx tsx src/pillars/security/run.ts --env=$(env) $(SEC_FLAGS)

# make test-sec-<service> env=<env> [repo=<repo>]
test-sec-%: .security-check-env
	@SERVICE_NAME=$(subst test-sec-,,$@); \
	$(if $(filter command line,$(origin repo)),SERVICE_NAME="$(repo)/$$SERVICE_NAME";) \
	echo "🛡️  Running security scan for $$SERVICE_NAME..."; \
	echo "🌍 Environment: $(env)"; \
	echo ""; \
	npx tsx src/pillars/security/run.ts --env=$(env) --service=$$SERVICE_NAME $(SEC_FLAGS)
