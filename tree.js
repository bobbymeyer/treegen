// treegen/tree — the node graph.
//
// A tree is nodes (each pinned to a lattice point) plus edges. **Only the
// points snap to the grid.** An edge is a straight segment between two of
// them and may span any distance at any angle — it is not walked along the
// lattice. Branches therefore read as clean lines rather than staircases.
//
// Node IDs are stable strings that survive dragging, re-snapping and grid
// switches; only the lattice index `gi` changes. Foliage hangs off node
// positions, so this stability is what keeps a canopy attached to its branch
// across every edit.
//
// The metrics at the bottom — depth, terminal, Strahler order — are all
// derived from graph shape alone. That is deliberate: they work identically
// on a hand-drawn tree and a generated one, which is the whole reason the
// vegetation rules key off them.

// ---------- Construction ----------

export function makeTree() {
  return {
    nodes: [],        // [{ id, gi }]
    edges: [],        // [[idA, idB]]
    rootId: null,
    horizonY: null,   // set by the first placed point
    nextId: 0,
  };
}

function newNode(tree, gi) {
  const node = { id: `n${tree.nextId++}`, gi };
  tree.nodes.push(node);
  return node;
}

export function nodeById(tree, id) {
  return tree.nodes.find((n) => n.id === id) || null;
}

export function nodeAt(tree, gi) {
  return tree.nodes.find((n) => n.gi === gi) || null;
}

// Join two nodes, but only if the result is still a tree.
//
// A branch attaches to exactly one node upstream. The l-system walks a lattice
// and regularly revisits a point it has already used; linking there again
// would give that node a second parent and close a loop, and the structure
// would stop being a tree — depth, Strahler order and the trunk path all
// assume it is one.
//
// Since the structure is always grown outward from the root, it is connected,
// and an edge between two nodes that both already have branches is exactly a
// loop. That makes the check a degree test rather than a graph search.
function linkNodes(tree, a, b) {
  if (a === b) return false;

  let degA = 0;
  let degB = 0;
  for (const [x, y] of tree.edges) {
    if (x === a || y === a) degA += 1;
    if (x === b || y === b) degB += 1;
    // Already joined; nothing to do.
    if ((x === a && y === b) || (x === b && y === a)) return false;
  }
  if (degA > 0 && degB > 0) return false;   // would close a loop

  tree.edges.push([a, b]);
  return true;
}

// ---------- Editing ----------

// Ensure a node exists at `gi`, without connecting it to anything.
//
// The first point is special: it becomes the root *and* sets the horizon.
// Everything above that y is canopy, everything below is roots.
function ensureNode(tree, grid, gi) {
  const existing = nodeAt(tree, gi);
  if (existing) return existing;

  const node = newNode(tree, gi);
  if (tree.nodes.length === 1) {
    tree.rootId = node.id;
    tree.horizonY = grid.point(gi).y;
  }
  return node;
}

// Place a node at lattice index `gi` and join it to the nearest existing one
// with a single straight branch.
//
// No intermediate nodes are inserted. Clicking somewhere distant gives one
// long branch, not a staircase of lattice steps — the point snaps to the
// grid, the line between points does not.
export function addNodeAt(tree, grid, gi) {
  const existing = nodeAt(tree, gi);
  if (existing) return existing;

  // Resolve the attachment before creating the node, or it would find itself.
  const from = tree.nodes.length ? nearestNode(tree, grid, gi) : null;
  const node = ensureNode(tree, grid, gi);
  if (from) linkNodes(tree, from.id, node.id);
  return node;
}

// Join two lattice points with one straight branch, creating either endpoint
// if it doesn't exist yet. This is what the L-system emits per segment.
export function connectAt(tree, grid, fromGi, toGi) {
  if (fromGi === toGi) return ensureNode(tree, grid, fromGi);
  const a = ensureNode(tree, grid, fromGi);
  const b = ensureNode(tree, grid, toGi);
  linkNodes(tree, a.id, b.id);
  return b;
}

