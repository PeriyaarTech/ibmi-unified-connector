import type { PoolConfig, ProgramConfig } from '../types.js';
import { buildXmlPayload } from '../rpg/XmlServiceBuilder.js';
import { parseXmlResponse } from '../rpg/XmlServiceParser.js';

/**
 * Unified connection pool wrapper supporting both idb-connector and ODBC.
 * Auto-detects the available driver: idb-connector preferred on IBM i, ODBC as fallback.
 */
export class UnifiedPoolWrapper {
  private connections: any[] = [];
  private availableConnections: any[] = [];
  private pendingRequests: Array<(conn: any) => void> = [];
  private initializedConnections = new WeakSet();
  private connectionState = new WeakMap<any, { lastUsedAt: number }>();

  private driver: 'idb-connector' | 'odbc' = 'odbc';
  private driverModule: any = null;
  private config: PoolConfig;

  private currentSize = 0;
  private closed = false;

  constructor(config: PoolConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    try {
      const ibmiModule = await import('idb-connector');
      this.driverModule = ibmiModule.default || ibmiModule;
      this.driver = 'idb-connector';
      console.log(`   Using idb-connector (IBM i native)`);
    } catch {
      try {
        const odbcModule = await import('odbc');
        this.driverModule = odbcModule.default || odbcModule;
        this.driver = 'odbc';
        console.log(`   Using ODBC driver`);
      } catch {
        throw new Error('No database driver available (tried idb-connector, odbc)');
      }
    }
    console.log(`   Pool initialized: ${this.config.name}`);
    console.log(`   Max connections: ${this.config.maxSize}, Timeout: ${this.config.timeout}ms`);
  }

  getDriverType(): 'idb-connector' | 'odbc' {
    return this.driver;
  }

