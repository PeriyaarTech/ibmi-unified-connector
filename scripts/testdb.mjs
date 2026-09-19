import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PoolManager } from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const candidateEnvPaths = [
  path.join(rootDir, '.env'),
  path.join(rootDir, 'examples', '.env')
];
const envExamplePath = path.join(rootDir, 'examples', '.env.example');
const envPath = candidateEnvPaths.find((p) => fs.existsSync(p));

const loadEnv = () => {
  const values = {};
  const sourcePath = envPath ?? envExamplePath;
  if (!fs.existsSync(sourcePath)) return values;

  for (const line of fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    values[key] = value;
    process.env[key] = value;
  }
  return values;
};

const env = loadEnv();

const resolveEnvValue = (value) => {
  if (!value || typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const resolved = env[key] ?? process.env[key] ?? '';
    return String(resolved);
  });
};

const getValue = (key, fallback) => {
  const raw = env[key] ?? process.env[key] ?? fallback;
  const resolved = resolveEnvValue(raw);
  return resolved && String(resolved).trim() ? String(resolved).trim() : fallback;
};

const mode = getValue('DB_MODE', 'auto').toLowerCase();
const system = getValue('DB_SYSTEM', '');
const user = getValue('DB_USER', '');
const password = getValue('DB_PASSWORD', '');
const odbcConnectionString = resolveEnvValue(getValue('ODBC_CONNECTION_STRING', ''));
const clpProgramLibrary = getValue('TESTDB_CLP_LIBRARY', '');
const clpProgramName = getValue('TESTDB_CLP_PROGRAM', 'TESTDB');
const configPath = path.resolve(rootDir, 'examples', 'config', 'pools.json');
const programsConfigPath = path.resolve(rootDir, 'examples', 'config', 'programs.json');

const colors = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  magenta: '\u001b[35m',
  blue: '\u001b[34m'
};

const colorize = (text, color) => `${colors[color] || ''}${text}${colors.reset}`;

const print = (msg, extra = '') => {
  console.log(msg + (extra ? ` ${extra}` : ''));
};

const printInfo = (msg) => console.log(colorize(msg, 'cyan'));
const printSuccess = (msg) => console.log(colorize(msg, 'green'));
const printWarning = (msg) => console.log(colorize(msg, 'yellow'));
const printError = (msg) => console.log(colorize(msg, 'red'));
const printHeader = (msg) => console.log(colorize(`${msg}`, 'bold') + colorize(' ', 'reset'));

const printUsage = () => {
  printHeader('\nUsage:');
  console.log('  cp examples/.env.example .env');
  console.log('  npm run testdb');
  console.log('  DB_MODE=auto|odbc|ibmi npm run testdb\n');
  printInfo('Notes:');
  console.log('  - This mirrors the consumer app DB validation pattern');
  console.log('  - It initializes PoolManager, validates the high-priority pool, and runs sample SQL');
};

const formatError = (error) => {
  if (!error) return 'Unknown error';
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
};

