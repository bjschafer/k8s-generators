/**
 * Example: How to use the Database construct from another app
 *
 * This file demonstrates how to declaratively create a database
 * with its owner role on the production PostgreSQL cluster.
 */

import { App } from "cdk8s";
import { PROD_CLUSTER } from "../../apps/postgres/app";
import { Database } from "./database";
import { BitwardenSecret } from "../secrets";

// Example 1: Create a database with password authentication
function exampleWithPassword(app: App) {
  const namespace = "myapp";

  // Create credentials secret
  const dbCreds = new BitwardenSecret(app, "myapp-db-creds", {
    name: "myapp-db-credentials",
    namespace: "postgres",
    data: {
      username: "your-bitwarden-item-id",
      password: "your-bitwarden-item-id",
    },
  });

  // Create database and register role with cluster
  new Database(app, "myapp-db", {
    name: "myapp",
    owner: "myapp_user",
    namespace: "postgres",
    cluster: { name: PROD_CLUSTER.clusterName },
    registerRole: PROD_CLUSTER.addManagedRole.bind(PROD_CLUSTER),
    passwordSecret: {
      name: dbCreds.secretName,
    },
    roleConfig: {
      comment: "MyApp database owner",
      inRoles: ["pg_monitor"],
    },
  });
}

// Example 2: Create a database without password (trust authentication)
function exampleWithoutPassword(app: App) {
  new Database(app, "analytics-db", {
    name: "analytics",
    owner: "analytics_user",
    namespace: "postgres",
    cluster: { name: PROD_CLUSTER.clusterName },
    registerRole: PROD_CLUSTER.addManagedRole.bind(PROD_CLUSTER),
    roleConfig: {
      comment: "Analytics database owner",
      connectionLimit: 100,
    },
  });
}

// Example 3: Multiple databases for the same app
function exampleMultipleDatabases(app: App) {
  // Main application database
  new Database(app, "app-main-db", {
    name: "myapp_main",
    owner: "myapp_main_user",
    namespace: "postgres",
    cluster: { name: PROD_CLUSTER.clusterName },
    registerRole: PROD_CLUSTER.addManagedRole.bind(PROD_CLUSTER),
  });

  // Separate database for background jobs
  new Database(app, "app-jobs-db", {
    name: "myapp_jobs",
    owner: "myapp_jobs_user",
    namespace: "postgres",
    cluster: { name: PROD_CLUSTER.clusterName },
    registerRole: PROD_CLUSTER.addManagedRole.bind(PROD_CLUSTER),
  });
}

// Example usage in a typical app.ts file:
/*
import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { PROD_CLUSTER } from "../postgres/app";
import { Database } from "../../lib/postgres/database";
import { BitwardenSecret } from "../../lib/secrets";

const namespace = "myapp";
const app = new App();

class MyAppChart extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Your app resources here...
  }
}

// Create database BEFORE instantiating your chart
const dbCreds = new BitwardenSecret(app, "db-creds", {
  name: "myapp-db-credentials",
  namespace: "postgres",
  data: {
    username: "bitwarden-id",
    password: "bitwarden-id",
  },
});

new Database(app, "myapp-db", {
  name: "myapp",
  owner: "myapp_user",
  namespace: "postgres",
  cluster: { name: PROD_CLUSTER.clusterName },
  registerRole: PROD_CLUSTER.addManagedRole.bind(PROD_CLUSTER),
  passwordSecret: { name: dbCreds.secretName },
});

// Then create your app
new MyAppChart(app, "myapp");

app.synth();
*/
