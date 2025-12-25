import { Chart, Cron, Size, Yaml } from "cdk8s";
import { ConcurrencyPolicy, ConfigMap, Cpu, CronJob, ImagePullPolicy, PersistentVolumeAccessMode, PersistentVolumeClaim, PersistentVolumeMode, RestartPolicy, Volume } from "cdk8s-plus-33";
import { Construct } from "constructs";
import { KometaConfigSchema } from "../../imports/helm-values/kometa-config.schema";
import { DEFAULT_SECURITY_CONTEXT } from "../../lib/consts";
import { BitwardenSecret } from "../../lib/secrets";
import { StorageClass } from "../../lib/volume";
import { mediaLabel, namespace } from "./app";

const name = "kometa";

const kometaConfig: KometaConfigSchema = {
  "plex": {
    "url": "http://plex.cmdcentral.xyz:32400",
    "token": "<<PLEX_TOKEN>>",
    "timeout": 60,
    "db_cache": 40,
    "clean_bundles": false,
    "empty_trash": false,
    "optimize": false,
    "verify_ssl": false
  },
  "tmdb": {
    "apikey": "<<TMDB_API_KEY>>",
    "cache_expiration": 60,
    "language": "en",
    "region": "US"
  },
  "libraries": {
    "Movies": {
      "remove_overlays": false,
      "collection_files": [
        {
          "default": "imdb"
        },
        {
          "default": "universe"
        },
        {
          "default": "seasonal"
        },
        {
          "default": "decade"
        }
      ],
      "overlay_files": [
        {
          "default": "ribbon"
        },
        {
          "default": "mediastinger"
        }
      ]
    },
    "TV Shows": {
      "remove_overlays": false,
      "collection_files": [
        {
          "default": "imdb"
        },
        {
          "default": "universe"
        },
        {
          "default": "anilist"
        },
        {
          "default": "myanimelist"
        }
      ],
      "overlay_files": [
        {
          "default": "ribbon"
        }
      ]
    }
  },
  "playlist_files": [
    {
      "default": "playlist",
      "template_variables": {
        "libraries": "Movies, TV Shows"
      }
    }
  ],
  "settings": {
    "run_order": [
      "operations",
      "metadata",
      "collections",
      "overlays"
    ],
    "cache": true,
    "cache_expiration": 60,
    "asset_directory": [
      "config/assets"
    ],
    "asset_folders": true,
    "asset_depth": 0,
    "create_asset_folders": false,
    "prioritize_assets": false,
    "dimensional_asset_rename": false,
    "download_url_assets": false,
    "show_missing_season_assets": false,
    "show_missing_episode_assets": false,
    "show_asset_not_needed": true,
    "sync_mode": "append",
    "minimum_items": 1,
    "default_collection_order": "release",
    "delete_below_minimum": true,
    "delete_not_scheduled": false,
    "run_again_delay": 2,
    "missing_only_released": false,
    "only_filter_missing": false,
    "show_unmanaged": true,
    "show_unconfigured": true,
    "show_filtered": false,
    "show_unfiltered": false,
    "show_options": true,
    "show_missing": true,
    "show_missing_assets": true,
    "save_report": false,
    "tvdb_language": "eng",
    "ignore_ids": null,
    "ignore_imdb_ids": null,
    "item_refresh_delay": 0,
    "playlist_sync_to_users": null,
    "playlist_exclude_users": null,
    "playlist_report": false,
    "verify_ssl": true,
    "custom_repo": null,
    "overlay_artwork_filetype": "webp_lossy",
    "overlay_artwork_quality": 90
  },
}

export class Kometa extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const labels = { "app.kubernetes.io/name": "navidrome", ...mediaLabel };

      const secrets = new BitwardenSecret(this, "kometa-secrets", {
          name: "kometa-secrets",
          namespace: namespace,
          data: {
              "KOMETA_PLEX_TOKEN": "fef8bb11-81be-4b3b-962f-b3be002860b2",
              "KOMETA_TMDB_API_KEY": "34ea986b-e288-4f8d-968b-b3be0028e8aa",
          }
      })

      const cj = new CronJob(this, "kometa-deploy", {
          metadata: {
              name: name,
              namespace: namespace,
              labels: labels,
          },
          schedule: Cron.daily(),
          restartPolicy: RestartPolicy.ON_FAILURE,
          concurrencyPolicy: ConcurrencyPolicy.FORBID,
          successfulJobsRetained: 1,
          failedJobsRetained: 1,
          securityContext: DEFAULT_SECURITY_CONTEXT,
          containers: [{
              name: name,
              image: "kometateam/kometa:latest",
              imagePullPolicy: ImagePullPolicy.IF_NOT_PRESENT,
              args: [
                  "--run",
                  "--read-only-config",
              ],
              envVariables: {
                  ...secrets.toEnvValues(),
              },
              resources: {
                  cpu: {
                      request: Cpu.millis(250),
                      limit: Cpu.millis(250),
                  },
                  memory: {
                      request: Size.mebibytes(256),
                      limit: Size.mebibytes(256),
                  }
              },
              securityContext: DEFAULT_SECURITY_CONTEXT,
          }]
      });

      const pvc = new PersistentVolumeClaim(this, "config-pvc", {
          metadata: {
              name: "kometa-config",
              namespace: namespace,
          },
          accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
          storageClassName: StorageClass.CEPH_RBD,
          storage: Size.gibibytes(5),
          volumeMode: PersistentVolumeMode.FILE_SYSTEM,
      });
      const pvcVol = Volume.fromPersistentVolumeClaim(this, "config-pvc-vol", pvc);

      const config = new ConfigMap(this, "configmap", {
          metadata: {
              name: "kometa-config",
              namespace: namespace,
          },
          data: {
              "config.yml": Yaml.stringify(kometaConfig),
          }
      })
      const configVol = Volume.fromConfigMap(this, "configmap-vol", config);
      

      cj.addVolume(pvcVol);
      cj.containers[0].mount("/config", pvcVol);
      cj.addVolume(configVol);
      cj.containers[0].mount("/config/config.yml", configVol, {
          subPath: "config.yml"
      });
  }
}