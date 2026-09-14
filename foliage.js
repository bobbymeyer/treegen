// treegen/foliage — vegetation, by rule only.
//
// The hard constraint from the design: there is no per-node manual object
// choice anywhere. Every leaf, blossom and fruit comes from rules evaluated
// against the graph. Nothing in this file can be told "put a leaf here".
//
// Two things make the seasons work:
//
//   1. Stable IDs. An object's ID is derived from its node ID and slot, not
//      from iteration order. The same object persists across all four
//      seasons, so a season is a different *evaluation* of one object set
//      rather than four unrelated pictures.
//
//   2. A two-stage colour pipeline. Stage one assigns a grayscale tone from
//      graph structure, knowing nothing about palettes. Stage two maps tone
//      to an actual swatch. Autumn is not a new mechanism — it is stage two
//      re-run against a different swatch list.

import { objRng, weighted, STREAMS } from './rng.js';
import { isCanopy, trunkPath } from './tree.js';

export const SEASONS = ['spring', 'summer', 'fall', 'winter'];

// ---------- Rule configuration ----------

// The v1 placement combo: depth AND terminal/interior AND seeded probability.
// Strahler order and local crowding are the named follow-ons — `metrics()`
// already computes Strahler, so those rules are additive here.
export const FOLIAGE_DEFAULTS = {
  placement: {
    trunkBare: true,      // the trunk carries no vegetation
    trunkMinOrder: 2,     // Strahler order at which the stem stops being trunk
    minDepth: 1,          // how far off the root foliage may start
    layers: 2,            // rings of cells around each branch — canopy fullness

    // Branches mature into wood. Strahler order rises as a branch accumulates
    // growth beyond it, so it doubles as an age-and-thickness measure: a twig
    // is order 1, a limb carrying many generations is order 4. Foliage
    // retreats from the thick old wood toward the young outer growth, which is
    // what opens the inside of an ageing crown.
    //
    // At `matureOrder` and above a branch bears nothing at all; below it,
    // foliage thins in proportion. Set to 0 to switch the whole rule off.
    matureOrder: 4,
    // How far foliage is held clear of mature wood, in cells. Left at 0 by
    // default: a growing tree sheds the twigs off its thick limbs outright
    // (see pruneMatureTwigs), so the gap is structural and does not need
    // faking. Raise it to open the crown of a tree that is not growing.
    matureClear: 0,
    canopyOnly: true,     // nothing grows below the horizon

    // How a claimed ring becomes foliage.
    //
    //   'solid'   every ring inside the outermost is filled, and only the
    //             silhouette is stochastic. The canopy reads as a mass of
    //             cells with a ragged edge.
    //   'scatter' every cell rolls independently, thinning outward. Airier,
    //             but at low densities it reads as confetti rather than
    //             foliage — which is why it is no longer the default.
    fill: 'solid',
    edgeChance: 0.55,     // solid: chance a silhouette cell is kept

    // Crown silhouette.
    //
    //   'branches' the outline is whatever ringing the branches traces —
    //              fan-shaped, because branches fan.
    //   'dome'     an ellipse is fitted to the canopy and the crown fills it,
    //              so the outline is a form in its own right rather than a
    //              by-product. Cells still have to be within reach of a
    //              branch, so foliage never floats free of the tree.
    crown: 'dome',
    crownWidth: 1.06,     // ellipse radii, as a fraction of the canopy spread
    crownHeight: 1.02,
    crownReach: 2,        // extra rings a dome cell may sit from a branch
    terminalChance: 0.95, // scatter: tips are dense
    interiorChance: 0.5,  // scatter: interiors are sparser
    layerFalloff: 0.62,   // scatter: chance multiplier per ring outward
  },
  // One shape by default: mixing circles into a cell canopy is what breaks
  // the grid read. A rule can still weight between shapes.
  shape: [
    { weight: 1, value: 'cell' },
  ],
  size: {
    scale: 1,             // 1 = fill the cell exactly
  },
  tone: {
    mode: 'depth',        // 'depth' | 'strahler' | 'random'
    jitter: 0.08,         // keep tone banded by structure, not speckled
    invert: false,
  },
  blossom: {
    chance: 0.14,
    sizeScale: 0.5,       // fraction of the cell — these sit inside a leaf
  },
  fruit: {
    chance: 0.07,
    sizeScale: 0.42,
  },
};

// ---------- Palettes ----------