// Nearest existing node to a lattice point, by straight-line distance.
export function nearestNode(tree, grid, gi) {
  const target = grid.point(gi);
  let best = null;
  let bestD = Infinity;
  for (const n of tree.nodes) {
    const p = grid.point(n.gi);
    const dx = p.x - target.x;
    const dy = p.y - target.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

// Work out where a drag would put everything.
//
// Dragging a node takes the whole limb with it: the node and everything
// downstream keep their shape and shift together. Moving the node alone would
// stretch the branch above it and leave its children behind, which is not what
// grabbing a branch means.
//
// The subtree translates by the same world-space delta and each member
// re-snaps to the lattice, so shape is preserved as closely as the grid
// allows. Returns { ok, targets } without touching the tree.
export function planBranchMove(tree, grid, id, gi) {
  const node = nodeById(tree, id);
  if (!node) return { ok: false, targets: null };
  if (node.gi === gi) return { ok: true, targets: new Map() };

  const from = grid.point(node.gi);
  const to = grid.point(gi);
  if (!from || !to) return { ok: false, targets: null };
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  const moving = twigNodes(tree, [id]);
  const parked = new Set(
    tree.nodes.filter((n) => !moving.has(n.id)).map((n) => n.gi)
  );

  const targets = new Map();
  const taken = new Set();
  for (const mid of moving) {
    const n = nodeById(tree, mid);
    const p = grid.point(n.gi);
    if (!p) return { ok: false, targets: null };
    const landing = grid.nearest(p.x + dx, p.y + dy);
    // A limb may not be dropped onto the rest of the tree, and re-snapping
    // must not fold two of its own nodes onto one point.
    if (parked.has(landing) || taken.has(landing)) return { ok: false, targets: null };
    taken.add(landing);
    targets.set(mid, landing);
  }
  return { ok: true, targets };
}

// Whether a node may be dragged to `gi`, taking its limb with it.
export function canMoveTo(tree, grid, id, gi) {
  return planBranchMove(tree, grid, id, gi).ok;
}

// Move a node and everything downstream of it. Moving the root takes the whole
// tree, and the horizon goes with it.
export function moveNode(tree, grid, id, gi) {
  const plan = planBranchMove(tree, grid, id, gi);
  if (!plan.ok) return false;

  for (const [mid, landing] of plan.targets) nodeById(tree, mid).gi = landing;
  if (id === tree.rootId) tree.horizonY = grid.point(gi).y;
  return true;
}

// Remove a node and everything beyond it — the node, its children, their
// children, all of it. This is what deleting a branch means: you cut it off
// and the whole limb goes, rather than leaving its tip floating.
//
// Refuses to cut the root, since that would take the entire tree and the
// horizon with it. Returns the number of nodes removed.
export function removeBranch(tree, id) {
  if (!tree.rootId || id === tree.rootId) return 0;
  const node = nodeById(tree, id);
  if (!node) return 0;

  const { children } = metrics(tree);
  const doomed = new Set([id]);
  const queue = [id];
  for (let head = 0; head < queue.length; head++) {
    for (const child of children.get(queue[head]) || []) {
      if (doomed.has(child)) continue;
      doomed.add(child);
      queue.push(child);
    }
  }

  tree.nodes = tree.nodes.filter((n) => !doomed.has(n.id));
  tree.edges = tree.edges.filter(([a, b]) => !doomed.has(a) && !doomed.has(b));
  return doomed.size;
}

// Remove a single node, splicing its children onto its parent so the tree
// never fragments. Contrast removeBranch, which takes the whole limb.
export function removeNode(tree, id) {
  if (id === tree.rootId) return false;
  const { parent } = metrics(tree);
  const up = parent.get(id);
  const kids = neighborIds(tree, id).filter((k) => k !== up);

  tree.edges = tree.edges.filter(([a, b]) => a !== id && b !== id);
  tree.nodes = tree.nodes.filter((n) => n.id !== id);
  if (up) for (const k of kids) linkNodes(tree, up, k);
  return true;
}

// Shed the fine twigs off matured wood — self-pruning.
//
// A branch's Strahler order rises as growth accumulates beyond it, so a high
// order means thick old wood. Real trees do not keep a fringe of twigs on
// their heavy limbs: those get shaded out and drop, which is what leaves an
// ageing crown open inside and carrying its foliage on the outer shell.
//
// Culling the structure is the honest version of that. Merely withholding
// *foliage* near thick branches hides the twigs without removing them, so the
// tree keeps accreting clutter inside the crown for ever.
//
// Only small, order-1 side branches are taken: anything that has itself grown
// into a limb has earned its place. Returns the number of nodes removed.
export function findMatureTwigs(tree, opts = {}) {
  const matureOrder = Math.max(0, Math.floor(opts.matureOrder) || 0);
  if (matureOrder < 2 || !tree.rootId) return [];
  const maxTwig = Math.max(1, Math.floor(opts.maxTwig) || 3);

  const stats = opts.metrics || metrics(tree);
  const doomed = [];

  for (const node of tree.nodes) {
    if ((stats.strahler.get(node.id) || 1) < matureOrder) continue;
    for (const child of stats.children.get(node.id) || []) {
      if ((stats.strahler.get(child) || 1) !== 1) continue;      // a limb, not a twig
      if ((stats.subtree.get(child) || 1) > maxTwig) continue;   // long enough to keep
      doomed.push(child);
    }
  }
  return doomed;
}

// Every node in the doomed subtrees — what will actually come away, which is
// what winter needs in order to drop it.
export function twigNodes(tree, roots, m = null) {
  const stats = m || metrics(tree);
  const out = new Set();
  const queue = [...roots];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    if (out.has(id)) continue;
    out.add(id);
    for (const child of stats.children.get(id) || []) queue.push(child);
  }
  return out;
}

export function pruneMatureTwigs(tree, opts = {}) {
  let removed = 0;
  for (const id of findMatureTwigs(tree, opts)) removed += removeBranch(tree, id);
  return removed;
}

// ---------- Traversal ----------

export function neighborIds(tree, id) {
  const out = [];
  for (const [a, b] of tree.edges) {
    if (a === id) out.push(b);
    else if (b === id) out.push(a);
  }
  return out;
}

// Adjacency as a Map, built once per metrics() pass.
function adjacency(tree) {
  const adj = new Map(tree.nodes.map((n) => [n.id, []]));
  for (const [a, b] of tree.edges) {
    if (adj.has(a)) adj.get(a).push(b);
    if (adj.has(b)) adj.get(b).push(a);
  }
  return adj;
}

// ---------- Metrics ----------

// Everything the vegetation rules key off, computed in two passes: a BFS down
// from the root for depth/parent/children, then a reverse walk back up for
// Strahler order.
//
// Returns:
//   depth     Map id -> graph distance from root
//   parent    Map id -> parent id (root maps to null)
//   children  Map id -> [child ids]
//   terminal  Set of ids with no children (excluding a childless root)
//   strahler  Map id -> Strahler order (thickness / age proxy)
//   subtree   Map id -> number of nodes at or below it
//   order     ids in BFS order, root first
//   maxDepth  deepest depth present
export function metrics(tree) {
  const depth = new Map();
  const parent = new Map();
  const children = new Map(tree.nodes.map((n) => [n.id, []]));
  const strahler = new Map();
  const subtree = new Map();
  const terminal = new Set();
  const order = [];

  if (!tree.rootId || !tree.nodes.length) {
    return { depth, parent, children, terminal, strahler, subtree, order, maxDepth: 0 };
  }

  const adj = adjacency(tree);
  let maxDepth = 0;

  depth.set(tree.rootId, 0);
  parent.set(tree.rootId, null);
  const queue = [tree.rootId];

  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    order.push(cur);
    const d = depth.get(cur);
    if (d > maxDepth) maxDepth = d;
    for (const n of adj.get(cur) || []) {
      if (depth.has(n)) continue;
      depth.set(n, d + 1);
      parent.set(n, cur);
      children.get(cur).push(n);
      queue.push(n);
    }
  }

  // Leaves first: walking the BFS order backwards guarantees every child is
  // resolved before its parent.
  for (let k = order.length - 1; k >= 0; k--) {
    const id = order[k];
    const kids = children.get(id);
    if (!kids.length) {
      strahler.set(id, 1);
      subtree.set(id, 1);
      if (id !== tree.rootId) terminal.add(id);
      continue;
    }

    let top = 0;
    let topCount = 0;
    let total = 1;
    for (const c of kids) {
      total += subtree.get(c) || 1;
      const s = strahler.get(c) || 1;
      if (s > top) {
        top = s;
        topCount = 1;
      } else if (s === top) {
        topCount++;
      }
    }
    strahler.set(id, topCount > 1 ? top + 1 : top);
    subtree.set(id, total);
  }

  return { depth, parent, children, terminal, strahler, subtree, order, maxDepth };
}

