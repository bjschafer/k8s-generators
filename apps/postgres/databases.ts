/**
 * Database Configuration
 *
 * This is the ONLY file you need to edit when adding a new database.
 * Just add an entry to the DATABASES array below.
 *
 * Example:
 * {
 *   name: "myapp",                      // Database and role name
 *   comment: "MyApp database owner",    // Human-readable description
 *   bitwardenPasswordId: "bw-item-id",  // Bitwarden item ID for password (optional)
 *   appNamespace: "myapp",              // Your app's namespace (optional)
 * }
 */

import { ClusterSpecManagedRoles } from "../../imports/postgresql.cnpg.io";

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
    name: "romm",
    comment: "ROMM database owner",
    bitwardenPasswordId: "your-bitwarden-id-here",
    appNamespace: "romm",
  },
];
