// treegen/animate — seasons, on one requestAnimationFrame loop.
//
// The season order is fixed and forward-only:
//
//   spring -> summer -> fall -> winter -> (year + 1) spring
//
// That constraint is what keeps this file small. Because you can never scrub
// backwards, a transition never has to be reversible or addressable at an
// arbitrary t — it just plays. Winter's swinging fall is computed per frame
// from the leaf's own seeded parameters, which is all an animation library
// would have done for us anyway.
//
// Motion never touches the object set. `buildFoliage` decides what exists;
// this decides where it is and how opaque it is right now.

import { SEASONS, isPresent, resolveColors } from './foliage.js';
import { objRng, range, STREAMS } from './rng.js';

export const TIMING = {
  springStagger: 0.9,   // seconds spread across the depth range
  springFade: 0.55,     // per-leaf fade duration
  summerPop: 0.5,
  fallRecolor: 1.1,
  winterStagger: 1.2,
  winterFallMin: 1.5,   // seconds for one leaf's descent
  winterFallMax: 2.8,
  jitter: 0.28,         // seeded per-object timing jitter, seconds
};

// Winter trajectory constants. `decay` is the confirmed amplitude decay:
// wide swings up high, narrowing toward the ground. Set it to 0 for uniform
// sway — that is the only change required.
export const WINTER = {
  amplitudeMin: 9,
  amplitudeMax: 28,
  decay: 0.55,          // amplitude at landing = (1 - decay) x initial
  periodMin: 0.30,      // fraction of the descent per full swing
  periodMax: 0.72,
  spinMin: -240,        // degrees over the whole descent
  spinMax: 240,
  fadeStart: 0.6,       // begin fading at 60% of the descent...
  fadeEnd: 0.8,         // ...fully gone by 80%, never reaching the ground
};

// ---------- Small maths ----------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (u) => 1 - Math.pow(1 - u, 3);
const easeOutBack = (u) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2);
};

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [136, 136, 136];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  const v = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  return '#' + (v | (1 << 24)).toString(16).slice(1);
}

// Interpolate two hex colours. Used for the autumn crossfade — the palette
// stage gives us start and end swatches, this walks between them.
export function lerpHex(a, b, u) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * u, g1 + (g2 - g1) * u, b1 + (b2 - b1) * u);
}

// ---------- Per-object seeded parameters ----------

// A leaf's fall is fully determined by its stable ID and the seed, so it
// looks identical every time the same year is replayed, and is unaffected by
// anything happening to its neighbours.
function winterParams(seed, obj) {
  const r = objRng(seed, obj.id, STREAMS.WINTER);
  return {
    amp: range(r, WINTER.amplitudeMin, WINTER.amplitudeMax),
    period: range(r, WINTER.periodMin, WINTER.periodMax),
    phase: r() * Math.PI * 2,
    spin: range(r, WINTER.spinMin, WINTER.spinMax),
    dur: range(r, TIMING.winterFallMin, TIMING.winterFallMax),
    jitter: r() * TIMING.jitter,
  };
}

function springParams(seed, obj) {
  const r = objRng(seed, obj.id, STREAMS.SPRING);
  return { jitter: r() * TIMING.jitter };
}

// ---------- Pure transition core ----------
//
// Planning and per-frame evaluation are pure functions so they can be tested
// without a DOM or a live animation clock. `createAnimator` below is the thin
// stateful shell that drives them from requestAnimationFrame.

// Build the per-object plan for entering `to` from `from`. This is the only
// place that knows what each season *means* in motion terms.
// Branches that are about to be shed fall in winter, with the leaves.
//
// They use the same trajectory as a leaf, only heavier: a limb is bigger, so
// it sways less and drops sooner. Planning them separately keeps the foliage
// plan untouched — a branch is not a leaf and does not belong in the object
// set.
export function planBranchFall(branches, seed) {
  const entries = new Map();
  let longest = 0;
  const maxDepth = Math.max(1, ...branches.map((b) => b.depth || 0));

  for (const b of branches) {
    const p = winterParams(seed, { id: b.id, rot: 0 });
    // Deepest first, same as the leaves, so the tree empties outside-in.
    const order = (maxDepth - (b.depth || 0)) / maxDepth;
    const entry = {
      mode: 'fall',
      delay: order * TIMING.winterStagger + p.jitter,
      dur: p.dur * 0.8,
      p: { ...p, amp: p.amp * 0.45, spin: p.spin * 0.5 },
    };
    entries.set(b.id, entry);
    longest = Math.max(longest, entry.delay + entry.dur);
  }
  return { entries, duration: longest };
}

