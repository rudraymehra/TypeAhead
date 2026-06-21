# Architecture & Design Decisions

This document explains every major design choice — the assignment requires being able
to justify each one in a viva. It is organized around the four graded areas.

---

## 1. System overview

```
                         ┌──────────────────────────────────────────┐
                         │                Browser                    │
                         │  debounce · keyboard nav · stale guard    │
                         └───────────────┬───────────────┬──────────┘
                          GET /suggest   │               │  POST /search
                                         ▼               ▼
                  ┌────────────────────────────┐   ┌──────────────────────┐
                  │   suggest.js (read path)    │   │  search.js (write)   │
                  │       cache-first           │   │     enqueue only     │
                  └──────┬───────────────┬──────┘   └──────────┬───────────┘
                         │ 1. lookup     │ 3. refill           │
                         ▼               │                     ▼
            ┌─────────────────────────┐  │          ┌──────────────────────┐
            │  cache.js  (Redis ring) │  │          │  batch.js (buffer)   │
            │  node = ring(prefix)    │  │          │  Map<query, delta>   │
            └──────────┬──────────────┘  │          └──────────┬───────────┘
              hit ▲    │ miss / down      │             flush (size≥500 / 2s)
                  │    ▼                  │                     ▼
                  │  ┌────────────────────┴─────────────────────────────────┐
                  └──┤            db.js  —  SQLite (source of truth)         │
                     │  queries(query PK, count, trend_score, last_updated) │
                     │  prefix match = PK range scan; batch = 1 transaction │
                     └──────────────────────────────────────────────────────┘
```

**Read path:** normalize prefix → check the prefix's cache node → HIT returns in
~0.5 ms; MISS computes from SQLite, refills the cache, returns.

**Write path:** normalize → enqueue into the batch buffer → return the dummy
`"Searched"` immediately. The DB never blocks a request.

---

## 2. Data modeling — why SQLite, why no trie

**Table** (`src/db.js`):

```sql
CREATE TABLE queries (
  query        TEXT    PRIMARY KEY,   -- normalized text
  count        INTEGER NOT NULL,      -- all-time popularity
  trend_score  REAL    NOT NULL,      -- lazily-decayed recency
  last_updated INTEGER NOT NULL       -- epoch ms of last touch
);
CREATE INDEX idx_count        ON queries(count DESC);
CREATE INDEX idx_last_updated ON queries(last_updated DESC);
```

**Prefix matching is a primary-key range scan**, not a trie:

```sql
WHERE query >= 'ip' AND query < 'ip￿'      -- ￿ = U+FFFF, highest code unit
ORDER BY count DESC LIMIT 10
```

Every string beginning with `ip` sorts inside `['ip', 'ip￿')`, so this rides the PK
index. Reasons this beats an in-memory trie here:

- **Durable** — counts survive restarts with no rebuild step.
- **Honest metrics** — a real DB lets us count reads/writes, which the report needs.
- **Simple & correct** — one indexed range query vs. maintaining a trie with
  per-node top-K. The reference repo that used a trie still re-ranked every match on
  the fly anyway; the range scan does the same work with less code.

Pragmas: `journal_mode=WAL` (reads proceed during a batch commit) and
`synchronous=NORMAL` (fast, and safe enough for a loss-tolerant popularity counter).

---

## 3. Distributed cache + consistent hashing  *(Basic, 60 marks)*

### Cache shape
- Key: `suggest:<mode>:<prefix>` → JSON array of the top-10 suggestions.
- TTL: **300 s** as a safety net; **explicit invalidation** on flush is the precise
  freshness mechanism.
- Three **logical** nodes. By default these are Redis DBs `0/1/2` on a single instance
  (so the grader runs one `redis-server`); pointing them at ports 6379/6380/6381
  (see `docker-compose.yml`) makes them three real servers. The ring code is identical.

### The ring (`src/ring.js`)
Ketama-style. `hash32(s)` = first 4 bytes of MD5 as a uint32 → a point on a 0…2³² ring.
Each node is placed at **150 virtual nodes** (`hash("node#i")`). A key is owned by the
first virtual node clockwise from `hash(key)`, found by binary search.

Why virtual nodes and why this matters — measured by `npm run ring-demo`:

| | 3-node distribution | keys remapped when adding a 4th node |
|---|---|---|
| **consistent hashing** | 34.4% / 32.8% / 32.8% | **23.5%** |
| naive `hash % N` | — | 74.8% |

Virtual nodes smooth the distribution; the ring guarantees only ~1/N of keys move when
the cluster changes, versus almost everything with modulo. That is the whole point of
consistent hashing for a cache: a node change shouldn't cold-start the entire cache.

### Why hash the prefix (not prefix+mode)
A prefix's `basic` and `trending` keys hash to the **same** node, so invalidating a
prefix is one node touching two keys — atomic per prefix, and the debug endpoint can
report a single owner.

---

## 4. Trending — recency-aware ranking  *(20 marks)*

The assignment asks five specific questions; here are the answers.

### a) How recent searches are tracked
Each row has a `trend_score` updated with **lazy exponential decay**. On every batch
flush, before adding the new delta we decay the stored score to *now*:

```
trend_score = trend_score · 0.5^(Δt / HALF_LIFE) + delta        (HALF_LIFE = 1 hour)
```

"Lazy" = no background timer. Decay is applied on touch and again at read time, so cost
is O(1) per touched row and reads stay cheap.

### b) How recency affects scoring
At query time we build a candidate pool — the prefix's **top-100 by count ∪ top-100 by
recency** — decay each row's recency to *now*, min-max normalize **count** and
**recency** to `[0,1]` within the pool, and blend:

