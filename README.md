# treegen

get in touch with nature without touching any nature

[**Open it →**](https://bobbymeyer.github.io/treegen/)

## quickstart

Nothing to install and nothing to build. Open `index.html`, or serve the
folder:

```sh
python3 -m http.server
```

```sh
npm test        # headless, Node >= 22.12
```

## the canvas

| Do this | Get this |
| --- | --- |
| Click empty space | Place a point. **The first point sets the horizon** — above it is canopy, below is root |
| Click an empty canvas | Plant a seed. With **grow** on the season turns to spring a moment later and the seed grows into it — a shoot up, roots down; with grow off it is just the first point, and you draw |
| Hover a point | Reveal it; points stay invisible otherwise |
| Drag a point | Move it and everything downstream with it; the branch above stretches |
| Right-click a point | Cut it, and everything past it |

Only the points snap to the lattice. A branch is a straight segment between
two of them at whatever angle and length that takes, so nothing staircases.

The stage tints from the horizon outward — sky above, earth below, both
fading to nothing as they go. The horizon is set by the first point, so an
empty canvas has no ground to show.

## toolbar

| Control | Range | Does |
| --- | --- | --- |
| **structure** | | |
| lattice | square, hex, triangle, voronoi | The grid points snap to. Voronoi adjacency is the Delaunay dual of its sites |
| trunk | 1–6, default 2 | Strahler order at which the stem stops counting as trunk. Higher ends the trunk lower |
| clear | | Empty the canvas |
| **look** | | |
| roll seed | | New seed. Changes the canopy without touching the tree you drew |
| palette | orchard, slate, ember, ink | Swatch list for leaf, fall, blossom and fruit |
| layers | 0–5, default 2 | Rings of lattice cells around each branch that can hold foliage |
| **season** | | |
| next season | | Advance one season |
| grow | **on** | Extend the tree by one L-system step each spring. Also what makes a planted seed germinate |
| sprout | 0–100, default 25 | Chance per spring that mature wood breaks a bud part-way along a limb |
| auto | **on** | Advance on a timer |
| interval | 1–60s, default 4 | Seconds per season |
| **file** | | |
| save json | | The document. This is what round-trips |
| load | | Read a saved document |
| export svg | | Snapshot of the current season. One-way — it cannot be loaded back |

### l-system

| Field | Default | Is |
| --- | --- | --- |
| axiom | `F` | Starting string |
| rules | `F -> F[+F][-F]F` | Production rules, one per line |
| iterations | 5, max 8 | Expansion passes |
| angle | 35°, 5–120 | Turn per `+` or `-` |
| segment | 2, 1–8 | Branch length, in grid steps |
| variation | 35, 0–100 | How far branches may depart from the exact rule |
| roots | 3, 0–6 | Depth of the root system below the horizon; 0 for none |

## how it behaves

**Vegetation is rules only.** There is no way to place a leaf. Foliage comes
from depth, tip-versus-interior, Strahler order and a seeded roll — properties
of shape alone, so the same rules apply whether you drew the tree or grew it.
Leaves fill whole lattice cells.

**Colour runs in two stages.** Every object takes a grayscale tone from its
position in the graph, knowing nothing about colour; a second stage maps tone
onto a swatch. Changing palette never disturbs the design underneath, and fall
is stage two re-run against a different swatch list.

**The trunk is found, not drawn.** From the root, follow the highest Strahler
order at every fork. That path bears no foliage.

**Seasons run forward in order** — spring, summer, fall, winter, then the next
year. Each object keeps a stable identity across all four. Winter drops every
leaf on a sine path, the swing narrowing as it falls, fading out before the
ground line.

**Growth extends from the tips**, so earlier years survive. Past a Strahler
threshold a limb stops bearing foliage and sheds its fine twigs, which come
away in winter with the leaves. Mature wood also breaks buds part-way along a
limb, at the `sprout` chance, opening into the widest gap in the wood already
leaving that node.

**Everything stochastic is seeded.** Voronoi sites, the L-system, placement,
tone, palette substitution, growth and every leaf's fall each draw from their
own named stream, so rolling one never disturbs another and the same seed
always gives the same tree.

## embedding it

`treegen.js` is an ES module that boots itself against `#treegen` markup on
its own page. To run it inside something else, take the markup from
`index.html`, load `treegen.css`, and drive it:

```js
window.__treegenEmbedded = true;   // before the import: don't self-boot
const { initTreegen, destroyTreegen } =
  await import('https://bobbymeyer.github.io/treegen/treegen.js');

initTreegen();        // no-ops when the markup isn't on the page
destroyTreegen();     // before the host removes it
```

This is how bobbymeyer.com runs it — loaded from this deploy rather than
vendored.

## files

| | |
| --- | --- |
| `rng.js` | mulberry32, named sub-streams, per-object streams |
| `grid.js` | the four lattices, adjacency, Poisson-disc + Delaunay |
| `tree.js` | the node graph, depth, Strahler order, trunk, pruning |
| `lsystem.js` | rules, expansion, the lattice turtle, growth, shoots |
| `foliage.js` | placement rules, crown shape, tone and palette |
| `render.js` | scene to SVG, canvas interaction |
| `animate.js` | the season clock and every transition |
| `treegen.js` | document, toolbar, and what holds it together |

## tech

ES modules, no dependencies, no build. Node >= 22.12 for the tests, which run
through `node --test`: 95 passing.

The engine is DOM-free and the renderer draws through an injected element
factory, so the same drawing code runs in the browser and in the tests. The
suite writes `test/treegen-proof.html`, a rendering of all four seasons.

## license

MIT.
