import type { IDatabase, PoolConfig, PoolsConfig } from '../types.js';
import { UnifiedPoolWrapper } from './UnifiedPoolWrapper.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export type { PoolConfig } from '../types.js';

/**
 * Manages multiple database connection pools with route-based selection.
 * Singleton — use PoolManager.getInstance().
 */
export class PoolManager {
  private static instance: PoolManager;
  private pools: Map<string, IDatabase> = new Map();
  private config: PoolsConfig | null = null;
  private driverType: 'ibmi' | 'odbc' = 'odbc';
  private configPath: string;

  private constructor(configPath: string) {
    this.configPath = configPath;
  }

  static getInstance(configPath?: string): PoolManager {
    if (!PoolManager.instance) {
      if (!configPath) throw new Error('configPath required for first call to PoolManager.getInstance()');
      PoolManager.instance = new PoolManager(configPath);
    }
    return PoolManager.instance;
  }

  /** Reset singleton (useful for testing) */
  static reset(): void {
    PoolManager.instance = undefined as any;
  }

  async initialize(): Promise<void> {
    await this.loadConfiguration();
    await this.detectDriver();
    console.log('✅ Pool Manager initialized');
    console.log(`   Driver: ${this.driverType}`);
    console.log(`   Pools configured: ${Object.keys(this.config!.pools).join(', ')}`);
    console.log(`   Default pool: ${this.config!.defaultPool}`);
  }

  private async loadConfiguration(): Promise<void> {
    try {
      const configContent = await fs.readFile(path.resolve(this.configPath), 'utf-8');
      const resolvedContent = this.resolveEnvironmentVariables(configContent);
      this.config = JSON.parse(resolvedContent) as PoolsConfig;
      console.log('📋 Pool configuration loaded');
    } catch (error) {
      console.error('Failed to load pool configuration:', error);
      throw new Error(`Pool configuration not found or invalid: ${this.configPath}`);
    }
  }

  private resolveEnvironmentVariables(content: string): string {
    return content.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        console.warn(`⚠️  Environment variable ${varName} not found, using placeholder`);
        return match;
      }
      return value;
    });
  }

  private async detectDriver(): Promise<void> {
    try {
      await import('idb-connector');
      this.driverType = 'ibmi';
      console.log('🔍 Detected: idb-connector (IBM i native)');
      return;
    } catch {
      try {
        await import('odbc');
        this.driverType = 'odbc';
        console.log('🔍 Detected: ODBC driver');
        return;
      } catch {
        throw new Error('No database driver available (tried idb-connector, odbc)');
      }
    }
  }

  async getPool(poolName: string): Promise<IDatabase> {
    if (!this.config) throw new Error('Pool Manager not initialized');
    const poolConfig = this.config.pools[poolName];
    if (!poolConfig) throw new Error(`Pool '${poolName}' not found in configuration`);

    if (!this.pools.has(poolName)) {
      const pool = await this.createPool(poolConfig);
      this.pools.set(poolName, pool);
      console.log(`🏊 Created pool: ${poolName} (${poolConfig.name})`);
      console.log(`   Max connections: ${poolConfig.maxSize}`);
      console.log(`   Timeout: ${poolConfig.timeout}ms`);
    }
    return this.pools.get(poolName)!;
  }

  async getPoolForRoute(route: string): Promise<IDatabase> {
    if (!this.config) throw new Error('Pool Manager not initialized');
    for (const [poolName, poolConfig] of Object.entries(this.config.pools)) {
      if (poolConfig.routePatterns) {
        for (const pattern of poolConfig.routePatterns) {
          if (this.matchesPattern(route, pattern)) {
            return this.getPool(poolName);
          }
        }
      }
    }
    return this.getPool(this.config.defaultPool!);
  }

  private matchesPattern(route: string, pattern: string): boolean {
    const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${regexPattern}$`).test(route);
  }

  private async createPool(config: PoolConfig): Promise<IDatabase> {
    const pool = new UnifiedPoolWrapper(config);
    await pool.initialize();
    return {
      initialize: async () => {},
      query: <T = any>(sql: string, params: any[] = []) => pool.execute<T>(sql, params),
      execute: async (sql: string, params: any[] = []) => {
        const result = await pool.execute(sql, params);
        return result.length || 0;
      },
      beginTransaction: async () => { throw new Error('Transactions not yet supported'); },
      commit: async () => { throw new Error('Transactions not yet supported'); },
      rollback: async () => { throw new Error('Transactions not yet supported'); },
      close: () => pool.close(),
      testConnection: async () => {
        try { await pool.execute('SELECT 1 FROM SYSIBM.SYSDUMMY1'); return true; }
        catch { return false; }
      },
      getDriverType: () => pool.getDriverType(),
      getSqlConcurrency: () => Math.max(1, Math.floor(config.sqlConcurrency ?? 1)),
      callRpg: (programName, programConfig, inputParams) => pool.callRpg(programName, programConfig, inputParams)
    };
  }

  async closeAll(): Promise<void> {
    console.log('🔌 Closing all database pools...');
    for (const [name, pool] of this.pools.entries()) {
      try { await pool.close(); console.log(`   ✓ Closed pool: ${name}`); }
      catch (error) { console.error(`   ✗ Error closing pool ${name}:`, error); }
    }
    this.pools.clear();
  }

  getDriverType(): 'ibmi' | 'odbc' { return this.driverType; }
  getPoolNames(): string[] { return Array.from(this.pools.keys()); }
  getAllConfiguredPoolNames(): string[] { return this.config ? Object.keys(this.config.pools) : []; }
  getPoolConfig(poolName: string): PoolConfig | undefined { return this.config?.pools[poolName]; }
}
