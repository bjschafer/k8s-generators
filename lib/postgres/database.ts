import { Construct } from "constructs";
import {
  Database as CnpgDatabase,
  DatabaseSpecCluster,
  DatabaseSpecEnsure,
  ClusterSpecManagedRoles,
  ClusterSpecManagedRolesEnsure,
} from "../../imports/postgresql.cnpg.io";

export interface DatabaseProps {
  /**
   * The name of the database to create
   */
  name: string;

  /**
   * The owner role for this database
   */
  owner: string;

  /**
   * The namespace where the database resource will be created
   */
  namespace: string;

  /**
   * Reference to the cluster where the database will be created
   */
  cluster: DatabaseSpecCluster;

  /**
   * Function to register the managed role with the cluster.
   * This should be the addManagedRole method from ProdPostgres.
   */
  registerRole: (role: ClusterSpecManagedRoles) => void;

  /**
   * Whether the database should be present or absent
   * @default "present"
   */
  ensure?: DatabaseSpecEnsure;

  /**
   * Additional role configuration options
   */
  roleConfig?: Partial<ClusterSpecManagedRoles>;

  /**
   * Password secret for the role
   * If not provided, the role will be created without a password
   */
  passwordSecret?: {
    name: string;
  };
}

/**
 * Database construct that:
 * 1. Registers a managed role with the cluster for the database owner
 * 2. Creates a CNPG Database resource
 *
 * Usage:
 * ```
 * new Database(app, "my-db", {
 *   name: "myapp",
 *   owner: "myapp_user",
 *   namespace: "postgres",
 *   cluster: { name: prodCluster.clusterName },
 *   registerRole: prodCluster.addManagedRole.bind(prodCluster),
 * });
 * ```
 */
export class Database extends Construct {
  public readonly database: CnpgDatabase;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);

    // Register the owner role with the cluster using declarative role management
    const roleConfig: ClusterSpecManagedRoles = {
      name: props.owner,
      ensure: ClusterSpecManagedRolesEnsure.PRESENT,
      login: true,
      // Merge any additional role config provided
      ...props.roleConfig,
      // Override with passwordSecret if provided
      ...(props.passwordSecret && {
        passwordSecret: props.passwordSecret,
      }),
    };

    props.registerRole(roleConfig);

    // Create the CNPG Database resource
    this.database = new CnpgDatabase(this, "database", {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
      spec: {
        name: props.name,
        owner: props.owner,
        cluster: props.cluster,
        ensure: props.ensure || DatabaseSpecEnsure.PRESENT,
      },
    });
  }
}