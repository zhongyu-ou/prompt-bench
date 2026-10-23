.DEFAULT_GOAL := help

ARGS ?=

GO_FILES := $(shell find . -type f -name '*.go' -not -path './.git/*')
JS_FILES := $(wildcard web/js/*.js) $(wildcard web/*.mjs)

.PHONY: help run dev build fmt fmt-check lint lint-backend lint-frontend type-check test test-backend test-frontend test-race check ci-check

help:
	@printf '%s\n' \
	  'make run                 Start without watching (loads .env if present)' \
	  'make dev                 Watch sources and rebuild/restart (loads .env if present)' \
	  'make run ARGS="--help"   Show application flags' \
	  'make build               Build ./promptbench' \
	  'make fmt                 Format Go sources in place' \
	  'make fmt-check           Check Go formatting without edits' \
	  'make lint                Go vet and JavaScript syntax checks' \
	  'make type-check          Compile and type-check Go packages' \
	  'make test                Run Go and frontend tests (requires test PostgreSQL)' \
	  'make test-race           Run Go race detection and frontend tests' \
	  'make check               Format, lint, type-check, then test locally' \
	  'make ci-check            Check formatting, lint and types without PostgreSQL'

dev:
	go run github.com/air-verse/air@v1.64.5 -c .air.toml -- $(if $(wildcard .env),--env-file .env) $(ARGS)

run:
	go run . $(if $(wildcard .env),--env-file .env) $(ARGS)

build:
	go build -o promptbench .

fmt:
	gofmt -w $(GO_FILES)

fmt-check:
	@set -e; files="$$(gofmt -l $(GO_FILES))"; \
	if [ -n "$$files" ]; then printf 'Go files need formatting:\n%s\n' "$$files"; exit 1; fi

lint: lint-backend lint-frontend

lint-backend:
	go vet ./...

lint-frontend:
	@set -e; for file in $(JS_FILES); do node --check "$$file"; done

type-check:
	go build ./...

test: test-backend test-frontend

test-backend:
	@set -e; \
	if [ -f .env.test ] && [ -z "$${PROMPTBENCH_TEST_DATABASE_URL:-}" ]; then \
		set -a; . ./.env.test; set +a; \
	fi; \
	go test ./...

test-frontend:
	node --test web/*.test.mjs

test-race:
	@set -e; \
	if [ -f .env.test ] && [ -z "$${PROMPTBENCH_TEST_DATABASE_URL:-}" ]; then \
		set -a; . ./.env.test; set +a; \
	fi; \
	go test -race ./...
	$(MAKE) test-frontend

check:
	$(MAKE) fmt
	$(MAKE) lint
	$(MAKE) type-check
	$(MAKE) test

ci-check:
	$(MAKE) fmt-check
	$(MAKE) lint
	$(MAKE) type-check
