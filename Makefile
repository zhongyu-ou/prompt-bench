.DEFAULT_GOAL := help

ARGS ?=

.PHONY: help run dev build test

help:
	@printf '%s\n' \
	  'make run                 Start without watching (loads .env if present)' \
	  'make dev                 Watch sources and rebuild/restart (loads .env if present)' \
	  'make run ARGS="--help"   Show application flags' \
	  'make build               Build ./promptbench' \
	  'make test                Run all Go tests'

dev:
	go run github.com/air-verse/air@v1.64.5 -c .air.toml -- $(if $(wildcard .env),--env-file .env) $(ARGS)

run:
	go run . $(if $(wildcard .env),--env-file .env) $(ARGS)

build:
	go build -o promptbench .

test:
	go test ./...
