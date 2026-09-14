// treegen/grid — the constrained lattice.
//
// One interface, four lattice types. Nodes may only ever sit on a lattice
// point, and a branch may only ever move to an adjacent one. Everything
// downstream (drawing, dragging, L-system turtle moves, grid switching) goes
// through this interface and never touches raw coordinates.
//
// Square is implemented here. Hex, triangle and Voronoi register into the
// same table — see LATTICES at the bottom.
//
// Coordinates are SVG user units, so y grows *downward*. The horizon is a y
// value: smaller y is canopy, larger y is roots.

// ---------- Shared helpers ----------

// Squared distance — comparisons don't need the sqrt.
function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

// Brute-force nearest point. Fine for the irregular lattices at the sizes we
// draw (a few thousand sites); the regular lattices override this with
// analytic arithmetic instead.
function nearestByScan(points, x, y) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = dist2(x, y, points[i].x, points[i].y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// Build an SVG path from a ring of [x, y] pairs.
function ringPath(ring) {
  if (!ring.length) return '';
  let d = `M${ring[0][0].toFixed(2)},${ring[0][1].toFixed(2)}`;
  for (let i = 1; i < ring.length; i++) {
    d += `L${ring[i][0].toFixed(2)},${ring[i][1].toFixed(2)}`;
  }
  return d + 'Z';
}

// ---------- Square ----------

// Axis-aligned points at `spacing` intervals. Adjacency is 8-way by default:
// diagonals give branches enough freedom to read as a tree rather than a
// plumbing diagram. Set `diagonals: false` for strict 4-way.
function buildSquare(opts) {
  const { width, height, spacing } = opts;
  const diagonals = opts.diagonals !== false;

  const cols = Math.max(2, Math.floor(width / spacing) + 1);
  const rows = Math.max(2, Math.floor(height / spacing) + 1);

  // Centre the lattice in the viewport so the drawing area isn't lopsided.
  const ox = (width - (cols - 1) * spacing) / 2;
  const oy = (height - (rows - 1) * spacing) / 2;

  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push({ i: r * cols + c, x: ox + c * spacing, y: oy + r * spacing });
    }
  }

  const colOf = (i) => i % cols;
  const rowOf = (i) => Math.floor(i / cols);

  const OFFSETS_4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const OFFSETS_8 = OFFSETS_4.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
  const offsets = diagonals ? OFFSETS_8 : OFFSETS_4;

  return {
    points,

    neighbors(i) {
      const c = colOf(i);
      const r = rowOf(i);
      const out = [];
      for (const [dc, dr] of offsets) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        out.push(nr * cols + nc);
      }
      return out;
    },

    // The square cell centred on the point — used by cell-shaped fills.
    cellPath(i) {
      const p = points[i];
      const h = spacing / 2;
      return ringPath([
        [p.x - h, p.y - h],
        [p.x + h, p.y - h],
        [p.x + h, p.y + h],
        [p.x - h, p.y + h],
      ]);
    },

    // Analytic: round to the nearest column and row, then clamp.
    nearest(x, y) {
      const c = Math.min(cols - 1, Math.max(0, Math.round((x - ox) / spacing)));
      const r = Math.min(rows - 1, Math.max(0, Math.round((y - oy) / spacing)));
      return r * cols + c;
    },

    cellRadius: spacing / 2,
    meta: { cols, rows, ox, oy },
  };
}

// ---------- Hex ----------

