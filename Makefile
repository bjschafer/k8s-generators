.DEFAULT_GOAL := all

APPS := $(shell find apps -maxdepth 1 -mindepth 1 -type d | sort)

.PHONY: all
all:
	@$(MAKE) -j8 $(APPS)

node_modules:
	npm ci

.PHONY: upgrade
upgrade:
	./node_modules/.bin/ncu -u
	npm install

.PHONY: compile
compile: node_modules clean
	./node_modules/.bin/tsc --build

.PHONY: apps/%
apps/%: compile
	npx node apps/$(@F)/app.js

.PHONY: watch
watch: node_modules 
	./node_modules/.bin/tsc --build -w

.PHONY: clean
clean: 
	find dist -type f \! \( -name '.argocd-source-*.yaml' -o -name 'sealedsecret.*.yaml' \) -delete
	find dist -type d -empty -delete

.PHONY: clean-full
clean-full: clean 
	rm -rf apps/**/*.js apps/**/*.d.ts
	rm -rf lib/*.js lib/*.d.ts lib/**/*.js lib/**/*.d.ts
	rm -rf imports/*.js imports/*.d.ts

.PHONY: fmt
fmt: node_modules
	./node_modules/.bin/prettier --check --write "**/*.ts"

.PHONY: format
format: fmt 

.PHONY: lint
lint: node_modules
	./node_modules/.bin/eslint --fix "**/*.ts"

.PHONY: test
test: node_modules 
	./node_modules/.bin/jest

.PHONY: check
check: fmt lint test
