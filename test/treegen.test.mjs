// treegen — headless tests.
//
//   node --test public/posts/treegen/
//
// Everything under test is DOM-free by construction. render.js is exercised
// through its injected element factory, so the same drawing code that runs in
// the browser produces the proof SVG written here — there is no second
// renderer to drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRng, sub, objRng, mix, hashStr, weighted, STREAMS } from '../rng.js';
import { makeGrid, GRID_TYPES, delaunay } from '../grid.js';
import {
  makeTree, addNodeAt, connectAt, moveNode, canMoveTo, metrics, remapToGrid,
  neighborIds, isCanopy, nodeById, nodeAt, treeBounds, needsRoom, trunkPath,
  removeBranch, pruneMatureTwigs, findMatureTwigs, twigNodes, planBranchMove,
} from '../tree.js';
import {
  buildFoliage, evaluateSeason, resolveColors, listNameFor, isPresent,
  SEASONS, PALETTE_NAMES,
} from '../foliage.js';
import { parseRules, expand, turtle, generate, extendTips } from '../lsystem.js';
import {
  renderToString, branchNodes, foliageNodes, objectEl, transformFor, frameFor,
} from '../render.js';
import {
  lerpHex, planTransition, planBranchFall, frameState, settledState, TIMING, WINTER,
} from '../animate.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// A shared fixture: a tree with a trunk, a fork, and roots below the horizon.
function fixture(type = 'square', seed = 5) {
  const grid = makeGrid({ type, width: 900, height: 600, spacing: 30, seed });
  const tree = makeTree();
  addNodeAt(tree, grid, grid.nearest(450, 430));
  for (const [x, y] of [
    [450, 250], [380, 190], [520, 190], [330, 140], [430, 130],
    [560, 140], [610, 200], [300, 220], [480, 100], [380, 90], [540, 95],
  ]) {
    addNodeAt(tree, grid, grid.nearest(x, y));
  }
  addNodeAt(tree, grid, grid.nearest(380, 520));
  addNodeAt(tree, grid, grid.nearest(520, 530));
  return { grid, tree };
}

// ---------- rng ----------

