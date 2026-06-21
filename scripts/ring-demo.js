'use strict';

/**
 * Demonstrates the two properties consistent hashing buys us:
 *   1. EVEN distribution of keys across nodes (thanks to virtual nodes).
 *   2. MINIMAL remap when the cluster changes — only ~1/N of keys move when a
 *      node is added, versus ~all of them with naive `hash % N`.
 *
 * Run: npm run ring-demo
 */

const crypto = require('crypto');
const { HashRing } = require('../src/ring');
const config = require('../src/config');

const KEYS = 100000;
const keys = Array.from({ length: KEYS }, (_, i) => `prefix-${i}`);

function distribution(ring) {
  const counts = {};
  for (const k of keys) {
    const n = ring.getNode(k);
    counts[n] = (counts[n] || 0) + 1;
  }
  return counts;
}

function naiveMod(key, n) {
  return crypto.createHash('md5').update(key).digest().readUInt32BE(0) % n;
}

console.log(`Consistent-hash ring demo — ${KEYS.toLocaleString()} keys, ${config.VNODES_PER_NODE} vnodes/node\n`);

// --- 3 nodes: distribution ---
const ids3 = ['cache-node-0', 'cache-node-1', 'cache-node-2'];
const ring3 = new HashRing(ids3, config.VNODES_PER_NODE);
const dist3 = distribution(ring3);

console.log('Distribution across 3 nodes:');
for (const id of ids3) {
  const c = dist3[id] || 0;
  console.log(`  ${id}: ${c.toLocaleString().padStart(7)}  (${((c / KEYS) * 100).toFixed(1)}%)`);
}

// --- add a 4th node: how many keys move? ---
const before = new Map(keys.map((k) => [k, ring3.getNode(k)]));
const ring4 = new HashRing([...ids3, 'cache-node-3'], config.VNODES_PER_NODE);
let movedConsistent = 0;
for (const k of keys) if (ring4.getNode(k) !== before.get(k)) movedConsistent++;

// --- naive modulo for comparison ---
let movedNaive = 0;
for (const k of keys) if (naiveMod(k, 4) !== naiveMod(k, 3)) movedNaive++;

console.log('\nAdding a 4th node — keys remapped:');
console.log(`  consistent hashing : ${movedConsistent.toLocaleString()} (${((movedConsistent / KEYS) * 100).toFixed(1)}%)`);
console.log(`  naive  hash % N     : ${movedNaive.toLocaleString()} (${((movedNaive / KEYS) * 100).toFixed(1)}%)`);
console.log(`\n→ Consistent hashing moves ~1/N of keys; modulo reshuffles almost everything.`);
