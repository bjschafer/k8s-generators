/**
 * Database Configuration
 *
 * This is the ONLY file you need to edit when adding a new database.
 * Just add an entry to the DATABASES array below.
 *
 * Example with Bitwarden password:
 * {
 *   name: "myapp",                      // Database and role name
 *   comment: "MyApp database owner",    // Human-readable description
 *   bitwardenPasswordId: "bw-item-id",  // Bitwarden item ID for password
 *   appNamespace: "myapp",              // Your app's namespace (optional)
 * }
 *
 * Example with auto-generated password (no Bitwarden required):
 * {
 *   name: "myapp",                      // Database and role name
 *   comment: "MyApp database owner",    // Human-readable description
 *   appNamespace: "myapp",              // Your app's namespace (optional)
 *   // Password will be auto-generated when bitwardenPasswordId is omitted
 * }
 */

import { ClusterSpecManagedRoles } from "../../imports/postgresql.cnpg.io";

/**
 * Password generation configuration for auto-generated passwords.
 * Used when bitwardenPasswordId is not set.
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
  /** Bitwarden item ID for the password (or undefined for no password) */
  bitwardenPasswordId?: string;
  /** Namespace where the app lives (for creating a copy of credentials there) */
  appNamespace?: string;
  /** Additional role configuration */
  roleConfig?: Partial<ClusterSpecManagedRoles>;
  /** Password generation config when not using Bitwarden. Uses defaults if omitted. */
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
    bitwardenPasswordId: "492205f2-22ec-4d75-8034-b3cf00066695",
    appNamespace: "homebox",
  },

  {
    name: "manyfold",
    comment: "Manyfold database owner",
    bitwardenPasswordId: "730357ee-1202-496f-ad6e-b3cc001af9a3",
    appNamespace: "manyfold",
  },

  {
    name: "noms",
    comment: "Noms database owner",
    bitwardenPasswordId: "f0107fac-b3ae-4d80-978b-b3c90172d46b",
    appNamespace: "noms",
  },

  {
    name: "romm",
    comment: "ROMM database owner",
    bitwardenPasswordId: "efb8a53a-dfd4-4f3a-b2e2-b39200423731",
    appNamespace: "romm",
  },
];
