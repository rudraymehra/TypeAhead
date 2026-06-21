'use strict';

/**
 * Latency + cache-hit-rate benchmark against a RUNNING server.
 * Generates a Zipf-skewed prefix workload (hot prefixes repeat → high hit rate),
 * measures client-side latency, and prints p50/p95/p99 plus server stats.
 *
 * Prereq: server running (npm start) and dataset loaded.
 * Run:    npm run perf-bench           (override host: BASE=http://localhost:3100 npm run perf-bench)
 */

const BASE = process.env.BASE || 'http://localhost:3000';
const REQUESTS = Number(process.env.REQUESTS) || 8000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 20;

// A pool of realistic prefixes; picked with a Zipf-like bias toward the front.
const SEEDS = ['se', 'sea', 'ip', 'ipo', 'jav', 'java', 'pro', 'win', 'goo', 'app',
  'mic', 'down', 'free', 'on', 'new', 'home', 'best', 'how', 'web', 'car'];

function pickPrefix() {
  const r = Math.pow(Math.random(), 3); // bias toward early (hot) seeds
  return SEEDS[Math.min(SEEDS.length - 1, Math.floor(r * SEEDS.length))];
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function one(latencies) {
  const prefix = pickPrefix();
  const t0 = process.hrtime.bigint();
  const res = await fetch(`${BASE}/suggest?q=${encodeURIComponent(prefix)}&mode=trending`);
  await res.json();
  latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
}

async function worker(remaining, latencies) {
  while (remaining.n > 0) {
    remaining.n--;
    try {
      await one(latencies);
    } catch (e) {
      /* count nothing on transport error */
    }
  }
}

async function main() {
  console.log(`Perf benchmark → ${BASE}`);
  console.log(`  ${REQUESTS.toLocaleString()} /suggest requests, concurrency ${CONCURRENCY}\n`);

  // Warm the cache a little first so we measure steady state.
  const latencies = [];
  const remaining = { n: REQUESTS };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(remaining, latencies)));
  const wallSec = (Date.now() - t0) / 1000;

  latencies.sort((a, b) => a - b);
  console.log('Client-side latency (ms):');
  console.log(`  p50 ${percentile(latencies, 50).toFixed(2)}   p95 ${percentile(latencies, 95).toFixed(2)}   p99 ${percentile(latencies, 99).toFixed(2)}`);
  console.log(`  throughput ≈ ${Math.round(latencies.length / wallSec).toLocaleString()} req/s\n`);

  try {
    const stats = await (await fetch(`${BASE}/stats`)).json();
    console.log('Server stats:');
    console.log(`  cache hit rate     : ${(stats.cache.hitRate * 100).toFixed(1)}%`);
    console.log(`  server suggest p95 : ${stats.suggest.latencyMs.p95} ms`);
    console.log(`  DB reads / writes  : ${stats.dbIO.reads} / ${stats.dbIO.writes}`);
    console.log('  per-node hits/misses:');
    for (const [id, n] of Object.entries(stats.cache.perNode)) {
      console.log(`    ${id} [${n.status}]: ${n.hits} hits / ${n.misses} misses`);
    }
  } catch (e) {
    console.warn('  (could not fetch /stats — is the server running?)');
  }
}

main();
