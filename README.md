# IBM i Unified Connector

A Node.js TypeScript library for connecting to IBM i systems through either the native IBM i driver or ODBC, with a priority-based connection pool model for routing different workloads to the right database access level.

This package is designed for applications that need a single integration point across IBM i environments while separating traffic by priority:

- high: interactive and latency-sensitive work
- medium: standard query and read traffic
- low: batch and background processing

## Features

- Unified database access via IBM i native driver or ODBC
- Shared PoolManager abstraction for connection pools
- Route-based pool selection using URL patterns
- RPG/XMLSERVICE payload builder and parser support
- TypeScript exports for easy integration
- Validation utility to test live connectivity and pool behavior

## Requirements

- Node.js 18 or newer
- An IBM i target system, or a reachable IBM i-compatible ODBC endpoint
- One of the following database drivers:
  - IBM i native: idb-connector
  - ODBC: odbc

## Install

```bash
npm install
npm run build
```

If you are consuming this library in another project, install it as a package and import from the library entry point.

## Configuration

The example pool configuration is stored in:

- [examples/config/pools.json](examples/config/pools.json)

The connection values are provided via environment variables in:

- [examples/.env.example](examples/.env.example)

Create a local environment file from the example:

```bash
cp examples/.env.example .env
```

Then update the values with your IBM i host and credentials:

```env
DB_SYSTEM=your-system.lmig.com
DB_USER=your-username
DB_PASSWORD=your-password
DB_MODE=auto
PGM_LIBRARY=YOURLIBRARY
ODBC_CONNECTION_STRING=DRIVER={IBM i Access ODBC Driver};SYSTEM=your-system.lmig.com;UID=your-username;PWD=your-password;DBQ=QTEMP,QGPL
```

## Pool model

The project is intentionally built around a priority-based pool design:

```json
{
  "pools": {
    "high": { "jobPriority": 10, "routePatterns": ["/api/*", "/health"] },
    "medium": { "jobPriority": 20, "routePatterns": ["/v1/query/*", "/api/v1/query/*"] },
    "low": { "jobPriority": 50, "routePatterns": ["/batch/*", "/api/batch/*"] }
  },
  "defaultPool": "high"
}
```

This lets the application route traffic based on workload type rather than using a single shared database connection for everything.

### Pool parameter reference

Each entry under `pools` controls how a database connection group behaves. The most important settings are:

- `name`: friendly label shown in logs
- `jobPriority`: the workload priority used to separate queues; lower numbers are usually more interactive and faster, higher numbers are more background-oriented
- `maxSize`: maximum number of open connections in that pool
- `timeout`: the connection wait timeout in milliseconds
- `incrementSize`: how many new connections are created when a pool needs to grow
- `validateOnBorrow`: checks the connection before reusing it
- `idleValidationMillis`: how long a connection can remain idle before it is considered stale
- `maxIdleMillis`: maximum idle time before a connection is destroyed
- `connectionCreateRetries`: retry count when creating a new connection fails
- `connectionCreateRetryDelayMillis`: delay between connection retry attempts
- `healthCheckSql`: SQL used to validate a connection is still usable
- `sqlConcurrency`: how many SQL calls can be processed concurrently in that pool
- `libraryList`: IBM i library list applied to native connections; useful for runtime objects and data access
- `currentLibrary`: optional current library to set on the native connection
- `connectionString`: ODBC connection string for the pool
- `routePatterns`: URL patterns that map incoming traffic to that pool

A practical rule is:

- `high`: interactive endpoints and time-sensitive API calls
- `medium`: normal reads and query operations
- `low`: batch jobs, background jobs, and slower processing

The top-level `defaultPool` is used when no route pattern matches a request.

## Basic usage

### Import and initialize

```ts
import { PoolManager } from 'ibmi-unified-connector';

const manager = PoolManager.getInstance('./examples/config/pools.json');
await manager.initialize();
```

### Use a pool by priority

```ts
const highPool = await manager.getPool('high');
const rows = await highPool.query('SELECT * FROM SYSIBM.SYSDUMMY1');

const mediumPool = await manager.getPool('medium');
const results = await mediumPool.query('SELECT 1 AS OK FROM SYSIBM.SYSDUMMY1');
```

### Route-based resolution

```ts
const routed = await manager.getPoolForRoute('/api/v1/query/db/policySearch');
const rows = await routed.query('SELECT * FROM SOME_TABLE');
```

## Database validation script

This project includes a utility that validates the actual database setup and pool routing logic:

```bash
npm run testdb
```

What it checks:

- loads the active env file
- resolves the pool configuration from the JSON file
- initializes the PoolManager
- selects the configured high-priority pool
- runs a connection test
- executes sample SQL queries
- verifies route-to-pool matching

This is useful for confirming that the runtime environment and pool configuration are aligned before integrating into an application.

## Example project layout

```text
.
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── pool/
│   └── rpg/
├── examples/
│   ├── .env.example
│   ├── .env
│   └── config/
│       └── pools.json
├── scripts/
│   └── testdb.mjs
├── package.json
├── tsconfig.json
└── README.md
```

## Notes

- The package is designed to support both IBM i native and ODBC drivers, but the available driver depends on the runtime environment.
- On macOS or other non-IBM i developer machines, ODBC connectivity to the target system may be limited unless the proper ODBC driver and network access are configured.
- The library is best used inside an environment that can reach the target IBM i system directly.

## Next steps

1. Copy the example env file and fill in your real IBM i values.
2. Adjust the pool definitions in [examples/config/pools.json](examples/config/pools.json) to reflect your actual workload mix.
3. Run `npm run testdb` to confirm the environment is correctly configured.
4. Use `PoolManager.getPool('high' | 'medium' | 'low')` in your application code based on traffic type.

## License

This project is currently configured without a published OSS license in the package metadata.