// Self-contained swatch lists. Ordered dark -> light within each list; tone
// indexes into that ordering, which is what makes the tone stage meaningful
// independent of which palette is active.
export const PALETTES = {
  orchard: {
    label: 'orchard',
    leaf: ['#2f5130', '#3d6b38', '#4e8547', '#68a05c', '#86b878'],
    fall: ['#8a4420', '#b06224', '#c9862f', '#ddaa46', '#ecc86a'],
    blossom: ['#d99cb4', '#e7b8c8', '#f2d4de'],
    fruit: ['#8f2118', '#b8342c', '#d4503f'],
  },
  slate: {
    label: 'slate',
    leaf: ['#22323d', '#2f4757', '#3f5e71', '#55788b', '#7295a6'],
    fall: ['#4a3a2c', '#6d5334', '#927044', '#b08f5c', '#c9ad7e'],
    blossom: ['#9aa7b5', '#b6c1cc', '#d2dae2'],
    fruit: ['#6b2230', '#8c3345', '#a9495b'],
  },
  ember: {
    label: 'ember',
    leaf: ['#3a3220', '#55492c', '#726139', '#907c4b', '#ad9a66'],
    fall: ['#6d1f14', '#95321c', '#ba5221', '#d4782b', '#e5a145'],
    blossom: ['#e0a07a', '#eebd9c', '#f7d8c1'],
    fruit: ['#5c1410', '#82221a', '#a53328'],
  },
  ink: {
    label: 'ink',
    leaf: ['#141414', '#2e2e2e', '#4a4a4a', '#6b6b6b', '#8f8f8f'],
    fall: ['#1f1f1f', '#3d3d3d', '#5c5c5c', '#7e7e7e', '#a3a3a3'],
    blossom: ['#b5b5b5', '#cfcfcf', '#e6e6e6'],
    fruit: ['#0a0a0a', '#262626', '#404040'],
  },
};

export const PALETTE_NAMES = Object.keys(PALETTES);

// Which swatch list each kind draws from, per season. This table *is* the
// autumn mechanism: leaves simply point at a different list in fall and
// winter.
const SWATCH_LIST = {
  leaf: { spring: 'leaf', summer: 'leaf', fall: 'fall', winter: 'fall' },
  blossom: { spring: 'blossom', summer: 'blossom', fall: 'blossom', winter: 'blossom' },
  fruit: { spring: 'fruit', summer: 'fruit', fall: 'fruit', winter: 'fruit' },
};

// Which kinds exist in which season. Leaves persist all year (winter is them
// falling); blossom and fruit are added on top of the existing leaf set.
const PRESENT = {
  leaf: { spring: true, summer: true, fall: true, winter: true },
  blossom: { spring: false, summer: true, fall: false, winter: false },
  fruit: { spring: false, summer: true, fall: true, winter: false },
};

export function isPresent(kind, season) {
  return !!(PRESENT[kind] && PRESENT[kind][season]);
}

// Which swatch list a kind draws from in a season. Seeding palette
// substitution off *this* rather than the season name is deliberate: spring
// and summer both read 'leaf', so a leaf keeps exactly one colour across
// both, and fall is the single visible recolouring — which is the whole
// point of the autumn mechanism.
export function listNameFor(kind, season) {
  return (SWATCH_LIST[kind] || SWATCH_LIST.leaf)[season] || 'leaf';
}

// ---------- Stage one: grayscale tone ----------

// A tone in [0, 1] derived from graph structure alone. No palette is
// consulted here, by design — the same grayscale design re-skins into any
// palette without touching this.
function toneFor(cfg, ctx, rng) {
  let base;
  if (cfg.mode === 'strahler') {
    base = ctx.maxStrahler > 1 ? (ctx.strahler - 1) / (ctx.maxStrahler - 1) : 0.5;
  } else if (cfg.mode === 'random') {
    base = rng();
  } else {
    base = ctx.maxDepth > 0 ? ctx.depth / ctx.maxDepth : 0.5;
  }
  const jittered = base + (rng() - 0.5) * 2 * (cfg.jitter || 0);
  const clamped = Math.min(1, Math.max(0, jittered));
  return cfg.invert ? 1 - clamped : clamped;
}

// ---------- Stage two: palette substitution ----------

