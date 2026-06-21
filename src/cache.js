'use strict';

const redis = require('redis');
const config = require('./config');
const { HashRing } = require('./ring');

/**
 * Distributed cache layer.
 *
 * - N logical Redis nodes (default: three DBs on one Redis instance) behind a
 *   consistent-hash ring. The PREFIX (not the mode) is hashed, so a prefix's
 *   `basic` and `trending` keys live on the SAME node → invalidation is one
 *   node hit and stays atomic per prefix.
 * - Key format: `suggest:<mode>:<prefix>` → JSON array of top-10 suggestions.
 * - GRACEFUL DEGRADATION: every Redis call is wrapped. On any error (node down,
 *   not installed, timeout) we count a miss and return null, so the read path
 *   transparently falls back to SQLite. The system never breaks — only slows.
 */

const ring = new HashRing(config.REDIS_NODES.map((n) => n.id), config.VNODES_PER_NODE);
const clients = new Map(); // id -> { client, node, ready }
const stats = {}; // id -> { hits, misses }

const keyFor = (mode, prefix) => `suggest:${mode}:${prefix}`;
const ownerId = (prefix) => ring.getNode(prefix);

async function connect() {
  await Promise.all(
    config.REDIS_NODES.map(async (node) => {
      stats[node.id] = { hits: 0, misses: 0 };
      const client = redis.createClient({
        socket: { host: node.host, port: node.port, connectTimeout: 1000, reconnectStrategy: (r) => Math.min(r * 200, 2000) },
        database: node.db,
        // Critical for graceful degradation: when a node is down, commands
        // reject IMMEDIATELY instead of queueing/hanging, so get()/set() fall
        // straight through to the SQLite path.
        disableOfflineQueue: true,
      });
      client.on('error', () => {}); // swallow: we degrade, never crash
      const entry = { client, node, ready: false };
      clients.set(node.id, entry);
      try {
        await client.connect();
        entry.ready = true;
      } catch (_) {
        entry.ready = false; // stays in degraded mode; reconnect handled by client
      }
    })
  );
  const up = [...clients.values()].filter((c) => c.ready).length;
  console.log(`Cache: ${up}/${config.REDIS_NODES.length} Redis node(s) connected` +
    (up === 0 ? ' — running in DEGRADED mode (all reads fall back to SQLite).' : '.'));
}

async function get(mode, prefix) {
  const id = ownerId(prefix);
  const entry = clients.get(id);
  try {
    const raw = await entry.client.get(keyFor(mode, prefix));
    if (raw == null) {
      stats[id].misses++;
      return null;
    }
    stats[id].hits++;
    return JSON.parse(raw);
  } catch (_) {
    stats[id].misses++; // node down → treat as miss
    return null;
  }
}

async function set(mode, prefix, suggestions) {
  const id = ownerId(prefix);
  try {
    await clients.get(id).client.set(keyFor(mode, prefix), JSON.stringify(suggestions), {
      EX: config.CACHE_TTL_SECONDS,
    });
  } catch (_) {
    /* best-effort; TTL/invalidation are backstops */
  }
}

// Delete the cached entries for a set of prefixes across both modes. Grouped by
// owning node so each node gets a single DEL.
async function invalidate(prefixes, modes = ['basic', 'trending']) {
  const byNode = new Map();
  for (const p of prefixes) {
    const id = ownerId(p);
    if (!byNode.has(id)) byNode.set(id, []);
    for (const m of modes) byNode.get(id).push(keyFor(m, p));
  }
  await Promise.all(
    [...byNode.entries()].map(async ([id, keys]) => {
      try {
        if (keys.length) await clients.get(id).client.del(keys);
      } catch (_) {
        /* TTL is the backstop */
      }
    })
  );
}

// For GET /cache/debug — which node owns a prefix, and is it currently cached?
async function debug(prefix, modes = ['basic', 'trending']) {
  const id = ownerId(prefix);
  const { node } = clients.get(id);
  const out = {
    prefix,
    owner: { id, host: node.host, port: node.port, db: node.db },
    state: {},
  };
  for (const m of modes) {
    try {
      out.state[m] = (await clients.get(id).client.exists(keyFor(m, prefix))) ? 'hit' : 'miss';
    } catch (_) {
      out.state[m] = 'node-down';
    }
  }
  return out;
}

function getStats() {
  let hits = 0;
  let misses = 0;
  const perNode = {};
  const vcounts = ring.vnodeCounts();
  for (const [id, s] of Object.entries(stats)) {
    hits += s.hits;
    misses += s.misses;
    const entry = clients.get(id);
    perNode[id] = {
      host: entry.node.host,
      port: entry.node.port,
      db: entry.node.db,
      status: entry.ready ? 'up' : 'down',
      hits: s.hits,
      misses: s.misses,
      vnodes: vcounts[id] || 0,
    };
  }
  const total = hits + misses;
  return {
    hitRate: total ? Number((hits / total).toFixed(4)) : null,
    hits,
    misses,
    total,
    vnodesPerNode: config.VNODES_PER_NODE,
    perNode,
  };
}

async function quit() {
  await Promise.all(
    [...clients.values()].map(async (e) => {
      try {
        await e.client.quit();
      } catch (_) {
        /* ignore */
      }
    })
  );
}

module.exports = { connect, get, set, invalidate, debug, getStats, quit, ownerId, ring };
