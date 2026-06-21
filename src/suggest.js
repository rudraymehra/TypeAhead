'use strict';

const db = require('./db');
const cache = require('./cache');
const trending = require('./trending');
const metrics = require('./metrics');
const { normalize } = require('./normalize');
const config = require('./config');

/**
 * Read path — CACHE-FIRST.
 *
 *   1. normalize prefix
 *   2. look up `suggest:<mode>:<prefix>` on the prefix's cache node
 *   3. HIT  → return immediately (sub-ms)
 *      MISS → compute from SQLite (basic = by count, trending = decay+blend),
 *             refill the cache, return
 *
 * Empty / missing prefixes short-circuit to an empty list (no DB or cache work).
 */
async function suggest(rawPrefix, mode = 'trending') {
  const t0 = process.hrtime.bigint();
  const prefix = normalize(rawPrefix);
  mode = mode === 'basic' ? 'basic' : 'trending';

  const node = cache.ownerId(prefix);

  if (!prefix) {
    return { query: '', mode, cache: 'skip', node, count: 0, suggestions: [] };
  }

  // 1) cache
  const cached = await cache.get(mode, prefix);
  if (cached) {
    metrics.recordSuggest(elapsedMs(t0), true);
    return { query: prefix, mode, cache: 'hit', node, count: cached.length, suggestions: cached };
  }

  // 2) miss → source of truth
  let suggestions;
  if (mode === 'basic') {
    suggestions = db
      .suggestByCount(prefix, config.MAX_SUGGESTIONS)
      .map((r) => ({ query: r.query, count: r.count }));
  } else {
    suggestions = trending.rankPrefix(prefix);
  }

  // 3) refill (best-effort)
  await cache.set(mode, prefix, suggestions);

  metrics.recordSuggest(elapsedMs(t0), false);
  return { query: prefix, mode, cache: 'miss', node, count: suggestions.length, suggestions };
}

function elapsedMs(t0) {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

module.exports = { suggest };