const routeMatches = (route, pattern) => {
  const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexPattern}$`).test(route);
};

const validateClpProgram = async (db) => {
  const program = `${clpProgramLibrary}/${clpProgramName}`;

  try {
    if (!fs.existsSync(programsConfigPath)) {
      throw new Error(`Program config not found at ${programsConfigPath}`);
    }

    const programFile = JSON.parse(fs.readFileSync(programsConfigPath, 'utf8'));
    const programDefinition = programFile.programs?.[clpProgramName];
    if (!programDefinition) {
      throw new Error(`Program definition not found for ${clpProgramName} in ${programsConfigPath}`);
    }

    const resolvedLibrary = resolveEnvValue(programDefinition.library ?? clpProgramLibrary);
    const testProgram = {
      ...programDefinition,
      library: resolvedLibrary || clpProgramLibrary
    };

    printHeader('\n=== CLP program validation ===');
    printInfo(`Calling ${resolvedLibrary || clpProgramLibrary}/${clpProgramName} with A=2, B=4`);

    const result = await db.callRpg(clpProgramName, testProgram, { A: 2, B: 4, RESULT: 0 });
    const computed = Number(result?.RESULT ?? result?.result ?? 0);
    console.log('XMLSERVICE result:', result);

    if (computed !== 8) {
      throw new Error(`Expected 8 but got ${computed}`);
    }

    printSuccess(`CLP validation passed: ${resolvedLibrary || clpProgramLibrary}/${clpProgramName} => ${computed}`);
    return true;
  } catch (error) {
    printError(`CLP validation failed: ${formatError(error)}`);
    printInfo(`Compile and place the test CLP program as ${program} before running npm run testdb.`);
    printInfo('Example source: examples/clp/TESTDB.CLLE');
    return false;
  }
};

async function runPoolCheck() {
  if (!envPath && !fs.existsSync(envExamplePath)) {
    printError('No .env file found. Copy examples/.env.example to .env and fill in values before running this utility.');
    printUsage();
    process.exit(1);
  }

  if (envPath) {
    printInfo(`Using env file: ${envPath}`);
  }

  if (!system && !odbcConnectionString) {
    printError('No DB_SYSTEM or ODBC_CONNECTION_STRING found. Update .env with your IBM i settings.');
    printUsage();
    process.exit(1);
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`Pool config not found at ${configPath}`);
  }

  printHeader('\n=== Pool Manager database validation ===');
  const poolManager = PoolManager.getInstance(configPath);
  await poolManager.initialize();

  const db = await poolManager.getPool('high');
  printInfo(`Resolved driver: ${db.getDriverType ? db.getDriverType() : 'unknown'}`);

  const isConnected = await db.testConnection();
  if (!isConnected) {
    throw new Error('Database connection test returned false');
  }
  printSuccess('Database connection test passed');

  const queries = [
    'SELECT 1 AS TEST FROM SYSIBM.SYSDUMMY1',
    'SELECT CURRENT TIMESTAMP AS NOW FROM SYSIBM.SYSDUMMY1'
  ];

  for (const sql of queries) {
    const rows = await db.query(sql);
    console.log(`SQL: ${sql}`);
    console.log(JSON.stringify(rows, null, 2));
  }

  const clpOk = await validateClpProgram(db);
  if (!clpOk) {
    throw new Error(`Required test CLP program ${clpProgramLibrary}/${clpProgramName} is not available`);
  }

  const routeChecks = [
    '/api/*',
    '/api/v1/query/db/policySearch',
    '/v1/query/db/policySearch',
    '/batch/processUnderwriting'
  ];

  printHeader('\n=== Route-to-pool selection check ===');
  for (const route of routeChecks) {
    let matchedPool = 'high';
    for (const poolName of poolManager.getAllConfiguredPoolNames()) {
      const poolConfig = poolManager.getPoolConfig(poolName);
      if (poolConfig?.routePatterns?.some((pattern) => routeMatches(route, pattern))) {
        matchedPool = poolName;
        break;
      }
    }
    printInfo(`${route} -> ${matchedPool}`);
  }

  printSuccess('\n=== Validation complete ===');
}

async function main() {
  const shouldUseIbmi = ['ibmi', 'native', 'idb'].includes(mode);
  const shouldUseOdbc = ['odbc', 'sql', 'database'].includes(mode);

  if (mode === 'auto' || mode === 'all' || shouldUseIbmi || shouldUseOdbc) {
    try {
      await runPoolCheck();
      return;
    } catch (error) {
      printError(`\nPoolManager validation failed: ${formatError(error)}`);
      printWarning('This is the same kind of DB check the browser/API consumer project performs, and it indicates the live DB connection is not available from this environment.');
      process.exit(1);
    }
  }

  printError(`Unsupported DB_MODE value: ${mode}`);
  printUsage();
  process.exit(1);
}

main().catch((error) => {
  printError(`Unexpected error: ${formatError(error)}`);
  process.exit(1);
});
