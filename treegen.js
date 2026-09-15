// treegen — entry point.
//
// Owns the document (the saveable JSON), wires the toolbar, and keeps the
// canvas and animator in sync. Everything interesting lives in the modules
// this imports; this file is plumbing.
//
// Two ways in. Open index.html and it boots itself against the #treegen markup
// on the page. Embedded elsewhere — bobbymeyer.com loads this module straight
// from its GitHub Pages deploy — the host calls `initTreegen()` when its
// markup is ready and `destroyTreegen()` before it takes it away again.

import { makeGrid, GRID_TYPES, GRID_DEFAULTS } from './grid.js';
import { objRng } from './rng.js';
import {
  makeTree, addNodeAt, connectAt, moveNode, canMoveTo, metrics, remapToGrid,
  needsRoom, removeBranch, nodeById, findMatureTwigs, twigNodes,
} from './tree.js';
import { buildFoliage, PALETTE_NAMES, FOLIAGE_DEFAULTS } from './foliage.js';
import { createCanvas, edgeKey } from './render.js';
import { createAnimator } from './animate.js';
import { generate, extendTips, LSYSTEM_DEFAULTS } from './lsystem.js';

const DRAFT_KEY = 'treegen:draft';
const DOC_VERSION = 1;

// Auto zoom-out. When the tree reaches within MARGIN_CELLS of an edge the
// world grows by GROW_BY and the tree re-snaps onto the larger lattice.
// Spacing stays fixed, so the world genuinely gains room to grow into and the
// whole thing reads as a zoom-out — the viewBox widens while the SVG keeps
// its layout size.
//
// MAX_POINTS is a backstop, not a design limit: the lattice is drawn as one
// path, so a large point count costs geometry rather than DOM nodes. It is
// high enough that a tree growing for many years keeps zooming instead of
// overrunning its world.
const MARGIN_CELLS = 2;
const GROW_BY = 1.3;
const MAX_POINTS = 26000;
const MAX_GROWTH_STEPS = 8;

// ---------- Document ----------

// The single source of truth. SVG export is one-way; this is what round-trips.
function defaultDoc() {
  return {
    version: DOC_VERSION,
    seed: 1,
    year: 0,
    grid: { ...GRID_DEFAULTS },
    tree: makeTree(),
    palette: 'orchard',
    grow: false,          // extend the tree by one production step each spring
    // Mirrors the engine's placement defaults for every value the app reads
    // back out of the document. A key missing here reads as undefined and the
    // rule silently never fires.
    rules: {
      placement: {
        layers: FOLIAGE_DEFAULTS.placement.layers,
        trunkMinOrder: FOLIAGE_DEFAULTS.placement.trunkMinOrder,
        matureOrder: FOLIAGE_DEFAULTS.placement.matureOrder,
      },
      cullMaxTwig: 3,
      // Chance each spring that a mature node breaks a new shoot. Stored as
      // a fraction; the toolbar shows it as a percentage.
      sproutChance: LSYSTEM_DEFAULTS.sproutChance,
    },
    lsystem: {
      axiom: LSYSTEM_DEFAULTS.axiom,
      rules: LSYSTEM_DEFAULTS.rules,
      iterations: LSYSTEM_DEFAULTS.iterations,
      angle: LSYSTEM_DEFAULTS.angle,
      step: LSYSTEM_DEFAULTS.step,
      jitter: LSYSTEM_DEFAULTS.jitter,
      rootIterations: LSYSTEM_DEFAULTS.rootIterations,
    },
  };
}

// Accept anything shaped roughly like a document; fill the rest from
// defaults so an older or hand-edited file still opens.
function normalizeDoc(raw) {
  const base = defaultDoc();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    grid: { ...base.grid, ...(raw.grid || {}) },
    tree: raw.tree && Array.isArray(raw.tree.nodes) ? raw.tree : base.tree,
    lsystem: { ...base.lsystem, ...(raw.lsystem || {}) },
    rules: {
      ...base.rules,
      ...(raw.rules || {}),
      placement: { ...base.rules.placement, ...((raw.rules || {}).placement || {}) },
    },
  };
}

