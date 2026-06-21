'use strict';

/**
 * Quantifies write reduction from batching. Replays a realistic Zipf-skewed
 * stream of searches and compares:
 *   - naive: one DB write PER search
 *   - batched: coalesce repeats, flush in transactions
 *
 * Uses a throwaway in-memory DB and a stubbed cache (no Redis needed).
 * Run: npm run batch-demo
 */

process.env.DB_PATH = ':memory:';

// Stub the cache so batch.invalidate() is a no-op (we're measuring DB writes).
const cache = require('../src/cache');
cache.invalidate = async () => {};

const db = require('../src/db');
const batch = require('../src/batch');
const config = require('../src/config');

db.init();

const DISTINCT = 200;
const SEARCHES = 10000;
db.loadMany(Array.from({ length: DISTINCT }, (_, i) => ({ query: `q${i}`, count: 0 })));

// Zipf-ish: low indices much more likely.
function pick() {
  const r = Math.pow(Math.random(), 2.2);
  return `q${Math.min(DISTINCT - 1, Math.floor(r * DISTINCT))}`;
}

async function main() {
  console.log(`Batch write demo — ${SEARCHES.toLocaleString()} searches over ${DISTINCT} distinct queries`);
  console.log(`Config: BATCH_SIZE=${config.BATCH_SIZE}, FLUSH_INTERVAL_MS=${config.FLUSH_INTERVAL_MS}\n`);

  for (let i = 0; i < SEARCHES; i++) {
    batch.enqueue(pick());
  }
  await batch.flush('demo-final');

  const s = batch.getStats();
  console.log('Naive approach :', SEARCHES.toLocaleString(), 'DB upserts,', SEARCHES.toLocaleString(), 'transactions');
  console.log('Batched approach:', s.rowsUpserted.toLocaleString(), 'DB upserts,', s.flushes.toLocaleString(), 'transactions');
  console.log('');
  console.log(`→ Row-write reduction   : ${s.writeReduction}×  (${SEARCHES} → ${s.rowsUpserted})`);
  console.log(`→ Transaction reduction : ${s.txnReduction}×  (${SEARCHES} → ${s.flushes})`);
  console.log('\nFailure trade-off: a crash before a flush loses only the un-flushed buffer');
  console.log(`(≤ BATCH_SIZE=${config.BATCH_SIZE} searches). Clean shutdown flushes first → zero loss.`);

  batch.stop();
  db.close();
}

main();
