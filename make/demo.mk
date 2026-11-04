# make/demo.mk — end-to-end proof of the repo flow on three demo repos
#
#   examples/demo/demo-api     standalone API
#   examples/demo/demo-web     calls demo-api  (.den.yml compose.uses)
#   examples/demo/demo-notes   unrelated, standalone
#
# Each repo carries its own Makefile (run it alone) and .den.yml (how
# den runs it: compose behind the HTTPS edge, no host ports).
#
#   make demo           register + up + check + restart + down, then clean up
#   make demo-register  workspace "demo" with the three repos
#   make demo-apps      den apps: "shop" (declared by the repos) + demo-notes (its own)
#   make demo-up        den up -A shop (demo-api first), then demo-notes
#   make demo-check     HTTPS through the edge (retries ~10s while the edge
#                       picks up new routes); demo-web shows demo-api's answer
#   make demo-status    den status
#   make demo-restart   den restart -A shop
#   make demo-down      den down, every demo repo
#   make demo-clean     down, drop the demo workspace + catalog entries, refocus

.PHONY: demo demo-apps demo-register demo-up demo-check demo-status demo-graph demo-restart demo-down demo-clean

DEMO_WS     := demo
DEMO_REPOS  := demo-api demo-web demo-notes
DEMO_DIR    := $(CURDIR)/examples/demo
DEMO_PREV   := $(HOME)/.den/demo-prev-focus
DEMO_DOMAIN := $(shell npx tsx -e 'import("./src/shared/edge/config.ts").then(m=>console.log(m.readEdgeConfig().domain))' 2>/dev/null)
DEN_CLI     := ./bin/den

# Steps run in sequence (a prerequisite list would run demo-check only once).
demo:
	@for t in demo-register demo-apps demo-graph demo-up demo-check demo-restart demo-check demo-status demo-clean; do \
	  echo "\n── make $$t"; $(MAKE) --no-print-directory $$t || { $(MAKE) --no-print-directory demo-clean; exit 1; }; \
	done
	@echo "\n✓ demo passed"

demo-register:
	@mkdir -p $(dir $(DEMO_PREV))
	@[ -f $(DEMO_PREV) ] || npx tsx -e 'import("./src/shared/environment-manager/workspaces.ts").then(m=>console.log(m.getFocusedWorkspaceName()??"default"))' > $(DEMO_PREV)
	@$(DEN_CLI) workspace create $(DEMO_WS) >/dev/null
	@$(DEN_CLI) workspace use $(DEMO_WS) >/dev/null
	@for r in $(DEMO_REPOS); do $(DEN_CLI) register $(DEMO_DIR)/$$r; done
	@$(DEN_CLI) workspace list

demo-apps:
	@$(DEN_CLI) apps

demo-graph:
	@$(DEN_CLI) up -A shop --dry-run

demo-up:
	@$(DEN_CLI) up -A shop
	@$(DEN_CLI) up demo-notes

demo-check:
	@set -e; for u in api.demo-api app.demo-web app.demo-notes; do \
	  for i in 1 2 3 4 5 6 7 8 9 10; do \
	    code=$$(curl -sk -o /dev/null -w '%{http_code}' https://$$u.$(DEMO_DOMAIN)/healthz); \
	    [ "$$code" = 200 ] && break; sleep 1; \
	  done; \
	  echo "$$code https://$$u.$(DEMO_DOMAIN)/healthz"; [ "$$code" = 200 ] || exit 1; \
	done
	@curl -sk https://app.demo-web.$(DEMO_DOMAIN)/ | grep -q '"service": "demo-api"' \
	  && echo "✓ demo-web reached demo-api over the link network" \
	  || { echo "✗ demo-web did not reach demo-api"; exit 1; }

demo-status:
	@$(DEN_CLI) status

demo-restart:
	@$(DEN_CLI) restart -A shop

demo-down:
	@$(DEN_CLI) down -A shop
	@$(DEN_CLI) down demo-notes

demo-clean: demo-down
	@$(DEN_CLI) workspace use $$(cat $(DEMO_PREV) 2>/dev/null || echo default) >/dev/null
	@$(DEN_CLI) workspace delete $(DEMO_WS) --yes >/dev/null
	@npx tsx -e 'import("./src/shared/environment-manager/catalog.ts").then(m=>{for(const r of process.argv.slice(1))m.removeCatalogEntry(r)})' $(DEMO_REPOS)
	@echo "✓ demo workspace removed; focus back on $$(cat $(DEMO_PREV) 2>/dev/null || echo default)"
	@rm -f $(DEMO_PREV)