// ---------- App ----------

function boot(root) {
  const $ = (sel) => root.querySelector(sel);

  let doc = defaultDoc();
  let grid = makeGrid(doc.grid);
  let objects = [];

  const stage = $('#tg-canvas');
  const statusEl = $('#tg-status');

  const canvas = createCanvas(stage, {
    onAdd: (gi) => {
      addNodeAt(doc.tree, grid, gi);
      refresh({ structure: true });
    },
    onMove: (id, gi) => {
      if (moveNode(doc.tree, grid, id, gi)) refresh({ structure: true });
    },
    canMoveTo: (id, gi) => canMoveTo(doc.tree, grid, id, gi),
    onDelete: (id) => {
      if (id === doc.tree.rootId) {
        say('the first point sets the horizon — use clear to start over', true);
        return;
      }
      const cut = removeBranch(doc.tree, id);
      if (!cut) return;
      refresh({ structure: true });
      say(`cut ${cut} node${cut > 1 ? 's' : ''}`);
    },
  });

  const animator = createAnimator(canvas, {
    onSeason: (season) => {
      if ($('#tg-season')) $('#tg-season').textContent = season;
    },
    onYear: (year) => {
      doc.year = year;
      if (doc.grow) growOneYear(year);
      saveDraft();
    },
    // A new year re-rolls the canopy — and, if growing, does it on a bigger
    // tree. The grid goes back too, since growth can push the world outward.
    rebuild: (year) => ({ objects: buildObjects(year), grid, tree: doc.tree }),
  });

  function effectiveSeed(year = doc.year) {
    return (doc.seed | 0) + (year | 0);
  }

  // The limbs this winter will take, described as the branch segments that
  // will fall. Discovery only — nothing is removed until winter is over.
  function doomedBranches() {
    if (!doc.grow) return [];
    const m = metrics(doc.tree);
    const roots = findMatureTwigs(doc.tree, {
      matureOrder: doc.rules.placement.matureOrder,
      maxTwig: doc.rules.cullMaxTwig ?? 3,
      metrics: m,
    });
    if (!roots.length) return [];

    const doomed = twigNodes(doc.tree, roots, m);
    const out = [];
    for (const [a, b] of doc.tree.edges) {
      // An edge falls if its far end is coming away.
      if (!doomed.has(a) && !doomed.has(b)) continue;
      const na = nodeById(doc.tree, a);
      const nb = nodeById(doc.tree, b);
      if (!na || !nb) continue;
      const pa = grid.point(na.gi);
      const pb = grid.point(nb.gi);
      out.push({
        id: edgeKey(a, b),
        x: (pa.x + pb.x) / 2,
        y: (pa.y + pb.y) / 2,
        rot: 0,
        depth: Math.max(m.depth.get(a) || 0, m.depth.get(b) || 0),
      });
    }
    return out;
  }

  function buildObjects(year = doc.year) {
    const m = metrics(doc.tree);
    return buildFoliage(doc, grid, doc.tree, m, effectiveSeed(year));
  }

  // One spring's structural growth: a single production step at each tip,
  // continuing the direction that tip was heading. Seeded on the year, so a
  // given year always grows the same way.
  function growOneYear(year) {
    // Winter has just finished dropping the shed limbs; now actually take
    // them off the tree, so what fell does not reappear in spring.
    let culled = 0;
    for (const id of findMatureTwigs(doc.tree, {
      matureOrder: doc.rules.placement.matureOrder,
      maxTwig: doc.rules.cullMaxTwig ?? 3,
    })) {
      culled += removeBranch(doc.tree, id);
    }

    const m = metrics(doc.tree);
    const before = doc.tree.nodes.length;
    const seed = effectiveSeed(year);

    const result = extendTips(grid, doc.tree, m, {
      ...doc.lsystem,
      seed,
      growChance: doc.rules.growChance ?? LSYSTEM_DEFAULTS.growChance,
      rootGrowChance: doc.rules.rootGrowChance ?? LSYSTEM_DEFAULTS.rootGrowChance,
      growLimit: doc.rules.growLimit ?? LSYSTEM_DEFAULTS.growLimit,
      // Shoots from old wood. `matureOrder` is the foliage threshold — the
      // same line that decides a limb bears no leaves and sheds its twigs
      // decides which wood can break a bud, so the two never drift apart.
      sproutChance: doc.rules.sproutChance ?? LSYSTEM_DEFAULTS.sproutChance,
      matureOrder: doc.rules.placement.matureOrder,
      // One seeded roll per tip; extendTips decides which threshold applies,
      // since only it knows whether a tip is a branch or a root. Sprouting
      // draws from its own stream, so changing one never reshuffles the other.
      roll: (id) => objRng(seed, id, 'grow')(),
      sproutRoll: (id) => objRng(seed, id, 'sprout')(),
    }, {
      edge: (from, to) => connectAt(doc.tree, grid, from, to),
    });

    if (!result.ok) {
      say(result.error, true);
      return;
    }

    // Growth can push the tree into the edge of the world.
    fitWorld();
    canvas.setStructure(doc.tree, grid, {
      trunkMinOrder: doc.rules.placement.trunkMinOrder,
      canopyLayers: doc.rules.placement.layers,
    });
    const added = doc.tree.nodes.length - before;
    const shed = culled ? `, shed ${culled} over winter` : '';
    const broke = result.sprouts
      ? `, ${result.sprouts} shoot${result.sprouts > 1 ? 's' : ''} off old wood`
      : '';
    say(
      result.capped
        ? `year ${year + 1} — fully grown${shed}`
        : `year ${year + 1} — grew ${added} new${broke}${shed}`
    );
  }

  // Grow the world until the tree has clear air on every side. Returns true
  // if anything changed, so the caller knows to redraw the structure.
  function fitWorld() {
    let grew = false;
    for (let step = 0; step < MAX_GROWTH_STEPS; step++) {
      if (!needsRoom(doc.tree, grid, MARGIN_CELLS)) break;

      const nextCfg = {
        ...doc.grid,
        width: Math.round(doc.grid.width * GROW_BY),
        height: Math.round(doc.grid.height * GROW_BY),
      };
      const nextGrid = makeGrid(nextCfg);
      if (nextGrid.count > MAX_POINTS) {
        say('canvas is as large as it goes — try a smaller tree or wider spacing');
        break;
      }

      // Both lattices centre themselves, so shift the tree by half the growth
      // to keep it where it was rather than stranding it toward the corner.
      doc.tree = remapToGrid(doc.tree, grid, nextGrid, {
        dx: (nextCfg.width - doc.grid.width) / 2,
        dy: (nextCfg.height - doc.grid.height) / 2,
      });
      doc.grid = nextCfg;
      grid = nextGrid;
      grew = true;
    }
    return grew;
  }

  // The one redraw path. `structure` also rebuilds branches and handles.
  function refresh({ structure = false, rebuildGrid = false } = {}) {
    if (rebuildGrid) grid = makeGrid(doc.grid);
    if (fitWorld()) structure = true;
    if (structure || rebuildGrid) {
      canvas.setStructure(doc.tree, grid, {
        trunkMinOrder: doc.rules.placement.trunkMinOrder,
        canopyLayers: doc.rules.placement.layers,
      });
    }

    objects = buildObjects();
    canvas.setFoliage(objects, grid);
    animator.setScene({
      objects,
      grid,
      tree: doc.tree,
      seed: doc.seed,
      palette: doc.palette,
      year: doc.year,
      branches: doomedBranches(),
    });
    syncReadouts();
    saveDraft();
  }

  function syncReadouts() {
    if ($('#tg-layers')) $('#tg-layers').value = String(doc.rules.placement.layers);
    if ($('#tg-trunk')) $('#tg-trunk').value = String(doc.rules.placement.trunkMinOrder);
    if ($('#tg-grow')) $('#tg-grow').checked = !!doc.grow;
    if ($('#tg-sprout')) {
      $('#tg-sprout').value = String(Math.round((doc.rules.sproutChance ?? 0) * 100));
    }
    if ($('#tg-seed')) $('#tg-seed').textContent = String(doc.seed);
    if ($('#tg-year')) $('#tg-year').textContent = String(doc.year + 1);
    if ($('#tg-season')) $('#tg-season').textContent = animator.season();
  }

  function say(msg, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', !!isError);
  }

  // ---------- Persistence ----------

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(doc));
    } catch (err) {
      // Private browsing, quota, whatever — a lost draft isn't worth a crash.
    }
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return false;
      doc = normalizeDoc(JSON.parse(raw));
      return true;
    } catch (err) {
      return false;
    }
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Export the current frame. Authoring chrome is stripped and the few
  // styles the branches rely on are inlined, so the file stands alone.
  function exportSvg() {
    canvas.showChrome(false);
    const clone = canvas.svg.cloneNode(true);
    canvas.showChrome(true);

    clone.querySelector('.tg-lattice')?.remove();
    clone.querySelector('.tg-overlay')?.remove();
    clone.querySelector('.tg-horizon')?.remove();

    const frame = canvas.frame() || { w: grid.width, h: grid.height };
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', Math.round(frame.w));
    clone.setAttribute('height', Math.round(frame.h));
    clone.removeAttribute('class');

    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent =
      '.tg-branch{stroke:#3a3028;stroke-linecap:round;fill:none}' +
      '.tg-branch-trunk{stroke:#2b231c;stroke-linecap:butt}' +
      '.tg-branch-root{stroke:#6b5c4a;stroke-dasharray:3 3}';
    clone.insertBefore(style, clone.firstChild);

    const text = new XMLSerializer().serializeToString(clone);
    download(`treegen-${animator.season()}-${doc.seed}.svg`, text, 'image/svg+xml');
    say(`exported ${animator.season()} as svg`);
  }

  // ---------- Controls ----------

  function wire() {
    const gridSel = $('#tg-grid');
    if (gridSel) {
      gridSel.innerHTML = '';
      for (const t of GRID_TYPES) {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        gridSel.appendChild(opt);
      }
      gridSel.value = doc.grid.type;
      gridSel.addEventListener('change', () => {
        const nextGrid = makeGrid({ ...doc.grid, type: gridSel.value });
        // Structure survives the switch: nodes re-snap to the nearest point
        // on the new lattice and edges are re-pathed along it.
        doc.tree = remapToGrid(doc.tree, grid, nextGrid);
        doc.grid = { ...doc.grid, type: gridSel.value };
        refresh({ rebuildGrid: true });
        say(`switched to ${gridSel.value} — nodes re-snapped`);
      });
    }

    const paletteSel = $('#tg-palette');
    if (paletteSel) {
      paletteSel.innerHTML = '';
      for (const p of PALETTE_NAMES) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        paletteSel.appendChild(opt);
      }
      paletteSel.value = doc.palette;
      paletteSel.addEventListener('change', () => {
        doc.palette = paletteSel.value;
        // Palette substitution is stage two only — tone is untouched, so
        // this never disturbs the design underneath.
        animator.repaint(doc.palette);
        saveDraft();
      });
    }

    const growInput = $('#tg-grow');
    if (growInput) {
      growInput.checked = !!doc.grow;
      growInput.addEventListener('change', () => {
        doc.grow = !!growInput.checked;
        saveDraft();
        say(
          doc.grow
            ? 'the tree will put on new growth each spring'
            : 'structure is fixed — only the canopy changes with the year'
        );
      });
    }

    const sproutInput = $('#tg-sprout');
    if (sproutInput) {
      sproutInput.value = String(Math.round((doc.rules.sproutChance ?? 0) * 100));
      sproutInput.addEventListener('change', () => {
        const pct = Math.max(0, Math.min(100, Math.round(Number(sproutInput.value) || 0)));
        sproutInput.value = String(pct);
        doc.rules.sproutChance = pct / 100;
        // Nothing to redraw: this only decides what next spring does.
        saveDraft();
        say(
          pct === 0
            ? 'growth only at the tips — old wood stays bare'
            : `${pct}% chance a mature limb breaks a new shoot each spring`
        );
      });
    }

    const trunkInput = $('#tg-trunk');
    if (trunkInput) {
      trunkInput.value = String(doc.rules.placement.trunkMinOrder);
      trunkInput.addEventListener('change', () => {
        const n = Math.max(1, Math.min(6, Number(trunkInput.value) || 1));
        trunkInput.value = String(n);
        doc.rules.placement.trunkMinOrder = n;
        // Structure is untouched — only where the stem stops counting as trunk.
        refresh({ structure: true });
        say(
          n === 1
            ? 'trunk runs the full central path'
            : `trunk ends where the stem drops below Strahler ${n}`
        );
      });
    }

    const layersInput = $('#tg-layers');
    if (layersInput) {
      layersInput.value = String(doc.rules.placement.layers);
      layersInput.addEventListener('change', () => {
        const n = Math.max(0, Math.min(5, Number(layersInput.value) || 0));
        layersInput.value = String(n);
        doc.rules.placement.layers = n;
        // Structure is untouched — only how far foliage spreads from it.
        refresh();
        say(n === 0 ? 'leaves only on the branch cells' : `${n} layer${n > 1 ? 's' : ''} of leaf`);
      });
    }

    $('#tg-roll')?.addEventListener('click', () => {
      doc.seed = (Math.random() * 0x7fffffff) | 0;
      doc.year = 0;
      refresh();
      say('new seed — same trunk, new canopy');
    });

    $('#tg-next')?.addEventListener('click', () => {
      animator.next();
      doc.year = animator.year();
      syncReadouts();
    });

    const auto = $('#tg-auto');
    const interval = $('#tg-interval');
    const applyAuto = () => {
      const secs = Math.max(1, Number(interval?.value) || 4);
      animator.setAutoplay(!!auto?.checked, secs);
    };
    auto?.addEventListener('change', applyAuto);
    interval?.addEventListener('change', applyAuto);

    $('#tg-clear')?.addEventListener('click', () => {
      doc.tree = makeTree();
      doc.year = 0;
      refresh({ structure: true });
      say('cleared — click to place the first point, which sets the horizon');
    });

    $('#tg-save')?.addEventListener('click', () => {
      download(`treegen-${doc.seed}.json`, JSON.stringify(doc, null, 2), 'application/json');
      say('saved json');
    });

    $('#tg-load')?.addEventListener('change', (evt) => {
      const file = evt.target.files && evt.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          doc = normalizeDoc(JSON.parse(String(reader.result)));
          if (gridSel) gridSel.value = doc.grid.type;
          if (paletteSel) paletteSel.value = doc.palette;
          syncLsystemFields();
          refresh({ rebuildGrid: true });
          say(`loaded ${file.name}`);
        } catch (err) {
          say("that file didn't parse as a treegen document", true);
        }
        evt.target.value = '';
      };
      reader.readAsText(file);
    });

    $('#tg-export')?.addEventListener('click', exportSvg);

    // ----- L-system -----

    $('#tg-ls-run')?.addEventListener('click', () => {
      doc.lsystem = {
        axiom: $('#tg-ls-axiom')?.value || LSYSTEM_DEFAULTS.axiom,
        rules: $('#tg-ls-rules')?.value || LSYSTEM_DEFAULTS.rules,
        iterations: Number($('#tg-ls-iters')?.value) || 3,
        angle: Number($('#tg-ls-angle')?.value) || 30,
        step: Number($('#tg-ls-step')?.value) || LSYSTEM_DEFAULTS.step,
        jitter: Number($('#tg-ls-jitter')?.value ?? LSYSTEM_DEFAULTS.jitter),
        rootIterations: Number($('#tg-ls-roots')?.value ?? LSYSTEM_DEFAULTS.rootIterations),
      };

      // Grow from the root if there is one, otherwise from a point low and
      // centre — which then becomes the horizon.
      const startGi = doc.tree.rootId
        ? doc.tree.nodes.find((n) => n.id === doc.tree.rootId).gi
        : grid.nearest(grid.width / 2, grid.height * 0.72);

      const result = generate(
        grid,
        startGi,
        { ...doc.lsystem, seed: doc.seed },
        {
          begin: (gi) => {
            if (!doc.tree.nodes.length) addNodeAt(doc.tree, grid, gi);
          },
          // Each move is one straight segment between two lattice points.
          // connectAt joins exactly those two, so a generated branch is the
          // same kind of edge a hand-drawn one is.
          edge: (from, to) => connectAt(doc.tree, grid, from, to),
        }
      );

      if (!result.ok) {
        say(result.error, true);
        return;
      }

      // Roots: the same grammar run downward from the same point.
      let roots = null;
      if (doc.lsystem.rootIterations > 0) {
        roots = generate(
          grid,
          startGi,
          { ...doc.lsystem, seed: doc.seed, direction: 'down' },
          { edge: (from, to) => connectAt(doc.tree, grid, from, to) }
        );
      }

      refresh({ structure: true });
      const parts = [`grew ${result.moves} branches`];
      if (roots && roots.ok) parts.push(`${roots.moves} roots`);
      if (result.notes.length) parts.push(`(${result.notes.join('; ')})`);
      say(parts.join(' · '));
    });
  }

  function syncLsystemFields() {
    if ($('#tg-ls-axiom')) $('#tg-ls-axiom').value = doc.lsystem.axiom;
    if ($('#tg-ls-rules')) $('#tg-ls-rules').value = doc.lsystem.rules;
    if ($('#tg-ls-iters')) $('#tg-ls-iters').value = doc.lsystem.iterations;
    if ($('#tg-ls-angle')) $('#tg-ls-angle').value = doc.lsystem.angle;
    if ($('#tg-ls-step')) $('#tg-ls-step').value = doc.lsystem.step;
    if ($('#tg-ls-jitter')) $('#tg-ls-jitter').value = doc.lsystem.jitter;
    if ($('#tg-ls-roots')) $('#tg-ls-roots').value = doc.lsystem.rootIterations;
  }

  // ---------- Start ----------

  const hadDraft = loadDraft();
  grid = makeGrid(doc.grid);
  wire();
  syncLsystemFields();
  canvas.setStructure(doc.tree, grid, {
    trunkMinOrder: doc.rules.placement.trunkMinOrder,
    canopyLayers: doc.rules.placement.layers,
  });
  refresh({ structure: true });

  if (!hadDraft || !doc.tree.nodes.length) {
    say('click to place the first point — it sets the horizon');
  } else {
    say('');
  }

  return {
    // Stop the animation loop and let go of the stage. The markup itself
    // belongs to the host, so it is left alone.
    destroy() {
      animator.destroy();
      if (stage) stage.replaceChildren();
    },
  };
}

// ---------- Embedding ----------

// One instance at a time. A host that swaps the DOM under us — an SPA router,
// say — would otherwise leave the old animator running against elements that
// are no longer on the page.
let live = null;

// Start the tool against `root`, or against `#treegen` if none is given.
// Returns a handle, or null when the markup isn't present — so calling this on
// every page of a site is safe.
export function initTreegen(root) {
  if (typeof document === 'undefined') return null;
  const host = root || document.getElementById('treegen');
  if (!host || live) return live;

  live = { root: host, ...boot(host) };
  return live;
}

export function destroyTreegen() {
  if (!live) return;
  if (typeof live.destroy === 'function') live.destroy();
  live = null;
}

// Standalone: boot against our own page once it is ready. Importing this
// module without that markup does nothing, which is what lets the tests and
// the embedding host import it freely.
if (typeof document !== 'undefined' && !window.__treegenEmbedded) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initTreegen());
  } else {
    initTreegen();
  }
}

export { boot, defaultDoc, normalizeDoc };
