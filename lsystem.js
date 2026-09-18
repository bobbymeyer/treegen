// treegen/lsystem — grammar-driven structure.
//
// Standard axiom + production rules, turtle-interpreted. The one non-obvious
// decision is how the turtle maps onto a lattice.
//
// Naive approach: treat `+` and `-` as stepping through a fixed direction
// table (4/8 for square, 6 for hex). That needs a different table per
// lattice, and has nothing sensible to say about Voronoi, where every site
// has a different number of Delaunay neighbours at irregular angles.
//
// Worse, stepping neighbour-to-neighbour makes branches *staircase*: a
// heading of -75 degrees on a square lattice has no matching direction, so
// successive steps alternate between north and north-east and the branch
// zig-zags along the grid.
//
// Instead the turtle carries a real heading in degrees and `F` travels a
// whole segment along it, snapping only the **endpoint** to the lattice. The
// branch drawn between those two points is a straight line at whatever angle
// the grammar asked for. One implementation, every lattice, Voronoi
// included.
//
// Generated structure is not privileged: it lands in the same node graph as
// hand-drawn nodes, and hand edits simply diverge from it. There is no
// reverse-derivation.

import { sub, weighted, STREAMS } from './rng.js';

export const LSYSTEM_DEFAULTS = {
  axiom: 'F',
  rules: 'F -> F[+F][-F]F',
  iterations: 5,
  angle: 35,
  step: 2,          // branch segment length, in lattice spacings
  tropism: 0,       // per-segment pull back toward vertical, 0..1
  taper: 1,         // segment length multiplier per level of branching
  upOnly: true,     // branches may not aim below horizontal

  // How much a branch may depart from the grammar's exact instructions.
  // Without this every fork turns by precisely `angle` and every segment is
  // precisely `step` long, which is what makes a generated tree read as
  // drafted rather than grown. Both are seeded, so a tree is still exactly
  // reproducible — it is varied, not unpredictable.
  jitter: 35,       // 0..100, scales both of the below
  angleJitter: 20,  // degrees of turn variation at full jitter
  stepJitter: 0.45, // fraction of segment length variation at full jitter
  maxWord: 20000,   // guards against exponential blowup in reader input
  maxNodes: 900,
  growChance: 0.65,     // share of canopy tips that take each spring
  rootGrowChance: 0.3,  // roots put on growth more slowly than branches

  // Old wood does not only extend at its ends. Once a limb has matured it
  // can still break a fresh shoot from a dormant bud part-way along, between
  // one mature node and the next. `matureOrder` is the same threshold the
  // foliage rules use and is passed in by the caller rather than kept here
  // twice — with none given, nothing sprouts.
  sproutChance: 0.25,   // chance a mature node breaks a new shoot each spring
  balance: 0.8,         // how strongly growth favours the lighter side, 0..1
  growLimit: 700,       // stop growing once the tree reaches this many nodes
  rootIterations: 3,    // depth of the root system
  rootScale: 0.75,      // root segment length, relative to a branch
};

// ---------- Rule parsing ----------

// Accepts one production per line, in either `F -> ...` or `F = ...` form.
// Stochastic alternatives are separated by `|` with optional weights:
//
//   F -> 0.6 : F[+F]  |  0.4 : FF
//
// Returns { ok, rules } or { ok: false, error } — the caller shows the error
// inline rather than us throwing at a reader.
export function parseRules(text) {
  const rules = new Map();
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  for (const line of lines) {
    const m = /^(\S)\s*(?:->|=|:)\s*(.+)$/.exec(line);
    if (!m) {
      return { ok: false, error: `can't read rule: "${line}"` };
    }
    const [, symbol, body] = m;

    const alts = body.split('|').map((part) => {
      const w = /^\s*([0-9]*\.?[0-9]+)\s*:\s*(.*)$/.exec(part);
      if (w) return { weight: parseFloat(w[1]), value: w[2].trim() };
      return { weight: 1, value: part.trim() };
    });

    if (alts.some((a) => !(a.weight > 0))) {
      return { ok: false, error: `bad weight in rule for "${symbol}"` };
    }
    rules.set(symbol, alts);
  }

  if (!rules.size) return { ok: false, error: 'no rules given' };
  return { ok: true, rules };
}

// ---------- Expansion ----------