export function planTransition(objects, from, to, seed) {
  const entries = new Map();
  const maxDepth = Math.max(1, ...objects.map((o) => o.depth || 0));
  let longest = 0;

  for (const obj of objects) {
    // Leaves are "present" during winter only in the sense that they are
    // falling through it. By the time winter ends they are on the ground and
    // gone, so a transition *out of* winter must treat them as absent —
    // otherwise spring reads as a colour change instead of a regrowth.
    const leftOverWinter = from === 'winter' && obj.kind === 'leaf';
    const wasHere = isPresent(obj.kind, from) && !leftOverWinter;
    const isHere = isPresent(obj.kind, to);
    const depth = obj.depth || 0;

    let entry;

    if (to === 'winter' && obj.kind === 'leaf') {
      // Reverse of growth order: the deepest leaves let go first.
      const p = winterParams(seed, obj);
      const order = (maxDepth - depth) / maxDepth;
      entry = { mode: 'fall', delay: order * TIMING.winterStagger + p.jitter, dur: p.dur, p };
    } else if (!wasHere && isHere) {
      // Appearing. Spring staggers ascending by depth — nearest the trunk
      // first — while summer's blossom and fruit just pop.
      const delay =
        to === 'spring'
          ? (depth / maxDepth) * TIMING.springStagger + springParams(seed, obj).jitter
          : springParams(seed, obj).jitter * 0.5;
      entry = {
        mode: 'appear',
        delay,
        dur: to === 'spring' ? TIMING.springFade : TIMING.summerPop,
        pop: to !== 'spring',
      };
    } else if (wasHere && !isHere) {
      entry = { mode: 'vanish', delay: 0, dur: TIMING.summerPop };
    } else if (isHere) {
      // Staying. The only thing that can change is colour — this is the
      // autumn mechanism and nothing more.
      entry = { mode: 'hold', delay: 0, dur: TIMING.fallRecolor };
    } else {
      entry = { mode: 'absent', delay: 0, dur: 0 };
    }

    entries.set(obj.id, entry);
    const end = entry.delay + entry.dur;
    if (end > longest) longest = end;
  }

  return { entries, duration: longest };
}

// The motion state of one object at `elapsed` seconds into a transition.
// `ctx` supplies { horizonY, colorFrom, colorTo }.
export function frameState(obj, entry, elapsed, ctx = {}) {
  const { colorFrom, colorTo } = ctx;
  const u = entry.dur > 0 ? clamp01((elapsed - entry.delay) / entry.dur) : 1;

  if (entry.mode === 'absent') return { opacity: 0 };

  if (entry.mode === 'fall') {
    if (elapsed <= entry.delay) return { opacity: 1, color: colorTo || colorFrom };
    const p = entry.p;
    // The approved trajectory: sine sway with decaying amplitude, linear
    // descent, continuous rotation.
    const descent = Math.max(1, (ctx.horizonY ?? obj.y) - obj.y);
    const amp = p.amp * (1 - WINTER.decay * u);
    return {
      dx: amp * Math.sin((2 * Math.PI * u) / p.period + p.phase),
      dy: descent * u,
      rot: (obj.rot || 0) + p.spin * u,
      // Gone before it ever reaches the ground line.
      opacity: 1 - clamp01((u - WINTER.fadeStart) / (WINTER.fadeEnd - WINTER.fadeStart)),
      color: colorTo || colorFrom,
    };
  }

  if (entry.mode === 'appear') {
    const e = entry.pop ? easeOutBack(u) : easeOutCubic(u);
    return {
      opacity: easeOutCubic(u),
      scale: entry.pop ? Math.max(0, e) : 1,
      color: colorTo || colorFrom,
    };
  }

  if (entry.mode === 'vanish') {
    return {
      opacity: 1 - easeOutCubic(u),
      scale: 1 - 0.3 * u,
      color: colorFrom || colorTo,
    };
  }

  // hold — crossfade colour only.
  return {
    opacity: 1,
    color:
      colorFrom && colorTo ? lerpHex(colorFrom, colorTo, easeOutCubic(u)) : colorTo || colorFrom,
  };
}