// Pointy-top hexagons in an odd-r offset layout. Points are cell *centres*,
// adjacency is the 6 edge-sharing neighbours, and the cell is the hexagon
// itself.
function buildHex(opts) {
  const { width, height } = opts;
  const s = opts.spacing * 0.62;          // circumradius
  const hexW = Math.sqrt(3) * s;
  const rowH = 1.5 * s;

  const cols = Math.max(2, Math.floor((width - hexW / 2) / hexW));
  const rows = Math.max(2, Math.floor((height - s) / rowH));

  const ox = (width - (cols - 1) * hexW - hexW / 2) / 2 + hexW / 2;
  const oy = (height - (rows - 1) * rowH) / 2;

  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push({
        i: r * cols + c,
        x: ox + c * hexW + (r % 2 ? hexW / 2 : 0),
        y: oy + r * rowH,
      });
    }
  }

  const colOf = (i) => i % cols;
  const rowOf = (i) => Math.floor(i / cols);

  // odd-r offset: odd rows sit half a cell to the right, so the diagonal
  // neighbour columns differ by row parity.
  const EVEN = [[-1, 0], [1, 0], [-1, -1], [0, -1], [-1, 1], [0, 1]];
  const ODD = [[-1, 0], [1, 0], [0, -1], [1, -1], [0, 1], [1, 1]];

  return {
    points,

    neighbors(i) {
      const c = colOf(i);
      const r = rowOf(i);
      const out = [];
      for (const [dc, dr] of r % 2 ? ODD : EVEN) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        out.push(nr * cols + nc);
      }
      return out;
    },

    cellPath(i) {
      const p = points[i];
      const ring = [];
      for (let k = 0; k < 6; k++) {
        const a = ((60 * k + 30) * Math.PI) / 180;
        ring.push([p.x + s * Math.cos(a), p.y + s * Math.sin(a)]);
      }
      return ringPath(ring);
    },

    cellRadius: (s * Math.sqrt(3)) / 2,
    meta: { cols, rows, s },
  };
}

// ---------- Triangle ----------

// Triangle *centroids*, not vertices — which keeps this lattice genuinely
// distinct from hex. (Hexagon centres already form a triangular lattice of
// points, so centre-based hex and vertex-based triangle would be the same
// graph wearing different clothes.) Here each cell has exactly 3 edge
// neighbours, and the cell really is a triangle.
//
// Cell (r, k) points up when (k + r) is even. x0 = ox + k*(s/2), so a cell
// and the cell directly below it in the next row share a full edge.
function buildTriangle(opts) {
  const { width, height } = opts;
  const s = opts.spacing * 1.15;          // side length
  const h = (s * Math.sqrt(3)) / 2;       // row height

  const cols = Math.max(3, Math.floor((width - s) / (s / 2)));
  const rows = Math.max(2, Math.floor(height / h));

  const ox = (width - ((cols - 1) * s) / 2 - s) / 2;
  const oy = (height - rows * h) / 2;

  const isUp = (r, k) => (k + r) % 2 === 0;
  const x0Of = (k) => ox + k * (s / 2);
  const yTopOf = (r) => oy + r * h;

  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const x0 = x0Of(k);
      const yTop = yTopOf(r);
      points.push({
        i: r * cols + k,
        x: x0 + s / 2,
        // Centroid sits two-thirds of the way from the apex to the base.
        y: isUp(r, k) ? yTop + (2 * h) / 3 : yTop + h / 3,
      });
    }
  }

  const colOf = (i) => i % cols;
  const rowOf = (i) => Math.floor(i / cols);

  return {
    points,

    neighbors(i) {
      const k = colOf(i);
      const r = rowOf(i);
      const out = [];
      if (k > 0) out.push(r * cols + (k - 1));
      if (k < cols - 1) out.push(r * cols + (k + 1));
      // An up triangle's base is its bottom edge; a down triangle's base is
      // its top edge. That is the only vertical neighbour either one has.
      if (isUp(r, k)) {
        if (r < rows - 1) out.push((r + 1) * cols + k);
      } else if (r > 0) {
        out.push((r - 1) * cols + k);
      }
      return out;
    },

    cellPath(i) {
      const k = colOf(i);
      const r = rowOf(i);
      const x0 = x0Of(k);
      const yTop = yTopOf(r);
      const yBot = yTop + h;
      return isUp(r, k)
        ? ringPath([[x0, yBot], [x0 + s, yBot], [x0 + s / 2, yTop]])
        : ringPath([[x0, yTop], [x0 + s, yTop], [x0 + s / 2, yBot]]);
    },

    cellRadius: s / (2 * Math.sqrt(3)),
    meta: { cols, rows, s, h },
  };
}

