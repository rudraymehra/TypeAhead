'use strict';

const crypto = require('crypto');

/**
 * Consistent-hash ring (Ketama-style).
 *
 * Each physical node is scattered as `vnodes` virtual points around a 0..2^32
 * ring. A key is owned by the first virtual node CLOCKWISE from hash(key).
 * Virtual nodes smooth out distribution and, crucially, mean that adding or
 * removing a node only remaps ~1/N of keys instead of nearly all of them
 * (which naive `hash % N` would do).
 */

// First 4 bytes of MD5 as a big-endian uint32 → a point on the 0..2^32 ring.
function hash32(str) {
  return crypto.createHash('md5').update(String(str)).digest().readUInt32BE(0);
}

class HashRing {
  constructor(nodeIds = [], vnodes = 150) {
    this.vnodes = vnodes;
    this.ring = []; // sorted array of { h, id }
    this.nodes = new Set();
    for (const id of nodeIds) this.addNode(id);
  }

  addNode(id) {
    if (this.nodes.has(id)) return;
    this.nodes.add(id);
    for (let i = 0; i < this.vnodes; i++) {
      this.ring.push({ h: hash32(`${id}#${i}`), id });
    }
    this.ring.sort((a, b) => a.h - b.h);
  }

  removeNode(id) {
    if (!this.nodes.has(id)) return;
    this.nodes.delete(id);
    this.ring = this.ring.filter((e) => e.id !== id);
  }

  // Owning node for a key: binary-search the first vnode with h >= hash(key),
  // wrapping back to the start of the ring when past the last point.
  getNode(key) {
    if (this.ring.length === 0) return null;
    const kh = hash32(key);
    if (kh > this.ring[this.ring.length - 1].h) return this.ring[0].id;
    let lo = 0;
    let hi = this.ring.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].h >= kh) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return this.ring[ans].id;
  }

  // Diagnostic: how many virtual nodes each physical node contributes.
  vnodeCounts() {
    const c = {};
    for (const e of this.ring) c[e.id] = (c[e.id] || 0) + 1;
    return c;
  }

  nodeIds() {
    return [...this.nodes];
  }
}

module.exports = { HashRing, hash32 };
