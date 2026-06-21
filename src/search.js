'use strict';

const batch = require('./batch');
const { normalize } = require('./normalize');

/**
 * Write path. A submitted search is normalized and ENQUEUED into the batch
 * buffer — we never write to SQLite synchronously on the request. The dummy
 * "Searched" response returns immediately; the count update (and any new-query
 * insert) is applied on the next batch flush and then reflected in suggestions
 * and trending. Returns the normalized query so the caller can echo it.
 */
function recordSearch(rawQuery) {
  const query = normalize(rawQuery);
  if (!query) return { recorded: false, query: '' };
  batch.enqueue(query);
  return { recorded: true, query };
}

module.exports = { recordSearch };
