/**
 * Database Configuration
 *
 * This is the ONLY file you need to edit when adding a new database.
 * Just add an entry to the DATABASES array below.
 *
 * Example with a password stored in OpenBao:
 * {
 *   name: "myapp",                      // Database and role name
 *   comment: "MyApp database owner",    // Human-readable description
 *   openBaoPassword: true,              // kv/kubernetes/_all/myapp-db-credentials
 *   appNamespace: "myapp",              // Your app's namespace (optional)
 * }
 *
 * Example with auto-generated password (nothing to store in OpenBao):
 * {
 *   name: "myapp",                      // Database and role name
 *   comment: "MyApp database owner",    // Human-readable description
 *   appNamespace: "myapp",              // Your app's namespace (optional)
 *   // Password will be auto-generated when openBaoPassword is omitted
 * }
 */

import { DatabaseRoleSpec } from "../../imports/postgresql.cnpg.io";

/**
 * Password generation configuration for auto-generated passwords.
 * Used when openBaoPassword is not set.
 */
export interface PasswordGenerationConfig {
  /** Length of password. Default: 32 */
  length?: number;
  /** Number of digit characters. Default: 6 */
  digits?: number;
  /** Number of symbol characters. Default: 4 */
  symbols?: number;
  /** Symbol characters to use. Default: "-_$@" (safe for most apps) */
  symbolCharacters?: string;
}

/**
 * Configuration for a managed database and its owner role
 */
export interface DatabaseConfig {
  /** Database and role name */
  name: string;
  /** Human-readable comment for the role */
  comment: string;
  /**
   * Read the password from OpenBao rather than generating one: the `password`
   * field of `kv/kubernetes/_all/<name>-db-credentials`. Shared, since both
   * the postgres namespace (for the role) and appNamespace read it.
   */
  openBaoPassword?: boolean;
  /** Namespace where the app lives (for creating a copy of credentials there) */
  appNamespace?: string;
  /**
   * Cluster to create the role and database on. Defaults to the prod cluster,
   * which is where all of this belongs unless the app needs something prod's
   * image does not ship -- see `bookorbit` below.
   */
  cluster?: string;
  /**
   * Extensions for CNPG to install into the database. Use this rather than
   * letting the app run `CREATE EXTENSION` itself: the owner role is not a
   * superuser, so it can only create the extensions Postgres marks trusted,
   * and the operator reconciles this list continuously.
   */
  extensions?: string[];
  /** Additional role configuration (DatabaseRole spec fields, minus name/cluster/passwordSecret which are set automatically) */
  roleConfig?: Partial<Omit<DatabaseRoleSpec, "name" | "cluster" | "passwordSecret">>;
  /**
   * Manage the role but do not create a database for it. For shared roles that
   * exist to read *other* people's databases -- a reporting login, say -- where
   * the usual name-is-both-role-and-database assumption does not hold and would
   * otherwise leave an empty database lying around.
   */
  roleOnly?: boolean;
  /** Password generation config when not using OpenBao. Uses defaults if omitted. */
  passwordGeneration?: PasswordGenerationConfig;
}

/**
 * ========================================================================
 * ADD YOUR DATABASES HERE
 * ========================================================================
 * Central registry of all databases and roles for the production cluster.
 * Each entry will automatically create:
 * - A managed role in the cluster
 * - A Database CRD
 * - Credentials in the postgres namespace
 * - Credentials in your app namespace (if appNamespace is set)
 */
export const DATABASES: DatabaseConfig[] = [
  {
    name: "homebox",
    comment: "Homebox database owner",
    openBaoPassword: true,
    appNamespace: "homebox",
  },

  {
    name: "manyfold",
    comment: "Manyfold database owner",
    openBaoPassword: true,
    appNamespace: "manyfold",
  },

  {
    name: "noms",
    comment: "Noms database owner",
    openBaoPassword: true,
    appNamespace: "noms",
  },

  {
    name: "romm",
    comment: "ROMM database owner",
    openBaoPassword: true,
    appNamespace: "romm",
  },

  {
    name: "book-club",
    comment: "Book Club database owner",
    appNamespace: "book-club",
  },

  {
    name: "bookorbit",
    comment: "BookOrbit database owner",
    appNamespace: "bookorbit",
    // Not on prod: BookOrbit's very first migration declares a `vector(256)`
    // column and an HNSW index, so pgvector has to be there before the app has
    // ever started. prod runs CloudNativePG's `minimal` image, which does not
    // carry it, and when this was placed upstream published pgvector
    // *extension images* only for Postgres 18 -- so on 17 the only ways to get
    // it were to re-flavour prod's image or to use a cluster that already had
    // it. This is the latter. The cluster is named for immich because immich
    // is what it was built for; it is a vectorchord image and pgvector comes
    // along with it.
    //
    // That constraint is gone as of the prod 17->18 upgrade: the trixie
    // major-18 catalog entry carries a pgvector extension image, so prod can
    // host this now. Moving it is a data migration, not a config change, so it
    // stays here until someone does that deliberately.
    cluster: "immich",
    extensions: ["uuid-ossp", "pg_trgm", "unaccent", "vector"],
  },

  {
    name: "hass",
    comment: "Home Assistant recorder database owner",
    appNamespace: "hass",
    // The role and database predate this registry -- they were created by hand.
    // Adopting them here is what rotates the password off the hardcoded value.
    //
    // No symbols: Home Assistant's recorder takes a single postgresql:// URL,
    // and the default symbol set ("-_$@") contains characters that change the
    // meaning of a URL rather than surviving it.
    passwordGeneration: { length: 40, digits: 8, symbols: 0 },
  },

  {
    name: "energy",
    comment: "Alliant Energy usage warehouse owner",
    appNamespace: "energy",
    // The loader is `psql -f`, which reads the password from PGPASSWORD rather
    // than a URL, so the default symbol set is safe here.
  },

  {
    name: "bambuddy",
    comment: "Bambuddy database owner",
    appNamespace: "bambuddy",
    // Bambuddy takes a single postgresql:// URL in DATABASE_URL, so the default
    // symbol set ("-_$@") would have to survive URL parsing intact. Same
    // reasoning as `hass` above.
    passwordGeneration: { length: 40, digits: 8, symbols: 0 },
  },

  {
    name: "grafanareader",
    comment: "Read-only reporting login used by Grafana datasources",
    // Predates this registry -- created by hand, and the password was never
    // recorded anywhere. Adopting it here is what puts that password in a
    // secret we can actually read, same as `hass` above.
    //
    // Adoption ROTATES the password, so every Grafana datasource using this
    // role must be re-entered once from `grafanareader-db-credentials`.
    roleOnly: true,
    // Owns nothing: it only ever reads other roles' databases, and each of
    // those grants it SELECT itself (see apps/energy/load.sql).
  },
];
