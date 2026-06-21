'use strict';

const path = require('path');

/**
 * Central configuration. Every tunable lives here so design choices are easy to
 * find and justify during the viva. Values can be overridden via env vars.
 */
module.exports = {
  PORT: Number(process.env.PORT) || 3000,

  // ---- SQLite (durable source of truth for query counts) ----
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'typeahead.db'),

  // ---- Redis distributed cache ----
  // Three LOGICAL cache nodes. By default they are three databases (0/1/2) on a
  // single Redis instance, so the grader only needs ONE `redis-server` running.
  // To use three real Redis processes instead, point each node at a different
  // port (see docker-compose.yml) — the consistent-hash ring is identical.
  REDIS_NODES: [
    { id: 'cache-node-0', host: '127.0.0.1', port: 6379, db: 0 },
    { id: 'cache-node-1', host: '127.0.0.1', port: 6379, db: 1 },
    { id: 'cache-node-2', host: '127.0.0.1', port: 6379, db: 2 },
  ],
  CACHE_TTL_SECONDS: 300, // 5-minute safety net; explicit invalidation is the precise mechanism

  // ---- Consistent-hash ring ----
  VNODES_PER_NODE: 150, // virtual nodes per physical node → even spread, ~1/N remap on change

  // ---- Suggestions ----
  MAX_SUGGESTIONS: 10,
  CANDIDATE_POOL: 100, // trending pool: top-100 by count ∪ top-100 by recency

  // ---- Trending (recency-aware ranking) ----
  TREND_HALF_LIFE_MS: 60 * 60 * 1000, // a recency spike cools to 50% in 1 hour
  TREND_ALPHA: 0.5, // blend weight: score = α·normCount + (1-α)·normRecency
  TREND_EPSILON: 0.01, // recency below this is treated as 0 (spikes can't rank forever)

  // ---- Batch writes ----
  BATCH_SIZE: 500, // flush when this many searches have been buffered...
  FLUSH_INTERVAL_MS: 2000, // ...or this often, whichever comes first
  INITIAL_COUNT: 1, // count assigned to a brand-new query on first search

  // ---- Dataset loading ----
  COUNT_SCALE: 1000, // raw Norvig counts are huge; scale down so live +1 searches matter
  TOP_BIGRAMS: 100000, // keep the top-N two-word phrases by count
};
