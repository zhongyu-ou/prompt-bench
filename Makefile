.DEFAULT_GOAL := help

ARGS ?=

.PHONY: help run build test

help:
	@printf '%s\n' \
	  'make run                 Start the local workbench' \
	  'make run ARGS="--help"   Show application flags' \
	  'make build               Build ./promptbench' \
	  'make test                Run all Go tests'

run:
	go run . $(ARGS)

build:
	go build -o promptbench .

test:
	go test ./...
