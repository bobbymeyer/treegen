// treegen/render — SVG output and canvas interaction.
//
// The drawing itself is pure: `latticeNodes`, `branchNodes` and
// `foliageNodes` build elements through an injected `el(tag, attrs)` factory
// and never touch the document. `createCanvas` supplies the DOM factory; the
// test suite supplies a plain-object one and serialises the result. One
// renderer, exercised both ways — no second implementation to drift.
//
// Layer order, back to front:
//   lattice    faint dots showing legal positions
//   horizon    the ground line set by the first placed point
//   branches   edges, stroked by Strahler order
//   foliage    leaves / fruit / blossom, one element per stable object ID
//   overlay    node handles and drag targets (authoring chrome, never exported)

import { metrics, trunkPath } from './tree.js';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export const LAYER_ORDER = ['lattice', 'horizon', 'branches', 'foliage', 'overlay'];

// Default factory: real SVG elements.
export function domEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) {
    if (attrs[k] == null) continue;
    node.setAttribute(k, attrs[k]);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// Branch thickness from Strahler order — the tree's own age/thickness proxy,
// so trunks read heavier than twigs without any extra authoring.
//
// Scaled to the lattice rather than fixed in pixels: the world grows as the
// tree does, and a fixed ramp leaves the trunk a hairline once it has zoomed
// out a step or two.
export function strokeFor(order, spacing = 20) {
  return Math.max(1, spacing * (0.05 + (order - 1) * 0.062));
}

// The transform string for a foliage object in a given motion state. Cell
// fills are positioned by their path data, so they rotate and scale about
// their own centre and then translate; everything else translates directly.
export function transformFor(obj, stateOrNull) {
  // Callers legitimately pass null for "settled, no motion", and an explicit
  // null skips a default parameter.
  const state = stateOrNull || {};
  const dx = state.dx || 0;
  const dy = state.dy || 0;
  const rot = state.rot != null ? state.rot : obj.rot || 0;
  // `baseScale` is the object's intrinsic size (a cell fill is authored at
  // full cell size, so it needs shrinking to match its rule-assigned size);
  // the state's scale is animation on top of that. They multiply.
  const base = obj.baseScale != null ? obj.baseScale : 1;
  const scale = base * (state.scale != null ? state.scale : 1);

  const head =
    `translate(${(obj.x + dx).toFixed(2)} ${(obj.y + dy).toFixed(2)}) ` +
    `rotate(${rot.toFixed(2)}) scale(${scale.toFixed(3)})`;

  return obj.shape === 'cell'
    ? `${head} translate(${(-obj.x).toFixed(2)} ${(-obj.y).toFixed(2)})`
    : head;
}

// ---------- Pure builders ----------

// The whole lattice as a single path rather than one element per point.
//
// A dot per point is the obvious implementation and it is what caps how far
// the canvas can zoom out: point count grows with the square of the world, so
// a tree that keeps growing puts tens of thousands of elements in the DOM and
// the zoom has to stop. One path costs the same whatever the count.
export function latticeNodes(grid, el) {
  if (!grid.points.length) return [];
  const r = 1.1;
  let d = '';
  for (const p of grid.points) {
    const x = (p.x - r).toFixed(1);
    const y = (p.y - r).toFixed(1);
    d += `M${x} ${y}h${(r * 2).toFixed(1)}v${(r * 2).toFixed(1)}h-${(r * 2).toFixed(1)}z`;
  }
  return [el('path', { class: 'tg-site', d })];
}

// `extent` lets the ground line span the visible frame rather than the world,
// which matters once the view is cropped to the tree.
export function horizonNodes(tree, grid, el, extent = null) {
  if (tree.horizonY == null) return [];
  const x1 = extent ? extent.x : 0;
  const x2 = extent ? extent.x + extent.w : grid.width;
  return [
    el('line', {
      class: 'tg-horizon-line',
      x1: x1.toFixed(2),
      y1: tree.horizonY.toFixed(2),
      x2: x2.toFixed(2),
      y2: tree.horizonY.toFixed(2),
    }),
  ];
}

// The rectangle the canvas should show: the tree plus breathing room, rather
// than the whole world.
//
// The world grows symmetrically around the tree, but a tree is mostly canopy —
// so framing the world wastes the bottom half on empty ground. This frames
// what is actually there. The frame is widened to the world's aspect ratio so
// the canvas keeps its shape on the page and only the zoom changes.
export function frameFor(tree, grid, opts = {}) {
  const whole = { x: 0, y: 0, w: grid.width, h: grid.height };
  const pts = [];
  for (const n of tree.nodes) {
    const p = grid.point(n.gi);
    if (p) pts.push(p);
  }
  if (pts.length < 2) return whole;

  // Leave room for foliage, which reaches `layers` cells past the branches.
  const pad = grid.spacing * (1.5 + Math.max(0, opts.canopyLayers || 0));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const aspect = grid.height > 0 ? grid.width / grid.height : 1.5;
  let w = Math.max(grid.spacing * 4, maxX - minX);
  let h = Math.max(grid.spacing * 4, maxY - minY);
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

// A stable key for an edge, order-independent.
export function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function branchNodes(tree, grid, el, m = null, opts = {}) {
  if (!tree.nodes.length) return [];
  const stats = m || metrics(tree);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const out = [];

  // Mark the trunk so the most central path reads as the main stem. Both
  // ends of an edge must be on it, or every branch leaving the trunk would
  // inherit the styling.
  const trunk = new Set(trunkPath(tree, stats, { minOrder: opts.trunkMinOrder, grid }));

  for (const [a, b] of tree.edges) {
    const na = byId.get(a);
    const nb = byId.get(b);
    if (!na || !nb) continue;
    const pa = grid.point(na.gi);
    const pb = grid.point(nb.gi);
    if (!pa || !pb) continue;

    // Thickness follows the shallower (older) end of the edge.
    const da = stats.depth.get(a) ?? 0;
    const db = stats.depth.get(b) ?? 0;
    const order = stats.strahler.get(da <= db ? a : b) || 1;
    const below =
      tree.horizonY != null && pa.y > tree.horizonY && pb.y > tree.horizonY;
    const isTrunk = trunk.has(a) && trunk.has(b);

    const cls = below
      ? 'tg-branch tg-branch-root'
      : isTrunk ? 'tg-branch tg-branch-trunk' : 'tg-branch';

    out.push(
      el('line', {
        class: cls,
        x1: pa.x.toFixed(2),
        y1: pa.y.toFixed(2),
        x2: pb.x.toFixed(2),
        y2: pb.y.toFixed(2),
        'stroke-width': strokeFor(order, grid.spacing).toFixed(2),
        'data-edge': edgeKey(a, b),
      })
    );
  }
  return out;
}

// One element per foliage object, with its settled state baked in. `colors`
// is the Map from foliage.resolveColors; `visible` decides initial opacity.
export function foliageNodes(objects, grid, el, opts = {}) {
  const colors = opts.colors || new Map();
  const visible = opts.visible || null;
  const out = [];

  for (const obj of objects) {
    const fill = colors.get(obj.id) || '#888888';
    const opacity = visible && !visible.has(obj.id) ? 0 : 1;

    const attrs = {
      fill,
      opacity,
      transform: transformFor(obj, null),
      'data-id': obj.id,
    };

    if (obj.shape === 'cell') {
      out.push(el('path', { ...attrs, d: grid.cellPath(obj.gi) }));
    } else if (obj.shape === 'path' && obj.d) {
      out.push(el('path', { ...attrs, d: obj.d }));
    } else {
      out.push(el('circle', { ...attrs, r: obj.size.toFixed(2) }));
    }
  }
  return out;
}

export function handleNodes(tree, grid, el) {
  return tree.nodes.map((n) => {
    const p = grid.point(n.gi);
    return el('circle', {
      class: n.id === tree.rootId ? 'tg-handle tg-handle-root' : 'tg-handle',
      cx: p.x.toFixed(2),
      cy: p.y.toFixed(2),
      r: 4.5,
      'data-node': n.id,
    });
  });
}

// ---------- Headless serialisation ----------

// A factory producing plain objects, for tests and any other non-DOM caller.
export function objectEl(tag, attrs = {}) {
  return {
    tag,
    attrs: { ...attrs },
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

function escapeAttr(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

// Serialise a tree of objectEl nodes to an SVG string. A node carrying `raw`
// emits its text verbatim, which is how the <style> block gets through.
export function serialize(node) {
  if (node.raw != null) return node.raw;
  const attrs = Object.entries(node.attrs)
    .filter(([, v]) => v != null)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  if (!node.children.length) return `<${node.tag}${attrs}/>`;
  const inner = node.children.map(serialize).join('');
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

// Build a complete standalone SVG document from engine state, without a DOM.
// Used by the test suite to emit a proof file.
export function renderToString(tree, grid, objects, opts = {}) {
  const el = objectEl;

  // `fit` crops the view to the drawing plus a margin, so a tree that
  // overruns its world is still fully visible. Without it the view is the
  // whole world, which is what the live canvas wants.
  let vb = { x: 0, y: 0, w: grid.width, h: grid.height };
  if (opts.fit) {
    const xs = [];
    const ys = [];
    for (const n of tree.nodes) {
      const p = grid.point(n.gi);
      if (p) { xs.push(p.x); ys.push(p.y); }
    }
    for (const o of objects) { xs.push(o.x); ys.push(o.y); }
    if (xs.length) {
      const pad = typeof opts.fit === 'number' ? opts.fit : grid.spacing * 2;
      const x0 = Math.min(...xs) - pad;
      const y0 = Math.min(...ys) - pad;
      vb = {
        x: x0,
        y: y0,
        w: Math.max(1, Math.max(...xs) + pad - x0),
        h: Math.max(1, Math.max(...ys) + pad - y0),
      };
    }
  }

  const root = el('svg', {
    xmlns: SVG_NS,
    viewBox: `${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ${vb.w.toFixed(1)} ${vb.h.toFixed(1)}`,
    width: Math.round(vb.w),
    height: Math.round(vb.h),
  });

  const style = el('style', {});
  style.children.push({
    tag: null,
    attrs: {},
    children: [],
    raw:
      '.tg-site{fill:rgba(0,0,0,.16)}' +
      '.tg-branch{stroke:#3a3028;stroke-linecap:round;fill:none}' +
      '.tg-branch-trunk{stroke:#2b231c;stroke-linecap:butt}' +
      '.tg-branch-root{stroke:#6b5c4a;stroke-dasharray:3 3}' +
      '.tg-horizon-line{stroke:rgba(0,0,0,.55);stroke-dasharray:5 4}',
  });
  root.appendChild(style);

  root.appendChild(el('rect', { x: vb.x, y: vb.y, width: vb.w, height: vb.h, fill: '#fff' }));

  if (opts.showLattice !== false) {
    const g = el('g', { class: 'tg-lattice' });
    for (const n of latticeNodes(grid, el)) g.appendChild(n);
    root.appendChild(g);
  }

  const gh = el('g', { class: 'tg-horizon' });
  for (const n of horizonNodes(tree, grid, el)) gh.appendChild(n);
  root.appendChild(gh);

  const gb = el('g', { class: 'tg-branches' });
  for (const n of branchNodes(tree, grid, el, null, opts)) gb.appendChild(n);
  root.appendChild(gb);

  const gf = el('g', { class: 'tg-foliage' });
  for (const n of foliageNodes(objects, grid, el, opts)) gf.appendChild(n);
  root.appendChild(gf);

  return serialize(root);
}

// ---------- Interactive canvas ----------

// Create the interactive stage inside `host`.
//
// Callbacks:
//   onAdd(gi)          empty-space click, already snapped to the lattice
//   onMove(id, gi)     node dragged to a new point
//   onDelete(id)       right-click on a node: cut it and everything past it
//   canMoveTo(id, gi)  -> bool, whether that point is free
// The prompt shown on a stage with nothing on it. Sized against the view
// rather than the screen so it holds its proportions as the world grows, and
// set where a seedling would stand — left of centre, above the middle — so it
// reads as a caption on the field rather than a dialog over it.
function emptyHint(grid, frame) {
  const f = frame || { x: 0, y: 0, w: grid.width, h: grid.height };
  const node = domEl('text', {
    class: 'tg-hint',
    x: (f.x + f.w * 0.08).toFixed(1),
    y: (f.y + f.h * 0.46).toFixed(1),
    'font-size': Math.max(11, f.w * 0.03).toFixed(1),
  });
  node.textContent = 'click to plant a seed';
  return node;
}

export function createCanvas(host, callbacks = {}) {
  const svg = domEl('svg', {
    class: 'tg-stage',
    xmlns: SVG_NS,
    preserveAspectRatio: 'xMidYMid meet',
  });

  const layers = {};
  for (const name of LAYER_ORDER) {
    layers[name] = domEl('g', { class: `tg-${name}` });
    svg.appendChild(layers[name]);
  }
  host.appendChild(svg);

  // id -> SVG element, so the animator can address objects directly.
  let foliageEls = new Map();
  // Same for branches, so a shed limb can be dropped rather than vanishing.
  let branchEls = new Map();
  let current = { grid: null, tree: null, objects: [], frame: null };
  let drag = null;

  // Re-frame only when the view no longer suits the drawing. Recomputing on
  // every edit would shift the canvas under the cursor as you place points.
  function applyFrame(next) {
    const cur = current.frame;
    if (cur) {
      const inside =
        next.x >= cur.x && next.y >= cur.y &&
        next.x + next.w <= cur.x + cur.w &&
        next.y + next.h <= cur.y + cur.h;
      const similar = Math.abs(next.w - cur.w) / cur.w < 0.15;
      if (inside && similar) return;
    }
    current.frame = next;
    svg.setAttribute(
      'viewBox',
      `${next.x.toFixed(1)} ${next.y.toFixed(1)} ${next.w.toFixed(1)} ${next.h.toFixed(1)}`
    );
  }

  function fill(layer, nodes) {
    clear(layer);
    const frag = document.createDocumentFragment();
    for (const n of nodes) frag.appendChild(n);
    layer.appendChild(frag);
  }

  // Screen coordinates -> SVG user units.
  function toLocal(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const local = pt.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  }

  // ----- Interaction -----

  // A branch is a straight segment of any length, so a node may be dragged
  // anywhere on the lattice — there is no set of "legal" neighbours to
  // enumerate. One ghost marks the point the drop will snap to.
  function showGhost(gi, grid, ok) {
    clearGhost();
    const p = grid.point(gi);
    if (!p) return;
    layers.overlay.appendChild(
      domEl('circle', {
        class: ok ? 'tg-target is-hot' : 'tg-target is-blocked',
        cx: p.x,
        cy: p.y,
        r: 6,
      })
    );
  }

  function clearGhost() {
    layers.overlay.querySelectorAll('.tg-target').forEach((n) => n.remove());
  }

  svg.addEventListener('pointerdown', (evt) => {
    const { grid } = current;
    if (!grid) return;
    // Right-click is handled on contextmenu; ignore its pointerdown so it
    // can't start a drag.
    if (evt.button === 2) return;
    const handle = evt.target.closest && evt.target.closest('[data-node]');

    if (handle) {
      evt.preventDefault();
      const id = handle.getAttribute('data-node');
      drag = { id, best: null, moved: false };
      svg.classList.add('is-dragging');
      // Capture is a nicety — it keeps the drag alive if the cursor leaves the
      // stage. It throws for a pointer the browser isn't tracking, and losing
      // the whole drag over that would be worse than losing the capture.
      try {
        svg.setPointerCapture(evt.pointerId);
      } catch (err) {
        /* not a live pointer; drag still works */
      }
      return;
    }

    const { x, y } = toLocal(evt);
    if (callbacks.onAdd) callbacks.onAdd(grid.nearest(x, y));
  });

  svg.addEventListener('pointermove', (evt) => {
    if (!drag) return;
    const { grid } = current;
    const { x, y } = toLocal(evt);
    drag.moved = true;

    const gi = grid.nearest(x, y);
    if (gi === drag.best) return;
    drag.best = gi;
    const free = callbacks.canMoveTo ? callbacks.canMoveTo(drag.id, gi) : true;
    showGhost(gi, grid, free);
  });

  function endDrag(evt) {
    if (!drag) return;
    const { id, best, moved } = drag;
    drag = null;
    svg.classList.remove('is-dragging');
    clearGhost();
    try {
      if (evt && svg.hasPointerCapture && svg.hasPointerCapture(evt.pointerId)) {
        svg.releasePointerCapture(evt.pointerId);
      }
    } catch (err) {
      /* never held it */
    }
    if (moved && best != null && callbacks.onMove) callbacks.onMove(id, best);
  }

  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  // Right-click a node to cut it and everything beyond it. Always swallow the
  // browser menu over the stage, so a mis-aimed right-click doesn't dump the
  // context menu over the drawing.
  svg.addEventListener('contextmenu', (evt) => {
    evt.preventDefault();
    const handle = evt.target.closest && evt.target.closest('[data-node]');
    if (!handle) return;
    if (drag) {
      drag = null;
      svg.classList.remove('is-dragging');
      clearGhost();
    }
    if (callbacks.onDelete) callbacks.onDelete(handle.getAttribute('data-node'));
  });

  // ----- Public surface -----

  return {
    svg,
    layers,

    // Full redraw of everything except foliage.
    // `opts.trunkMinOrder` must match what the placement rules used, or the
    // bare stretch of stem and the stem that is *drawn* as trunk disagree.
    setStructure(tree, grid, opts = {}) {
      current.tree = tree;
      current.grid = grid;
      // Frame the tree, not the world, so the view isn't half empty ground.
      applyFrame(frameFor(tree, grid, opts));
      fill(layers.lattice, latticeNodes(grid, domEl));
      fill(layers.horizon, horizonNodes(tree, grid, domEl, current.frame));
      const branches = branchNodes(tree, grid, domEl, null, opts);
      branchEls = new Map();
      for (const b of branches) {
        const key = b.getAttribute('data-edge');
        if (key) branchEls.set(key, b);
      }
      fill(layers.branches, branches);
      fill(layers.overlay, handleNodes(tree, grid, domEl));

      // An empty stage is indistinguishable from a broken one, so it says
      // what to do with it. This lives on the canvas rather than in the
      // status line because the canvas is the thing you have to click, and
      // it goes the moment there is a seed to look at instead.
      if (!tree.nodes.length) layers.overlay.appendChild(emptyHint(grid, current.frame));
    },

    frame() {
      return current.frame;
    },

    // Rebuild foliage. Called when the object *set* changes — a new seed, a
    // new year, an edited structure — never per animation frame.
    setFoliage(objects, grid, colors) {
      current.objects = objects;
      const g = grid || current.grid;
      const nodes = foliageNodes(objects, g, domEl, { colors });
      foliageEls = new Map();
      objects.forEach((obj, i) => foliageEls.set(obj.id, nodes[i]));
      fill(layers.foliage, nodes);
    },

    // Per-frame hook used by animate.js.
    applyState(obj, state) {
      const node = foliageEls.get(obj.id);
      if (!node) return;
      if (state.color && state.color !== node.getAttribute('fill')) {
        node.setAttribute('fill', state.color);
      }
      node.setAttribute('transform', transformFor(obj, state));
      node.setAttribute(
        'opacity',
        (state.opacity != null ? state.opacity : 1).toFixed(3)
      );
    },

    elementFor(id) {
      return foliageEls.get(id) || null;
    },

    // Move a branch for the winter fall. A line has no transform origin of
    // its own, so it is rotated about its own midpoint and then translated —
    // otherwise a falling limb would swing about the world origin.
    applyBranchState(key, state) {
      const node = branchEls.get(key);
      if (!node) return;
      const cx = (Number(node.getAttribute('x1')) + Number(node.getAttribute('x2'))) / 2;
      const cy = (Number(node.getAttribute('y1')) + Number(node.getAttribute('y2'))) / 2;
      const dx = state.dx || 0;
      const dy = state.dy || 0;
      const rot = state.rot || 0;
      node.setAttribute(
        'transform',
        `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${rot.toFixed(2)} ${cx.toFixed(2)} ${cy.toFixed(2)})`
      );
      node.setAttribute(
        'opacity',
        (state.opacity != null ? state.opacity : 1).toFixed(3)
      );
    },

    branchKeys() {
      return [...branchEls.keys()];
    },

    // Authoring chrome is hidden for export.
    showChrome(on) {
      layers.lattice.style.display = on ? '' : 'none';
      layers.overlay.style.display = on ? '' : 'none';
    },

    objects() {
      return current.objects;
    },
  };
}
