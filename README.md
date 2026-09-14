# treegen

A tool for growing trees on a grid.

Points snap to a lattice; a branch is a straight line between two of them, at
whatever angle and length that takes. Vegetation is never placed by hand — every
leaf, blossom and fruit comes from rules evaluated against the graph. Four
seasons animate a single set of objects rather than four unrelated pictures, and
a tree can be left to grow year on year.

[**Open it →**](https://bobbymeyer.github.io/treegen/)

## How it works

**Only the points snap to the grid.** An edge is a straight segment between two
of them and is not walked along the lattice, so nothing staircases. Four grid
types sit behind one interface: square, hex, triangle, and a seeded Voronoi
whose adjacency is the Delaunay dual of its sites.

**Structure is drawn, grown, or both.** Click to place points, drag a node to
move it and everything downstream with it, right-click to cut a limb and
everything past it. Or grow one from an L-system: axiom, production rules, angle
and segment length, with a variation control that wobbles branches without
walking the trunk sideways.

**Vegetation is rules only.** There is no way to put a leaf somewhere. Foliage
comes from depth, tip-versus-interior, Strahler order and a seeded roll, so the
same rules work identically whether you drew the tree or grew it. Leaves fill
whole lattice cells, so the canopy reads as a mass on the grid rather than
scattered marks.

**Colour runs in two stages.** Every object takes a grayscale tone from its
position in the graph, knowing nothing about colour; a separate step maps tone
onto a swatch. That split means a palette change never disturbs the design
underneath — and autumn needs no special machinery, being stage two re-run
against a different swatch list.

**The trunk is found, not drawn.** From the root, follow the dominant branch at
every fork — highest Strahler order, which is what "main channel" means in a
branching network. It bears no foliage, so the main stem reads as wood.

**Seasons run forward in order,** with each object keeping a stable identity
across all four, which is what makes the transitions continuous. Winter drops
every leaf on a sine path with the swing narrowing as it falls, fading out
before it reaches the ground line.

**A growing tree renews.** Each spring it extends from its tips rather than
regenerating, so earlier years survive. Branches mature: once a limb passes a
Strahler threshold it stops bearing foliage and sheds its fine twigs, which come
away in winter with the leaves. That is what opens the inside of an older crown.

**Everything stochastic is seeded.** Voronoi sites, the L-system, placement,
tone, palette substitution, growth, and every leaf's fall each draw from their
own named stream — so rolling one never disturbs another, and the same seed
always gives the same tree.

## Running it

Nothing to install and nothing to build. Open `index.html`, or serve the folder:

```bash
python3 -m http.server
```

Tests are headless and need only Node:

```bash
npm test
```

The engine is DOM-free by construction, and the renderer draws through an
injected element factory — so the same drawing code runs in the browser and in
the tests, and there is no second implementation to drift. The suite also writes
`test/treegen-proof.html`, a rendering of all four seasons you can open.

## Embedding it

`treegen.js` is an ES module and boots itself against `#treegen` markup on its
own page. To run it inside something else, take the markup from `index.html`,
load `treegen.css`, and drive it yourself:

```js
window.__treegenEmbedded = true;   // before the import: don't self-boot
const { initTreegen, destroyTreegen } =
  await import('https://bobbymeyer.github.io/treegen/treegen.js');

initTreegen();        // no-ops when the markup isn't on the page
destroyTreegen();     // before the host removes it
```

This is how [bobbymeyer.com](https://bobbymeyer.com) runs it: loaded from this
deploy rather than vendored, so there is one copy rather than two that drift.

## Files

| | |
|---|---|
| `rng.js` | mulberry32, named sub-streams, per-object streams |
| `grid.js` | the four lattices, adjacency, Poisson-disc + Delaunay |
| `tree.js` | the node graph, depth, Strahler order, trunk, pruning |
| `lsystem.js` | rules, expansion, the lattice turtle, growth |
| `foliage.js` | placement rules, crown shape, tone and palette |
| `render.js` | scene to SVG, canvas interaction |
| `animate.js` | the season clock and every transition |
| `treegen.js` | document, toolbar, and what holds it together |

## License

MIT.
