# Kubernetes using CDK8S

This uses CDK8S in TypeScript to build K8S deployments and such.

Some apps are deployed directly from this repo, others are used as a base for something in prod.

**IMPORTANT**: Before committing any changes, run `make` to lint and build YAML. Or else
you're gonna have a bad time.

## Secrets

Secrets are all handled with [Bitnami Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets). For additional paranoia, all secrets live in the (private)
[k8s-prod](https://github.com/bjschafer/k8s-prod) repo. These are in the `secrets` folder, with a subfolder per-namespace to keep it organized. The ArgoCD app
has `.spec.source.directory.recurse=true` to make that work.

Then, secrets can just be referenced by name in CDK8S.