// Map a tone onto an actual swatch. Tone picks the band; the band's
// neighbours get a minority share, which is the "tone-band X -> slot A 60% /
// B 40%" branching from the design. Reseedable independently of placement,
// so re-rolling colour never disturbs structure.
export function resolveColor(tone, kind, season, paletteName, rng) {
  const palette = PALETTES[paletteName] || PALETTES.orchard;
  const list = palette[listNameFor(kind, season)] || palette.leaf;
  if (!list.length) return '#888888';

  const band = Math.min(list.length - 1, Math.max(0, Math.floor(tone * list.length)));
  const lower = Math.max(0, band - 1);
  const upper = Math.min(list.length - 1, band + 1);

  return weighted(rng, [
    { weight: 0.6, value: list[band] },
    { weight: 0.2, value: list[lower] },
    { weight: 0.2, value: list[upper] },
  ]);
}

// Re-resolve colours for the whole object set in one season. Returns
// Map(id -> hex). Called on every season change; fall is this and nothing
// else.
export function resolveColors(objects, season, paletteName, seed) {
  const out = new Map();
  for (const obj of objects) {
    const stream = STREAMS.PALETTE + ':' + listNameFor(obj.kind, season);
    const rng = objRng(seed, obj.id, stream);
    out.set(obj.id, resolveColor(obj.tone, obj.kind, season, paletteName, rng));
  }
  return out;
}

// ---------- Object set construction ----------

