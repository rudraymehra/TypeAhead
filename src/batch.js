'use strict';

const db = require('./db');
const cache = require('./cache');
const config = require('./config');

/**
 * Batch writer — turns a flood of per-search increments into a handful of DB
 * transactions.
 *
 * - `buffer` coalesces repeats: Map<query, summed delta>. Searching "iphone"
 *   200 times in a window becomes a single (+200) row write.
 * - Flush triggers: buffered search count ≥ BATCH_SIZE, OR a FLUSH_INTERVAL_MS
 *   timer — whichever fires first.
 * - SNAPSHOT-THEN-WRITE: the buffer is swapped for a fresh Map synchronously,
 *   BEFORE any await, so searches arriving mid-flush are never lost or double
 *   counted. One SQLite transaction applies the whole snapshot.
 * - Invalidation happens AFTER the commit, so a concurrent read can't refill the
 *   cache with about-to-be-stale data.
 * - On a clean shutdown we flush first → zero loss. On a crash, only the
 *   un-flushed buffer (≤ BATCH_SIZE searches) is lost — an acceptable trade-off
 *   for a popularity counter, and the price of not writing synchronously.
 */

let buffer = new Map(); // query -> coalesced delta
let bufferedSearches = 0; // counts repeats too
let timer = null;

const stats = {
  enqueued: 0, // lifetime searches buffered
  flushes: 0, // transactions committed
  rowsUpserted: 0, // distinct rows written
  prefixesInvalidated: 0,
};

function armTimer() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush('timer').catch((e) => console.error('flush(timer) failed:', e.message));
  }, config.FLUSH_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function enqueue(query) {
  buffer.set(query, (buffer.get(query) || 0) + 1);
  bufferedSearches++;
  stats.enqueued++;
  if (bufferedSearches >= config.BATCH_SIZE) {
    flush('size').catch((e) => console.error('flush(size) failed:', e.message));
  } else {
    armTimer();
  }
}

// Every distinct prefix of a query — these are the cache keys it can affect.
function prefixesOf(query) {
  const out = [];
  for (let i = 1; i <= query.length; i++) out.push(query.slice(0, i));
  return out;
}

async function flush(reason = 'manual') {
  if (buffer.size === 0) return { upserts: 0, prefixes: 0, reason };

  // --- snapshot-then-write (synchronous, before any await) ---
  const snapshot = buffer;
  const snapshotSearches = bufferedSearches;
  buffer = new Map();
  bufferedSearches = 0;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  const entries = [...snapshot.entries()];
  const flushTs = Date.now();

  // --- one transaction for the whole batch ---
  let upserts;
  try {
    upserts = db.flushBatch(entries, flushTs, config.TREND_HALF_LIFE_MS);
  } catch (err) {
    // Fold the snapshot back so no counts are lost, then retry on the next tick.
    for (const [q, d] of entries) buffer.set(q, (buffer.get(q) || 0) + d);
    bufferedSearches += snapshotSearches;
    armTimer();
    throw err;
  }

  // --- invalidate affected prefixes AFTER commit ---
  const affected = new Set();
  for (const [q] of entries) for (const p of prefixesOf(q)) affected.add(p);
  await cache.invalidate([...affected]);

  stats.flushes++;
  stats.rowsUpserted += upserts;
  stats.prefixesInvalidated += affected.size;

  // Keep going if traffic kept arriving during the flush.
  if (bufferedSearches >= config.BATCH_SIZE) {
    flush('size').catch((e) => console.error('flush(size) failed:', e.message));
  } else if (buffer.size > 0) {
    armTimer();
  }

  return { upserts, prefixes: affected.size, searches: snapshotSearches, reason };
}

function getStats() {
  return {
    enqueued: stats.enqueued,
    flushes: stats.flushes,
    rowsUpserted: stats.rowsUpserted,
    prefixesInvalidated: stats.prefixesInvalidated,
    pendingSearches: bufferedSearches,
    pendingDistinct: buffer.size,
    batchSize: config.BATCH_SIZE,
    flushIntervalMs: config.FLUSH_INTERVAL_MS,
    // How many synchronous writes we avoided:
    writeReduction: stats.rowsUpserted ? Number((stats.enqueued / stats.rowsUpserted).toFixed(2)) : null,
    txnReduction: stats.flushes ? Number((stats.enqueued / stats.flushes).toFixed(2)) : null,
  };
}

function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = { enqueue, flush, getStats, stop, prefixesOf };
