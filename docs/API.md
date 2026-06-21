# API Reference

Base URL: `http://localhost:3000`. All queries and prefixes are normalized
(`trim().toLowerCase()`) before use.

---

## `GET /suggest`

Top suggestions for a prefix. Cache-first; on a miss it computes from SQLite and
refills the cache.

**Query params**

| param | required | default | notes |
|---|---|---|---|
| `q` | yes | `''` | the prefix being typed |
| `mode` | no | `trending` | `basic` = sort by all-time count; `trending` = recency-aware blend |

**Response `200`**

```json
{
  "query": "ip",
  "mode": "trending",
  "cache": "hit",
  "node": "cache-node-1",
  "count": 10,
  "suggestions": [
    { "query": "ip",   "count": 64162, "score": 0.5 },
    { "query": "ipod", "count": 36985, "score": 0.2882 }
  ]
}
```

- `cache` is `hit`, `miss`, or `skip` (empty prefix). `node` is the owning cache node.
- `score` is present only in `trending` mode.
- Empty / missing / no-match prefixes return `suggestions: []` (never an error).

---

## `POST /search`

Record a submitted search. The write is **batched** — it does not hit SQLite
synchronously; the count update appears within one batch window (~2s).

**Body**

```json
{ "query": "iphone 15" }
```

**Response `200`**

```json
{ "message": "Searched", "query": "iphone 15", "recorded": true }
```

`recorded` is `false` for an empty query.

---

## `GET /trending`

Global trending feed for the UI panel — queries with live recency, hottest first.
Falls back to all-time top when nothing has been searched yet.

**Query params:** `limit` (default 10, max 50).

**Response `200`**

```json
{
  "mode": "trending",
  "trending": [
    { "query": "iphone", "count": 56, "score": 5.999 }
  ]
}
```

`mode` is `trending` when live recency exists, else `count` (cold-start fallback).

---

## `GET /cache/debug`

Shows which cache node owns a prefix and whether it is currently cached — proves the
consistent-hashing routing.

**Query params:** `prefix` (required).

**Response `200`**

```json
{
  "prefix": "ip",
  "owner": { "id": "cache-node-1", "host": "127.0.0.1", "port": 6379, "db": 1 },
  "state": { "basic": "hit", "trending": "miss" }
}
```

`state` values: `hit`, `miss`, or `node-down` (that node is unreachable).

---

## `GET /stats`

Everything the report needs in one call.

**Response `200`**

```json
{
  "dbRows": 424183,
  "dbIO": { "reads": 23, "writes": 0 },
  "suggest": {
    "suggestRequests": 8000,
    "cacheHits": 7977, "cacheMisses": 23, "hitRate": 0.9971,
    "latencyMs": { "p50": 0.21, "p95": 0.556, "p99": 1.10, "samples": 5000 }
  },
  "cache": {
    "hitRate": 0.9971, "hits": 7977, "misses": 23, "total": 8000,
    "vnodesPerNode": 150,
    "perNode": {
      "cache-node-0": { "host": "127.0.0.1", "port": 6379, "db": 0, "status": "up", "hits": 822, "misses": 3, "vnodes": 150 }
    }
  },
  "batch": {
    "enqueued": 10000, "flushes": 20, "rowsUpserted": 3273, "prefixesInvalidated": 41000,
    "pendingSearches": 0, "pendingDistinct": 0,
    "batchSize": 500, "flushIntervalMs": 2000,
    "writeReduction": 3.06, "txnReduction": 500
  }
}
```

| field | meaning |
|---|---|
| `dbIO.reads/writes` | SQLite read/write operations counted by the app |
| `cache.hitRate` | hits / (hits + misses) across all nodes |
| `batch.writeReduction` | searches enqueued ÷ rows actually upserted |
| `batch.txnReduction` | searches enqueued ÷ flush transactions committed |