// ---------- Voronoi ----------

// Seeded Poisson-disc sampling (Bridson). Same seed, same sites, every time.
function poissonDisc(width, height, radius, rand, tries = 24) {
  const cell = radius / Math.SQRT2;
  const gw = Math.ceil(width / cell);
  const gh = Math.ceil(height / cell);
  const gridIdx = new Int32Array(gw * gh).fill(-1);
  const samples = [];
  const active = [];

  const put = (p) => {
    const gx = Math.min(gw - 1, Math.floor(p.x / cell));
    const gy = Math.min(gh - 1, Math.floor(p.y / cell));
    gridIdx[gy * gw + gx] = samples.length;
    samples.push(p);
    active.push(samples.length - 1);
  };

  const fits = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const gx = Math.min(gw - 1, Math.floor(x / cell));
    const gy = Math.min(gh - 1, Math.floor(y / cell));
    for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2); yy++) {
      for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) {
        const s = gridIdx[yy * gw + xx];
        if (s === -1) continue;
        if (dist2(x, y, samples[s].x, samples[s].y) < radius * radius) return false;
      }
    }
    return true;
  };

  put({ x: width / 2, y: height / 2 });

  while (active.length) {
    const ai = Math.floor(rand() * active.length);
    const origin = samples[active[ai]];
    let placed = false;
    for (let t = 0; t < tries; t++) {
      const a = rand() * Math.PI * 2;
      const d = radius * (1 + rand());
      const x = origin.x + Math.cos(a) * d;
      const y = origin.y + Math.sin(a) * d;
      if (!fits(x, y)) continue;
      put({ x, y });
      placed = true;
      break;
    }
    if (!placed) active.splice(ai, 1);
  }

  return samples;
}

// Circumcentre of a triangle, plus its squared circumradius.
function circumcircle(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x: ux, y: uy, r2: dist2(ux, uy, a.x, a.y) };
}

// Bowyer–Watson Delaunay triangulation. Returns triangles as index triples
// into `pts`. This is the piece that gives Voronoi both its adjacency (the
// Delaunay dual, as the design requires) and its cell polygons.
export function delaunay(pts) {
  if (pts.length < 3) return [];

  // A super-triangle comfortably containing every point.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const dmax = Math.max(dx, dy) * 20;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  const work = pts.slice();
  const s0 = work.length;
  work.push({ x: midX - dmax, y: midY - dmax });
  work.push({ x: midX + dmax, y: midY - dmax });
  work.push({ x: midX, y: midY + dmax });

  let tris = [{ a: s0, b: s0 + 1, c: s0 + 2, cc: null }];
  tris[0].cc = circumcircle(work[s0], work[s0 + 1], work[s0 + 2]);

  for (let i = 0; i < s0; i++) {
    const p = work[i];
    const edges = [];
    const keep = [];

    for (const t of tris) {
      if (t.cc && dist2(p.x, p.y, t.cc.x, t.cc.y) < t.cc.r2) {
        edges.push([t.a, t.b], [t.b, t.c], [t.c, t.a]);
      } else {
        keep.push(t);
      }
    }

    // Edges shared by two bad triangles are interior; only the boundary
    // of the cavity gets re-triangulated against p.
    for (let e = 0; e < edges.length; e++) {
      if (!edges[e]) continue;
      for (let f = e + 1; f < edges.length; f++) {
        if (!edges[f]) continue;
        if (
          (edges[e][0] === edges[f][1] && edges[e][1] === edges[f][0]) ||
          (edges[e][0] === edges[f][0] && edges[e][1] === edges[f][1])
        ) {
          edges[e] = null;
          edges[f] = null;
          break;
        }
      }
    }

    for (const edge of edges) {
      if (!edge) continue;
      const cc = circumcircle(work[edge[0]], work[edge[1]], p);
      if (!cc) continue;
      keep.push({ a: edge[0], b: edge[1], c: i, cc });
    }
    tris = keep;
  }

  // Drop anything still touching the super-triangle.
  return tris
    .filter((t) => t.a < s0 && t.b < s0 && t.c < s0)
    .map((t) => ({ a: t.a, b: t.b, c: t.c, cc: t.cc }));
}

