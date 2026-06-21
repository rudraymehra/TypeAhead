'use strict';

/**
 * Canonical text normalization for every query and prefix.
 * Lowercasing + trimming makes matching case-insensitive and collapses
 * accidental whitespace, so "  iPhone " and "iphone" hit the same row/cache key.
 */
function normalize(input) {
  if (input == null) return '';
  return String(input).trim().toLowerCase();
}

module.exports = { normalize };
