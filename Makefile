COMPOSE ?= docker compose
PYTHON ?= python3
VENV_PYTHON ?= .venv/bin/python
PNPM ?= ./scripts/pnpm.sh
RUFF ?= $(if $(wildcard .venv/bin/ruff),.venv/bin/ruff,ruff)
MYPY ?= $(if $(wildcard .venv/bin/mypy),.venv/bin/mypy,mypy)
PYTEST_PYTHON ?= $(if $(wildcard $(VENV_PYTHON)),$(VENV_PYTHON),$(PYTHON))

.PHONY: native-install config build up down restart logs ps api-logs web-logs db-shell api-shell lint typecheck test robotics-test check

native-install:
	$(PYTHON) -m venv .venv
	$(VENV_PYTHON) -m pip install -e './backend[dev,spot]'
	$(PNPM) install --frozen-lockfile

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
	$(RUFF) check backend
	$(PNPM) --filter @nexus/dashboard lint

typecheck:
	$(MYPY) backend/src
	$(PNPM) --filter @nexus/dashboard typecheck

test:
	$(PYTEST_PYTHON) -m pytest backend
	$(PNPM) --filter @nexus/dashboard test

robotics-test:
	cmake -S robotics -B build/robotics -DNEXUS_BUILD_TESTS=ON -DCMAKE_BUILD_TYPE=Release
	cmake --build build/robotics --config Release
	ctest --test-dir build/robotics --build-config Release --output-on-failure

check: config lint typecheck test robotics-test
