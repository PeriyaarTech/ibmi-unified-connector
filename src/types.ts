/**
 * Type definitions for ibmi-unified-connector
 */

/**
 * Database driver types supported
 */
export type DriverType = 'ibmi' | 'odbc';

/**
 * Configuration for a single connection pool
 */
export interface PoolConfig {
  name: string;
  description?: string;
  maxSize: number;
  timeout: number;
  incrementSize?: number;
  jobPriority?: number;
  connectionString?: string;
  routePatterns?: string[];
  libraryList?: string[];    // IBM i library list — applied via CHGLIBL on idb-connector connections
  currentLibrary?: string;  // IBM i current library — applied via CHGCURLIB
  validateOnBorrow?: boolean;
  idleValidationMillis?: number;
  maxIdleMillis?: number;
  connectionCreateRetries?: number;
  connectionCreateRetryDelayMillis?: number;
  healthCheckSql?: string;
  sqlConcurrency?: number;
}

/**
 * Full pools configuration (matches pools.json schema)
 */
export interface PoolsConfig {
  version?: string;
  description?: string;
  pools: Record<string, PoolConfig>;
  defaultPool?: string;
}

/**
 * Common interface for database operations
 */
export interface IDatabase {
  initialize(): Promise<void>;
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  execute(sql: string, params?: any[]): Promise<number>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  testConnection(): Promise<boolean>;
  getDriverType?(): DriverType | 'idb-connector';
  getSqlConcurrency?(): number;
  callRpg(programName: string, programConfig: ProgramConfig, inputParams: Record<string, any>): Promise<Record<string, any>>;
}

// ─── RPG Program Types ────────────────────────────────────────────────────────

/**
 * Single RPG parameter definition
 * type uses IBM i notation: e.g. "15p0" (packed), "1A" (char), "9999A" (long char), "10i0" (integer)
 */
export interface RpgParam {
  name: string;
  type: string;
}

/**
 * RPG program definition (one entry from programs.json)
 */
export interface ProgramConfig {
  description?: string;
  library?: string;
  params: RpgParam[];
}

/**
 * Full programs registry (matches programs.json schema)
 */
export interface ProgramsRegistry {
  version?: string;
  description?: string;
  programs: Record<string, ProgramConfig>;
}

