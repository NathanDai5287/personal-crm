'use strict';
// graph-communities.js — group the relationship graph into communities so the
// force layout can cluster friends who reference each other.
//
// Weighted label propagation (Raghavan et al.): cheap, no dependencies, and good
// enough for a graph of tens-to-low-hundreds of people. Every node starts in its
// own community, then repeatedly adopts the community its edges pull hardest
// toward; dense clusters usually settle within a handful of passes. On a
// near-symmetric graph LP can oscillate rather than fully converge, so the loop is
// bounded by maxIter and simply returns wherever it is at that point — the result
// stays DETERMINISTIC either way (fixed order + smallest-label tie-break), it may
// just be a slightly coarser partition. That's an acceptable trade for a
// dependency-free grouping used only to colour and pre-cluster the layout.
//
// DETERMINISM MATTERS: this runs on every /graph render, and a layout that
// re-colours itself on each refresh of the same data would read as noise. So the
// node visiting order is fixed (heaviest first, then slug), ties are broken by the
// smallest slug, and the final integer ids are assigned in a stable order. Same
// edges in → same communities out, every time.

// Collapse the DIRECTED mention edges into one UNDIRECTED weighted adjacency:
// A mentioning B and B mentioning A are the same social tie for clustering, so
// their counts add. Edges touching a slug outside `nodes` are ignored (the caller
// excludes the owner, whose star-shaped edges would wrongly fuse everyone).
function buildAdjacency(nodes, edges) {
  const nodeSet = new Set(nodes);
  const adj = new Map();       // slug -> Map(neighbourSlug -> summed weight)
  for (const s of nodes) adj.set(s, new Map());
  for (const e of edges) {
    const a = e.from_slug, b = e.to_slug;
    if (a === b) continue;                    // a self-mention is not a tie
    if (!nodeSet.has(a) || !nodeSet.has(b)) continue;
    const w = e.n || 1;
    adj.get(a).set(b, (adj.get(a).get(b) || 0) + w);
    adj.get(b).set(a, (adj.get(b).get(a) || 0) + w);
  }
  return adj;
}

// Total incident weight per node, used only to fix the visiting order (heaviest
// hubs settle first, which speeds and stabilises convergence).
function strengthOrder(nodes, adj) {
  const strength = new Map();
  for (const s of nodes) {
    let t = 0;
    for (const w of adj.get(s).values()) t += w;
    strength.set(s, t);
  }
  return [...nodes].sort((a, b) => (strength.get(b) - strength.get(a)) || (a < b ? -1 : a > b ? 1 : 0));
}

// One asynchronous LP pass: each node adopts the label with the greatest summed
// neighbour weight, updating in place so later nodes see earlier moves. Returns
// whether any label changed. Ties (including a node's own current label) break
// toward the lexicographically smallest label, which is what makes the result
// reproducible rather than dependent on Map insertion order.
function propagateOnce(order, adj, label) {
  let changed = false;
  for (const node of order) {
    const votes = new Map();
    for (const [nbr, w] of adj.get(node)) {
      const l = label.get(nbr);
      votes.set(l, (votes.get(l) || 0) + w);
    }
    if (!votes.size) continue;               // isolated node keeps its own label
    let best = null, bestW = -Infinity;
    for (const [l, w] of votes) {
      if (w > bestW || (w === bestW && (best === null || l < best))) { best = l; bestW = w; }
    }
    if (best !== label.get(node)) { label.set(node, best); changed = true; }
  }
  return changed;
}

// Rename the raw slug-labels to small integer ids 0..k-1, ordered by community
// size (largest first) then by the smallest slug inside — a stable, meaningful
// order so "community 0" is the biggest cluster on every render.
function compactLabels(nodes, label) {
  const members = new Map();                 // rawLabel -> [slugs]
  for (const s of nodes) {
    const l = label.get(s);
    if (!members.has(l)) members.set(l, []);
    members.get(l).push(s);
  }
  const groups = [...members.values()].map((slugs) => {
    slugs.sort();
    return { slugs, size: slugs.length, min: slugs[0] };
  });
  groups.sort((a, b) => (b.size - a.size) || (a.min < b.min ? -1 : a.min > b.min ? 1 : 0));
  const out = new Map();
  groups.forEach((g, id) => { for (const s of g.slugs) out.set(s, id); });
  return out;
}

// Public: nodes (array of slugs) + directed edges -> Map(slug -> communityId).
// communityCount is the number of distinct communities found.
function detectCommunities(nodes, edges, opts = {}) {
  const maxIter = opts.maxIter || 30;
  if (!nodes.length) return { community: new Map(), communityCount: 0 };
  const adj = buildAdjacency(nodes, edges);
  const order = strengthOrder(nodes, adj);
  const label = new Map(nodes.map((s) => [s, s]));
  for (let i = 0; i < maxIter; i += 1) {
    if (!propagateOnce(order, adj, label)) break;   // stable: no node moved
  }
  const community = compactLabels(nodes, label);
  const communityCount = new Set(community.values()).size;
  return { community, communityCount };
}

module.exports = { detectCommunities, buildAdjacency };
