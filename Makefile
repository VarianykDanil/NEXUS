COMPOSE ?= docker compose
PYTHON ?= python3

.PHONY: config build up down restart logs ps api-logs web-logs db-shell api-shell lint typecheck test robotics-test check

config:
	$(COMPOSE) config --quiet

build:
	$(COMPOSE) build

up:
	$(COMPOSE) up --build --detach --wait

down:
	$(COMPOSE) down --remove-orphans

restart: down up

logs:
	$(COMPOSE) logs --follow --tail=200

api-logs:
	$(COMPOSE) logs --follow --tail=200 api

web-logs:
	$(COMPOSE) logs --follow --tail=200 web

ps:
	$(COMPOSE) ps

db-shell:
	$(COMPOSE) exec db sh -lc 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

api-shell:
	$(COMPOSE) exec api /bin/sh

lint:
	ruff check backend
	corepack pnpm --filter @nexus/dashboard lint

typecheck:
	mypy backend/src
	corepack pnpm --filter @nexus/dashboard typecheck

test:
	$(PYTHON) -m pytest backend
	corepack pnpm --filter @nexus/dashboard test

robotics-test:
	cmake -S robotics -B build/robotics -DNEXUS_BUILD_TESTS=ON -DCMAKE_BUILD_TYPE=Release
	cmake --build build/robotics --config Release
	ctest --test-dir build/robotics --build-config Release --output-on-failure

check: config lint typecheck test robotics-test
