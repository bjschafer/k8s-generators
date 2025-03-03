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
	node apps/$(@F)/app.js

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

.PHONY: imports
imports:
	$(eval VERSION=$(shell kubectl get node | tail -n1 | awk '{ print $$NF }' | sed -e 's/\+.*$$//' -e 's/[0-9]$$/0/' -e 's/^v//'))
	cdk8s import k8s@$(VERSION)
	bash -c 'cdk8s import <(kubectl get crd -ojson)'

.PHONY: schemas
schemas:
	./node_modules/.bin/json2ts -i schemas/ -o imports/helm-values/
