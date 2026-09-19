/**
 * ibmi-unified-connector
 *
 * Unified cross-platform database connector supporting IBM i (idb-connector) and ODBC.
 * Auto-detects the available driver at runtime — no platform flags needed.
 *
 * @example
 * import { PoolManager } from 'ibmi-unified-connector';
 *
 * const pool = PoolManager.getInstance('./config/pools.json');
 * await pool.initialize();
 * const rows = await (await pool.getPool('high')).query('SELECT * FROM ORDERS');
 */

export { PoolManager } from './pool/PoolManager.js';
export { UnifiedPoolWrapper } from './pool/UnifiedPoolWrapper.js';
export type { IDatabase, PoolConfig, PoolsConfig, DriverType, RpgParam, ProgramConfig, ProgramsRegistry } from './types.js';
export { buildXmlPayload } from './rpg/XmlServiceBuilder.js';
export { parseXmlResponse } from './rpg/XmlServiceParser.js';
