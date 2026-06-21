'use strict';

/**
 * Dataset loader. Builds a realistic >100k-row query/count table from Peter
 * Norvig's public n-gram frequency lists (derived from the Google Web Trillion
 * Word Corpus):
 *
 *   count_1w.txt  — ~333k single words      (https://norvig.com/ngrams/count_1w.txt)
 *   count_2w.txt  — ~286k two-word phrases  (https://norvig.com/ngrams/count_2w.txt)
 *
 * We merge unigrams with the top-N bigrams, scale the (huge) raw counts down so
 * a live "+1" search is meaningful, and bulk-insert into SQLite.
 *
 * If the network is unavailable, we fall back to a synthetic Zipf-distributed
 * dataset so `npm run load-data` never hard-fails.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const db = require('../src/db');
const config = require('../src/config');
const { normalize } = require('../src/normalize');

const RAW_DIR = path.join(__dirname, '..', 'data', 'raw');

const SOURCES = {
  unigrams: { file: path.join(RAW_DIR, 'count_1w.txt'), url: 'https://norvig.com/ngrams/count_1w.txt' },
  bigrams: { file: path.join(RAW_DIR, 'count_2w.txt'), url: 'https://norvig.com/ngrams/count_2w.txt' },
};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    const out = fs.createWriteStream(tmp);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${url} → HTTP ${res.statusCode}`));
        }
        res.pipe(out);
        out.on('finish', () => out.close(() => {
          fs.renameSync(tmp, dest);
          resolve(dest);
        }));
      })
      .on('error', (err) => {
        fs.rmSync(tmp, { force: true });
        reject(err);
      });
  });
}

async function ensureFile(src) {
  if (fs.existsSync(src.file) && fs.statSync(src.file).size > 0) return true;
  process.stdout.write(`  downloading ${path.basename(src.file)} ... `);
  await download(src.url, src.file);
  console.log('done');
  return true;
}

// Norvig lines are "word<TAB>count". Returns [{ query, raw }].
function parseLines(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const query = normalize(line.slice(0, tab));
    const raw = Number(line.slice(tab + 1));
    if (query && Number.isFinite(raw) && raw > 0) rows.push({ query, raw });
  }
  return rows;
}

const scale = (raw) => Math.max(1, Math.floor(raw / config.COUNT_SCALE));

// Offline fallback: 150k Zipf-distributed pronounceable tokens.
function syntheticRows(n = 150000) {
  const syll = ['ar', 'be', 'ca', 'de', 'en', 'fa', 'go', 'hi', 'in', 'jo',
    'ka', 'lo', 'mi', 'na', 'op', 'pa', 'qu', 're', 'sa', 'ti', 'un', 'vi',
    'wo', 'xe', 'yo', 'ze'];
  const map = new Map();
  let i = 0;
  while (map.size < n) {
    i++;
    const len = 2 + (i % 3); // 2–4 syllables
    let w = '';
    let k = i;
    for (let j = 0; j < len; j++) {
      w += syll[k % syll.length];
      k = Math.floor(k / syll.length) + 1;
    }
    const raw = Math.floor(1e9 / i); // Zipf: rank 1 huge, long thin tail
    map.set(w, Math.max(map.get(w) || 0, scale(raw)));
  }
  return [...map].map(([query, count]) => ({ query, count }));
}

async function buildRows() {
  try {
    await ensureFile(SOURCES.unigrams);
    await ensureFile(SOURCES.bigrams);
  } catch (err) {
    console.warn(`\n  ⚠ could not fetch Norvig data (${err.message}).`);
    console.warn('  → falling back to synthetic Zipf dataset.\n');
    return syntheticRows();
  }

  const merged = new Map();
  const add = (query, count) => {
    const prev = merged.get(query);
    if (prev === undefined || count > prev) merged.set(query, count); // keep higher on collision
  };

  const uni = parseLines(fs.readFileSync(SOURCES.unigrams.file, 'utf8'));
  for (const { query, raw } of uni) add(query, scale(raw));

  const bi = parseLines(fs.readFileSync(SOURCES.bigrams.file, 'utf8'));
  bi.sort((a, b) => b.raw - a.raw);
  for (const { query, raw } of bi.slice(0, config.TOP_BIGRAMS)) add(query, scale(raw));

  return [...merged].map(([query, count]) => ({ query, count }));
}

async function main() {
  console.log('Loading dataset into SQLite:', config.DB_PATH);
  db.init();

  const rows = await buildRows();
  console.log(`  prepared ${rows.length.toLocaleString()} unique queries; inserting ...`);
  db.loadMany(rows);

  const total = db.rowCount();
  console.log(`✓ Loaded. Table now holds ${total.toLocaleString()} rows.`);
  if (total < 100000) {
    console.warn('  ⚠ Below the 100k minimum — check the data source.');
  }
  db.close();
}

main().catch((err) => {
  console.error('load-data failed:', err);
  process.exit(1);
});
