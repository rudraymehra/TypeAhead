# Performance Report

All numbers below were measured on this machine (Apple Silicon, macOS, Node 24) against
the ~424k-row Norvig dataset, with three logical Redis nodes on one instance. Reproduce
with the commands shown.

---

## 1. `/suggest` latency & cache hit rate

`npm run perf-bench` — 8,000 requests, concurrency 20, Zipf-skewed prefixes (hot
prefixes repeat, as real traffic does):

| metric | value |
|---|---|
| Cache hit rate | **99.7%** |
| Server-side suggest p95 | **0.556 ms** |
| Client-side p50 / p95 / p99 | 1.15 / 3.35 / 7.27 ms |
| Throughput | ~10,900 req/s |
| SQLite reads for 8,000 requests | **23** (only the misses) |

Per-node hits/misses confirm the ring spreads load across all three nodes:

```
cache-node-0 [up]:  822 hits / 3 misses
cache-node-1 [up]: 2614 hits / 9 misses
cache-node-2 [up]: 4541 hits / 11 misses
```

> Client-side latency is higher than server-side because it includes localhost HTTP
> round-trip and JSON parsing. The server's own read-path p95 is ~0.5 ms.

**Reading:** with a 99.7% hit rate, 7,977 of 8,000 requests were served from Redis in
~0.5 ms; only 23 ever touched SQLite. This is the cache-first design working as intended.

---

## 2. Consistent hashing

`npm run ring-demo` — 100,000 keys, 150 vnodes/node:

| | result |
|---|---|
| 3-node distribution | 34.4% / 32.8% / 32.8% |
| Keys remapped adding a 4th node — **consistent hashing** | **23.5%** |
| Keys remapped adding a 4th node — naive `hash % N` | 74.8% |

The ring keeps load even and limits churn to ~1/N on a cluster change; modulo hashing
would reshuffle three-quarters of the cache.

---

## 3. Batch write reduction

`npm run batch-demo` — 10,000 searches over 200 distinct queries (Zipf):

| approach | DB upserts | transactions |
|---|---|---|
| naive (write per search) | 10,000 | 10,000 |
| **batched** | **3,273** | **20** |

- **Row-write reduction: 3.06×** (driven by repeat coalescing)
- **Transaction reduction: 500×** (driven by `BATCH_SIZE`)

On a hotter workload (more repeats per window) row reduction climbs further; on the live
server a quick test showed 7 searches → 2 upserts (3.5×).

---

## 4. Graceful degradation (Redis down)

With Redis stopped mid-run, `/suggest` continues to return correct results from SQLite:

| state | `/suggest?q=zebra` latency | source |
|---|---|---|
| Redis up, cached | ~0.5 ms | Redis |
| Redis **down** | ~104 ms (first call) | SQLite fallback |

`disableOfflineQueue: true` makes commands reject immediately instead of hanging, so the
fallback is fast and the system never errors out.

---

## 5. Durability of batched writes (graceful shutdown)

Submitting 3 searches (held in the buffer), then `kill -TERM`:

```
SIGTERM received — flushing batch buffer ...
  flushed 3 rows, invalidated 47 prefixes.
```

After restart the new query persisted in SQLite (`alpha uniquetest → count 1`),
confirming **zero loss on clean shutdown**. A crash before flush would lose at most one
buffer window (≤ `BATCH_SIZE` searches) — the documented trade-off.

---

## How to reproduce

```bash
npm install && npm run load-data
redis-server --daemonize yes
npm start                          # terminal 1
npm run perf-bench                 # terminal 2  (or BASE=http://localhost:3100 ...)
npm run ring-demo
npm run batch-demo
npm run trending-demo
```
