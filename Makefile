# curl-runner — common tasks.
# Override the port for any target: `make local PORT=9999`

PORT ?= 2875
export PORT

.DEFAULT_GOAL := help

.PHONY: help local install docker up down logs clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

local: install ## Run locally with Node + auto-restart on server.js changes (default http://localhost:2875)
	@echo "→ http://localhost:$(PORT)  (watching server.js — refresh browser for UI edits)"
	node --watch server.js

install: node_modules ## Install Node dependencies
node_modules: package.json
	npm install
	@touch node_modules

docker: up ## Alias for `up`

up: ## Build and run in Docker (default http://localhost:2875)
	@echo "→ http://localhost:$(PORT)"
	docker compose up --build

down: ## Stop the Docker container
	docker compose down

logs: ## Tail the Docker container logs
	docker compose logs -f

clean: ## Remove node_modules and stop Docker
	docker compose down 2>/dev/null || true
	rm -rf node_modules
