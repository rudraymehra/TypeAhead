'use strict';

const db = require('./db');
const config = require('./config');

/**
 * Recency-aware ("trending") ranking.
 *
 * Each row carries a `trend_score` that is LAZILY exponentially decayed: every
 * time a query is touched (batch flush) we first decay its stored score to now,
 * then add the new activity:
 *
 *     score = score · 0.5^(Δt / HALF_LIFE) + delta      (done in db.flushBatch)
 *
 * Reading is therefore cheap — no background timer. At query time we decay once
 * more to the read instant and blend with all-time popularity:
 *
 *     blended = α · normCount + (1-α) · normRecency      (α = TREND_ALPHA = 0.5)
 *
 * normCount / normRecency are min-max-normalized to [0,1] WITHIN the candidate
 * pool, so the two very different scales (counts in the thousands vs. recency in
 * single digits) get an equal vote. A short-lived spike cannot rank forever:
 * its recency decays back below TREND_EPSILON and it falls out of contention.
 */

function decayedRecency(row, now) {
  if (!row.last_updated || row.last_updated <= 0) return 0;
  const dt = Math.max(0, now - row.last_updated);
  const v = row.trend_score * Math.pow(0.5, dt / config.TREND_HALF_LIFE_MS);
  return v < config.TREND_EPSILON ? 0 : v;
}

function blend(rows, now) {
  if (!rows.length) return [];
  const alpha = config.TREND_ALPHA;

  const enriched = rows.map((r) => ({
    query: r.query,
    count: r.count,
    recency: decayedRecency(r, now),
  }));

  const maxCount = Math.max(1, ...enriched.map((e) => e.count));
  const maxRec = Math.max(0, ...enriched.map((e) => e.recency));

  for (const e of enriched) {
    const nc = e.count / maxCount;
    const nr = maxRec > 0 ? e.recency / maxRec : 0;
    e.score = alpha * nc + (1 - alpha) * nr;
  }

  enriched.sort((a, b) => b.score - a.score || b.count - a.count);
  return enriched;
}

// Trending suggestions for a prefix: blend over the candidate pool, take top-N.
function rankPrefix(prefix, now = Date.now()) {
  const pool = db.candidatePool(prefix);
  return blend(pool, now)
    .slice(0, config.MAX_SUGGESTIONS)
    .map((e) => ({ query: e.query, count: e.count, score: Number(e.score.toFixed(4)) }));
}

// Global trending feed for the UI panel: queries with live recency, hottest
// first. Falls back to all-time top if nothing has been searched yet.
function globalTrending(limit = config.MAX_SUGGESTIONS, now = Date.now()) {
  const pool = db.globalRecentPool(config.CANDIDATE_POOL * 2);
  const hot = pool
    .map((r) => ({ query: r.query, count: r.count, score: decayedRecency(r, now) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => ({ query: e.query, count: e.count, score: Number(e.score.toFixed(3)) }));

  if (hot.length) return { mode: 'trending', trending: hot };
  return { mode: 'count', trending: db.topGlobal(limit) };
}

module.exports = { rankPrefix, globalTrending, decayedRecency, blend };
