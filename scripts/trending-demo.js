'use strict';

/**
 * Shows the difference between BASIC (all-time count) and TRENDING (recency-aware)
 * ranking, and that a short-lived spike DECAYS back instead of ranking forever.
 *
 * Uses a throwaway in-memory SQLite DB so it never touches your real data.
 * Run: npm run trending-demo
 */

process.env.DB_PATH = ':memory:';
const db = require('../src/db');
const trending = require('../src/trending');
const config = require('../src/config');

db.init();

// Seed: "search" is a giant all-time query; "seattle" is a modest one.
db.loadMany([
  { query: 'search', count: 50000 },
  { query: 'search engine', count: 12000 },
  { query: 'seattle', count: 800 },
  { query: 'seafood', count: 600 },
  { query: 'season', count: 1500 },
]);

const now = Date.now();

function show(label, ts) {
  const rows = trending.rankPrefix('sea', ts);
  console.log(`\n${label}`);
  rows.forEach((r, i) => {
    const row = db.getOne(r.query);
    const absRec = trending.decayedRecency(row, ts).toFixed(3);
    console.log(
      `  ${i + 1}. ${r.query.padEnd(16)} count=${String(r.count).padStart(6)}  ` +
      `score=${String(r.score).padEnd(6)} rawRecency=${absRec}`
    );
  });
}

console.log('Prefix "sea" — BASIC ranking (pure count):');
db.suggestByCount('sea').forEach((r, i) =>
  console.log(`  ${i + 1}. ${r.query.padEnd(16)} count=${r.count}`)
);

show('TRENDING ranking, no recent activity (≈ count order):', now);

// Simulate a surge: "seattle" searched hard, just now.
db.flushBatch([['seattle', 400]], now, config.TREND_HALF_LIFE_MS);
show('TRENDING right after a 400-search surge on "seattle":', now);
console.log('  → "seattle" jumps the ranking despite a far smaller all-time count.');

// Let time pass. The raw recency decays exponentially; once it falls below
// TREND_EPSILON it is treated as 0 and the spike stops mattering entirely.
const hl = config.TREND_HALF_LIFE_MS;
show('TRENDING 4 half-lives later (raw recency decaying, still leads):', now + 4 * hl);
show('TRENDING 16 half-lives later (recency < EPSILON → melted to 0):', now + 16 * hl);
console.log('  → recency faded below EPSILON; ranking relaxes back to all-time popularity.');
console.log('\nThis is how a short-lived spike cannot rank forever: absolute recency');
console.log(`decays by half every ${hl / 3.6e6}h and is dropped once it crosses EPSILON=${config.TREND_EPSILON}.`);

db.close();