// ---------- Trunk ----------

// The trunk: the most central path through the tree, from the root outward.
// At every fork it follows the dominant child — highest Strahler order first,
// since that is what "main channel" means in a branching network; then the
// largest subtree; then the deepest reach. The final tiebreak is on ID so the
// trunk is stable rather than dependent on edge insertion order.
//
// `minOrder` is where the trunk stops being a trunk. Strahler order falls as
// you move outward — order 1 is a twig — so the threshold reads directly as
// "how thick a branch must still be to count as stem". At 1 the trunk runs
// all the way to a tip; raise it and the trunk ends lower, leaving the upper
// stem to behave like any other branch. The root is always included, so a
// trunk always exists even for an unbranched stick.
//
// Pass `opts.grid` once a tree has roots: the trunk must stay in the canopy,
// or a large root system can win the Strahler comparison at the root node and
// the "trunk" dives underground.
//
// Returns node IDs in order, root first. Empty for an empty tree.
export function trunkPath(tree, m = null, opts = {}) {
  if (!tree.rootId || !tree.nodes.length) return [];
  const stats = m || metrics(tree);
  if (!stats.depth.has(tree.rootId)) return [];

  const minOrder = Math.max(1, Math.floor(opts.minOrder) || 1);

  // How straight on a child is, relative to the direction we arrived from.
  // 1 is dead ahead, 0 is a right-angle turn.
  //
  // This matters more than it looks. At a symmetric fork the children tie on
  // every structural measure, and falling through to a tie-break on node ID
  // makes the trunk pick the same side every single time — the grammar emits
  // `[+F]` before `[-F]`, so the lower ID is always the `+` branch and the
  // trunk leans off-centre by construction. Straightness breaks those ties the
  // way a trunk actually behaves: it carries on.
  const straightness = (fromId, id) => {
    if (!opts.grid) return 0;
    const cur = nodeById(tree, fromId);
    const kid = nodeById(tree, id);
    if (!cur || !kid) return 0;
    const a = opts.grid.point(cur.gi);
    const b = opts.grid.point(kid.gi);
    if (!a || !b) return 0;

    const prevId = stats.parent.get(fromId);
    const prev = prevId ? nodeById(tree, prevId) : null;
    const p = prev && opts.grid.point(prev.gi);
    // No parent yet: the trunk leaves the root upward.
    const inX = p ? a.x - p.x : 0;
    const inY = p ? a.y - p.y : -1;

    const outX = b.x - a.x;
    const outY = b.y - a.y;
    const inLen = Math.hypot(inX, inY) || 1;
    const outLen = Math.hypot(outX, outY) || 1;
    return (inX * outX + inY * outY) / (inLen * outLen);
  };

  const rank = (fromId, id) => [
    stats.strahler.get(id) || 1,
    stats.subtree.get(id) || 1,
    deepestReach(stats, id),
    straightness(fromId, id),
  ];

  const path = [tree.rootId];
  let cur = tree.rootId;

  // Guard against a malformed graph rather than looping forever.
  while (path.length <= tree.nodes.length) {
    let kids = stats.children.get(cur) || [];
    // The trunk belongs to the canopy; never step below the horizon.
    if (opts.grid && tree.horizonY != null) {
      const above = kids.filter((id) => {
        const n = nodeById(tree, id);
        const p = n && opts.grid.point(n.gi);
        return p && p.y <= tree.horizonY;
      });
      if (above.length) kids = above;
    }
    if (!kids.length) break;

    let best = kids[0];
    let bestRank = rank(cur, best);
    for (let i = 1; i < kids.length; i++) {
      const id = kids[i];
      const r = rank(cur, id);
      const better =
        r[0] !== bestRank[0] ? r[0] > bestRank[0]
          : r[1] !== bestRank[1] ? r[1] > bestRank[1]
            : r[2] !== bestRank[2] ? r[2] > bestRank[2]
              : Math.abs(r[3] - bestRank[3]) > 1e-9 ? r[3] > bestRank[3]
                : id < best;
      if (better) {
        best = id;
        bestRank = r;
      }
    }

    // Stop where the stem thins past the threshold. Checked on the candidate
    // rather than after appending, so the trunk ends on its last thick node.
    if ((stats.strahler.get(best) || 1) < minOrder) break;

    path.push(best);
    cur = best;
  }

  return path;
}