  async getConnection(): Promise<any> {
    if (this.closed) throw new Error('Connection pool is closed');

    const available = await this.borrowAvailableConnection();
    if (available) return available;

    if (this.currentSize < this.config.maxSize) {
      const count = Math.min(this.config.incrementSize || 1, this.config.maxSize - this.currentSize);
      for (let i = 0; i < count; i++) {
        const newConn = await this.createConnectionWithRetries();
        if (newConn && !this.initializedConnections.has(newConn)) {
          await this.initializeConnection(newConn);
          this.initializedConnections.add(newConn);
        }
      }
      const newAvailable = await this.borrowAvailableConnection();
      if (newAvailable) return newAvailable;
    }

    return new Promise<any>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.pendingRequests.indexOf(resolve);
        if (index > -1) this.pendingRequests.splice(index, 1);
        reject(new Error(`Connection pool timeout after ${this.config.timeout}ms`));
      }, this.config.timeout);

      this.pendingRequests.push(async (conn: any) => {
        clearTimeout(timeoutId);
        if (!this.initializedConnections.has(conn)) {
          await this.initializeConnection(conn);
          this.initializedConnections.add(conn);
        }
        resolve(conn);
      });
    });
  }

  releaseConnection(connection: any): void {
    this.markConnectionUsed(connection);
    if (this.closed) { this.destroyConnection(connection); return; }
    if (this.pendingRequests.length > 0) {
      const resolver = this.pendingRequests.shift();
      resolver!(connection);
      return;
    }
    this.availableConnections.push(connection);
  }

  private async borrowAvailableConnection(): Promise<any | undefined> {
    while (this.availableConnections.length > 0) {
      const conn = this.availableConnections.pop();
      if (!conn) continue;

      if (!(await this.prepareConnectionForBorrow(conn))) continue;

      if (!this.initializedConnections.has(conn)) {
        await this.initializeConnection(conn);
        this.initializedConnections.add(conn);
      }
      return conn;
    }

    return undefined;
  }

  private async prepareConnectionForBorrow(connection: any): Promise<boolean> {
    const state = this.connectionState.get(connection);
    const idleMillis = state ? Date.now() - state.lastUsedAt : 0;
    const maxIdleMillis = this.config.maxIdleMillis ?? 0;

    if (maxIdleMillis > 0 && idleMillis >= maxIdleMillis) {
      await this.destroyConnection(connection);
      return false;
    }

    const validateOnBorrow = this.config.validateOnBorrow ?? false;
    const idleValidationMillis = this.config.idleValidationMillis ?? 0;
    if (!validateOnBorrow || idleValidationMillis <= 0 || idleMillis < idleValidationMillis) {
      return true;
    }

    try {
      await this.testConnectionHealth(connection);
      this.markConnectionUsed(connection);
      return true;
    } catch (error) {
      console.warn(`   Stale pooled connection discarded (${this.config.name}):`, error);
      await this.destroyConnection(connection);
      return false;
    }
  }

  private markConnectionUsed(connection: any): void {
    this.connectionState.set(connection, { lastUsedAt: Date.now() });
  }

  async execute<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const connection = await this.getConnection();
    try {
      let result: any;
      if (this.driver === 'idb-connector') {
        const { dbstmt } = this.driverModule;
        result = await new Promise((resolve, reject) => {
          const stmt = new dbstmt(connection);
          const closeAndReject = (error: Error) => {
            stmt.close();
            reject(error);
          };

          if (params.length === 0) {
            stmt.exec(sql, (rows: any[], err: Error) => {
              stmt.close();
              if (err) reject(err);
              else resolve(rows || []);
            });
            return;
          }

          stmt.prepare(sql, (prepareError: Error) => {
            if (prepareError) return closeAndReject(prepareError);
            stmt.bindParameters(params, (bindError: Error) => {
              if (bindError) return closeAndReject(bindError);
              stmt.execute((_output: any[], executeError: Error) => {
                if (executeError) return closeAndReject(executeError);
                stmt.fetchAll((rows: any[], fetchError: Error) => {
                  stmt.close();
                  if (fetchError) reject(fetchError);
                  else resolve(rows || []);
                });
              });
            });
          });
        });
      } else {
        result = await connection.query(sql, params);
      }
      this.releaseConnection(connection);
      return result as T[];
    } catch (error) {
      try {
        await this.testConnectionHealth(connection);
        this.releaseConnection(connection);
      } catch {
        this.destroyConnection(connection);
      }
      throw error;
    }
  }

  private async createConnection(): Promise<any> {
    try {
      let connection: any;
      if (this.driver === 'idb-connector') {
        const { dbconn } = this.driverModule;
        connection = new dbconn();
        connection.conn('*LOCAL');
      } else {
        const connectionString = this.config.connectionString || process.env.ODBC_CONNECTION_STRING;
        if (!connectionString) throw new Error('ODBC connection string not provided');
        connection = await this.driverModule.connect(connectionString);
      }
      this.connections.push(connection);
      this.availableConnections.push(connection);
      this.markConnectionUsed(connection);
      this.currentSize++;
      return connection;
    } catch (error) {
      console.error('Failed to create connection:', error);
      throw error;
    }
  }

  private async createConnectionWithRetries(): Promise<any> {
    const retries = Math.max(0, this.config.connectionCreateRetries ?? 0);
    const delayMillis = Math.max(0, this.config.connectionCreateRetryDelayMillis ?? 0);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.createConnection();
      } catch (error) {
        if (attempt >= retries || !this.isTransientConnectionError(error)) throw error;
        if (delayMillis > 0) await new Promise(resolve => setTimeout(resolve, delayMillis));
      }
    }

    throw new Error('Failed to create connection');
  }

  private isTransientConnectionError(error: any): boolean {
    const message = String(error?.message ?? error ?? '');
    const odbcErrors = Array.isArray(error?.odbcErrors) ? error.odbcErrors : [];
    return message.includes('Communication link failure')
      || message.includes('CWBCO1047')
      || odbcErrors.some((err: any) => String(err?.state ?? '') === '08S01' || String(err?.message ?? '').includes('CWBCO1047'));
  }

  private async initializeConnection(connection: any): Promise<void> {
    try {
      // 1. Set job run priority
      if (this.config.jobPriority !== undefined) {
        const priority = this.config.jobPriority;
        const sql = `CALL QSYS2.QCMDEXC('CHGJOB RUNPTY(${priority})')`;
        if (this.driver === 'idb-connector') {
          const { dbstmt } = this.driverModule;
          await new Promise<void>((resolve, reject) => {
            const stmt = new dbstmt(connection);
            stmt.exec(sql, (_rows: any[], err: Error) => {
              stmt.close();
              if (err) reject(err);
              else resolve();
            });
          });
        } else {
          await connection.query(sql);
        }
        console.log(`   Connection initialized with priority ${priority} (${this.config.name})`);
      }

      // 2. Set library list (idb-connector only — ODBC uses DBQ/DefaultLibraries in connection string)
      // Resolve from: explicit libraryList config → parse from connectionString → skip
      if (this.driver === 'idb-connector') {
        const libList = this.config.libraryList?.length
          ? [...this.config.libraryList]
          : this.parseLibraryListFromConnectionString();

        if (libList.length === 0) {
          libList.push('QTEMP', 'QGPL');
        }

        if (libList.length > 0) {
          const { dbstmt } = this.driverModule;
          const libl = libList.join(' ');
          const chgliblSql = `CALL QSYS2.QCMDEXC('CHGLIBL LIBL(${libl})')`;
          await new Promise<void>((resolve, reject) => {
            const stmt = new dbstmt(connection);
            stmt.exec(chgliblSql, (_rows: any[], err: Error) => {
              stmt.close();
              if (err) reject(err);
              else resolve();
            });
          });

          // Optionally set current library
          if (this.config.currentLibrary) {
            const chgcurlibSql = `CALL QSYS2.QCMDEXC('CHGCURLIB CURLIB(${this.config.currentLibrary})')`;
            await new Promise<void>((resolve, reject) => {
              const stmt = new dbstmt(connection);
              stmt.exec(chgcurlibSql, (_rows: any[], err: Error) => {
                stmt.close();
                if (err) reject(err);
                else resolve();
              });
            });
          }

          console.log(`   Library list set: ${libl} (${this.config.name})`);
        }
      }

    } catch (error) {
      console.warn(`   Warning: Connection initialization failed:`, error);
    }
  }

  /**
   * Parses the library list from the ODBC connection string.
   * Supports both DBQ= (IBM i Access ODBC Driver) and DefaultLibraries= formats.
   * Leading commas are stripped (eradani-style ",lib1,lib2" → ["lib1","lib2"]).
   */
  private parseLibraryListFromConnectionString(): string[] {
    const cs = this.config.connectionString ?? '';
    const dbqMatch = cs.match(/(?:DBQ|DefaultLibraries)=([^;]+)/i);
    if (!dbqMatch) return [];
    return dbqMatch[1]
      .split(',')
      .map(l => l.trim())
      .filter(Boolean);
  }

  private async testConnectionHealth(connection: any): Promise<void> {
    const healthCheckSql = this.config.healthCheckSql ?? 'SELECT 1 FROM SYSIBM.SYSDUMMY1';

    if (this.driver === 'idb-connector') {
      const { dbstmt } = this.driverModule;
      await new Promise<void>((resolve, reject) => {
        const stmt = new dbstmt(connection);
        stmt.exec(healthCheckSql, (_rows: any[], err: Error) => {
          stmt.close();
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      await connection.query(healthCheckSql);
    }
  }

  private async destroyConnection(connection: any): Promise<void> {
    try {
      if (this.driver === 'idb-connector') {
        try { connection.disconn(); } catch {}
        try { connection.close(); } catch {}
      } else {
        await connection.close();
      }
      this.currentSize--;
      const index = this.connections.indexOf(connection);
      if (index > -1) this.connections.splice(index, 1);
    } catch (error) {
      console.error('Error destroying connection:', error);
    }
  }

  /**
   * Call an RPG program via IBM i XMLSERVICE (QXMLSERV.iPLUG512K).
   * Works with both idb-connector and ODBC drivers.
   * Returns a flat key/value map of output parameter names to their values.
   */
  async callRpg(programName: string, programConfig: ProgramConfig, inputParams: Record<string, any>): Promise<Record<string, any>> {
    const xmlIn = buildXmlPayload(
      programName,
      programConfig.library,
      programConfig.params,
      inputParams
    );

    const ipc = '*NA';
    const ctl = '*here';
    const xmlOut = '';

    const sql = 'CALL QXMLSERV.iPLUG512K(?,?,?,?)';
    const connection = await this.getConnection();

    try {
      let rawXmlOut: string;

      if (this.driver === 'idb-connector') {
        const { dbstmt } = this.driverModule;
        const outParams: any[] = await new Promise((resolve, reject) => {
          const stmt = new dbstmt(connection);
          stmt.prepare(sql, (err: Error) => {
            if (err) { stmt.close(); return reject(err); }
            stmt.bindParam([
              [ipc,   1, 1],  // INPUT, CHAR
              [ctl,   1, 1],  // INPUT, CHAR
              [xmlIn, 1, 1],  // INPUT, CHAR
              [''.padEnd(512000), 2, 1],  // OUTPUT, CHAR (512k buffer for xmlOut)
            ], (err: Error) => {
              if (err) { stmt.close(); return reject(err); }
              stmt.execute((out: any[], err: Error) => {
                stmt.close();
                if (err) return reject(err);
                resolve(out ?? []);
              });
            });
          });
        });
        rawXmlOut = String(outParams[0] ?? '');
      } else {
        // ODBC: use iPLUGR variant of XMLSERVICE — returns XML as a result set column
        // instead of output parameter, bypassing unixODBC output param limitation on Mac.
        // iPLUGR4K / iPLUGR32K / iPLUGR65K / iPLUGR512K — all INPUT params, XML returned in OUT151 column
        const xmlInLen = Buffer.byteLength(xmlIn, 'utf8');
        const sp = xmlInLen <= 4064   ? 'iPLUGR4K'   :
                   xmlInLen <= 32000  ? 'iPLUGR32K'  :
                   xmlInLen <= 65536  ? 'iPLUGR65K'  : 'iPLUGR512K';

        const stmt = await connection.createStatement();
        await stmt.prepare(`CALL QXMLSERV.${sp}(?,?,?)`);
        await stmt.bind(['*NA', '*here', xmlIn]);
        const result: any[] = await stmt.execute();
        await stmt.close();

        // Concatenate all result rows (large XML may span multiple rows)
        // Column name is OUT151 for iPLUGR variants
        let reportXml = '';
        for (const row of (result ?? [])) {
          reportXml += String(row?.OUT151 ?? Object.values(row ?? {})[0] ?? '');
        }

        // iPLUGR returns a <report> wrapper — extract the inner <xmloutput> CDATA
        // which contains the actual <script> XMLSERVICE response
        const xmloutputMatch = reportXml.match(/<xmloutput[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/xmloutput>/);
        rawXmlOut = xmloutputMatch ? xmloutputMatch[1].trim() : reportXml.trim();

        if (!rawXmlOut) {
          const debug = { sp, rows: result?.length, cols: result?.[0] ? Object.keys(result[0]) : null };
          throw new Error(`[callRpg ODBC] iPLUGR output not found. Debug: ${JSON.stringify(debug)}`);
        }
      }

      this.releaseConnection(connection);

      // Log raw XML for diagnostics (always — helps debug IBM i issues)
      console.log(`[callRpg:${programName}] Raw XML response:\n${rawXmlOut}`);

      return await parseXmlResponse(rawXmlOut);

    } catch (error) {
      this.destroyConnection(connection);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const resolver of this.pendingRequests) {
      resolver(Promise.reject(new Error('Pool is closing')));
    }
    this.pendingRequests = [];
    await Promise.all(this.connections.map(conn => this.destroyConnection(conn)));
    this.connections = [];
    this.availableConnections = [];
    this.currentSize = 0;
  }

  getStats() {
    return {
      driver: this.driver,
      total: this.currentSize,
      available: this.availableConnections.length,
      inUse: this.currentSize - this.availableConnections.length,
      waiting: this.pendingRequests.length,
      maxSize: this.config.maxSize,
    };
  }
}
