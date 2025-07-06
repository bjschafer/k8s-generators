# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Kubernetes configuration generator using CDK8S (Cloud Development Kit for Kubernetes) in TypeScript. The project generates Kubernetes YAML manifests for various applications and services, primarily deployed via ArgoCD.

## Key Commands

### Primary Development Commands
- `make` - Lint, format, and build all applications (run before committing)
- `make fmt` - Format all TypeScript files with Prettier
- `make lint` - Run ESLint with auto-fix on all TypeScript files
- `make check` - Run format, lint, and tests
- `make clean` - Remove generated files (preserves ArgoCD and sealed secrets)
- `make test` - Run Jest tests
- `bun install` - Install dependencies (uses Bun package manager)

### Build Commands
- `make apps/[app-name]` - Build specific application (e.g., `make apps/immich`)
- `make upgrade` - Update dependencies using npm-check-updates
- `make imports` - Import Kubernetes CRDs and update schema definitions
- `make schemas` - Generate TypeScript types from JSON schemas

### Testing Individual Apps
Build individual apps by running: `bun run apps/[app-name]/app.ts`

## Architecture

### Core Library Structure
- `lib/app.ts` - Base application classes (`BasicApp`, `CustomApp`) for standard Kubernetes deployments
- `lib/app-plus.ts` - Enhanced application builder with additional features
- `lib/argo.ts` - ArgoCD application management and deployment
- `lib/helm.ts` - Helm chart integration for ArgoCD
- `lib/kustomize.ts` - Kustomization file generation
- `lib/secrets.ts` - Bitnami Sealed Secrets integration
- `lib/volume.ts` - Persistent volume and storage management
- `lib/monitoring/` - VictoriaMetrics and monitoring integrations

### Application Structure
Each app in `apps/` follows the pattern:
- `app.ts` - Main application definition using library components
- Uses `basename(__dirname)` for namespace naming
- Typically includes ArgoCD app creation via `NewArgoApp()`

### Key Patterns
1. **Namespace Convention**: App namespace derived from directory name
2. **Secret Management**: All secrets use Bitnami Sealed Secrets, stored in separate private repo
3. **Resource Management**: Default CPU/memory limits defined in `lib/consts.ts`
4. **Deployment Strategy**: Longhorn PVCs use `Recreate` strategy, others use `RollingUpdate`
5. **DNS Configuration**: Apps can use external DNS via `useExternalDNS` flag

### Output Structure
- `dist/` - Generated Kubernetes YAML files
- `dist/apps/` - ArgoCD application definitions
- Kustomization files auto-generated for each app directory

## Important Notes

- **Always run `make` before committing** - This ensures proper formatting, linting, and builds
- Secrets are handled via Bitnami Sealed Secrets in a separate private repository
- The project uses Bun as the package manager and runtime
- CDK8S imports are managed via `make imports` which pulls from current cluster CRDs
- Applications are deployed via ArgoCD with automatic sync enabled

## Development Workflow

1. Create new app directory under `apps/`
2. Implement `app.ts` using library components
3. Run `make apps/[app-name]` to test build
4. Run `make` to verify full build and linting
5. Generated YAML appears in `dist/` for ArgoCD deployment