// How far below `id` the tree reaches, in edges. Memoised per call site via
// the stats object so repeated lookups during trunk selection stay cheap.
function deepestReach(stats, id) {
  if (!stats._reach) stats._reach = new Map();
  if (stats._reach.has(id)) return stats._reach.get(id);

  // Walk the BFS order backwards so children resolve before parents.
  for (let k = stats.order.length - 1; k >= 0; k--) {
    const cur = stats.order[k];
    if (stats._reach.has(cur)) continue;
    const kids = stats.children.get(cur) || [];
    let best = 0;
    for (const c of kids) best = Math.max(best, 1 + (stats._reach.get(c) || 0));
    stats._reach.set(cur, best);
  }
  return stats._reach.get(id) || 0;
}

// ---------- Horizon ----------

// Canopy is above the horizon line, roots below. Vegetation rules use this to
// stay out of the root system.
export function isCanopy(tree, grid, id) {
  const node = nodeById(tree, id);
  if (!node || tree.horizonY == null) return false;
  return grid.point(node.gi).y < tree.horizonY;
}

// ---------- Extent ----------

// World-space bounding box of every node, or null for an empty tree. Used to
// decide when the canvas has to grow.
export function treeBounds(tree, grid) {
  if (!tree.nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of tree.nodes) {
    const p = grid.point(n.gi);
    if (!p) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// True when the tree has come within `marginCells` of any edge of the world.
export function needsRoom(tree, grid, marginCells = 2) {
  const b = treeBounds(tree, grid);
  if (!b) return false;
  const m = grid.spacing * marginCells;
  return (
    b.minX < m ||
    b.minY < m ||
    b.maxX > grid.width - m ||
    b.maxY > grid.height - m
  );
}

// ---------- Grid switching ----------

// Re-snap every node onto a different lattice.
//
// Nodes move to the nearest point on the new lattice, so the drawing distorts
// slightly but the structure survives exactly. Two nodes can collide onto one
// point — they get merged. Edges need no repair at all: a branch is a
// straight segment between two points, so it simply follows its endpoints.
//
// `offset` shifts every node by {dx, dy} before re-snapping. That is what
// keeps a tree centred when the world grows around it — both lattices centre
// themselves, so without the shift a growing canvas would leave the tree
// stranded toward the top-left.
//
// Returns a new tree; the input is left alone.
export function remapToGrid(tree, fromGrid, toGrid, offset = {}) {
  const dx = offset.dx || 0;
  const dy = offset.dy || 0;
  const next = makeTree();
  next.nextId = tree.nextId;

  // Old id -> new id. Collisions collapse onto whichever node landed first.
  const byPoint = new Map();
  const idMap = new Map();

  for (const n of tree.nodes) {
    const p = fromGrid.point(n.gi);
    const gi = toGrid.nearest(p.x + dx, p.y + dy);
    if (byPoint.has(gi)) {
      idMap.set(n.id, byPoint.get(gi));
      continue;
    }
    const moved = { id: n.id, gi };
    next.nodes.push(moved);
    byPoint.set(gi, n.id);
    idMap.set(n.id, n.id);
  }

  next.rootId = idMap.get(tree.rootId) || (next.nodes[0] && next.nodes[0].id) || null;
  if (next.rootId) {
    next.horizonY = toGrid.point(nodeById(next, next.rootId).gi).y;
  }

  for (const [a, b] of tree.edges) {
    const na = idMap.get(a);
    const nb = idMap.get(b);
    // Skip only edges whose ends merged onto the same point.
    if (!na || !nb || na === nb) continue;
    linkNodes(next, na, nb);
  }

  return next;
}