```
score = α · normCount + (1 − α) · normRecency        (α = TREND_ALPHA = 0.5)
```

Normalizing inside the pool gives two very different scales (counts in the thousands,
recency in single digits) an **equal vote**. The union pool means a fresh surge that
isn't yet top-by-count can still enter contention.

### c) How a short spike avoids ranking forever
Recency decays exponentially and, once it drops below `TREND_EPSILON = 0.01`, is treated
as exactly 0 — the query reverts to its all-time-count position. `npm run trending-demo`
shows this lifecycle: a 400-search surge on "seattle" vaults it to #1, still leads after
4 half-lives (raw recency 25), then by 16 half-lives recency < ε and it falls back to #4.

### d) How the cache stays correct when rankings change
Rankings only change on a batch flush. **After** the DB commit, the flush invalidates
every affected prefix's cache keys (both modes). The next `/suggest` is a miss that
recomputes and refills. TTL is a backstop if an invalidation is ever dropped.

### e) Trade-offs (freshness vs latency vs complexity)
- Larger `α` → more stable/popularity-driven; smaller `α` → twitchier/fresher.
- Longer `HALF_LIFE` → spikes linger; shorter → they fade fast.
- Lazy decay keeps **reads** O(1) at the cost of decaying-on-read; a background sweeper
  would simplify reads but add a timer and constant churn. We chose lazy for latency.
- Invalidate-on-flush trades a brief recompute for never serving stale top-10s.

> **Intended behavior of the α=0.5 blend (viva note).** Because count is min-max
> normalized, the pool's highest-count query always contributes a full `0.5` from the
> count term. So a fresh surge on a *low-count* query competes with — but does not
> automatically dominate — an all-time-popular query: recency gets an equal vote, not an
> overriding one. A surge clearly overtakes a popular term that has *no* recent activity
> (see `trending-demo`), and ties closely when the popular term is *also* being searched.
> This is a deliberate "balanced" choice; `α` is a single knob to make ranking twitchier
> (lower `α`) if desired. The separate `/trending` panel is the **pure-recency** view and
> always surfaces the hottest queries first.

---

## 5. Batch writes  *(20 marks)*

`src/batch.js`. Searches are coalesced into `Map<query, summed delta>` and flushed when
**≥ 500 searches** are buffered **or** every **2 s**, whichever first.

### Coalescing + reduction
Searching "iphone" 200 times in a window becomes a single `+200` row write.
Measured by `npm run batch-demo` (10,000 Zipf-skewed searches over 200 queries):

```
Naive   : 10,000 upserts, 10,000 transactions
Batched :  3,273 upserts,     20 transactions
→ 3.06× fewer row writes, 500× fewer transactions
```

(Row reduction tracks the repeat rate of the workload; transaction reduction tracks
batch size — both compound to drastically less write pressure.)

### Snapshot-then-write (correctness under concurrency)
On flush we swap the buffer for a fresh `Map` **synchronously, before any `await`**, so
searches arriving mid-flush land in the new buffer and are never lost or double-counted.
The snapshot is applied in **one SQLite transaction**. Cache invalidation happens
**after** the commit, so a concurrent reader can't refill the cache with
about-to-be-stale data. If the transaction throws, the snapshot is folded back into the
buffer — no counts lost.

### Failure trade-off
This is the explicit cost of not writing synchronously:
- **Clean shutdown** (SIGINT/SIGTERM) flushes the buffer before exit → **zero loss**
  (verified: 3 pending searches were flushed on SIGTERM and persisted across restart).
- **Crash** before a flush loses only the un-flushed buffer — at most `BATCH_SIZE`
  searches / one timer window. For a popularity counter that tolerates approximate
  counts, this is an acceptable trade for removing a synchronous DB write from every
  request.

---

## 6. Graceful degradation

Every Redis call in `cache.js` is wrapped in try/catch, and the client is created with
`disableOfflineQueue: true` so commands **reject immediately** when a node is down
instead of hanging. On any cache error we count a miss and return `null`, so the read
path falls straight through to SQLite.

Startup is also resilient: because the reconnect strategy retries forever, a blocking
`client.connect()` would hang the server if Redis is down at boot. We cap the initial
connect wait (race against a 1.5 s timer) and proceed in degraded mode, while the client
keeps reconnecting in the background and flips back to "up" via the `ready` event when
Redis returns. Verified both ways: started with Redis **down**, the server boots in
`0/3 DEGRADED` mode and `/suggest` returns correct SQLite results in well under a second;
started with Redis **up**, it connects `3/3` and caches normally. The system slows; it
never breaks.

---

## 7. Frontend

`public/app.js`: input is **debounced** (180 ms, min 2 chars) to avoid a request per
keystroke; a monotonic request id is a **stale-response guard** so a slow older response
can't overwrite a newer one. Keyboard nav (↑/↓/Enter/Esc), a basic/trending toggle,
loading/error states, and live Trending + Stats panels round it out.

---

## 8. Configuration (`src/config.js`)

| key | value | role |
|---|---|---|
| `VNODES_PER_NODE` | 150 | ring smoothness |
| `CACHE_TTL_SECONDS` | 300 | cache safety net |
| `MAX_SUGGESTIONS` | 10 | results per query |
| `CANDIDATE_POOL` | 100 | trending pool size per signal |
| `TREND_HALF_LIFE_MS` | 1 h | recency decay rate |
| `TREND_ALPHA` | 0.5 | count vs recency blend |
| `TREND_EPSILON` | 0.01 | recency cutoff (anti-permanent-spike) |
| `BATCH_SIZE` | 500 | flush threshold |
| `FLUSH_INTERVAL_MS` | 2000 | flush timer |