// Voronoi lattice: Poisson-disc sites, Delaunay adjacency, dual cells.
function buildVoronoi(opts) {
  const { width, height, seed } = opts;
  const rand = makeSeededRand(seed);
  const sites = poissonDisc(width, height, opts.spacing * 0.95, rand);

  const points = sites.map((p, i) => ({ i, x: p.x, y: p.y }));
  const tris = delaunay(points);

  // Adjacency = Delaunay edges. A branch may move only to a Delaunay
  // neighbour, exactly as specified.
  const adj = points.map(() => new Set());
  const around = points.map(() => []);
  for (const t of tris) {
    adj[t.a].add(t.b); adj[t.a].add(t.c);
    adj[t.b].add(t.a); adj[t.b].add(t.c);
    adj[t.c].add(t.a); adj[t.c].add(t.b);
    if (t.cc) {
      around[t.a].push(t.cc);
      around[t.b].push(t.cc);
      around[t.c].push(t.cc);
    }
  }

  const neighborLists = adj.map((s) => [...s]);

  // Cell polygon: the circumcentres of the triangles incident to this site,
  // sorted by angle. Circumcentres are clamped to the viewport rather than
  // properly clipped — boundary cells are therefore approximate, which is
  // acceptable for a fill shape and keeps this from needing a clipper.
  const cellPaths = points.map((p, i) => {
    const cs = around[i];
    if (cs.length < 3) return '';
    const ring = cs
      .map((c) => ({
        x: Math.min(width, Math.max(0, c.x)),
        y: Math.min(height, Math.max(0, c.y)),
      }))
      .map((c) => ({ ...c, a: Math.atan2(c.y - p.y, c.x - p.x) }))
      .sort((m, n) => m.a - n.a)
      .map((c) => [c.x, c.y]);
    return ringPath(ring);
  });

  return {
    points,
    neighbors: (i) => neighborLists[i] || [],
    cellPath: (i) => cellPaths[i] || '',
    cellRadius: opts.spacing * 0.45,
    meta: { sites: points.length, triangles: tris.length },
  };
}

// A tiny local copy of mulberry32 so grid.js stays importable on its own.
function makeSeededRand(seed) {
  let s = (seed | 0) >>> 0 || 1;
  return function rand() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Registry ----------

const LATTICES = {
  square: buildSquare,
  hex: buildHex,
  triangle: buildTriangle,
  voronoi: buildVoronoi,
};

export const GRID_TYPES = Object.keys(LATTICES);

export const GRID_DEFAULTS = {
  type: 'square',
  width: 900,
  height: 600,
  spacing: 30,
  seed: 1,
};

// Build a grid. The returned object is immutable as far as callers are
// concerned — changing the type or spacing means building a new one.
export function makeGrid(opts = {}) {
  const cfg = { ...GRID_DEFAULTS, ...opts };
  const build = LATTICES[cfg.type];
  if (!build) throw new Error(`treegen: unknown grid type "${cfg.type}"`);

  const impl = build(cfg);

  return {
    type: cfg.type,
    width: cfg.width,
    height: cfg.height,
    spacing: cfg.spacing,
    seed: cfg.seed,

    points: impl.points,
    count: impl.points.length,

    // Inradius of a cell — what "full cell size" means on this lattice.
    cellRadius: impl.cellRadius || cfg.spacing / 2,

    point: (i) => impl.points[i],
    neighbors: (i) => impl.neighbors(i),
    cellPath: (i) => impl.cellPath(i),
    nearest: impl.nearest || ((x, y) => nearestByScan(impl.points, x, y)),

    // True when b is a legal single move from a.
    adjacent(a, b) {
      return impl.neighbors(a).indexOf(b) !== -1;
    },

    meta: impl.meta || {},
  };
}

export { ringPath, dist2, nearestByScan };