// Rewrite the axiom `iterations` times. Stops early and reports truncation
// rather than letting a reader's `F -> FFFF` at 8 iterations lock the tab.
export function expand(axiom, rules, iterations, opts = {}) {
  const cfg = { ...LSYSTEM_DEFAULTS, ...opts };
  const rng = sub(cfg.seed != null ? cfg.seed : 1, STREAMS.LSYSTEM);

  let word = String(axiom || '');
  let truncated = false;

  const n = Math.max(0, Math.min(12, iterations | 0));
  for (let step = 0; step < n; step++) {
    let out = '';
    for (const ch of word) {
      const alts = rules.get(ch);
      out += alts ? weighted(rng, alts) : ch;
      if (out.length > cfg.maxWord) {
        truncated = true;
        break;
      }
    }
    word = out;
    if (truncated) break;
  }

  return { word, truncated };
}

// ---------- Turtle ----------

// Signed smallest angle from `a` to `b`, in degrees.
function angleDelta(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// Real branches bend back toward the light as they extend. Pulling each
// heading a little toward vertical is the classic L-system tropism, and it
// is most of what separates a plausible tree from a starburst.
function applyTropism(heading, amount) {
  if (!(amount > 0)) return heading;
  return heading + angleDelta(heading, -90) * Math.min(1, amount);
}

// Keep a branch in its own half of the world: canopy above the horizon,
// roots below. Headings are clamped to the hemisphere rather than reflected,
// so a branch that would cross over runs horizontally instead of flipping.
// `axis` is -90 for up, +90 for down.
function clampHemisphere(heading, axis) {
  const d = angleDelta(axis, heading);
  if (d > 90) return axis + 90;
  if (d < -90) return axis - 90;
  return heading;
}

// Travel `distance` along `heading` and snap the landing point to the
// lattice. Only the endpoint snaps; the branch between here and there is a
// straight line.
//
// Returns null when the move fails — either it landed back on the point it
// started from (segment shorter than the lattice can express), or `nearest`
// clamped it well short of the target, which means the turtle walked off the
// edge of the world.
function stepAlong(grid, gi, heading, distance) {
  const here = grid.point(gi);
  const rad = (heading * Math.PI) / 180;
  const tx = here.x + Math.cos(rad) * distance;
  const ty = here.y + Math.sin(rad) * distance;

  const to = grid.nearest(tx, ty);
  if (to === gi) return null;

  const landed = grid.point(to);
  const drift = Math.hypot(landed.x - tx, landed.y - ty);
  if (drift > distance * 0.5) return null;

  return to;
}

// Walk the expanded word, emitting branch segments.
//
// Alphabet:
//   F  move forward one segment, drawing a straight branch
//   f  move forward without drawing
//   +  turn left by `angle`
//   -  turn right by `angle`
//   [  push position + heading
//   ]  pop position + heading
//   anything else — no-op, free for use as a rewriting symbol
//
// Returns { moves, stopped } where each move is { from, to, draw }.
// Heading starts at -90 (straight up: SVG y grows downward) unless
// `opts.heading` continues an existing branch.
export function turtle(word, grid, startGi, opts = {}) {
  const cfg = { ...LSYSTEM_DEFAULTS, ...opts };
  const moves = [];
  const stack = [];
  const base = grid.spacing * Math.max(0.5, cfg.step || 2);
  const taper = cfg.taper > 0 ? Math.min(1, cfg.taper) : 1;

  // Variation stream. Keyed by `stream` as well as seed so that growth, which
  // runs one turtle per tip, does not give every tip the identical wobble.
  const vary = Math.max(0, Math.min(100, cfg.jitter ?? 0)) / 100;
  const rng = sub(cfg.seed != null ? cfg.seed : 1,
    STREAMS.LSYSTEM + ':turtle:' + (cfg.stream || ''));
  const spread = (amount) => (vary > 0 ? (rng() * 2 - 1) * amount * vary : 0);

  // Wobble is deliberately kept *out* of the heading.
  //
  // Folding it in means every turn random-walks the branch direction, and
  // over a long main axis those steps accumulate: the trunk wanders off to
  // one side and the whole tree leans. Instead the heading holds exactly what
  // the grammar asked for, and `drift` carries the deviation — decayed each
  // step so it is pulled back rather than compounding. Branches curve; the
  // trunk stays put.
  const DRIFT_DECAY = 0.55;
  let drift = 0;

  let gi = startGi;
  // Straight up unless the caller is continuing an existing branch.
  let heading = opts.heading != null ? opts.heading : -90;
  let level = 0;                  // bracket depth: how far out on the tree
  let stopped = false;
  const visited = new Set([startGi]);

  for (const ch of word) {
    if (ch === '+') {
      heading -= cfg.angle;
    } else if (ch === '-') {
      heading += cfg.angle;
    } else if (ch === '[') {
      stack.push({ gi, heading, level, drift });
      level += 1;
    } else if (ch === ']') {
      const prev = stack.pop();
      if (prev) {
        gi = prev.gi;
        heading = prev.heading;
        level = prev.level;
        drift = prev.drift;
      }
    } else if (ch === 'F' || ch === 'f') {
      if (cfg.downOnly) heading = clampHemisphere(heading, 90);
      else if (cfg.upOnly) heading = clampHemisphere(heading, -90);

      // Bounded wobble around the grammar's heading, not a walk away from it.
      drift = drift * DRIFT_DECAY + spread(cfg.angleJitter);
      const aim = heading + drift;
      // Segments shorten as branching deepens, the way real twigs do, and
      // vary a little so no two branches march in lockstep.
      const segment = base * Math.pow(taper, level) * (1 + spread(cfg.stepJitter));
      const to = stepAlong(grid, gi, aim, segment);
      if (to == null) continue;     // ran off the lattice; ignore this move
      if (ch === 'F') moves.push({ from: gi, to, draw: true });
      visited.add(to);
      gi = to;
      heading = applyTropism(heading, cfg.tropism);
      if (visited.size > cfg.maxNodes) {
        stopped = true;
        break;
      }
    }
  }

  return { moves, stopped };
}

// ---------- Full generation ----------

// Expand, walk, and write the result into a tree rooted at `startGi`.
//
// `makeTreeAt` and `link` are injected by the caller so this module stays
// free of any dependency on tree.js's internals — the same reason the
// renderer takes an element factory.
export function generate(grid, startGi, config, hooks) {
  const cfg = { ...LSYSTEM_DEFAULTS, ...config };
  const parsed = parseRules(cfg.rules);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // Roots are the same grammar run the other way up: downward, usually
  // shallower and shorter, and never allowed to surface.
  const down = cfg.direction === 'down';
  const iterations = down ? (cfg.rootIterations ?? 3) : cfg.iterations;

  const { word, truncated } = expand(cfg.axiom, parsed.rules, iterations, cfg);
  if (!word.length) return { ok: false, error: 'axiom produced nothing' };

  const { moves, stopped } = turtle(word, grid, startGi, {
    ...cfg,
    heading: down ? 90 : (cfg.heading ?? -90),
    upOnly: !down && cfg.upOnly !== false,
    downOnly: down,
    step: down ? (cfg.step ?? 2) * (cfg.rootScale ?? 0.75) : cfg.step,
    stream: down ? 'roots' : (cfg.stream || ''),
  });
  if (!moves.length) {
    return { ok: false, error: 'no branches grew — try a larger angle or more iterations' };
  }

  if (hooks.begin) hooks.begin(startGi);
  for (const mv of moves) hooks.edge(mv.from, mv.to);

  const notes = [];
  if (truncated) notes.push('rule expansion hit the size cap');
  if (stopped) notes.push(`stopped at ${cfg.maxNodes} nodes`);

  return { ok: true, moves: moves.length, notes };
}

// ---------- Growth ----------

// How far a shoot gets before it runs into the tree it grew from.
//
// Tips grow into open air, but old wood sits in the middle of the crown where
// the lattice is already full of branch. `connectAt` refuses an edge between
// two nodes that both already carry one — that would close a loop — so a
// shoot running into existing structure gets silently dropped part-way and
// leaves the rest of itself floating unattached. Finding the collision first
// is cheaper than repairing after.
//
// What comes back is a length, not a yes/no, because a shoot that only half
// fits is still a shoot: it opens, takes what room there is, and stops. That
// is the honest answer for a crowded crown, where insisting on the whole
// word would mean almost no bud ever broke at all. Every prefix is connected
// — a move sets out from either the node the bud broke from or a point an
// earlier move in the run already made — so a truncated shoot hangs off the
// limb exactly like a complete one.
//
// Only landing points are tested; joining a fresh point to either of those
// starting places is always allowed.
function clearRun(moves, occupied) {
  const fresh = new Set();
  for (let i = 0; i < moves.length; i++) {
    const { to } = moves[i];
    if (occupied.has(to) && !fresh.has(to)) return i;
    fresh.add(to);
  }
  return moves.length;
}

// Which way a bud on old wood should break, best first.
//
// Aiming a shoot straight up is what a tree reaching for light suggests, and
// it is almost always wrong here: the limb bearing the bud is itself heading
// roughly that way, so the shoot's first step lands on the very node the limb
// carries on to and the whole thing is refused before it starts. A bud does
// not open into its own branch — it opens where there is a gap.
//
// So candidate headings across the shoot's hemisphere are ranked by angular
// clearance from the wood already leaving this node, less a mild pull back
// toward the vertical axis so that, among equally open directions, the one
// facing the light wins. The seeded nudge keeps two equally clear gaps from
// always resolving the same way. The caller walks the list until a shoot
// fits.
//
// `axis` is -90 for a canopy shoot, +90 for a root one.
function sproutHeadings(grid, m, byId, id, here, axis, rng) {
  const wood = [];
  for (const other of [m.parent.get(id), ...(m.children.get(id) || [])]) {
    const on = other ? byId.get(other) : null;
    const p = on ? grid.point(on.gi) : null;
    if (!p) continue;
    wood.push((Math.atan2(p.y - here.y, p.x - here.x) * 180) / Math.PI);
  }

  const candidates = [];
  for (let off = -75; off <= 75; off += 15) {
    const heading = axis + off;
    let clear = 180;
    for (const w of wood) clear = Math.min(clear, Math.abs(angleDelta(heading, w)));
    candidates.push({ heading, score: clear - Math.abs(off) * 0.15 + rng() * 8 });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((c) => c.heading);
}

// Germination: the first year of a seed.
//
// A seed is a single point with no edges, so it has no tips, so the tip rule
// below has nothing to work on and a planted seed would sit there for ever.
// Its first year is therefore its own rule: put up a shoot and put down a
// root, both unconditionally. Nothing is rolled for here — `growChance`
// thins a crown that already exists, and a seed that might not germinate is
// only a canvas that stays empty.
//
// The root point is also what set the horizon, so the downward run is below
// ground by construction and comes out root-scaled and dashed like any other
// root, with no special casing.
function germinate(grid, tree, word, cfg, hooks) {
  const seed = tree.nodes.find((n) => n.id === tree.rootId);
  if (!seed) return 0;

  let grown = 0;
  for (const down of [false, true]) {
    const { moves } = turtle(word, grid, seed.gi, {
      ...cfg,
      heading: down ? 90 : -90,
      stream: `${cfg.stream || ''}:germinate:${down ? 'root' : 'shoot'}`,
      upOnly: !down,
      downOnly: down,
      step: down ? (cfg.step ?? 2) * (cfg.rootScale ?? 0.75) : cfg.step,
    });
    for (const mv of moves) {
      hooks.edge(mv.from, mv.to);
      grown += 1;
    }
  }
  return grown;
}

// Extend an existing tree by one season's worth of growth.
//
// Rather than regenerating from the axiom — which would throw away the tree
// you have and hand you a different one — this applies a single production
// step at each *tip*, continuing in the direction that tip was already
// heading. Structure you drew or grew in earlier years survives untouched;
// only the ends move outward, which is how a tree actually thickens up.
//
// Tips are not the only place growth starts: mature wood can break a new
// shoot part-way along a limb — that pass runs first, below. A tree with no
// edges at all is a seed, and germinates instead.
//
// Growth is seeded, so a given year always grows the same way. `growChance`
// thins which tips take, so a tree does not double every spring.
export function extendTips(grid, tree, m, config, hooks) {
  const cfg = { ...LSYSTEM_DEFAULTS, ...config };
  const parsed = parseRules(cfg.rules);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // One production step is one year's growth.
  const { word } = expand('F', parsed.rules, 1, cfg);
  if (!word || word === 'F') {
    return { ok: false, error: 'these rules produce no new growth' };
  }

  const limit = cfg.growLimit ?? 700;
  if (tree.nodes.length >= limit) {
    return { ok: true, grown: 0, tips: 0, sprouts: 0, germinated: false, capped: true };
  }

  // Nothing joined up yet: this is a seed, and one season's growth on a seed
  // is germination rather than an extension of anything.
  if (tree.rootId && !tree.edges.length) {
    const grown = germinate(grid, tree, word, cfg, hooks);
    return { ok: true, grown, tips: 0, sprouts: 0, germinated: true, capped: false };
  }

  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  // A seeded roll per tip, so the caller decides reproducibility and this
  // decides who it applies to. Defaults to "everything grows".
  const roll = cfg.roll || (() => 0);

  // Which side of the trunk each half of the tree currently reaches further on.
  //
  // Growth picks tips at random, so without this one side out-grows the other
  // and the crown slides off the trunk — the trunk stays straight but stops
  // looking central. Favouring the lighter side pulls it back, and because the
  // correction is proportional to the imbalance it stops once balanced.
  //
  // Measured as reach, not node count: what reads as off-centre is one side
  // extending further, and a side can carry the same number of nodes while
  // stretching twice as far.
  const axis = tree.rootId && byId.get(tree.rootId)
    ? grid.point(byId.get(tree.rootId).gi)
    : null;
  const mass = { up: [0, 0], down: [0, 0] };   // [left, right] reach
  if (axis) {
    for (const n of tree.nodes) {
      const p = grid.point(n.gi);
      if (!p || p.x === axis.x) continue;
      const half = tree.horizonY != null && p.y > tree.horizonY ? mass.down : mass.up;
      const side = p.x < axis.x ? 0 : 1;
      half[side] = Math.max(half[side], Math.abs(p.x - axis.x));
    }
  }
  const leanOf = (half) => {
    const total = half[0] + half[1];
    return total ? (half[1] - half[0]) / total : 0;   // + means reaching further right
  };
  const balance = Math.max(0, Math.min(1, cfg.balance ?? 0));

  let grown = 0;
  let tips = 0;

  // Has this season used up its node budget?
  //
  // `hooks.edge` writes straight into the tree, so once anything has grown
  // its length is the exact count and the only thing worth reading. `grown`
  // is not a substitute: it counts branch segments emitted, and a segment
  // landing on a point the tree already holds adds no node — so over a full
  // season it can run at twice the nodes actually gained. Adding the two
  // together, as this used to, therefore trips the limit at around half its
  // value, and the pass that pays for that is whichever one runs second.
  //
  // A caller that only watches the moves and never writes them leaves the
  // tree flat; `grown` is the fallback there, an over-count that stops early
  // rather than never, which is the safe way for a guard to be wrong.
  const startNodes = tree.nodes.length;
  const atLimit = () =>
    (tree.nodes.length > startNodes ? tree.nodes.length : startNodes + grown) >= limit;

  // ---------- Shoots from old wood ----------
  //
  // This runs before the tips, and has to. A tree that only extends at its
  // ends hollows out: wood at `matureOrder` bears no foliage and sheds its
  // twigs, so year on year the inside of the crown empties and the canopy
  // retreats to a shell. Real trees answer that with epicormic shoots —
  // dormant buds under the bark of old wood breaking out into new leafy
  // growth part-way along a limb, rather than at its end.
  //
  // A node qualifies when it is mature *and* the wood carries on past it.
  // Strahler order never rises as you move outward, so a node's parent is at
  // least its equal and a mature node with a mature child therefore sits
  // strictly between two mature nodes — inside the zone rather than on its
  // edge. The frontier where maturity runs out is left alone: it is nearly a
  // tip already, and tips have their own rule below.
  //
  // Going first is what makes the rule mean anything. Tip growth is
  // exponential and the season's node budget is shared, so left until
  // afterwards a shoot would only ever get the scraps of a young tree and
  // nothing at all from the year the crown fills out — which is the year the
  // tree first has old wood to break from. A handful of buds cost little and
  // spring breaks them early; the tips can have what is left.
  //
  // What a shoot becomes is left to the same rules as everything else. A
  // forked one carries enough wood to outlast winter's twig cull; a single
  // strand is an order-1 twig off mature wood, which is exactly what that
  // cull takes. Weak shoots are shed and strong ones stay, without either
  // being special-cased here.
  let sprouts = 0;
  const sproutChance = Math.max(0, Math.min(1, cfg.sproutChance ?? 0));
  const matureOrder = Math.max(0, Math.floor(cfg.matureOrder) || 0);
  const sproutRoll = cfg.sproutRoll || (() => 0);

  if (sproutChance > 0 && matureOrder >= 2) {
    const occupied = new Set(tree.nodes.map((n) => n.gi));

    for (const id of m.order) {
      if (atLimit()) break;
      if (id === tree.rootId) continue;
      if ((m.strahler.get(id) || 1) < matureOrder) continue;
      const kids = m.children.get(id) || [];
      if (!kids.some((c) => (m.strahler.get(c) || 1) >= matureOrder)) continue;
      if (sproutRoll(id) >= sproutChance) continue;

      const node = byId.get(id);
      const here = node ? grid.point(node.gi) : null;
      if (!here) continue;
      const underground = tree.horizonY != null && here.y > tree.horizonY;

      // Its own named stream, so re-rolling where shoots aim disturbs nothing
      // else and no two buds on a limb open the same way.
      const aim = sub(cfg.seed != null ? cfg.seed : 1,
        STREAMS.LSYSTEM + ':sprout:' + id);

      // Take the direction that gives the shoot the longest clear run, out of
      // the openest few. Trying only a handful is the point: past that the
      // ranking has run out of gaps, and a bud with nowhere to go stays
      // dormant rather than being forced somewhere implausible.
      let taken = null;
      for (const heading of
        sproutHeadings(grid, m, byId, id, here, underground ? 90 : -90, aim).slice(0, 5)) {
        const { moves } = turtle(word, grid, node.gi, {
          ...cfg,
          heading,
          stream: id + ':sprout',
          upOnly: !underground,
          downOnly: underground,
          step: underground ? (cfg.step ?? 2) * (cfg.rootScale ?? 0.75) : cfg.step,
        });
        const run = clearRun(moves, occupied);
        if (run && (!taken || run > taken.length)) taken = moves.slice(0, run);
        if (taken && taken.length === moves.length) break;   // nothing to beat
      }
      if (!taken) continue;

      sprouts += 1;
      for (const mv of taken) {
        hooks.edge(mv.from, mv.to);
        occupied.add(mv.to);
        grown += 1;
      }
    }
  }

  // Snapshot the tips before extending any: growth adds nodes, and newly
  // grown tips — shoots included — must not grow again within the same
  // season.
  const terminals = [...m.terminal];

  for (const id of terminals) {
    if (atLimit()) break;
    if (id === tree.rootId) continue;

    const node = byId.get(id);
    if (!node) continue;
    const parentId = m.parent.get(id);
    const here = grid.point(node.gi);

    // Roots put on growth more slowly than branches, so which half of the
    // world a tip sits in decides how likely it is to take at all.
    const underground = tree.horizonY != null && here && here.y > tree.horizonY;
    let chance = underground
      ? (cfg.rootGrowChance ?? 0.3)
      : (cfg.growChance ?? 0.65);

    // Hold the crown around the trunk.
    //
    // Nudging the odds is not enough on its own: the side with more tips keeps
    // out-growing the other whatever the per-tip chance, and the drift
    // compounds year on year. So this is a limit rather than a preference — a
    // tip that already reaches further out than the far side has got to wait,
    // which bounds how lopsided the crown can become however long it grows.
    if (balance > 0 && axis && here && here.x !== axis.x) {
      const half = underground ? mass.down : mass.up;
      const side = here.x < axis.x ? 0 : 1;
      const reach = Math.abs(here.x - axis.x);
      const other = half[1 - side];
      const slack = 1 + (1 - balance) * 1.5;
      if (reach > other * slack + grid.spacing * 2) continue;

      // Within the limit, still lean toward the shorter side.
      const lean = leanOf(half);
      chance *= Math.max(0, Math.min(2, 1 - balance * lean * (side ? 1 : -1)));
    }

    if (chance <= 0 || roll(id) >= chance) continue;

    // Continue along the branch that arrived here.
    let heading = -90;
    if (parentId && byId.get(parentId)) {
      const prev = grid.point(byId.get(parentId).gi);
      if (prev && here) {
        heading = (Math.atan2(here.y - prev.y, here.x - prev.x) * 180) / Math.PI;
      }
    }

    const isRoot = underground;
    const { moves } = turtle(word, grid, node.gi, {
      ...cfg,
      heading,
      stream: id,
      upOnly: !isRoot,
      downOnly: isRoot,
      step: isRoot ? (cfg.step ?? 2) * (cfg.rootScale ?? 0.75) : cfg.step,
    });
    if (!moves.length) continue;

    tips += 1;
    for (const mv of moves) {
      hooks.edge(mv.from, mv.to);
      grown += 1;
    }
  }

  return { ok: true, grown, tips, sprouts, germinated: false, capped: atLimit() };
}
