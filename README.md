# Search Typeahead

A distributed, low-latency search autocomplete system: as you type, it returns the
top-10 popular queries matching your prefix; submitting a search updates popularity.
Built for the **[SST-2028] HLD101 — Search Typeahead** assignment.

It demonstrates the four things the assignment grades:

- **Distributed cache + consistent hashing** — prefix → top-10 results cached across
  three logical Redis nodes, routed by a Ketama-style hash ring.
- **Recency-aware trending** — a lazily-decayed recency score blended with all-time
  popularity, so fresh surges surface without ranking forever.
- **Batched writes** — searches are buffered and coalesced, turning thousands of
  per-request writes into a handful of transactions.
- **Graceful degradation** — if Redis is down, every lookup falls back to SQLite; the
  system slows but never breaks.

---

## Architecture at a glance

```
Browser (public/) ──debounced──▶ GET /suggest?q=&mode=
                                     │
                             suggest.js (cache-first)
                                     │
                   ┌──── cache.js (Redis ring) ──hit──▶ top-10 JSON  (~0.5 ms)
                   │ miss / Redis down
                   ▼
                 db.js (SQLite PK range-scan) ──▶ rank ──▶ refill cache

Browser ──▶ POST /search ──▶ search.js ──▶ batch.js  (Map<query,delta> buffer)
                                                │ flush on size≥500 or every 2s
                                                ▼
                                     SQLite txn (count+trend) → invalidate prefixes
```

- **Source of truth:** SQLite (`better-sqlite3`). Prefix matching is a primary-key
  **range scan** (`query >= 'ip' AND query < 'ip￿'`) — no trie needed, durable
  across restarts, and it lets us count DB reads/writes for the report.
- **Cache:** three logical Redis nodes (default: DBs `0/1/2` on one Redis instance)
  behind a consistent-hash ring. Hashing the **prefix** keeps a prefix's `basic` and
  `trending` keys co-located so invalidation is one atomic node hit.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and every
trade-off, [`docs/API.md`](docs/API.md) for the endpoint reference, and
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) for measured numbers.

---

## Requirements

- **Node.js ≥ 18**
- **Redis** (optional but recommended). Without it the app still runs — fully degraded
  to SQLite. Install via `brew install redis` / `apt install redis-server`, or use the
  bundled `docker-compose.yml`.

## Setup

```bash
npm install          # installs express, better-sqlite3, redis
npm run load-data    # downloads Norvig n-gram lists → SQLite (~424k rows)
```

`load-data` pulls Peter Norvig's public word/phrase frequency lists
(`count_1w.txt` + top 100k of `count_2w.txt`) and scales the counts. If the network is
unavailable it falls back to a synthetic Zipf dataset, so seeding never hard-fails.

## Run

```bash
# start a single Redis (any one of these)
redis-server --daemonize yes        # local install
npm run redis:up                    # OR three real Redis nodes via Docker

npm start                           # → http://localhost:3000
```

Open **http://localhost:3000**, start typing, and submit searches. The Trending and
Live-stats panels update every few seconds.

> If port 3000 is taken, run `PORT=3100 npm start`.

---

## Dataset

| | |
|---|---|
| Source | [norvig.com/ngrams](https://norvig.com/ngrams/) — `count_1w.txt`, `count_2w.txt` (Google Web Trillion Word Corpus) |
| Format | `query<TAB>count`, aggregated to `query,count` |
| Size | **~424,000 rows** (well past the 100k minimum) |
| Loading | `npm run load-data` (offline Zipf fallback built in) |

---

## Demos & benchmarks

| Command | What it shows |
|---|---|
| `npm run ring-demo` | Key distribution across nodes + % remapped when adding a node (consistent vs naive modulo) |
| `npm run trending-demo` | Basic vs recency-aware ranking; a surge leads, then decays back |
| `npm run batch-demo` | Write reduction: searches → DB upserts / transactions |
| `npm run perf-bench` | `/suggest` p50/p95/p99 latency + cache hit rate (needs a running server) |

---

## API summary

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/suggest?q=<prefix>&mode=basic\|trending` | Up to 10 suggestions |
| `POST` | `/search` `{ "query": "..." }` | Record a search (dummy `"Searched"` response) |
| `GET` | `/trending?limit=N` | Global trending feed |
| `GET` | `/cache/debug?prefix=<p>` | Which cache node owns a prefix + hit/miss |
| `GET` | `/stats` | DB rows + I/O, cache hit rate, latency, batch write-reduction |

Full request/response shapes in [`docs/API.md`](docs/API.md).

---

## Project layout

```
src/
  config.js      all tunables (vnodes, TTL, batch size, α, half-life)
  normalize.js   lowercase + trim
  db.js          SQLite schema, prefix range-scan, batch transaction
  ring.js        consistent-hash ring (MD5, virtual nodes, binary search)
  cache.js       Redis logical nodes, degrade-on-failure, debug, stats
  suggest.js     cache-first read path
  trending.js    lazy exponential decay + count/recency blend
  batch.js       buffer, snapshot-then-flush, graceful flush
  search.js      write path → enqueue
  metrics.js     latency percentiles + hit-rate counters
  server.js      Express routes + graceful shutdown
scripts/         load-data + the four demos/benchmarks
public/          index.html, style.css, app.js (debounce, keyboard nav, panels)
docs/            ARCHITECTURE.md, API.md, PERFORMANCE.md
```