// The settled (post-transition) state for a season.
export function settledState(obj, season, color) {
  const present = isPresent(obj.kind, season);
  const fallen = season === 'winter' && obj.kind === 'leaf';
  return { opacity: present && !fallen ? 1 : 0, color };
}

// ---------- Animator ----------

// `canvas` is the object returned by render.createCanvas.
//
// callbacks:
//   onSeason(season, year)  fired when a transition starts
//   onYear(year)            fired when winter wraps, before the new object
//                           set is requested
//   rebuild(year)           must return a fresh { objects } for that year, and
//                           may return { grid, tree } too when the structure
//                           itself changed — which it does if the tree grows
export function createAnimator(canvas, callbacks = {}) {
  let objects = [];
  let branches = [];      // limbs due to be shed this winter
  let branchPlan = null;
  let grid = null;
  let tree = null;
  let seed = 1;
  let palette = 'orchard';
  let year = 0;

  let season = 'spring';
  let plans = null;      // Map id -> per-object transition plan
  let startedAt = 0;
  let duration = 0;
  let running = false;
  let raf = 0;

  let autoplay = false;
  let interval = 4;      // seconds between automatic advances
  let restAt = 0;        // when the current transition finished

  // Colours for the season we are leaving and the one we are entering.
  let colorsFrom = new Map();
  let colorsTo = new Map();

  const now = () => (typeof performance !== 'undefined' ? performance.now() : 0) / 1000;

  // ----- Planning and frames -----
  //
  // Both delegate to the pure functions above; this shell only supplies the
  // current state and pushes the results at the canvas.

  function plan(from, to) {
    const built = planTransition(objects, from, to, seed);
    let duration = built.duration;

    // Shed limbs come down in winter and stay gone afterwards.
    branchPlan = null;
    if (to === 'winter' && branches.length) {
      branchPlan = planBranchFall(branches, seed + year);
      duration = Math.max(duration, branchPlan.duration);
    }
    return { map: built.entries, duration };
  }

  function applyFrame(elapsed) {
    const horizonY = tree && tree.horizonY != null ? tree.horizonY : grid && grid.height;

    if (branchPlan && canvas.applyBranchState) {
      for (const b of branches) {
        const entry = branchPlan.entries.get(b.id);
        if (!entry) continue;
        canvas.applyBranchState(b.id, frameState(b, entry, elapsed, { horizonY }));
      }
    }

    for (const obj of objects) {
      const entry = plans.get(obj.id);
      if (!entry) continue;
      canvas.applyState(
        obj,
        frameState(obj, entry, elapsed, {
          horizonY,
          colorFrom: colorsFrom.get(obj.id),
          colorTo: colorsTo.get(obj.id),
        })
      );
    }
  }

  // Freeze everything into the settled state for `season`.
  function settle() {
    for (const obj of objects) {
      canvas.applyState(obj, settledState(obj, season, colorsTo.get(obj.id)));
    }
    // A shed limb is on the ground by the end of winter.
    if (season === 'winter' && branches.length && canvas.applyBranchState) {
      for (const b of branches) canvas.applyBranchState(b.id, { opacity: 0 });
    }
  }

  function tick() {
    if (!running) return;
    const elapsed = now() - startedAt;

    if (plans && elapsed < duration) {
      applyFrame(elapsed);
    } else if (plans) {
      applyFrame(duration);
      settle();
      plans = null;
      restAt = now();
      if (!autoplay) {
        running = false;
        raf = 0;
        return;
      }
    } else if (autoplay && now() - restAt >= interval) {
      next();
    }

    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    raf = requestAnimationFrame(tick);
  }

  // Browsers don't fire animation frames in a hidden tab, so wall-clock time
  // keeps running while the transition doesn't. Without this, coming back to
  // the tab makes one frame see a huge `elapsed` and snap straight to the
  // settled state — and any "next season" clicks made while hidden are lost,
  // because start() sees `running` still true and declines to reschedule.
  //
  // So: freeze progress on hide, rebase it on show, and re-kick the loop.
  let pausedElapsed = null;
  let pausedRest = null;

  function onVisibility() {
    if (document.hidden) {
      pausedElapsed = plans ? now() - startedAt : null;
      pausedRest = now() - restAt;
      return;
    }
    if (pausedElapsed != null) startedAt = now() - pausedElapsed;
    if (pausedRest != null) restAt = now() - pausedRest;
    pausedElapsed = null;
    pausedRest = null;
    if (plans || autoplay) {
      running = false;   // the previous frame request died with the tab
      start();
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  // ----- Transitions -----

  function transitionTo(target) {
    const from = season;
    colorsFrom = colorsTo.size ? colorsTo : resolveColors(objects, from, palette, seed + year);
    colorsTo = resolveColors(objects, target, palette, seed + year);
    season = target;

    const built = plan(from, target);
    plans = built.map;
    duration = built.duration;
    startedAt = now();

    if (callbacks.onSeason) callbacks.onSeason(season, year);
    start();
  }

  // Open a growing year: grow, re-roll the canopy, and come into spring.
  //
  // Winter wraps into this, which is where it is usually reached from, but it
  // is not only winter's to call. Planting a seed enters spring the same way
  // — it is the same event, a tree putting on a year's growth and leafing out
  // — and going through here is what makes a seed sprout as a season rather
  // than simply appear.
  //
  // `intoYear` is which year is starting, so the caller decides whether that
  // is the next one or the one already on the clock: winter is ending a year
  // and so asks for the next, while planting is starting the first and asks
  // for the one it is already on.
  //
  // The effective seed is seed + year, so every year is different while each
  // individual year stays perfectly reproducible.
  function beginYear(intoYear) {
    year = intoYear;
    if (callbacks.onYear) callbacks.onYear(year);
    if (callbacks.rebuild) {
      const fresh = callbacks.rebuild(year);
      if (fresh && fresh.objects) {
        // A growing tree can also move to a larger world, so take the grid
        // and tree back if the caller replaced them.
        if (fresh.grid) grid = fresh.grid;
        if (fresh.tree) tree = fresh.tree;
        objects = fresh.objects;
        canvas.setFoliage(objects, grid);
      }
    }
    // The limbs that fell are gone; the caller has removed them by now.
    branches = [];
    branchPlan = null;
    colorsTo = new Map();
    // Come into spring *from* winter whatever the clock said, so the canopy
    // fades up from nothing rather than cross-fading out of some other season.
    season = 'winter';
    for (const obj of objects) canvas.applyState(obj, { opacity: 0 });
    transitionTo('spring');
  }

  // Advance one step in the fixed order, wrapping the year after winter.
  function next() {
    const idx = SEASONS.indexOf(season);
    if (idx === SEASONS.length - 1) {
      beginYear(year + 1);
      return;
    }
    transitionTo(SEASONS[idx + 1]);
  }

  return {
    // Install a new object set without animating — used on first render and
    // after any structural edit.
    setScene(next) {
      objects = next.objects || [];
      grid = next.grid || grid;
      tree = next.tree || tree;
      seed = next.seed != null ? next.seed : seed;
      palette = next.palette || palette;
      if (next.year != null) year = next.year;
      if (next.branches) branches = next.branches;
      colorsTo = resolveColors(objects, season, palette, seed + year);
      colorsFrom = colorsTo;
      plans = null;
      settle();
    },

    // Re-resolve colours in place — a palette switch, no motion.
    repaint(nextPalette) {
      if (nextPalette) palette = nextPalette;
      colorsTo = resolveColors(objects, season, palette, seed + year);
      colorsFrom = colorsTo;
      if (!plans) settle();
    },

    next,
    goTo: transitionTo,
    beginYear,

    setAutoplay(on, seconds) {
      autoplay = !!on;
      if (seconds > 0) interval = seconds;
      restAt = now();
      if (autoplay) start();
    },

    season: () => season,
    year: () => year,
    isAutoplaying: () => autoplay,

    destroy() {
      running = false;
      autoplay = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    },
  };
}