// Build the year's vegetation from the graph. Deterministic in
// (seed, tree shape, rules): same inputs always give the same object set,
// with the same IDs.
//
// `seed` here is the *effective* seed — the caller folds the year in, so
// each year grows a different canopy while staying reproducible.
export function buildFoliage(doc, grid, tree, m, seed) {
  const cfg = { ...FOLIAGE_DEFAULTS, ...(doc.rules || {}) };
  const place = { ...FOLIAGE_DEFAULTS.placement, ...(cfg.placement || {}) };
  const sizeCfg = { ...FOLIAGE_DEFAULTS.size, ...(cfg.size || {}) };
  const toneCfg = { ...FOLIAGE_DEFAULTS.tone, ...(cfg.tone || {}) };
  const blossomCfg = { ...FOLIAGE_DEFAULTS.blossom, ...(cfg.blossom || {}) };
  const fruitCfg = { ...FOLIAGE_DEFAULTS.fruit, ...(cfg.fruit || {}) };
  const shapeCfg = cfg.shape || FOLIAGE_DEFAULTS.shape;

  const objects = [];
  if (!tree.nodes.length) return objects;

  let maxStrahler = 1;
  for (const v of m.strahler.values()) if (v > maxStrahler) maxStrahler = v;

  // ---- Pass one: claim cells ----
  //
  // Foliage occupies whole lattice cells, so a leaf always lands square on
  // the dot grid rather than floating near it. Each qualifying branch node
  // claims its own cell, then rings of neighbouring cells outward — `layers`
  // controls how many rings, which is the knob for canopy fullness.
  //
  // Cells are claimed by whichever node reaches them in the fewest rings, so
  // two nearby branches share a canopy instead of stacking leaves.
  const claims = new Map(); // gi -> { ring, depth, nodeId, terminal, ctx }
  const layers = Math.max(0, place.layers | 0);

  // The trunk is bare. It is the most central path through the tree, so
  // excluding it leaves the main stem reading as wood rather than disappearing
  // under its own canopy. Its cells are withheld from every other branch's
  // rings too — otherwise neighbouring foliage simply grows over it.
  //
  // Its final node is the exception: that is where the trunk stops being a
  // stem and becomes a growing tip, so it bears foliage like any other.
  const trunk = place.trunkBare
    ? trunkPath(tree, m, { minOrder: place.trunkMinOrder, grid })
    : [];
  const bareIds = trunk.slice(0, -1);
  const byNodeId = new Map(tree.nodes.map((n) => [n.id, n]));

  const trunkNodes = new Set(bareIds);
  const bareCells = new Set(
    bareIds.map((id) => (byNodeId.get(id) || {}).gi).filter((gi) => gi != null)
  );

  // Old wood is withheld the same way the trunk is, and for the same reason:
  // simply declining to *seed* foliage from a mature branch achieves nothing,
  // because its neighbouring twigs ring right over it and the crown shape
  // fills the rest. To read as wood it has to be held clear.
  const matureOrder = Math.max(0, place.matureOrder | 0);
  if (matureOrder > 1) {
    const clearBase = Math.max(0, place.matureClear | 0);
    for (const node of tree.nodes) {
      const order = m.strahler.get(node.id) || 1;
      if (order < matureOrder) continue;

      // The thicker the limb, the wider it holds the canopy off.
      const rings = clearBase + (order - matureOrder);
      bareCells.add(node.gi);
      let edge = [node.gi];
      const seen = new Set(edge);
      for (let r = 0; r < rings; r++) {
        const next = [];
        for (const gi of edge) {
          for (const nb of grid.neighbors(gi)) {
            if (seen.has(nb)) continue;
            seen.add(nb);
            bareCells.add(nb);
            next.push(nb);
          }
        }
        edge = next;
        if (!edge.length) break;
      }
    }
  }

  for (const node of tree.nodes) {
    if (trunkNodes.has(node.id)) continue;
    const depth = m.depth.get(node.id);
    if (depth == null || depth < place.minDepth) continue;
    if (place.canopyOnly && !isCanopy(tree, grid, node.id)) continue;

    // How much canopy this branch still carries, given how mature it is.
    const order = m.strahler.get(node.id) || 1;
    let reach = layers;
    if (matureOrder > 1) {
      const aged = Math.min(1, Math.max(0, (order - 1) / (matureOrder - 1)));
      reach = Math.round(layers * (1 - aged));
      if (order >= matureOrder) reach = -1;   // fully wood: bears nothing
    }
    if (reach < 0) continue;

    const terminal = m.terminal.has(node.id);
    const ctx = {
      depth,
      maxDepth: m.maxDepth,
      strahler: m.strahler.get(node.id) || 1,
      maxStrahler,
      terminal,
    };

    let frontier = [node.gi];
    const reached = new Set(frontier);

    for (let ring = 0; ring <= reach; ring++) {
      for (const gi of frontier) {
        const prev = claims.get(gi);
        // Closest ring wins; a tie goes to the tip, which should read denser.
        if (prev && (prev.ring < ring || (prev.ring === ring && prev.terminal))) continue;
        claims.set(gi, { ring, depth, nodeId: node.id, terminal, ctx });
      }
      if (ring === reach) break;

      const next = [];
      for (const gi of frontier) {
        for (const nb of grid.neighbors(gi)) {
          if (reached.has(nb)) continue;
          reached.add(nb);
          next.push(nb);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
  }

  // ---- Pass one-and-a-half: shape the crown ----
  //
  // Ringing branches gives a fan, because branches fan. To make the outline
  // a decision rather than a side effect, fit an ellipse to the canopy and
  // let that decide: cells inside it join the crown, cells outside leave it.
  // Reach keeps the result attached to the tree instead of a floating blob.
  if (place.crown === 'dome' && layers > 0 && claims.size) {
    const pts = [];
    for (const gi of claims.keys()) {
      const p = grid.point(gi);
      if (p) pts.push(p);
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rx = Math.max(grid.spacing, ((maxX - minX) / 2) * (place.crownWidth ?? 1.06));
    const ry = Math.max(grid.spacing, ((maxY - minY) / 2) * (place.crownHeight ?? 1.02));

    // How far outside the claimed set a dome cell may sit, in rings.
    const reach = Math.max(0, place.crownReach | 0);
    const frontier = new Map([...claims.keys()].map((gi) => [gi, 0]));
    let edge = [...claims.keys()];
    for (let step = 1; step <= reach; step++) {
      const next = [];
      for (const gi of edge) {
        for (const nb of grid.neighbors(gi)) {
          if (frontier.has(nb)) continue;
          frontier.set(nb, step);
          next.push(nb);
        }
      }
      edge = next;
      if (!edge.length) break;
    }

    // Ring is now radial position inside the ellipse, so the stochastic edge
    // lands on the crown's outline instead of each branch's.
    const shaped = new Map();
    for (const [gi, step] of frontier) {
      const p = grid.point(gi);
      if (!p) continue;
      const t = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      if (t > 1) continue;

      const inherited = claims.get(gi);
      const donor = inherited || nearestClaim(grid, claims, gi);
      if (!donor) continue;

      shaped.set(gi, {
        ...donor,
        // Only the outermost sliver is treated as silhouette. A wide band
        // here makes the stochastic edge eat holes through the whole crown
        // rather than break up its outline.
        ring: t > 0.93 ? layers : Math.min(layers - 1, Math.floor(t * layers)),
      });
    }
    // Union, never replace. Culling branch claims that fall outside the
    // ellipse leaves bare twigs poking through the canopy, so the dome only
    // ever adds: the silhouette is the branches plus the fitted form.
    for (const [gi, c] of shaped) {
      if (!claims.has(gi)) claims.set(gi, c);
    }
  }

  // ---- Pass two: thin the claims by rule, and dress what survives ----
  const radius = grid.cellRadius * (sizeCfg.scale ?? 1);
  const horizonY = tree.horizonY;

  for (const [gi, claim] of claims) {
    if (bareCells.has(gi)) continue;
    const point = grid.point(gi);
    if (!point) continue;
    // Outer rings can reach back under the horizon; keep the canopy above it.
    if (place.canopyOnly && horizonY != null && point.y > horizonY) continue;

    // The cell is the identity, so a leaf is stable for as long as the
    // structure is — and two branches can never double-stack one cell.
    const id = `c${gi}`;
    const rng = objRng(seed, id, STREAMS.PLACEMENT);

    // Composable AND: depth gated the node above, then the fill rule decides
    // whether this particular cell survives.
    if (place.fill === 'scatter') {
      const base = claim.terminal ? place.terminalChance : place.interiorChance;
      const chance = base * Math.pow(place.layerFalloff ?? 0.62, claim.ring);
      if (rng() >= chance) continue;
    } else if (claim.ring >= layers && layers > 0) {
      // Solid inside, ragged only at the silhouette.
      if (rng() >= (place.edgeChance ?? 0.55)) continue;
    }

    const tone = toneFor(toneCfg, claim.ctx, objRng(seed, id, STREAMS.TONE));
    const shape = weighted(rng, shapeCfg);

    const leaf = {
      id,
      nodeId: claim.nodeId,
      kind: 'leaf',
      gi,
      x: point.x,
      y: point.y,
      ring: claim.ring,
      size: radius,
      // Cell fills are drawn from the lattice's own cell path, so they must
      // not be rotated or offset — that is what keeps them on the grid.
      rot: shape === 'cell' ? 0 : rng() * 360,
      shape,
      tone,
      depth: claim.depth,
    };
    objects.push(leaf);

    // Blossom and fruit sit inside an existing leaf cell, so they never
    // appear where nothing grows.
    const extraRng = objRng(seed, id, STREAMS.PLACEMENT + ':extra');
    if (claim.terminal && extraRng() < blossomCfg.chance) {
      objects.push(derive(id, 'blossom', leaf, blossomCfg.sizeScale, extraRng, seed));
    }
    if (claim.terminal && extraRng() < fruitCfg.chance) {
      objects.push(derive(id, 'fruit', leaf, fruitCfg.sizeScale, extraRng, seed));
    }
  }

  return objects;
}

// The claim of the nearest already-claimed cell, so a cell pulled in by the
// crown shape inherits a plausible owner (and therefore depth and tone).
function nearestClaim(grid, claims, gi) {
  const seen = new Set([gi]);
  let edge = [gi];
  for (let step = 0; step < 4; step++) {
    const next = [];
    for (const cur of edge) {
      for (const nb of grid.neighbors(cur)) {
        if (seen.has(nb)) continue;
        if (claims.has(nb)) return claims.get(nb);
        seen.add(nb);
        next.push(nb);
      }
    }
    edge = next;
    if (!edge.length) break;
  }
  return null;
}

// A blossom/fruit object inside a leaf cell. Its ID stays stable for the same
// reason the leaf's does. These are fruit, not foliage, so they sit at a
// fraction of the cell rather than filling it.
function derive(baseId, kind, from, sizeScale, rng, seed) {
  const id = `${baseId}:${kind}`;
  const toneRng = objRng(seed, id, STREAMS.TONE);
  return {
    id,
    nodeId: from.nodeId,
    kind,
    gi: from.gi,
    x: from.x,
    y: from.y,
    ring: from.ring,
    size: from.size * sizeScale,
    rot: rng() * 360,
    shape: 'circle',
    tone: toneRng(),
    depth: from.depth,
  };
}

// ---------- Season evaluation ----------

// The per-season view of the object set: which objects exist, and what colour
// they are. Position and motion are animate.js's job.
export function evaluateSeason(objects, season, paletteName, seed) {
  const colors = resolveColors(objects, season, paletteName, seed);
  const visible = objects.filter((o) => isPresent(o.kind, season));
  return { season, visible, colors };
}