test('mulberry32 is deterministic and stays in range', () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  for (let i = 0; i < 500; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('named streams are independent and reproducible', () => {
  assert.equal(sub(42, STREAMS.PLACEMENT)(), sub(42, STREAMS.PLACEMENT)());
  assert.notEqual(sub(42, STREAMS.PLACEMENT)(), sub(42, STREAMS.TONE)());
  assert.notEqual(sub(42, STREAMS.PALETTE)(), sub(43, STREAMS.PALETTE)());
});

test('objRng depends only on (seed, id, stream)', () => {
  assert.equal(objRng(1, 'n3:0', 'winter')(), objRng(1, 'n3:0', 'winter')());
  assert.notEqual(objRng(1, 'n3:0', 'winter')(), objRng(1, 'n3:1', 'winter')());
  // Seed + 1 is the year wrap; adjacent seeds must not correlate.
  assert.notEqual(objRng(1, 'n3:0', 'winter')(), objRng(2, 'n3:0', 'winter')());
});

test('mix avalanches adjacent inputs', () => {
  const a = mix(1, hashStr('tone'));
  const b = mix(2, hashStr('tone'));
  assert.notEqual(a, b);
  assert.ok(Math.abs(a - b) > 1000, 'adjacent seeds should not produce adjacent hashes');
});

test('weighted respects weights and tolerates degenerate input', () => {
  const entries = [{ weight: 1, value: 'a' }, { weight: 0, value: 'b' }];
  const rng = makeRng(9);
  for (let i = 0; i < 50; i++) assert.equal(weighted(rng, entries), 'a');
  assert.equal(weighted(rng, [{ weight: 0, value: 'x' }]), 'x');
});

// ---------- grid ----------

for (const type of GRID_TYPES) {
  test(`${type}: adjacency is symmetric, connected, and nearest() is exact`, () => {
    const grid = makeGrid({ type, width: 900, height: 600, spacing: 30, seed: 5 });
    assert.ok(grid.count > 50, `${type} produced too few points`);

    for (let i = 0; i < grid.count; i++) {
      const ns = grid.neighbors(i);
      assert.ok(ns.length > 0, `${type} point ${i} is isolated`);
      for (const n of ns) {
        assert.ok(grid.neighbors(n).includes(i), `${type} adjacency asymmetric ${i}<->${n}`);
      }
    }

    // Every point reachable from point 0.
    const seen = new Set([0]);
    const queue = [0];
    for (let h = 0; h < queue.length; h++) {
      for (const n of grid.neighbors(queue[h])) {
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    assert.equal(seen.size, grid.count, `${type} lattice is disconnected`);

    // A point's own coordinates must resolve back to itself.
    for (let i = 0; i < grid.count; i += Math.max(1, Math.floor(grid.count / 40))) {
      const p = grid.point(i);
      assert.equal(grid.nearest(p.x, p.y), i, `${type} nearest() missed point ${i}`);
    }

    assert.ok(grid.cellPath(Math.floor(grid.count / 2)).startsWith('M'));
  });
}

test('lattice degree matches each geometry', () => {
  const deg = (type) => {
    const g = makeGrid({ type, width: 900, height: 600, spacing: 30, seed: 5 });
    let sum = 0;
    for (let i = 0; i < g.count; i++) sum += g.neighbors(i).length;
    return sum / g.count;
  };
  assert.ok(deg('square') > 7, 'square is 8-way');
  assert.ok(deg('hex') > 5 && deg('hex') <= 6, 'hex is 6-way');
  assert.ok(deg('triangle') <= 3, 'triangle is 3-way');
  // Mean degree of a Delaunay triangulation tends to 6.
  const v = deg('voronoi');
  assert.ok(v > 5 && v < 6.5, `voronoi mean degree ${v} should approach 6`);
});

test('voronoi sites are reproducible from the seed', () => {
  const a = makeGrid({ type: 'voronoi', width: 900, height: 600, spacing: 30, seed: 5 });
  const b = makeGrid({ type: 'voronoi', width: 900, height: 600, spacing: 30, seed: 5 });
  const c = makeGrid({ type: 'voronoi', width: 900, height: 600, spacing: 30, seed: 6 });
  assert.equal(a.count, b.count);
  assert.deepEqual(a.points, b.points);
  assert.notDeepEqual(a.points, c.points);
});

test('delaunay triangulates a known point set', () => {
  // Unit square: exactly two triangles, covering all four corners.
  const square = [
    { i: 0, x: 0, y: 0 }, { i: 1, x: 100, y: 0 },
    { i: 2, x: 100, y: 100 }, { i: 3, x: 0, y: 100 },
  ];
  const tris = delaunay(square);
  assert.equal(tris.length, 2);
  const used = new Set(tris.flatMap((t) => [t.a, t.b, t.c]));
  assert.deepEqual([...used].sort(), [0, 1, 2, 3]);

  // A point strictly inside a triangle yields three triangles.
  const fan = [
    { i: 0, x: 0, y: 0 }, { i: 1, x: 100, y: 0 },
    { i: 2, x: 50, y: 100 }, { i: 3, x: 50, y: 30 },
  ];
  assert.equal(delaunay(fan).length, 3);

  // Delaunay's defining property: no point lies inside any circumcircle.
  const pts = [];
  const rng = makeRng(77);
  for (let i = 0; i < 40; i++) pts.push({ i, x: rng() * 400, y: rng() * 400 });
  for (const t of delaunay(pts)) {
    for (const p of pts) {
      if (p.i === t.a || p.i === t.b || p.i === t.c) continue;
      const d2 = (p.x - t.cc.x) ** 2 + (p.y - t.cc.y) ** 2;
      assert.ok(d2 >= t.cc.r2 - 1e-6, 'empty-circumcircle property violated');
    }
  }
});

// ---------- tree ----------

test('Strahler order on a hand-built fixture', () => {
  const tree = makeTree();
  tree.nodes = [
    { id: 'r', gi: 0 }, { id: 'a', gi: 1 }, { id: 'b', gi: 2 },
    { id: 'c', gi: 3 }, { id: 'd', gi: 4 }, { id: 'e', gi: 5 },
  ];
  // r - a - { b - {d, e}, c }
  tree.edges = [['r', 'a'], ['a', 'b'], ['a', 'c'], ['b', 'd'], ['b', 'e']];
  tree.rootId = 'r';

  const m = metrics(tree);
  assert.equal(m.strahler.get('d'), 1);
  assert.equal(m.strahler.get('e'), 1);
  assert.equal(m.strahler.get('b'), 2, 'two order-1 children promote to 2');
  assert.equal(m.strahler.get('c'), 1);
  assert.equal(m.strahler.get('a'), 2, 'orders 2 and 1 do not promote');
  assert.equal(m.strahler.get('r'), 2);

  assert.equal(m.depth.get('d'), 3);
  assert.equal(m.maxDepth, 3);
  assert.deepEqual([...m.terminal].sort(), ['c', 'd', 'e']);
  assert.equal(m.parent.get('r'), null);
});

test('the first placed point sets the horizon and the root', () => {
  const grid = makeGrid({ type: 'square', width: 600, height: 400, spacing: 25 });
  const tree = makeTree();
  const gi = grid.nearest(300, 300);
  const root = addNodeAt(tree, grid, gi);
  assert.equal(tree.rootId, root.id);
  assert.equal(tree.horizonY, grid.point(gi).y);
});

test('a distant click makes one straight branch, not a staircase', () => {
  const grid = makeGrid({ type: 'square', width: 900, height: 600, spacing: 30 });
  const tree = makeTree();
  const rootGi = grid.nearest(450, 450);
  addNodeAt(tree, grid, rootGi);

  // A point far away and off any lattice direction.
  const farGi = grid.nearest(700, 130);
  const node = addNodeAt(tree, grid, farGi);

  // Exactly two nodes and one edge — no intermediate points were invented.
  assert.equal(tree.nodes.length, 2, 'the gap was filled with extra nodes');
  assert.equal(tree.edges.length, 1);
  assert.equal(node.gi, farGi, 'the clicked point should hold the new node');
  assert.deepEqual(tree.edges[0].slice().sort(), [tree.rootId, node.id].sort());

  // The endpoints are on the grid; the span between them is not.
  assert.ok(!grid.adjacent(rootGi, farGi), 'fixture should span many cells');
  for (const n of tree.nodes) assert.deepEqual(grid.point(n.gi), grid.points[n.gi]);
});

test('every node sits on a lattice point', () => {
  for (const type of GRID_TYPES) {
    const { grid, tree } = fixture(type);
    for (const n of tree.nodes) {
      const p = grid.point(n.gi);
      assert.ok(p, `${type} node ${n.id} is off the lattice`);
      assert.equal(grid.nearest(p.x, p.y), n.gi, `${type} node is not on its own point`);
    }
  }
});

test('connectAt joins exactly two points with one branch', () => {
  const grid = makeGrid({ type: 'square', width: 900, height: 600, spacing: 30 });
  const tree = makeTree();
  const a = grid.nearest(450, 450);
  const b = grid.nearest(300, 120);
  connectAt(tree, grid, a, b);

  assert.equal(tree.nodes.length, 2);
  assert.equal(tree.edges.length, 1);
  assert.equal(tree.rootId, nodeAt(tree, a).id, 'the first point placed is the root');
  assert.equal(tree.horizonY, grid.point(a).y);

  // Reconnecting the same pair is idempotent.
  connectAt(tree, grid, a, b);
  assert.equal(tree.edges.length, 1);
  // A degenerate segment creates a point but no edge.
  connectAt(tree, grid, b, b);
  assert.equal(tree.edges.length, 1);
});

test('canopy and roots are split by the horizon', () => {
  const { grid, tree } = fixture();
  const above = tree.nodes.filter((n) => isCanopy(tree, grid, n.id));
  assert.ok(above.length > 0);
  for (const n of above) assert.ok(grid.point(n.gi).y < tree.horizonY);
});

test('dragging a node takes its whole limb along', () => {
  const { grid, tree } = fixture();
  const m = metrics(tree);

  // A node with descendants, so there is a limb to carry.
  const carrier = tree.nodes.find(
    (n) => n.id !== tree.rootId && (m.children.get(n.id) || []).length > 0
  );
  const moving = [...twigNodes(tree, [carrier.id], m)];
  assert.ok(moving.length > 1, 'fixture needs a node with descendants');

  const before = new Map(tree.nodes.map((n) => [n.id, grid.point(n.gi)]));
  const target = grid.nearest(
    before.get(carrier.id).x + grid.spacing * 2,
    before.get(carrier.id).y - grid.spacing
  );
  const shift = {
    dx: grid.point(target).x - before.get(carrier.id).x,
    dy: grid.point(target).y - before.get(carrier.id).y,
  };

  assert.ok(moveNode(tree, grid, carrier.id, target));

  // The whole limb shifted by the same amount — its shape is intact.
  for (const id of moving) {
    const was = before.get(id);
    const now = grid.point(nodeById(tree, id).gi);
    assert.ok(
      Math.abs(now.x - (was.x + shift.dx)) <= grid.spacing / 2 &&
        Math.abs(now.y - (was.y + shift.dy)) <= grid.spacing / 2,
      `${id} did not travel with the limb`
    );
  }

  // Nothing upstream moved; the branch above simply stretches.
  const stationary = tree.nodes.filter((n) => !moving.includes(n.id));
  assert.ok(stationary.length > 0);
  for (const n of stationary) {
    assert.deepEqual(grid.point(n.gi), before.get(n.id), `${n.id} should not have moved`);
  }

  assert.equal(metrics(tree).order.length, tree.nodes.length, 'the drag fragmented the tree');
});

test('a limb cannot be dropped onto the rest of the tree', () => {
  const { grid, tree } = fixture();
  const m = metrics(tree);
  const tip = [...m.terminal][0];

  // Its own point is always fine — a drag can be put back.
  assert.ok(canMoveTo(tree, grid, tip, nodeById(tree, tip).gi));

  // A point another node holds is not.
  const other = tree.nodes.find((n) => n.id !== tip);
  assert.equal(canMoveTo(tree, grid, tip, other.gi), false);
  assert.equal(moveNode(tree, grid, tip, other.gi), false);

  // A rejected move leaves everything exactly where it was.
  const snapshot = tree.nodes.map((n) => `${n.id}:${n.gi}`).join(',');
  moveNode(tree, grid, tip, other.gi);
  assert.equal(tree.nodes.map((n) => `${n.id}:${n.gi}`).join(','), snapshot);
});

test('dragging the root moves the whole tree, horizon and all', () => {
  const { grid, tree } = fixture();
  const before = new Map(tree.nodes.map((n) => [n.id, grid.point(n.gi)]));
  const rootWas = before.get(tree.rootId);
  const target = grid.nearest(rootWas.x + grid.spacing, rootWas.y + grid.spacing);
  const dx = grid.point(target).x - rootWas.x;
  const dy = grid.point(target).y - rootWas.y;

  assert.ok(canMoveTo(tree, grid, tree.rootId, target));
  assert.ok(moveNode(tree, grid, tree.rootId, target));
  assert.equal(tree.horizonY, grid.point(target).y, 'the horizon should follow the root');

  // Everything came along: the tree translated, it did not deform.
  for (const n of tree.nodes) {
    const was = before.get(n.id);
    const now = grid.point(n.gi);
    assert.ok(
      Math.abs(now.x - (was.x + dx)) <= grid.spacing / 2 &&
        Math.abs(now.y - (was.y + dy)) <= grid.spacing / 2,
      `${n.id} was left behind`
    );
  }
});

test('planBranchMove reports without touching the tree', () => {
  const { grid, tree } = fixture();
  const m = metrics(tree);
  const carrier = tree.nodes.find(
    (n) => n.id !== tree.rootId && (m.children.get(n.id) || []).length > 0
  );
  const snapshot = tree.nodes.map((n) => `${n.id}:${n.gi}`).join(',');

  const target = grid.nearest(
    grid.point(carrier.gi).x + grid.spacing * 2,
    grid.point(carrier.gi).y
  );
  const plan = planBranchMove(tree, grid, carrier.id, target);
  assert.ok(plan.ok);
  assert.ok(plan.targets.size > 1, 'the plan should cover the whole limb');
  assert.equal(
    tree.nodes.map((n) => `${n.id}:${n.gi}`).join(','), snapshot,
    'planning must not move anything'
  );
});

// ---------- grid switching ----------

for (const target of GRID_TYPES.filter((t) => t !== 'square')) {
  test(`switching square -> ${target} preserves the structure exactly`, () => {
    const { grid, tree } = fixture('square');
    const next = makeGrid({ type: target, width: 900, height: 600, spacing: 30, seed: 5 });
    const moved = remapToGrid(tree, grid, next);

    assert.ok(moved.rootId, 'root survived the switch');
    assert.equal(moved.horizonY, next.point(nodeById(moved, moved.rootId).gi).y);

    // Branches are straight segments, so nothing needs re-pathing and no
    // intermediate nodes are invented. Only merged points may reduce counts.
    assert.ok(moved.nodes.length <= tree.nodes.length, `${target} invented nodes`);
    assert.ok(moved.edges.length <= tree.edges.length, `${target} invented edges`);

    // Every node is on a real point of the new lattice, and none collide.
    const seen = new Set();
    for (const n of moved.nodes) {
      assert.ok(next.point(n.gi), `${target} node landed off-lattice`);
      assert.ok(!seen.has(n.gi), 'two nodes collided onto one point');
      seen.add(n.gi);
    }

    // The graph stays in one piece.
    const m = metrics(moved);
    assert.equal(m.order.length, moved.nodes.length, `${target} remap fragmented the tree`);
  });
}

// ---------- the structure stays a tree ----------

test('a node never gains a second parent', () => {
  const grid = makeGrid({ type: 'square', width: 1400, height: 1100, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(700, 950);
  addNodeAt(tree, grid, start);

  // The turtle revisits lattice points constantly; every revisit is a chance
  // to close a loop.
  generate(grid, start,
    { rules: 'F -> F[+F][-F]F', iterations: 5, angle: 35, step: 2, seed: 1, jitter: 35 },
    { edge: (a, b) => connectAt(tree, grid, a, b) });

  const m = metrics(tree);
  // n nodes, n-1 edges is the definition of a tree.
  assert.equal(tree.edges.length, tree.nodes.length - 1,
    'edge count says this is not a tree');
  assert.equal(m.order.length, tree.nodes.length, 'the structure is not connected');

  // Every node but the root has exactly one parent.
  for (const n of tree.nodes) {
    if (n.id === tree.rootId) continue;
    assert.ok(m.parent.get(n.id), `${n.id} has no parent`);
  }

  // No duplicate edges, and none doubling back on themselves.
  const seen = new Set();
  for (const [a, b] of tree.edges) {
    assert.notEqual(a, b, 'a branch joined a node to itself');
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    assert.ok(!seen.has(key), 'a branch was drawn twice');
    seen.add(key);
  }
});

test('re-linking joined nodes is refused, joining a fresh one is not', () => {
  const grid = makeGrid({ type: 'square', width: 900, height: 600, spacing: 30 });
  const tree = makeTree();
  const a = grid.nearest(450, 450);
  const b = grid.nearest(450, 390);
  const c = grid.nearest(510, 390);
  connectAt(tree, grid, a, b);
  connectAt(tree, grid, b, c);
  assert.equal(tree.edges.length, 2);

  // a and c are both already in the tree: joining them would close a loop.
  connectAt(tree, grid, a, c);
  assert.equal(tree.edges.length, 2, 'a loop was allowed');

  // A brand-new point still attaches normally.
  connectAt(tree, grid, c, grid.nearest(570, 330));
  assert.equal(tree.edges.length, 3, 'a legitimate branch was refused');
  assert.equal(metrics(tree).order.length, tree.nodes.length);
});

test('growth keeps the structure a tree', () => {
  const grid = makeGrid({ type: 'square', width: 2400, height: 1800, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(1200, 1550);
  addNodeAt(tree, grid, start);
  generate(grid, start,
    { rules: 'F -> F[+F][-F]F', iterations: 3, angle: 35, step: 2, seed: 1, jitter: 35 },
    { edge: (a, b) => connectAt(tree, grid, a, b) });

  for (let y = 1; y <= 5; y++) {
    extendTips(grid, tree, metrics(tree),
      { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, seed: y, jitter: 35,
        growChance: 0.65, rootGrowChance: 0.3, balance: 0.8,
        roll: (id) => objRng(y, id, 'grow')() },
      { edge: (a, b) => connectAt(tree, grid, a, b) });
    assert.equal(tree.edges.length, tree.nodes.length - 1,
      `year ${y} left the structure with a loop`);
  }
});

// ---------- cutting ----------

test('cutting a node takes everything past it', () => {
  //  r - a - b - { c - d,  e }
  const tree = makeTree();
  tree.nodes = ['r','a','b','c','d','e'].map((id, i) => ({ id, gi: i }));
  tree.edges = [['r','a'],['a','b'],['b','c'],['c','d'],['b','e']];
  tree.rootId = 'r';

  // Cutting b takes b, c, d and e — the whole limb.
  assert.equal(removeBranch(tree, 'b'), 4);
  assert.deepEqual(tree.nodes.map((n) => n.id), ['r','a']);
  assert.deepEqual(tree.edges, [['r','a']]);
  assert.equal(metrics(tree).order.length, 2, 'the remainder must stay whole');
});

test('cutting a tip takes only the tip', () => {
  const { tree } = fixture();
  const m = metrics(tree);
  const tip = [...m.terminal][0];
  const before = tree.nodes.length;

  assert.equal(removeBranch(tree, tip), 1);
  assert.equal(tree.nodes.length, before - 1);
  assert.equal(nodeById(tree, tip), null);
  // No edge may reference a node that is gone.
  for (const [a, b] of tree.edges) {
    assert.ok(nodeById(tree, a) && nodeById(tree, b), 'dangling edge left behind');
  }
  assert.equal(metrics(tree).order.length, tree.nodes.length);
});

test('the root cannot be cut, and unknown nodes are a no-op', () => {
  const { tree } = fixture();
  const before = tree.nodes.length;
  assert.equal(removeBranch(tree, tree.rootId), 0, 'cutting the root would take the horizon');
  assert.equal(removeBranch(tree, 'nope'), 0);
  assert.equal(tree.nodes.length, before);
  assert.equal(removeBranch(makeTree(), 'x'), 0);
});

// ---------- growth ----------

test('growth extends the tips and leaves the rest alone', () => {
  const grid = makeGrid({ type: 'square', width: 1200, height: 900, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(600, 820);
  addNodeAt(tree, grid, start);
  generate(grid, start,
    { rules: 'F -> F[+F][-F]F', iterations: 3, angle: 35, step: 2, seed: 1 },
    { begin: () => {}, edge: (a, b) => connectAt(tree, grid, a, b) });

  const before = {
    nodes: tree.nodes.map((n) => ({ ...n })),
    edges: tree.edges.map((e) => [...e]),
    root: tree.rootId,
    horizon: tree.horizonY,
  };
  const m = metrics(tree);
  const tips = new Set(m.terminal);

  const res = extendTips(grid, tree, m,
    { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, seed: 5, growChance: 1, rootGrowChance: 1 },
    { edge: (a, b) => connectAt(tree, grid, a, b) });

  assert.ok(res.ok, res.error);
  assert.ok(res.grown > 0, 'nothing grew');
  assert.ok(tree.nodes.length > before.nodes.length, 'no new nodes');

  // Every pre-existing node survives, at the same point. Growth adds; it
  // never regenerates.
  for (const old of before.nodes) {
    const now = nodeById(tree, old.id);
    assert.ok(now, `node ${old.id} was lost in growth`);
    assert.equal(now.gi, old.gi, `node ${old.id} moved during growth`);
  }
  for (const [a, b] of before.edges) {
    assert.ok(
      tree.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a)),
      'an existing branch was lost in growth'
    );
  }
  assert.equal(tree.rootId, before.root);
  assert.equal(tree.horizonY, before.horizon);

  // The new growth hangs off what were tips, and the tree stays whole.
  const after = metrics(tree);
  assert.equal(after.order.length, tree.nodes.length, 'growth fragmented the tree');
  assert.ok(after.maxDepth > m.maxDepth, 'growth should reach further out');
  const stillTips = [...after.terminal].filter((id) => tips.has(id));
  assert.ok(stillTips.length < tips.size, 'old tips should have grown children');
});

test('growth is reproducible and year-dependent', () => {
  const run = (seed) => {
    const grid = makeGrid({ type: 'square', width: 1200, height: 900, spacing: 20 });
    const tree = makeTree();
    const start = grid.nearest(600, 820);
    addNodeAt(tree, grid, start);
    generate(grid, start,
      { rules: 'F -> F[+F][-F]F', iterations: 3, angle: 35, step: 2, seed: 1 },
      { begin: () => {}, edge: (a, b) => connectAt(tree, grid, a, b) });
    const m = metrics(tree);
    extendTips(grid, tree, m,
      { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, seed, growChance: 0.6,
        roll: (id) => objRng(seed, id, 'grow')() },
      { edge: (a, b) => connectAt(tree, grid, a, b) });
    return tree.nodes.map((n) => n.gi).join(',');
  };
  assert.equal(run(7), run(7), 'the same year must grow the same way');
  assert.notEqual(run(7), run(8), 'a different year should grow differently');
});

test('growth stops at the limit and reports bad rules', () => {
  const grid = makeGrid({ type: 'square', width: 1200, height: 900, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(600, 820);
  addNodeAt(tree, grid, start);
  generate(grid, start,
    { rules: 'F -> F[+F][-F]F', iterations: 3, angle: 35, step: 2, seed: 1 },
    { begin: () => {}, edge: (a, b) => connectAt(tree, grid, a, b) });

  const capped = extendTips(grid, tree, metrics(tree),
    { rules: 'F -> F[+F][-F]F', growLimit: 1 },
    { edge: () => { throw new Error('should not have grown'); } });
  assert.ok(capped.ok);
  assert.equal(capped.grown, 0);
  assert.equal(capped.capped, true);

  const bad = extendTips(grid, tree, metrics(tree), { rules: 'nonsense' }, { edge: () => {} });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);

  // A rule that rewrites F to itself cannot grow anything.
  const inert = extendTips(grid, tree, metrics(tree), { rules: 'F -> F' }, { edge: () => {} });
  assert.equal(inert.ok, false);
  assert.match(inert.error, /no new growth/);
});

// ---------- shoots from old wood ----------

// One season on a tree old enough to have mature wood. Every node the rule
// offers a bud to is recorded on the way past, so a test can check what was
// picked rather than trying to infer it from the result.
function season(sproutChance, matureOrder, seed = 9) {
  const grid = makeGrid({ type: 'square', width: 2400, height: 1800, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(1200, 1550);
  addNodeAt(tree, grid, start);
  generate(grid, start,
    { rules: 'F -> F[+F][-F]F', iterations: 4, angle: 35, step: 2, seed: 3, jitter: 35 },
    { edge: (a, b) => connectAt(tree, grid, a, b) });

  const offered = [];
  const before = metrics(tree);
  const res = extendTips(grid, tree, before,
    { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, seed, jitter: 35,
      growChance: 0.65, rootGrowChance: 0.3, balance: 0.8,
      sproutChance, matureOrder,
      roll: (id) => objRng(seed, id, 'grow')(),
      sproutRoll: (id) => {
        offered.push(id);
        return objRng(seed, id, 'sprout')();
      } },
    { edge: (a, b) => connectAt(tree, grid, a, b) });

  return { grid, tree, before, after: metrics(tree), res, offered };
}

test('shoots break from between mature nodes, never anywhere else', () => {
  const MATURE = 3;
  const run = season(1, MATURE);

  assert.ok(run.res.ok, run.res.error);
  assert.ok(run.res.sprouts > 0, 'no shoot broke from mature wood');
  assert.ok(run.offered.length >= run.res.sprouts);

  const m = run.before;
  for (const id of run.offered) {
    assert.notEqual(id, run.tree.rootId, 'a bud was offered to the root itself');
    assert.ok(!m.terminal.has(id), `${id} is a tip — tips have their own rule`);
    assert.ok((m.strahler.get(id) || 1) >= MATURE,
      `a bud was offered to ${id}, which is not mature wood`);
    // Strahler order never rises outward, so a mature node with a mature
    // child sits strictly between two of them rather than at the frontier.
    const kids = m.children.get(id) || [];
    assert.ok(kids.some((c) => (m.strahler.get(c) || 1) >= MATURE),
      `${id} is where the mature zone ends, not a point between its nodes`);
  }

  // A shoot joins the tree it came off: no loop, and nothing left floating.
  assert.equal(run.tree.edges.length, run.tree.nodes.length - 1, 'a shoot closed a loop');
  assert.equal(run.after.order.length, run.tree.nodes.length, 'a shoot floated free');
});

test('shoots are seeded, and stay put without a maturity threshold', () => {
  const gis = (seed) => season(1, 3, seed).tree.nodes.map((n) => n.gi).join(',');
  assert.equal(gis(11), gis(11), 'the same year must put out the same shoots');
  assert.notEqual(gis(11), gis(12), 'a different year should shoot differently');

  assert.equal(season(0, 3).res.sprouts, 0, 'shoots broke with the chance at zero');

  // Without a threshold there is no mature zone to break from, whatever the
  // chance says — the app passes its foliage setting through rather than this
  // module keeping a second copy of it.
  const noZone = season(1, 0);
  assert.equal(noZone.offered.length, 0);
  assert.equal(noZone.res.sprouts, 0, 'shoots broke with no mature zone defined');
});

// Shoots are cheap and tips are exponential, so the pass that runs second on
// a shared node budget is the one that gets nothing. Old wood goes first.
test('shoots get their chance before the tips spend the budget', () => {
  const MATURE = 3;
  const roomy = season(1, MATURE, 9);
  assert.ok(roomy.res.sprouts > 0);

  // The same season, with only enough budget left for a fraction of it: the
  // shoots still break, and it is tip growth that gives way.
  const grid = makeGrid({ type: 'square', width: 2400, height: 1800, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(1200, 1550);
  addNodeAt(tree, grid, start);
  generate(grid, start,
    { rules: 'F -> F[+F][-F]F', iterations: 4, angle: 35, step: 2, seed: 3, jitter: 35 },
    { edge: (a, b) => connectAt(tree, grid, a, b) });

  const tight = extendTips(grid, tree, metrics(tree),
    { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, seed: 9, jitter: 35,
      growLimit: tree.nodes.length + 12,
      growChance: 0.65, rootGrowChance: 0.3, balance: 0.8,
      sproutChance: 1, matureOrder: MATURE,
      roll: (id) => objRng(9, id, 'grow')(),
      sproutRoll: (id) => objRng(9, id, 'sprout')() },
    { edge: (a, b) => connectAt(tree, grid, a, b) });

  assert.ok(tight.sprouts > 0, 'the tips took a budget the shoots never saw');
  assert.ok(tight.tips < roomy.res.tips, 'tip growth should be what gives way');
});

test('a season spends its whole node budget rather than half of it', () => {
  const grid = makeGrid({ type: 'square', width: 2400, height: 1800, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(1200, 1550);
  addNodeAt(tree, grid, start);
  generate(grid, start,
    { rules: 'F -> F[+F][-F]F', iterations: 3, angle: 35, step: 2, seed: 1, jitter: 35 },
    { edge: (a, b) => connectAt(tree, grid, a, b) });

  const LIMIT = 300;
  let last = null;
  for (let y = 1; y <= 10; y++) {
    last = extendTips(grid, tree, metrics(tree),
      { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, seed: y, jitter: 35,
        growLimit: LIMIT, growChance: 0.65, rootGrowChance: 0.3, balance: 0.8,
        roll: (id) => objRng(y, id, 'grow')() },
      { edge: (a, b) => connectAt(tree, grid, a, b) });
  }

  // `grown` counts segments, and a segment landing on a point the tree
  // already holds adds no node — so counting it against the limit alongside
  // the tree's own length stops a season at roughly half its budget.
  assert.ok(tree.nodes.length >= LIMIT,
    `growth stalled at ${tree.nodes.length} of a ${LIMIT} node budget`);
  assert.ok(tree.nodes.length < LIMIT + 16, 'growth overran its budget');
  assert.equal(last.capped, true);
});

test('the turtle can continue from an existing heading', () => {
  const grid = makeGrid({ type: 'square', width: 900, height: 900, spacing: 30 });
  const start = grid.nearest(450, 450);
  const up = turtle('F', grid, start, { step: 2 });
  const right = turtle('F', grid, start, { step: 2, heading: 0, upOnly: false });

  const p0 = grid.point(start);
  assert.ok(grid.point(up.moves[0].to).y < p0.y, 'default heading is up');
  assert.ok(grid.point(right.moves[0].to).x > p0.x, 'heading 0 should go right');
  assert.equal(grid.point(right.moves[0].to).y, p0.y, 'heading 0 should stay level');
});

// ---------- variation ----------

test('jitter varies turn and length without breaking reproducibility', () => {
  const grid = makeGrid({ type: 'square', width: 1400, height: 1000, spacing: 20 });
  const start = grid.nearest(700, 900);
  const { rules } = parseRules('F -> F[+F][-F]F');
  const { word } = expand('F', rules, 4);

  const lengths = (opts) => {
    const { moves } = turtle(word, grid, start, { angle: 35, step: 2, seed: 4, ...opts });
    return moves.map((mv) => {
      const a = grid.point(mv.from), b = grid.point(mv.to);
      return Math.round(Math.hypot(b.x - a.x, b.y - a.y));
    });
  };

  // Without jitter the only variation is the endpoint snapping to the
  // lattice — a diagonal landing is a little longer than an axial one — so
  // lengths cluster tightly.
  const exact = lengths({ jitter: 0 });
  assert.ok(new Set(exact).size <= 2, 'without jitter lengths should barely vary');

  // With jitter: lengths spread well beyond what snapping alone explains.
  const varied = lengths({ jitter: 60 });
  assert.ok(
    new Set(varied).size > new Set(exact).size,
    'jitter should widen the spread of segment lengths'
  );
  assert.deepEqual(varied, lengths({ jitter: 60 }), 'jitter must be reproducible');
  assert.notDeepEqual(varied, lengths({ jitter: 60, seed: 5 }), 'a new seed should vary differently');

  // Direction varies too: more distinct headings than the grammar alone gives.
  const headings = (opts) => {
    const { moves } = turtle(word, grid, start, { angle: 35, step: 2, seed: 4, ...opts });
    return new Set(moves.map((mv) => {
      const a = grid.point(mv.from), b = grid.point(mv.to);
      return Math.round(Math.atan2(b.y - a.y, b.x - a.x) * 57.3);
    })).size;
  };
  assert.ok(headings({ jitter: 60 }) > headings({ jitter: 0 }), 'jitter should vary direction');
});

test('growth gives each tip its own variation', () => {
  const grid = makeGrid({ type: 'square', width: 1400, height: 1000, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(700, 900);
  addNodeAt(tree, grid, start);
  generate(grid, start,
    { rules: 'F -> F[+F][-F]F', iterations: 3, angle: 35, step: 2, seed: 1, jitter: 0 },
    { begin: () => {}, edge: (a, b) => connectAt(tree, grid, a, b) });

  const m = metrics(tree);
  const perTip = new Map();
  extendTips(grid, tree, m,
    { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, seed: 9, jitter: 70,
      growChance: 1, rootGrowChance: 1 },
    { edge: (a, b) => { perTip.set(a, (perTip.get(a) || 0) + 1); connectAt(tree, grid, a, b); } });

  // Tips are seeded by their own ID, so they must not all wobble alike.
  const grownFrom = [...m.terminal].filter((id) => {
    const n = nodeById(tree, id);
    return n && perTip.has(n.gi);
  });
  assert.ok(grownFrom.length > 1, 'expected several tips to grow');
});

// ---------- roots ----------

test('roots grow downward and stay below the horizon', () => {
  const grid = makeGrid({ type: 'square', width: 1400, height: 1200, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(700, 600);
  addNodeAt(tree, grid, start);
  const horizon = tree.horizonY;

  const res = generate(grid, start,
    { rules: 'F -> F[+F][-F]F', rootIterations: 3, angle: 35, step: 2, seed: 1,
      direction: 'down' },
    { edge: (a, b) => connectAt(tree, grid, a, b) });

  assert.ok(res.ok, res.error);
  assert.ok(tree.nodes.length > 1, 'no roots grew');

  // Every root node is at or below the horizon — none surface.
  for (const n of tree.nodes) {
    assert.ok(grid.point(n.gi).y >= horizon, `root node ${n.id} came up above ground`);
  }
  // And the system genuinely descends rather than running flat.
  const deepest = Math.max(...tree.nodes.map((n) => grid.point(n.gi).y));
  assert.ok(deepest > horizon + grid.spacing * 2, 'roots should reach well down');
});

test('a root tip grows downward, a canopy tip upward', () => {
  const grid = makeGrid({ type: 'square', width: 1400, height: 1200, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(700, 600);
  addNodeAt(tree, grid, start);
  const horizon = tree.horizonY;

  // One branch up, one root down.
  generate(grid, start, { rules: 'F -> F[+F][-F]F', iterations: 2, angle: 35, step: 2, seed: 1 },
    { edge: (a, b) => connectAt(tree, grid, a, b) });
  generate(grid, start, { rules: 'F -> F[+F][-F]F', rootIterations: 2, angle: 35, step: 2,
    seed: 1, direction: 'down' }, { edge: (a, b) => connectAt(tree, grid, a, b) });

  const before = new Set(tree.nodes.map((n) => n.id));
  const m = metrics(tree);
  extendTips(grid, tree, m,
    { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, seed: 3, growChance: 1, rootGrowChance: 1 },
    { edge: (a, b) => connectAt(tree, grid, a, b) });

  // New growth must respect the side of the horizon it started on.
  const fresh = tree.nodes.filter((n) => !before.has(n.id));
  assert.ok(fresh.length > 0, 'nothing grew');
  const m2 = metrics(tree);
  for (const n of fresh) {
    const p = grid.point(n.gi);
    const parent = m2.parent.get(n.id);
    if (!parent) continue;
    const pp = grid.point(nodeById(tree, parent).gi);
    // A node whose parent is underground must not surface.
    if (pp.y > horizon) {
      assert.ok(p.y >= horizon, `root growth surfaced at ${n.id}`);
    }
  }
});

test('roots put on growth more slowly than branches', () => {
  const build = () => {
    const grid = makeGrid({ type: 'square', width: 1600, height: 1400, spacing: 20 });
    const tree = makeTree();
    const start = grid.nearest(800, 700);
    addNodeAt(tree, grid, start);
    generate(grid, start, { rules: 'F -> F[+F][-F]F', iterations: 3, angle: 35, step: 2, seed: 1 },
      { edge: (a, b) => connectAt(tree, grid, a, b) });
    generate(grid, start, { rules: 'F -> F[+F][-F]F', rootIterations: 3, angle: 35, step: 2,
      seed: 1, direction: 'down' }, { edge: (a, b) => connectAt(tree, grid, a, b) });
    return { grid, tree };
  };

  const sides = (grid, tree, ids) => {
    let up = 0, down = 0;
    for (const id of ids) {
      const n = nodeById(tree, id);
      if (!n) continue;
      if (grid.point(n.gi).y > tree.horizonY) down += 1; else up += 1;
    }
    return { up, down };
  };

  // Same roll for every tip, so the only thing separating branches from roots
  // is the threshold each is held to.
  const { grid, tree } = build();
  const m = metrics(tree);
  const start = sides(grid, tree, m.terminal);
  assert.ok(start.up > 0 && start.down > 0, 'fixture needs tips on both sides');

  const grew = { up: 0, down: 0 };
  extendTips(grid, tree, m,
    { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, seed: 2,
      growChance: 1, rootGrowChance: 0, roll: () => 0.5 },
    { edge: (from) => {
        const p = grid.point(from);
        if (p.y > tree.horizonY) grew.down += 1; else grew.up += 1;
      } });

  // At rootGrowChance 0 the roots must sit the year out while branches grow.
  assert.ok(grew.up > 0, 'branches should have grown');
  assert.equal(grew.down, 0, 'roots grew despite a zero root chance');

  // And with both thresholds equal, roots do grow — so the difference is the
  // rate, not a blanket refusal.
  const second = build();
  const m2 = metrics(second.tree);
  let rootGrowth = 0;
  extendTips(second.grid, second.tree, m2,
    { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, seed: 2,
      growChance: 1, rootGrowChance: 1, roll: () => 0.5 },
    { edge: (from) => {
        if (second.grid.point(from).y > second.tree.horizonY) rootGrowth += 1;
      } });
  assert.ok(rootGrowth > 0, 'roots should grow when allowed to');
});

test('the trunk ignores the root system', () => {
  const grid = makeGrid({ type: 'square', width: 1400, height: 1200, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(700, 600);
  addNodeAt(tree, grid, start);
  // A deliberately large root system against a small canopy.
  generate(grid, start, { rules: 'F -> F[+F][-F]F', iterations: 2, angle: 35, step: 2, seed: 1 },
    { edge: (a, b) => connectAt(tree, grid, a, b) });
  generate(grid, start, { rules: 'F -> F[+F][-F]F', rootIterations: 4, angle: 35, step: 2,
    seed: 1, direction: 'down' }, { edge: (a, b) => connectAt(tree, grid, a, b) });

  const m = metrics(tree);
  const path = trunkPath(tree, m, { minOrder: 1, grid });
  assert.ok(path.length > 1);
  for (const id of path) {
    assert.ok(
      grid.point(nodeById(tree, id).gi).y <= tree.horizonY,
      'the trunk dived into the roots'
    );
  }

  // Roots bear no foliage, whatever else happens.
  const objects = buildFoliage({ rules: {} }, grid, tree, m, 7);
  for (const o of objects) assert.ok(o.y <= tree.horizonY, 'foliage grew underground');
});

// ---------- maturing ----------

test('matured wood sheds its fine twigs but keeps its limbs', () => {
  //  r - a - b, with b thick. b carries one lone twig and one real limb (L1),
  //  and L1's own branches are long enough to count as limbs themselves.
  const tree = makeTree();
  const ids = ['r', 'a', 'b', 't', 'L1',
    'c1', 'c2', 'c3', 'c4', 'd1', 'd2', 'd3', 'd4'];
  tree.nodes = ids.map((id, i) => ({ id, gi: i }));
  tree.edges = [
    ['r', 'a'], ['a', 'b'],
    ['b', 't'],                 // a lone twig on thick wood
    ['b', 'L1'],
    ['L1', 'c1'], ['c1', 'c2'], ['c2', 'c3'], ['c3', 'c4'],
    ['L1', 'd1'], ['d1', 'd2'], ['d2', 'd3'], ['d3', 'd4'],
  ];
  tree.rootId = 'r';

  const m = metrics(tree);
  assert.ok(m.strahler.get('b') >= 2, 'b should read as matured wood');
  assert.equal(m.strahler.get('t'), 1, 't is a twig');
  assert.equal(m.subtree.get('c1'), 4, 'c1 is a limb by length');

  const cut = pruneMatureTwigs(tree, { matureOrder: 2, maxTwig: 3, metrics: m });
  assert.equal(cut, 1, 'only the lone twig should go');
  assert.equal(nodeById(tree, 't'), null, 'the twig survived');
  for (const kept of ['L1', 'c1', 'c4', 'd1', 'd4']) {
    assert.ok(nodeById(tree, kept), `${kept} was culled but is a limb`);
  }
  assert.equal(metrics(tree).order.length, tree.nodes.length, 'pruning fragmented the tree');
});

test('a twig is judged by its length, not just its order', () => {
  // Same shape, but now L1's branches are short — so they are twigs too, and
  // mature wood sheds them as well. Order alone would keep them.
  const tree = makeTree();
  tree.nodes = ['r', 'a', 'b', 'L1', 'c1', 'd1'].map((id, i) => ({ id, gi: i }));
  tree.edges = [['r', 'a'], ['a', 'b'], ['b', 'L1'], ['L1', 'c1'], ['L1', 'd1']];
  tree.rootId = 'r';

  assert.equal(metrics(tree).strahler.get('L1'), 2, 'L1 forks, so it is order 2');
  const cut = pruneMatureTwigs(tree, { matureOrder: 2, maxTwig: 3 });
  assert.equal(cut, 2, 'both short branches should be shed');
  assert.ok(nodeById(tree, 'L1'), 'the fork itself stays');
  assert.equal(metrics(tree).order.length, tree.nodes.length);
});

test('pruning is off below the threshold and never takes the whole tree', () => {
  const { tree } = fixture();
  const before = tree.nodes.length;
  assert.equal(pruneMatureTwigs(tree, { matureOrder: 0 }), 0, 'rule off means no cull');
  assert.equal(pruneMatureTwigs(tree, { matureOrder: 1 }), 0, 'order 1 would cull everything');
  assert.equal(tree.nodes.length, before);

  // Even at its most aggressive, the root and the structure survive.
  pruneMatureTwigs(tree, { matureOrder: 2, maxTwig: 99 });
  assert.ok(nodeById(tree, tree.rootId), 'the root was culled');
  assert.ok(tree.nodes.length > 1, 'pruning took the whole tree');
  assert.equal(metrics(tree).order.length, tree.nodes.length);
});

test('a growing tree renews rather than only accreting', () => {
  const run = (cullOrder) => {
    const grid = makeGrid({ type: 'square', width: 3400, height: 2600, spacing: 20 });
    const tree = makeTree();
    const start = grid.nearest(1700, 2200);
    addNodeAt(tree, grid, start);
    generate(grid, start,
      { rules: 'F -> F[+F][-F]F', iterations: 4, angle: 35, step: 2, seed: 3, jitter: 35 },
      { edge: (a, b) => connectAt(tree, grid, a, b) });
    let shed = 0;
    for (let y = 1; y <= 8; y++) {
      extendTips(grid, tree, metrics(tree),
        { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, seed: 3 + y, jitter: 35,
          growChance: 0.65, rootGrowChance: 0.3, balance: 0.8,
          roll: (id) => objRng(3 + y, id, 'grow')() },
        { edge: (a, b) => connectAt(tree, grid, a, b) });
      if (cullOrder) shed += pruneMatureTwigs(tree, { matureOrder: cullOrder, maxTwig: 3 });
    }
    const m = metrics(tree);
    // Fine twigs still hanging off thick wood — the clutter inside the crown
    // that shedding exists to take away.
    let clutter = 0;
    for (const node of tree.nodes) {
      if ((m.strahler.get(node.id) || 1) < 3) continue;
      for (const c of m.children.get(node.id) || []) {
        if ((m.strahler.get(c) || 1) === 1 && (m.subtree.get(c) || 1) <= 3) clutter += 1;
      }
    }
    return { shed, clutter, nodes: tree.nodes.length, whole: m.order.length === tree.nodes.length };
  };

  const kept = run(0);
  const shedding = run(3);
  assert.equal(kept.shed, 0);
  assert.ok(shedding.shed > 0, 'nothing was shed over eight years');
  assert.ok(shedding.whole, 'pruning fragmented a grown tree');

  // What shedding is for, measured where it happens: heavy wood carrying a
  // fringe of twigs. Not max Strahler order — both trees run to the same node
  // budget, and the shedding one spends it on limbs instead of that fringe,
  // so its order reads *higher* while its crown is the open one.
  assert.ok(kept.clutter > 0, 'the un-shed tree should be cluttered with twigs');
  assert.ok(shedding.clutter < kept.clutter / 4,
    'shedding left the inside of the crown as cluttered as not shedding at all');
});

// ---------- shed limbs fall ----------

test('discovery and removal agree on what comes away', () => {
  const tree = makeTree();
  tree.nodes = ['r','a','b','t','u','L1','c1','c2','c3','c4']
    .map((id, i) => ({ id, gi: i }));
  tree.edges = [
    ['r','a'], ['a','b'], ['b','t'], ['t','u'],
    ['b','L1'], ['L1','c1'], ['c1','c2'], ['L1','c3'], ['c3','c4'],
  ];
  tree.rootId = 'r';

  const opts = { matureOrder: 2, maxTwig: 3 };
  const roots = findMatureTwigs(tree, opts);
  assert.ok(roots.length > 0, 'nothing was identified to shed');

  // Everything in those subtrees, which is what winter has to drop.
  const doomed = twigNodes(tree, roots);
  for (const id of roots) assert.ok(doomed.has(id));
  assert.ok(doomed.has('u'), 'a twig\'s own child must fall with it');

  // And it matches exactly what pruning then removes.
  const copy = JSON.parse(JSON.stringify(tree));
  const removed = pruneMatureTwigs(copy, opts);
  assert.equal(removed, doomed.size, 'winter would drop a different set than spring removes');
  for (const id of doomed) assert.equal(nodeById(copy, id), null, `${id} survived`);
});

test('falling limbs follow the same trajectory as leaves, but heavier', () => {
  const branches = [
    { id: 'a|b', x: 100, y: 100, rot: 0, depth: 6 },
    { id: 'c|d', x: 200, y: 140, rot: 0, depth: 2 },
  ];
  const { entries, duration } = planBranchFall(branches, 7);
  assert.equal(entries.size, 2);
  assert.ok(duration > 0);

  // Deepest first, same order the leaves drop in.
  assert.ok(
    entries.get('a|b').delay < entries.get('c|d').delay,
    'the outermost limb should let go first'
  );

  const entry = entries.get('a|b');
  const at = (u) => frameState(branches[0], entry, entry.delay + entry.dur * u, { horizonY: 400 });

  // Descends to the ground line and fades before reaching it.
  assert.ok(at(0.5).dy > 0 && at(1).dy > at(0.5).dy, 'a limb should descend');
  assert.equal(at(1).opacity, 0, 'it should be gone by the end');

  // A limb is heavier than a leaf: it sways less and spins less.
  const leafLike = planTransition(
    [{ id: 'a|b', kind: 'leaf', depth: 6, rot: 0 }], 'fall', 'winter', 7
  ).entries.get('a|b');
  assert.ok(entry.p.amp < leafLike.p.amp, 'a limb should sway less than a leaf');
  assert.ok(Math.abs(entry.p.spin) < Math.abs(leafLike.p.spin), 'a limb should spin less');
});

test('nothing falls when the tree is not growing', () => {
  // planBranchFall is only ever given limbs that are actually being shed.
  const { entries, duration } = planBranchFall([], 3);
  assert.equal(entries.size, 0);
  assert.equal(duration, 0);
});

// ---------- framing ----------

test('the view frames the tree, not the empty world', () => {
  const grid = makeGrid({ type: 'square', width: 3000, height: 2400, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(1500, 2000);
  addNodeAt(tree, grid, start);
  generate(grid, start, { rules: 'F -> F[+F][-F]F', iterations: 4, angle: 35, step: 2, seed: 1 },
    { edge: (a, b) => connectAt(tree, grid, a, b) });

  const frame = frameFor(tree, grid, { canopyLayers: 2 });

  // Every node is inside the frame.
  for (const n of tree.nodes) {
    const p = grid.point(n.gi);
    assert.ok(p.x >= frame.x && p.x <= frame.x + frame.w, 'a node fell outside the frame');
    assert.ok(p.y >= frame.y && p.y <= frame.y + frame.h, 'a node fell outside the frame');
  }

  // It is tighter than the world it sits in — that is the whole point.
  assert.ok(frame.w < grid.width, 'the frame should crop the world');
  assert.ok(frame.h < grid.height, 'the frame should crop the world');

  // Vertically centred on the tree, so a canopy-heavy tree is not left with
  // half a frame of empty ground below it.
  const ys = tree.nodes.map((n) => grid.point(n.gi).y);
  const treeMid = (Math.min(...ys) + Math.max(...ys)) / 2;
  const frameMid = frame.y + frame.h / 2;
  assert.ok(
    Math.abs(frameMid - treeMid) < frame.h * 0.1,
    'the frame should sit on the tree, not the world'
  );

  // The canvas keeps its shape on the page; only the zoom changes.
  assert.ok(
    Math.abs(frame.w / frame.h - grid.width / grid.height) < 0.01,
    'framing must preserve the aspect ratio'
  );
});

test('framing degrades gracefully on an empty or single-node tree', () => {
  const grid = makeGrid({ type: 'square', width: 900, height: 600, spacing: 30 });
  const empty = frameFor(makeTree(), grid, {});
  assert.deepEqual(empty, { x: 0, y: 0, w: 900, h: 600 }, 'an empty tree shows the world');

  const one = makeTree();
  addNodeAt(one, grid, grid.nearest(450, 450));
  assert.deepEqual(frameFor(one, grid, {}), { x: 0, y: 0, w: 900, h: 600 });
});

test('a wider tree gets a wider frame', () => {
  const grid = makeGrid({ type: 'square', width: 3000, height: 2400, spacing: 20 });
  const build = (iters) => {
    const tree = makeTree();
    const start = grid.nearest(1500, 2000);
    addNodeAt(tree, grid, start);
    generate(grid, start, { rules: 'F -> F[+F][-F]F', iterations: iters, angle: 35, step: 2, seed: 1 },
      { edge: (a, b) => connectAt(tree, grid, a, b) });
    return frameFor(tree, grid, { canopyLayers: 2 });
  };
  assert.ok(build(4).w > build(2).w, 'a bigger tree should get a bigger frame');
});

// ---------- centrality ----------

// Where the trunk sits relative to the middle of the crown, as a share of the
// crown's half-width. 0 is dead centre, 1 is out at the edge.
function trunkOffset(grid, tree) {
  const m = metrics(tree);
  const canopy = tree.nodes
    .map((n) => grid.point(n.gi))
    .filter((p) => p && p.y <= tree.horizonY);
  if (canopy.length < 2) return 0;
  const minX = Math.min(...canopy.map((p) => p.x));
  const maxX = Math.max(...canopy.map((p) => p.x));
  const half = Math.max(1, (maxX - minX) / 2);

  // The stem as it reads: the lower half of the trunk path, before it starts
  // following whichever limb carries on at the top.
  const ids = trunkPath(tree, m, { minOrder: 2, grid });
  const ys = ids.map((id) => grid.point(nodeById(tree, id).gi).y);
  const cut = (Math.max(...ys) + Math.min(...ys)) / 2;
  const base = ids
    .map((id) => grid.point(nodeById(tree, id).gi))
    .filter((p) => p.y >= cut);
  const mean = base.reduce((a, p) => a + p.x, 0) / base.length;
  return (mean - (minX + maxX) / 2) / half;
}

function grown(seed, years, opts = {}) {
  const grid = makeGrid({ type: 'square', width: 3000, height: 2400, spacing: 20 });
  const tree = makeTree();
  const start = grid.nearest(1500, 2000);
  addNodeAt(tree, grid, start);
  const base = { rules: 'F -> F[+F][-F]F', angle: 35, step: 2, jitter: 35, ...opts };
  generate(grid, start, { ...base, iterations: 4, seed },
    { edge: (a, b) => connectAt(tree, grid, a, b) });
  for (let y = 1; y <= years; y++) {
    extendTips(grid, tree, metrics(tree),
      { ...base, seed: seed + y, growChance: 0.65, rootGrowChance: 0.3,
        roll: (id) => objRng(seed + y, id, 'grow')() },
      { edge: (a, b) => connectAt(tree, grid, a, b) });
  }
  return { grid, tree };
}

test('a symmetric grammar builds a symmetric tree with a central trunk', () => {
  const { grid, tree } = grown(1, 0, { jitter: 0 });
  const rootX = grid.point(nodeById(tree, tree.rootId).gi).x;
  const pts = tree.nodes.map((n) => grid.point(n.gi));

  // Every node has a mirror twin about the trunk.
  const key = (x, y) => `${x},${y}`;
  const set = new Set(pts.map((p) => key(p.x, p.y)));
  for (const p of pts) {
    assert.ok(set.has(key(2 * rootX - p.x, p.y)), 'the tree is not mirror-symmetric');
  }
  assert.equal(trunkOffset(grid, tree), 0, 'a symmetric tree must have a centred trunk');
});

test('variation wobbles branches without walking the trunk sideways', () => {
  // Jitter must not accumulate into the heading, or the trunk leans.
  let worst = 0;
  for (let seed = 1; seed <= 12; seed++) {
    worst = Math.max(worst, Math.abs(trunkOffset(...Object.values(grown(seed, 0)))));
  }
  assert.ok(worst < 0.12, `variation pushed the trunk off centre by ${worst.toFixed(3)}`);
});

test('growth keeps the crown around the trunk, however long it runs', () => {
  const measure = (years, balance) => {
    let worst = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { grid, tree } = grown(seed, years, { balance });
      worst = Math.max(worst, Math.abs(trunkOffset(grid, tree)));
    }
    return worst;
  };

  // Unchecked, drift compounds with every year of growth.
  const loose8 = measure(8, 0);
  const held8 = measure(8, 0.8);
  assert.ok(held8 < loose8, `balancing should reduce drift (${held8} vs ${loose8})`);

  // The point of a limit rather than a nudge: it does not keep getting worse.
  const held12 = measure(12, 0.8);
  assert.ok(held12 <= held8 + 0.02, `drift kept growing: ${held8} -> ${held12}`);
  assert.ok(held12 < 0.3, `trunk drifted too far off centre: ${held12.toFixed(3)}`);
});

// ---------- trunk ----------

test('the trunk follows the dominant branch at every fork', () => {
  //        r - a - b - { c - d - e,  f }
  // The c-branch is longer and carries more nodes, so it is the main stem.
  const tree = makeTree();
  tree.nodes = ['r','a','b','c','d','e','f'].map((id, i) => ({ id, gi: i }));
  tree.edges = [['r','a'],['a','b'],['b','c'],['c','d'],['d','e'],['b','f']];
  tree.rootId = 'r';

  assert.deepEqual(trunkPath(tree), ['r','a','b','c','d','e']);
});

test('the trunk prefers Strahler order over raw length', () => {
  // r - a - { b - {c, d}  (a fork, so Strahler 2),  e - f - g - h (longer) }
  const tree = makeTree();
  tree.nodes = ['r','a','b','c','d','e','f','g','h'].map((id, i) => ({ id, gi: i }));
  tree.edges = [
    ['r','a'], ['a','b'], ['b','c'], ['b','d'],
    ['a','e'], ['e','f'], ['f','g'], ['g','h'],
  ];
  tree.rootId = 'r';

  const m = metrics(tree);
  assert.equal(m.strahler.get('b'), 2, 'the forked side is order 2');
  assert.equal(m.strahler.get('e'), 1, 'the straight side stays order 1');

  // The e-branch is longer, but b carries the higher order — the main
  // channel of a branching network follows order, not length.
  const path = trunkPath(tree, m);
  assert.deepEqual(path.slice(0, 3), ['r','a','b']);
  assert.ok(!path.includes('e'), 'trunk took the longer but thinner branch');
});

test('the trunk is stable and well formed', () => {
  const { tree } = fixture();
  const m = metrics(tree);
  const path = trunkPath(tree, m);

  assert.ok(path.length > 1);
  assert.equal(path[0], tree.rootId, 'the trunk starts at the root');
  assert.equal(new Set(path).size, path.length, 'the trunk revisits a node');

  // Every consecutive pair is a real parent-child edge.
  for (let i = 1; i < path.length; i++) {
    assert.equal(m.parent.get(path[i]), path[i - 1], 'trunk is not a path');
  }
  // It runs all the way to a tip.
  assert.equal((m.children.get(path[path.length - 1]) || []).length, 0);

  // Deterministic across repeated calls and fresh metrics.
  assert.deepEqual(path, trunkPath(tree));
  assert.deepEqual(path, trunkPath(tree, metrics(tree)));

  assert.deepEqual(trunkPath(makeTree()), []);
});

test('subtree sizes are counted correctly', () => {
  const { tree } = fixture();
  const m = metrics(tree);
  assert.equal(m.subtree.get(tree.rootId), tree.nodes.length, 'root covers the tree');
  for (const id of m.terminal) assert.equal(m.subtree.get(id), 1);
});

test('the trunk is bare except for its tip', () => {
  const { grid, tree } = fixture();
  const m = metrics(tree);
  const minOrder = 2;
  const trunk = trunkPath(tree, m, { minOrder });
  const tip = trunk[trunk.length - 1];
  const bare = new Set(trunk.slice(0, -1));
  const bareCells = new Set([...bare].map((id) => nodeById(tree, id).gi));

  const objects = buildFoliage(
    { rules: { placement: { trunkMinOrder: minOrder } } }, grid, tree, m, 7
  );
  assert.ok(objects.length > 0, 'the rest of the tree still grows');

  // Everything below the tip stays wood, and no neighbour's ring covers it.
  for (const o of objects) {
    assert.ok(!bare.has(o.nodeId), `trunk node ${o.nodeId} produced foliage`);
    assert.ok(!bareCells.has(o.gi), 'foliage grew over a bare trunk cell');
  }

  // The tip is where the stem becomes a growing shoot, so it is *eligible*.
  // Whether it actually grows is still a seeded roll — at this threshold the
  // tip is an interior node, so it only takes the interior chance. Prove
  // eligibility across seeds rather than demanding it grow on any one, while
  // checking the bare stem below stays empty on every seed.
  let tipGrewSomewhere = false;
  for (let seed = 1; seed <= 25; seed++) {
    const set = buildFoliage(
      { rules: { placement: { trunkMinOrder: minOrder } } }, grid, tree, m, seed
    );
    if (set.some((o) => o.nodeId === tip)) tipGrewSomewhere = true;
    for (const o of set) {
      assert.ok(!bare.has(o.nodeId), `seed ${seed}: bare stem grew foliage`);
      assert.ok(!bareCells.has(o.gi), `seed ${seed}: foliage covered a bare trunk cell`);
    }
  }
  assert.ok(tipGrewSomewhere, 'the final trunk node was never able to grow');

  // Turning the rule off puts foliage back on the whole stem.
  const unbare = buildFoliage(
    { rules: { placement: { trunkBare: false, trunkMinOrder: minOrder } } }, grid, tree, m, 7
  );
  assert.ok(unbare.length > objects.length, 'trunkBare:false should add foliage');
  assert.ok(unbare.some((o) => bare.has(o.nodeId)), 'stem should grow when allowed');
});

test('a one-node trunk is all tip', () => {
  // A root with two equal branches still yields a trunk; whatever its last
  // node is must remain eligible rather than being silently excluded.
  const grid = makeGrid({ type: 'square', width: 600, height: 400, spacing: 20 });
  const tree = makeTree();
  addNodeAt(tree, grid, grid.nearest(300, 340));
  const m0 = metrics(tree);
  assert.deepEqual(trunkPath(tree, m0), [tree.rootId]);

  // slice(0, -1) on a single-element path leaves nothing bare.
  const objects = buildFoliage({ rules: {} }, grid, tree, m0, 7);
  assert.deepEqual(objects, [], 'a lone root is still below minDepth');
});

test('the Strahler threshold sets where the trunk ends', () => {
  const { tree } = fixture();
  const m = metrics(tree);
  let maxOrder = 0;
  for (const v of m.strahler.values()) maxOrder = Math.max(maxOrder, v);
  assert.ok(maxOrder >= 2, 'fixture needs a real fork to test against');

  const full = trunkPath(tree, m, { minOrder: 1 });
  assert.deepEqual(full, trunkPath(tree, m), 'minOrder defaults to 1');
  assert.equal(m.strahler.get(full[full.length - 1]), 1, 'at 1 the trunk reaches a twig');

  // Raising the threshold can only shorten the trunk, never lengthen it, and
  // each trunk is a prefix of the looser one.
  let prev = full;
  for (let k = 2; k <= maxOrder; k++) {
    const path = trunkPath(tree, m, { minOrder: k });
    assert.ok(path.length <= prev.length, `order ${k} lengthened the trunk`);
    assert.deepEqual(path, prev.slice(0, path.length), `order ${k} is not a prefix`);

    // Every node on it is at least that thick, and it ends on its last thick one.
    for (const id of path.slice(1)) {
      assert.ok(m.strahler.get(id) >= k, `order ${k} kept a thinner node`);
    }
    assert.equal(m.strahler.get(path[path.length - 1]), k >= maxOrder ? maxOrder : k,
      `order ${k} stopped at the wrong node`);
    prev = path;
  }

  // Above the tree's own maximum, only the root survives — a trunk always
  // exists, even when nothing qualifies.
  const beyond = trunkPath(tree, m, { minOrder: maxOrder + 3 });
  assert.deepEqual(beyond, [tree.rootId]);

  // Nonsense input falls back to the full path rather than throwing.
  assert.deepEqual(trunkPath(tree, m, { minOrder: 0 }), full);
  assert.deepEqual(trunkPath(tree, m, { minOrder: NaN }), full);
});

test('a shorter trunk frees more of the stem to grow', () => {
  const { grid, tree } = fixture();
  const m = metrics(tree);
  const leaves = (k) =>
    buildFoliage({ rules: { placement: { trunkMinOrder: k } } }, grid, tree, m, 7).length;

  // A higher threshold ends the trunk lower, so more stem behaves like an
  // ordinary branch and bears foliage.
  assert.ok(leaves(3) >= leaves(2), 'raising the threshold should not lose foliage');
  assert.ok(leaves(2) >= leaves(1), 'raising the threshold should not lose foliage');
});

test('the drawn trunk matches the threshold the rules used', () => {
  const { grid, tree } = fixture();
  const m = metrics(tree);

  for (const minOrder of [1, 2, 3]) {
    const drawn = branchNodes(tree, grid, objectEl, m, { trunkMinOrder: minOrder })
      .filter((n) => n.attrs.class.includes('tg-branch-trunk')).length;

    const path = trunkPath(tree, m, { minOrder });
    const onPath = new Set(path);
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    let expected = 0;
    for (const [a, b] of tree.edges) {
      const pa = grid.point(byId.get(a).gi);
      const pb = grid.point(byId.get(b).gi);
      const below = tree.horizonY != null && pa.y > tree.horizonY && pb.y > tree.horizonY;
      if (onPath.has(a) && onPath.has(b) && !below) expected++;
    }
    assert.equal(drawn, expected, `order ${minOrder}: drawn trunk disagrees with the rule`);
  }
});

test('the trunk is drawn as its own kind of branch', () => {
  const { grid, tree } = fixture();
  const nodes = branchNodes(tree, grid, objectEl);
  const trunkLines = nodes.filter((n) => n.attrs.class.includes('tg-branch-trunk'));
  assert.ok(trunkLines.length > 0, 'no trunk edges were marked');

  // Only edges with both ends on the trunk are marked.
  const trunk = new Set(trunkPath(tree));
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  let expected = 0;
  for (const [a, b] of tree.edges) {
    const pa = grid.point(byId.get(a).gi);
    const pb = grid.point(byId.get(b).gi);
    const below = tree.horizonY != null && pa.y > tree.horizonY && pb.y > tree.horizonY;
    if (trunk.has(a) && trunk.has(b) && !below) expected++;
  }
  assert.equal(trunkLines.length, expected);
});

// ---------- foliage ----------

test('foliage is reproducible and respects the placement rules', () => {
  const { grid, tree } = fixture();
  const m = metrics(tree);
  const doc = { rules: {} };

  const a = buildFoliage(doc, grid, tree, m, 7);
  const b = buildFoliage(doc, grid, tree, m, 7);
  assert.ok(a.length > 0);
  assert.deepEqual(a, b, 'same seed must give a byte-identical object set');

  // canopyOnly: nothing below the horizon.
  for (const o of a) assert.ok(o.y <= tree.horizonY, 'foliage grew below the horizon');
  // minDepth: nothing on the trunk.
  for (const o of a) assert.ok(o.depth >= 2);
  // One leaf per cell: IDs are cell-keyed, so nothing double-stacks.
  assert.equal(new Set(a.map((o) => o.id)).size, a.length);
  const leaves = a.filter((o) => o.kind === 'leaf');
  assert.equal(new Set(leaves.map((o) => o.gi)).size, leaves.length,
    'two leaves landed in one cell');
  for (const o of leaves) assert.equal(o.id, `c${o.gi}`);
});

test('a new year re-rolls the canopy but stays reproducible', () => {
  const { grid, tree } = fixture();
  const m = metrics(tree);
  const doc = { rules: {} };

  const y1 = buildFoliage(doc, grid, tree, m, 7);
  const y2 = buildFoliage(doc, grid, tree, m, 8);
  assert.notDeepEqual(y1, y2, 'seed + year must change the canopy');
  assert.deepEqual(y2, buildFoliage(doc, grid, tree, m, 8), 'each year is reproducible');
});

test('tone is palette-blind; palette substitution is a separate stage', () => {
  const { grid, tree } = fixture();
  const objects = buildFoliage({ rules: {} }, grid, tree, metrics(tree), 7);
  const tones = objects.map((o) => o.tone);

  for (const name of PALETTE_NAMES) {
    const colors = resolveColors(objects, 'summer', name, 7);
    assert.equal(colors.size, objects.length);
    for (const c of colors.values()) assert.match(c, /^#[0-9a-f]{6}$/i);
  }
  assert.deepEqual(objects.map((o) => o.tone), tones, 'palette work must not touch tone');
});

test('autumn is the palette stage re-run, nothing more', () => {
  const { grid, tree } = fixture();
  const objects = buildFoliage({ rules: {} }, grid, tree, metrics(tree), 7);
  const leaf = objects.find((o) => o.kind === 'leaf');

  const byS = {};
  for (const s of SEASONS) byS[s] = evaluateSeason(objects, s, 'orchard', 7).colors.get(leaf.id);

  // Spring and summer read the same swatch list, so a leaf holds one colour.
  assert.equal(byS.spring, byS.summer, 'spring and summer must not differ in colour');
  // Fall switches the list — the single visible recolouring.
  assert.notEqual(byS.fall, byS.spring);
  // Winter leaves fall in their autumn colour.
  assert.equal(byS.fall, byS.winter);

  assert.equal(listNameFor('leaf', 'spring'), 'leaf');
  assert.equal(listNameFor('leaf', 'fall'), 'fall');
});

test('object identity persists across all four seasons', () => {
  const { grid, tree } = fixture();
  const objects = buildFoliage({ rules: {} }, grid, tree, metrics(tree), 7);
  const leaves = new Set(objects.filter((o) => o.kind === 'leaf').map((o) => o.id));
  assert.ok(leaves.size > 0);

  for (const s of SEASONS) {
    const ev = evaluateSeason(objects, s, 'orchard', 7);
    const got = new Set(ev.visible.filter((o) => o.kind === 'leaf').map((o) => o.id));
    assert.deepEqual([...got].sort(), [...leaves].sort(), `leaf set changed in ${s}`);
  }

  // Blossom is summer-only; fruit carries into fall.
  assert.equal(isPresent('blossom', 'spring'), false);
  assert.equal(isPresent('blossom', 'summer'), true);
  assert.equal(isPresent('fruit', 'fall'), true);
  assert.equal(isPresent('fruit', 'winter'), false);
});

// ---------- l-system ----------

test('rule parsing accepts both forms and reports errors', () => {
  assert.ok(parseRules('F -> FF').ok);
  assert.ok(parseRules('F = FF').ok);
  assert.ok(parseRules('F -> 0.6 : F[+F] | 0.4 : FF').ok);

  const bad = parseRules('this is not a rule');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /can't read rule/);
  assert.equal(parseRules('').ok, false);
});

test('expansion rewrites and caps runaway growth', () => {
  const { rules } = parseRules('F -> F[+F]');
  assert.equal(expand('F', rules, 0).word, 'F');
  assert.equal(expand('F', rules, 1).word, 'F[+F]');
  assert.equal(expand('F', rules, 2).word, 'F[+F][+F[+F]]');

  const { rules: big } = parseRules('F -> FFFF');
  const out = expand('F', big, 12, { maxWord: 500 });
  assert.ok(out.truncated, 'runaway expansion must be truncated');
  assert.ok(out.word.length <= 600);
});

test('the turtle draws straight segments between lattice points', () => {
  for (const type of GRID_TYPES) {
    const grid = makeGrid({ type, width: 900, height: 600, spacing: 30, seed: 5 });
    const start = grid.nearest(450, 430);
    const { rules } = parseRules('F -> FF[+F][-F]');
    const { word } = expand('F', rules, 3);
    const step = 3;
    const { moves } = turtle(word, grid, start, { angle: 30, step });
    const segment = grid.spacing * step;

    assert.ok(moves.length > 0, `${type} produced no moves`);
    for (const mv of moves) {
      // Both ends are real lattice points...
      const a = grid.point(mv.from);
      const b = grid.point(mv.to);
      assert.ok(a && b, `${type} segment has an off-lattice end`);
      assert.notEqual(mv.from, mv.to, `${type} emitted a zero-length branch`);
      // ...and the span between them is a whole segment, not one cell hop.
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      assert.ok(len <= segment * 1.5, `${type} segment overshot: ${len}`);
      assert.ok(len >= segment * 0.5, `${type} segment fell short: ${len}`);
    }

    // The point of the change: segments span more than one cell.
    const spans = moves.filter((mv) => !grid.adjacent(mv.from, mv.to));
    assert.ok(spans.length > 0, `${type} still stepped cell to cell`);
  }
});

test('a straight run of F produces a straight branch, not a staircase', () => {
  const grid = makeGrid({ type: 'square', width: 900, height: 900, spacing: 30 });
  const start = grid.nearest(450, 800);
  // 20 degrees off vertical has no matching square-lattice direction, which
  // is exactly the case that used to zig-zag.
  const { moves } = turtle('FFFF', grid, start, { angle: 0, step: 3 });
  assert.equal(moves.length, 4);

  const pts = [grid.point(moves[0].from), ...moves.map((mv) => grid.point(mv.to))];
  // Heading starts straight up, so every segment should march upward in a line.
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].y < pts[i - 1].y, 'segments should climb');
    assert.equal(pts[i].x, pts[0].x, 'a vertical run must not drift sideways');
  }
});

test('generate writes into a tree and reports failure without throwing', () => {
  const grid = makeGrid({ type: 'square', width: 900, height: 600, spacing: 30 });
  const tree = makeTree();
  const start = grid.nearest(450, 430);

  const res = generate(
    grid, start,
    { axiom: 'F', rules: 'F -> FF[+F][-F]', iterations: 3, angle: 30, seed: 1 },
    {
      begin: (gi) => addNodeAt(tree, grid, gi),
      edge: (from, to) => connectAt(tree, grid, from, to),
    }
  );

  assert.ok(res.ok, res.error);
  assert.ok(tree.nodes.length > 5);
  // Endpoints on the lattice; the segments between them unconstrained.
  for (const [a, b] of tree.edges) {
    assert.ok(grid.point(nodeById(tree, a).gi), 'edge end is off-lattice');
    assert.ok(grid.point(nodeById(tree, b).gi), 'edge end is off-lattice');
  }
  assert.equal(metrics(tree).order.length, tree.nodes.length, 'generation fragmented the tree');

  const bad = generate(grid, start, { rules: 'nonsense' }, { begin() {}, edge() {} });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

// ---------- render ----------

test('colour interpolation walks between two hexes', () => {
  assert.equal(lerpHex('#000000', '#ffffff', 0), '#000000');
  assert.equal(lerpHex('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(lerpHex('#000000', '#ffffff', 0.5), '#808080');
});

test('transforms rotate cell fills about their own centre', () => {
  const circle = { x: 10, y: 20, rot: 0, shape: 'circle' };
  assert.equal(transformFor(circle, {}), 'translate(10.00 20.00) rotate(0.00) scale(1.000)');
  const cell = { x: 10, y: 20, rot: 0, shape: 'cell' };
  assert.match(transformFor(cell, {}), /translate\(-10\.00 -20\.00\)$/);
});

test('the same drawing code renders headlessly', () => {
  const { grid, tree } = fixture();
  const objects = buildFoliage({ rules: {} }, grid, tree, metrics(tree), 7);
  const colors = resolveColors(objects, 'summer', 'orchard', 7);

  const branches = branchNodes(tree, grid, objectEl);
  assert.equal(branches.length, tree.edges.length);
  for (const b of branches) assert.ok(Number(b.attrs['stroke-width']) >= 1);

  const leaves = foliageNodes(objects, grid, objectEl, { colors });
  assert.equal(leaves.length, objects.length);
  for (const l of leaves) {
    assert.ok(['circle', 'path'].includes(l.tag));
    assert.match(l.attrs.fill, /^#[0-9a-f]{6}$/i);
  }

  const svg = renderToString(tree, grid, objects, { colors });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('tg-branches') && svg.includes('tg-foliage'));
  // Deterministic output for the same inputs.
  assert.equal(svg, renderToString(tree, grid, objects, { colors }));
});

// ---------- cell mapping, layers, and canvas growth ----------

test('foliage lands square on the dot grid at full cell size', () => {
  for (const type of GRID_TYPES) {
    const { grid, tree } = fixture(type);
    const objects = buildFoliage({ rules: {} }, grid, tree, metrics(tree), 7);
    const leaves = objects.filter((o) => o.kind === 'leaf');
    assert.ok(leaves.length > 0, `${type} grew no foliage`);

    for (const o of leaves) {
      const p = grid.point(o.gi);
      // Exactly on the lattice point — no scatter offset.
      assert.equal(o.x, p.x, `${type} leaf drifted off its cell in x`);
      assert.equal(o.y, p.y, `${type} leaf drifted off its cell in y`);
      // Full cell size, and cell fills are never rotated off the grid.
      assert.equal(o.size, grid.cellRadius, `${type} leaf is not full cell size`);
      if (o.shape === 'cell') {
        assert.equal(o.rot, 0, `${type} cell fill was rotated off the grid`);
        assert.ok(o.baseScale == null || o.baseScale === 1, 'cell fills must not be shrunk');
      }
    }
  }
});

test('a cell fill drawn at rest matches the lattice cell exactly', () => {
  const { grid, tree } = fixture();
  const objects = buildFoliage({ rules: {} }, grid, tree, metrics(tree), 7);
  const cellLeaf = objects.find((o) => o.kind === 'leaf' && o.shape === 'cell');
  assert.ok(cellLeaf, 'expected at least one cell-shaped leaf');

  const [node] = foliageNodes([cellLeaf], grid, objectEl, { colors: new Map() });
  assert.equal(node.attrs.d, grid.cellPath(cellLeaf.gi), 'cell path should be the lattice cell');
  // Identity transform — anything else would shift it off the grid.
  assert.match(node.attrs.transform, /rotate\(0\.00\) scale\(1\.000\)/);
});

test('more layers means a fuller canopy', () => {
  const { grid, tree } = fixture();
  const m = metrics(tree);
  const count = (layers) =>
    buildFoliage({ rules: { placement: { layers } } }, grid, tree, m, 7)
      .filter((o) => o.kind === 'leaf').length;

  const zero = count(0);
  const one = count(1);
  const two = count(2);
  const three = count(3);

  assert.ok(zero > 0, 'layer 0 should still put leaves on the branch cells');
  assert.ok(one > zero, 'layer 1 should add leaves');
  assert.ok(two > one, 'layer 2 should add more');
  assert.ok(three > two, 'layer 3 should add more still');

  // Layer 0 means foliage only on cells that actually hold a branch node.
  const nodeCells = new Set(tree.nodes.map((n) => n.gi));
  for (const o of buildFoliage({ rules: { placement: { layers: 0 } } }, grid, tree, m, 7)) {
    assert.ok(nodeCells.has(o.gi), 'layer 0 put a leaf off the branch');
  }

  // Rings never exceed the configured layer count.
  for (const o of buildFoliage({ rules: { placement: { layers: 2 } } }, grid, tree, m, 7)) {
    assert.ok(o.ring <= 2, 'a leaf was claimed beyond its layer budget');
  }
});

test('layer changes never move the tree, only the foliage', () => {
  const { grid, tree } = fixture();
  const before = JSON.stringify(tree);
  buildFoliage({ rules: { placement: { layers: 4 } } }, grid, tree, metrics(tree), 7);
  assert.equal(JSON.stringify(tree), before, 'placement must not mutate the graph');
});

test('treeBounds and needsRoom detect a tree reaching the edge', () => {
  const grid = makeGrid({ type: 'square', width: 600, height: 400, spacing: 20 });
  const tree = makeTree();
  addNodeAt(tree, grid, grid.nearest(300, 300));
  assert.equal(needsRoom(tree, grid, 2), false, 'a centred root has room');

  const b = treeBounds(tree, grid);
  assert.ok(b && b.minX === b.maxX, 'a single node is a degenerate box');
  assert.equal(treeBounds(makeTree(), grid), null);

  // Grow a branch into the top edge.
  addNodeAt(tree, grid, grid.nearest(300, 0));
  assert.equal(needsRoom(tree, grid, 2), true, 'a tree at the edge needs room');
});

test('growing the world keeps the tree centred and intact', () => {
  const grid = makeGrid({ type: 'square', width: 600, height: 400, spacing: 20 });
  const tree = makeTree();
  addNodeAt(tree, grid, grid.nearest(300, 340));
  for (const [x, y] of [[300, 20], [200, 120], [400, 120], [120, 60], [480, 60]]) {
    addNodeAt(tree, grid, grid.nearest(x, y));
  }
  assert.ok(needsRoom(tree, grid, 2), 'fixture should reach the top edge');

  const before = treeBounds(tree, grid);
  const bigger = makeGrid({ type: 'square', width: 780, height: 520, spacing: 20 });
  const moved = remapToGrid(tree, grid, bigger, { dx: 90, dy: 60 });

  // Same structure, node for node and edge for edge.
  assert.equal(moved.nodes.length, tree.nodes.length);
  assert.equal(moved.edges.length, tree.edges.length);
  assert.equal(metrics(moved).order.length, moved.nodes.length, 'the tree fragmented');

  // The tree kept its size and gained clear air on every side.
  const after = treeBounds(moved, bigger);
  assert.ok(Math.abs(after.width - before.width) <= bigger.spacing);
  assert.ok(Math.abs(after.height - before.height) <= bigger.spacing);
  assert.equal(needsRoom(moved, bigger, 2), false, 'growing did not create room');

  // Spacing is unchanged, so this is a genuine zoom-out: more lattice, same cells.
  assert.equal(bigger.spacing, grid.spacing);
  assert.ok(bigger.count > grid.count);
});

test('remapToGrid without an offset is unchanged', () => {
  const { grid, tree } = fixture();
  const other = makeGrid({ type: 'hex', width: 900, height: 600, spacing: 30, seed: 5 });
  assert.deepEqual(remapToGrid(tree, grid, other), remapToGrid(tree, grid, other, { dx: 0, dy: 0 }));
});

// ---------- season transitions ----------

// A transition is planned and evaluated purely, so the motion can be checked
// without a DOM or a real animation clock.
function planned(from, to, seed = 7) {
  const { grid, tree } = fixture();
  const objects = buildFoliage({ rules: {} }, grid, tree, metrics(tree), seed);
  return { objects, tree, grid, ...planTransition(objects, from, to, seed) };
}

test('each transition assigns the right motion to each kind', () => {
  const springward = planned('winter', 'spring');
  for (const o of springward.objects) {
    const mode = springward.entries.get(o.id).mode;
    // Leaves have fallen by winter's end, so spring is a regrowth — not a
    // colour hold. This was a real bug: isPresent('leaf','winter') is true.
    if (o.kind === 'leaf') assert.equal(mode, 'appear', 'spring must regrow leaves');
    else assert.equal(mode, 'absent');
  }

  const summerward = planned('spring', 'summer');
  for (const o of summerward.objects) {
    const mode = summerward.entries.get(o.id).mode;
    assert.equal(mode, o.kind === 'leaf' ? 'hold' : 'appear');
  }

  // Fall is colour only — every surviving object holds, nothing moves.
  const fallward = planned('summer', 'fall');
  for (const o of fallward.objects) {
    const mode = fallward.entries.get(o.id).mode;
    if (o.kind === 'leaf' || o.kind === 'fruit') assert.equal(mode, 'hold');
    else assert.equal(mode, 'vanish', 'blossom does not survive into fall');
  }

  const winterward = planned('fall', 'winter');
  for (const o of winterward.objects) {
    const mode = winterward.entries.get(o.id).mode;
    if (o.kind === 'leaf') assert.equal(mode, 'fall');
  }
});

test('spring staggers ascending by depth, winter descending', () => {
  const spring = planned('winter', 'spring');
  const leaves = spring.objects.filter((o) => o.kind === 'leaf');
  const shallow = leaves.reduce((a, b) => (a.depth <= b.depth ? a : b));
  const deep = leaves.reduce((a, b) => (a.depth >= b.depth ? a : b));
  assert.ok(
    spring.entries.get(shallow.id).delay < spring.entries.get(deep.id).delay,
    'spring should grow from the trunk outward'
  );

  const winter = planned('fall', 'winter');
  assert.ok(
    winter.entries.get(deep.id).delay < winter.entries.get(shallow.id).delay,
    'winter should drop the deepest leaves first'
  );
});

test('the winter fall follows the approved trajectory', () => {
  const { objects, entries, tree } = planned('fall', 'winter');
  const leaf = objects.find((o) => o.kind === 'leaf');
  const entry = entries.get(leaf.id);
  const ctx = { horizonY: tree.horizonY, colorFrom: '#b06224', colorTo: '#b06224' };
  const at = (u) => frameState(leaf, entry, entry.delay + entry.dur * u, ctx);

  // Descent is linear and lands on the horizon.
  const descent = tree.horizonY - leaf.y;
  assert.ok(Math.abs(at(0.5).dy - descent * 0.5) < 1e-6, 'descent should be linear');
  assert.ok(Math.abs(at(1).dy - descent) < 1e-6);

  // Rotation is continuous and monotonic in one direction.
  const rots = [0.2, 0.4, 0.6, 0.8].map((u) => at(u).rot);
  const rising = rots.every((r, i) => i === 0 || r > rots[i - 1]);
  const falling = rots.every((r, i) => i === 0 || r < rots[i - 1]);
  assert.ok(rising || falling, 'rotation should be continuous');

  // Amplitude decays: the sway envelope narrows as it falls.
  const envelope = (u) => entry.p.amp * (1 - WINTER.decay * u);
  assert.ok(envelope(1) < envelope(0), 'sway should narrow toward the ground');
  assert.ok(Math.abs(envelope(1) - entry.p.amp * (1 - WINTER.decay)) < 1e-9);
  for (const u of [0.1, 0.35, 0.7, 1]) {
    assert.ok(Math.abs(at(u).dx) <= envelope(u) + 1e-9, 'sway exceeded its envelope');
  }

  // Sway actually oscillates rather than drifting one way.
  const xs = Array.from({ length: 40 }, (_, i) => at(i / 39).dx);
  let signChanges = 0;
  for (let i = 1; i < xs.length; i++) if (Math.sign(xs[i]) !== Math.sign(xs[i - 1])) signChanges++;
  assert.ok(signChanges >= 2, 'the leaf should swing, not drift');

  // Faded out well before the ground line.
  assert.equal(at(1).opacity, 0);
  assert.equal(at(WINTER.fadeEnd).opacity, 0);
  assert.ok(at(WINTER.fadeStart).opacity > 0.99, 'fading starts only at 60% of the fall');
  const fadeY = descent * WINTER.fadeEnd;
  assert.ok(fadeY < descent, 'leaves must vanish before reaching the horizon');
});

test('winter parameters come from the leaf ID, not its neighbours', () => {
  const a = planned('fall', 'winter', 7);
  const b = planned('fall', 'winter', 7);
  const leaf = a.objects.find((o) => o.kind === 'leaf');
  assert.deepEqual(a.entries.get(leaf.id).p, b.entries.get(leaf.id).p);

  // A different year gives a different fall for the same slot.
  const c = planned('fall', 'winter', 8);
  if (c.entries.has(leaf.id)) {
    assert.notDeepEqual(a.entries.get(leaf.id).p, c.entries.get(leaf.id).p);
  }
});

test('the autumn crossfade walks from the old colour to the new', () => {
  const { objects, entries } = planned('summer', 'fall');
  const leaf = objects.find((o) => o.kind === 'leaf');
  const entry = entries.get(leaf.id);
  const ctx = { colorFrom: '#2f5130', colorTo: '#b06224' };

  assert.equal(frameState(leaf, entry, 0, ctx).color, '#2f5130');
  assert.equal(frameState(leaf, entry, entry.dur, ctx).color, '#b06224');
  const mid = frameState(leaf, entry, entry.dur / 2, ctx).color;
  assert.notEqual(mid, '#2f5130');
  assert.notEqual(mid, '#b06224');
  // Colour only — a hold never moves the object.
  assert.equal(frameState(leaf, entry, entry.dur / 2, ctx).dx, undefined);
});

test('settled state hides fallen leaves and out-of-season objects', () => {
  const leaf = { kind: 'leaf' };
  const blossom = { kind: 'blossom' };
  assert.equal(settledState(leaf, 'summer', '#fff').opacity, 1);
  assert.equal(settledState(leaf, 'winter', '#fff').opacity, 0, 'winter ends with bare branches');
  assert.equal(settledState(blossom, 'summer', '#fff').opacity, 1);
  assert.equal(settledState(blossom, 'spring', '#fff').opacity, 0);
});

// ---------- proof artefact ----------

test('writes a proof SVG for each season', () => {
  const { grid, tree } = fixture();
  const objects = buildFoliage({ rules: {} }, grid, tree, metrics(tree), 7);

  const parts = [];
  for (const season of SEASONS) {
    const ev = evaluateSeason(objects, season, 'orchard', 7);
    const visible = new Set(ev.visible.map((o) => o.id));
    parts.push(
      `<h2>${season}</h2>` +
        renderToString(tree, grid, objects, {
          colors: ev.colors,
          visible,
          showLattice: false,
        })
    );
  }

  const html =
    '<!doctype html><meta charset="utf-8"><title>treegen proof</title>' +
    '<style>body{font-family:sans-serif;margin:2rem;max-width:960px}' +
    'svg{border:1px solid #000;width:100%;height:auto;margin-bottom:2rem}</style>' +
    parts.join('');

  writeFileSync(join(HERE, 'treegen-proof.html'), html);
  assert.ok(parts.every((p) => p.includes('<svg')));
});
