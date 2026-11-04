# Runs this repo on its own with Docker Compose (host port on 127.0.0.1).
# den doesn't use `up`/`down` here: it runs the compose project itself,
# with no host ports, behind its HTTPS edge (see .den.yml `compose:`).
.PHONY: setup up down restart status logs test

setup:
	@docker compose pull --quiet

up:
	docker compose up -d --wait

down:
	docker compose down

restart: down up

status:
	@docker compose ps

logs:
	docker compose logs -f --tail=100

test:
	@node --check server.mjs && echo "server.mjs ok"
