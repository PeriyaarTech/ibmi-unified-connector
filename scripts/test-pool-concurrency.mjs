// Cold-pool regression test: parallel queries with a slow async connect() must all finish.
import { UnifiedPoolWrapper } from '../dist/pool/UnifiedPoolWrapper.js';

const CONNECT_MS = 300;
const QUERY_MS = 20;
const TIMEOUT_MS = 3000;
const MAX_SIZE = 12;

function makePool() {
  const pool = new UnifiedPoolWrapper({
    name: 'Test Pool',
    connectionString: 'DRIVER={fake};SYSTEM=none',
    maxSize: MAX_SIZE,
    timeout: TIMEOUT_MS,
    incrementSize: 1,
    validateOnBorrow: false,
  });
  let opened = 0;
  pool.driver = 'odbc';
  pool.driverModule = {
    connect: async () => {
      opened++;
      await new Promise(r => setTimeout(r, CONNECT_MS));
      return {
        query: async () => { await new Promise(r => setTimeout(r, QUERY_MS)); return [{ ok: 1 }]; },
        close: async () => {},
      };
    },
  };
  return { pool, opened: () => opened };
}

async function wave(pool, n) {
  return Promise.allSettled(Array.from({ length: n }, () => pool.execute('SELECT 1')));
}

const log = console.log;
console.log = () => {};
let failed = false;

for (const concurrency of [10, 20]) {
  const { pool, opened } = makePool();
  const started = Date.now();
  // Two dependent waves, as getPolicy does.
  const first = await wave(pool, concurrency);
  const second = await wave(pool, 3);
  const rejected = [...first, ...second].filter(r => r.status === 'rejected');
  const stats = pool.getStats();
  const ok = rejected.length === 0 && opened() <= MAX_SIZE && stats.inUse === 0 && stats.waiting === 0;
  log(`${ok ? 'PASS' : 'FAIL'} concurrency=${concurrency} ${Date.now() - started}ms opened=${opened()} rejected=${rejected.length} ${JSON.stringify(stats)}`);
  if (rejected[0]) log('  first error:', rejected[0].reason?.message);
  if (!ok) failed = true;
  await pool.close();
}

process.exit(failed ? 1 : 0);
