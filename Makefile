.DEFAULT_GOAL := all

APPS := $(shell find apps -maxdepth 1 -mindepth 1 -type d | sort)

.PHONY: all
all:
	@$(MAKE) -j$(nproc) $(APPS)

node_modules:
	bun install

.PHONY: upgrade
upgrade:
	bun x ncu -u
	bun install

.PHONY: apps/%
apps/%: node_modules clean
	bun run apps/$(@F)/app.ts

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
	bun x prettier --check --write "**/*.ts"

.PHONY: format
format: fmt 

.PHONY: lint
lint: node_modules
	bun x eslint --fix "**/*.ts"

.PHONY: test
test: node_modules 
	bun x jest

.PHONY: check
check: fmt lint test

.PHONY: imports
imports:
	$(eval VERSION=$(shell kubectl get node | tail -n1 | awk '{ print $$NF }' | sed -e 's/\+.*$$//' -e 's/[0-9]$$/0/' -e 's/^v//'))
	cdk8s import k8s@$(VERSION)
	bash -c 'cdk8s import <(kubectl get crd -ojson)'

.PHONY: schemas
schemas:
	bun x json2ts -i schemas/ -o imports/helm-values/
