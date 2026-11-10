import { basename } from "../../lib/util";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { App } from "cdk8s";
import { NewArgoApp } from "../../lib/argo";
import { NewKustomize } from "../../lib/kustomize";

// Being retired (2026-11-10): PowerDNS was replaced by Technitium, whose own
// console (https://dns.cmdcentral.xyz) replaces this UI. Phase 1 of 2 keeps the
// Application with no resources so Argo prunes the workload; the Application
// carries no resources finalizer, so deleting it first would orphan everything.
// Phase 2 deletes this directory. Backup of /data/powerdns-admin.db:
// vmhost03:/warp/Shared/dump/pdns-cutover-2026-11-10/.
const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
      // Automated sync refuses to prune an app down to nothing ("auto-sync
      // will wipe out all resources") unless this is set. Phase 1 needs it.
      allowEmpty: true,
    },
  },
  namespace: namespace,
});

app.synth();

NewKustomize(app.outdir);
