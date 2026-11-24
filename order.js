import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PNG} from 'pngjs';

const dir = process.argv[2] ?? '/frames';
const SIZE = 32; // thumbnails are SIZE x SIZE x RGB
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MS ?? 20000);
const t0 = Date.now();
const timeLeft = () => Date.now() - t0 < TIME_BUDGET_MS;

// Decode a PNG and box-average it down to a small RGB thumbnail.
function features(path) {
  const {width, height, data} = PNG.sync.read(readFileSync(path));
  const sums = new Float64Array(SIZE * SIZE * 3);
  const counts = new Float64Array(SIZE * SIZE);
  for (let y = 0; y < height; y++) {
    const ty = Math.min(SIZE - 1, Math.floor((y * SIZE) / height));
    for (let x = 0; x < width; x++) {
      const cell = ty * SIZE + Math.min(SIZE - 1, Math.floor((x * SIZE) / width));
      const p = (y * width + x) * 4;
      sums[cell * 3] += data[p];
      sums[cell * 3 + 1] += data[p + 1];
      sums[cell * 3 + 2] += data[p + 2];
      counts[cell]++;
    }
  }
  const out = new Float32Array(SIZE * SIZE * 3);
  for (let c = 0; c < SIZE * SIZE; c++) {
    if (!counts[c]) continue;
    for (let k = 0; k < 3; k++) out[c * 3 + k] = sums[c * 3 + k] / counts[c];
  }
  return out;
}

const names = readdirSync(dir).filter(n => n.toLowerCase().endsWith('.png')).sort();
const n = names.length;
if (n <= 2) {
  names.forEach(x => console.log(x));
  process.exit(0);
}

const feats = names.map(name => features(join(dir, name)));

// Pairwise L2 distances between thumbnails.
const D = new Float32Array(n * n);
for (let i = 0; i < n; i++) {
  for (let j = i + 1; j < n; j++) {
    let s = 0;
    const a = feats[i], b = feats[j];
    for (let k = 0; k < a.length; k++) {
      const diff = a[k] - b[k];
      s += diff * diff;
    }
    D[i * n + j] = D[j * n + i] = Math.sqrt(s);
  }
}

// Node n is a dummy with distance 0 to everything. A shortest *cycle*
// through all n+1 nodes, cut at the dummy, is a shortest open *path*.
const d = (a, b) => (a === n || b === n ? 0 : D[a * n + b]);
const m = n + 1;

// 1. Greedy nearest-neighbour paths from several starts; keep the best.
function greedyPath(start) {
  const seen = new Uint8Array(n);
  const path = [start];
  seen[start] = 1;
  let len = 0;
  for (let step = 1; step < n; step++) {
    const cur = path[path.length - 1];
    let best = -1, bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (!seen[j] && D[cur * n + j] < bestD) { bestD = D[cur * n + j]; best = j; }
    }
    seen[best] = 1;
    path.push(best);
    len += bestD;
  }
  return {path, len};
}

let bestPath = null, bestLen = Infinity;
const starts = Math.min(n, 12);
for (let s = 0; s < starts; s++) {
  const {path, len} = greedyPath(Math.floor((s * n) / starts));
  if (len < bestLen) { bestLen = len; bestPath = path; }
}
let tour = [...bestPath, n];

// 2. Local search: 2-opt and Or-opt until no improvement (or out of time).
function twoOpt() {
  let improved = false;
  for (let i = 0; i < m - 2; i++) {
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue;
      const a = tour[i], b = tour[i + 1], c = tour[j], e = tour[(j + 1) % m];
      if (d(a, c) + d(b, e) - d(a, b) - d(c, e) < -1e-6) {
        for (let l = i + 1, r = j; l < r; l++, r--) [tour[l], tour[r]] = [tour[r], tour[l]];
        improved = true;
      }
    }
    if (!timeLeft()) break;
  }
  return improved;
}

function orOpt() {
  if (m < 6) return false;
  for (let len = 1; len <= 3; len++) {
    for (let i = 1; i + len <= m; i++) {
      const prev = tour[i - 1], next = tour[(i + len) % m];
      const s0 = tour[i], s1 = tour[i + len - 1];
      const removeGain = d(prev, s0) + d(s1, next) - d(prev, next);
      let bestDelta = -1e-6, bestK = -1, bestRev = false;
      for (let k = 0; k < m; k++) {
        if (k >= i - 1 && k <= i + len - 1) continue;
        const p = tour[k], q = tour[(k + 1) % m];
        const fwd = d(p, s0) + d(s1, q) - d(p, q) - removeGain;
        const rev = d(p, s1) + d(s0, q) - d(p, q) - removeGain;
        if (fwd < bestDelta) { bestDelta = fwd; bestK = k; bestRev = false; }
        if (rev < bestDelta) { bestDelta = rev; bestK = k; bestRev = true; }
      }
      if (bestK >= 0) {
        const p = tour[bestK];
        const seg = tour.slice(i, i + len);
        if (bestRev) seg.reverse();
        const rest = tour.slice(0, i).concat(tour.slice(i + len));
        rest.splice(rest.indexOf(p) + 1, 0, ...seg);
        tour = rest;
        return true;
      }
    }
    if (!timeLeft()) return false;
  }
  return false;
}

while (timeLeft()) {
  const a = twoOpt();
  const b = timeLeft() ? orOpt() : false;
  if (!a && !b) break;
}

// 3. Cut the cycle at the dummy node to get an open path.
const at = tour.indexOf(n);
let order = tour.slice(at + 1).concat(tour.slice(0, at));

// 4. Direction. Distances can't tell forward from backward, so this is
// currently arbitrary-but-deterministic. See NOTES.md; improve it here.
if (names[order[0]] > names[order[order.length - 1]]) order.reverse();

for (const i of order) console.log(names[i]);
