'use strict';
/* graph-client.js — the interactive relationship graph, served verbatim at
 * /assets/graph.js and run in the browser. It is NOT a Node module; the leading
 * 'use strict' + IIFE keep it a single self-contained script (and let
 * `node --check` lint it). All data arrives on window.__GRAPH, injected by
 * scripts/crm-web.js graphPage(); with JavaScript off, this never runs and the
 * server-rendered edge table below the canvas is the fallback.
 *
 * Design: a small dependency-free force simulation (repulsion + weighted springs
 * + per-community cohesion), SVG rendering, pan/zoom/drag like the Obsidian graph.
 * The owner ("nathan") is never a node — see graphPage for why the model excludes
 * him. */
(function () {
  var G = window.__GRAPH;
  var host = document.getElementById('graph-canvas');
  if (!G || !host || !host.getBoundingClientRect) return;

  var SVGNS = 'http://www.w3.org/2000/svg';
  var W = 1000, H = 700, CX = W / 2, CY = H / 2;

  // ---- data ---------------------------------------------------------------
  var nodes = G.nodes.map(function (n) {
    return { slug: n.slug, name: n.name, size: n.size, community: n.community,
      x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null, r: 12 };
  });
  var byId = {};
  nodes.forEach(function (n) { byId[n.slug] = n; });
  var edges = G.edges.filter(function (e) { return byId[e.from] && byId[e.to] && e.from !== e.to; });
  var suffix = G.edgeSuffix || '';

  // Node radius: sqrt so AREA tracks mention count. A node nobody names still gets
  // the floor radius so it stays clickable.
  var sizes = nodes.map(function (n) { return n.size; });
  var maxS = Math.max.apply(null, sizes.concat([1]));
  var minS = Math.min.apply(null, sizes.concat([0]));
  nodes.forEach(function (n) {
    var t = maxS === minS ? 0.5 : (Math.sqrt(n.size) - Math.sqrt(minS)) / (Math.sqrt(maxS) - Math.sqrt(minS));
    n.r = 9 + t * 22;
  });

  var ns = edges.map(function (e) { return e.n; });
  var maxN = Math.max.apply(null, ns.concat([1]));
  var minN = Math.min.apply(null, ns.concat([1]));
  function strokeW(n) {
    var t = maxN === minN ? 0.5 : (n - minN) / (maxN - minN);
    return 1.2 + t * 5;
  }

  // Community palette — mid-tone hues that read on both the light and the dark
  // sheet. Cycles if there are more communities than colours.
  var PALETTE = ['#4f7cc4', '#c46a4f', '#57a773', '#b061b0', '#c9a227', '#4fb0b0',
    '#d16a8f', '#7a86c9', '#8faa3e', '#c98a3e', '#5a9bd4', '#a86f5a'];
  var NEUTRAL = '#9b9c94';   // the "Ungrouped" bucket (people with no peer ties) reads as no-colour
  function color(c) {
    if (G.ungroupedId != null && c === G.ungroupedId) return NEUTRAL;
    return PALETTE[((c % PALETTE.length) + PALETTE.length) % PALETTE.length];
  }

  // ---- selection (subset view) --------------------------------------------
  // sel drives visibility: empty = show everyone; non-empty = show only those
  // slugs and the edges between them. The community dropdown and the checkbox
  // list both edit this one set.
  var sel = {};        // slug -> true
  function selCount() { return Object.keys(sel).length; }
  function isVisible(slug) { return selCount() === 0 || sel[slug]; }
  function visibleNodes() { return nodes.filter(function (n) { return isVisible(n.slug); }); }
  function visibleEdges() { return edges.filter(function (e) { return isVisible(e.from) && isVisible(e.to); }); }

  // ---- SVG scaffold -------------------------------------------------------
  var svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('class', 'graph-svg');
  svg.setAttribute('role', 'application');
  svg.setAttribute('aria-label', 'Interactive relationship graph');
  var defs = document.createElementNS(SVGNS, 'defs');
  defs.innerHTML = '<marker id="g-arrow" viewBox="0 0 10 10" refX="9" refY="5" '
    + 'markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">'
    + '<path d="M0,0 L10,5 L0,10 z" fill="var(--stamp)" fill-opacity="0.75"/></marker>';
  svg.appendChild(defs);
  var vp = document.createElementNS(SVGNS, 'g');           // pan/zoom viewport
  var edgeLayer = document.createElementNS(SVGNS, 'g');
  var nodeLayer = document.createElementNS(SVGNS, 'g');
  vp.appendChild(edgeLayer);
  vp.appendChild(nodeLayer);
  svg.appendChild(vp);
  host.appendChild(svg);

  var view = { x: 0, y: 0, k: 1 };
  function applyView() { vp.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')'); }

  // Client coords -> SVG user units, honouring the responsive viewBox.
  function toSvg(cx, cy) {
    var pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
    var m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    var p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }
  function toGraph(cx, cy) {
    var s = toSvg(cx, cy);
    return { x: (s.x - view.x) / view.k, y: (s.y - view.y) / view.k };
  }

  // ---- DOM elements per node/edge (created on (re)build, updated per tick) --
  var edgeEls = [];    // { e, path }
  var nodeEls = [];    // { n, g, circle, label }
  var selectedSlug = null;

  function clearLayer(layer) { while (layer.firstChild) layer.removeChild(layer.firstChild); }

  function build() {
    // If a filter change hid the currently-selected node, drop the selection so
    // applyHighlight() doesn't dim the whole (now unrelated) visible set and leave
    // a panel open for someone off-screen.
    if (selectedSlug && !isVisible(selectedSlug)) { selectedSlug = null; if (panel) panel.hidden = true; }
    clearLayer(edgeLayer); clearLayer(nodeLayer);
    edgeEls = []; nodeEls = [];
    var vn = visibleNodes();
    var ve = visibleEdges();

    // Seed any node that has never been placed onto a centred ring; keep the
    // positions of nodes already laid out so toggling a subset doesn't reshuffle.
    var unplaced = vn.filter(function (n) { return !n._placed; });
    unplaced.forEach(function (n, i) {
      var theta = (2 * Math.PI * i) / Math.max(1, unplaced.length) - Math.PI / 2;
      var rad = Math.min(W, H) / 3;
      n.x = CX + rad * Math.cos(theta) + (Math.random() - 0.5) * 40;
      n.y = CY + rad * Math.sin(theta) + (Math.random() - 0.5) * 40;
      n.vx = 0; n.vy = 0; n._placed = true;
    });

    ve.forEach(function (e) {
      var path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'graph-edge');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', strokeW(e.n).toFixed(1));
      path.setAttribute('marker-end', 'url(#g-arrow)');
      path.setAttribute('data-edge', '1');
      var title = document.createElementNS(SVGNS, 'title');
      title.textContent = name(e.from) + ' → ' + name(e.to) + ' · ' + e.n + ' mention' + (e.n === 1 ? '' : 's');
      path.appendChild(title);
      path.addEventListener('click', function () {
        if (movedFar) return;            // a drag that ended on this edge, not a click — don't navigate
        window.location.href = '/graph/edge?from=' + encodeURIComponent(e.from) + '&to=' + encodeURIComponent(e.to) + suffix;
      });
      edgeLayer.appendChild(path);
      edgeEls.push({ e: e, path: path });
    });

    vn.forEach(function (n) {
      var g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'graph-node');
      g.setAttribute('data-node', n.slug);
      var c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('r', n.r.toFixed(1));
      c.setAttribute('fill', color(n.community));
      var t = document.createElementNS(SVGNS, 'title');
      t.textContent = n.name + ' · ' + n.size + ' mention' + (n.size === 1 ? '' : 's');
      c.appendChild(t);
      var label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('class', 'graph-label');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('y', (n.r + 13).toFixed(1));
      label.textContent = n.name;
      g.appendChild(c); g.appendChild(label);
      nodeLayer.appendChild(g);
      nodeEls.push({ n: n, g: g, circle: c, label: label });
    });

    applyHighlight();
    reheat();
  }

  function name(slug) { return byId[slug] ? byId[slug].name : slug; }

  // ---- force simulation ---------------------------------------------------
  var alpha = 1, running = false;
  var REPULSION = 2600, SPRING = 0.02, CENTER = 0.012, COHESION = 0.020, DAMP = 0.9;

  function reheat() { alpha = Math.max(alpha, 0.9); if (!running) { running = true; requestAnimationFrame(tick); } }

  function tick() {
    var vn = visibleNodes();
    var ve = visibleEdges();
    var i, j, a, b;

    // Pairwise repulsion (O(n^2); fine for tens–low-hundreds of nodes).
    for (i = 0; i < vn.length; i += 1) {
      a = vn[i];
      for (j = i + 1; j < vn.length; j += 1) {
        b = vn[j];
        var dx = a.x - b.x, dy = a.y - b.y;
        var d2 = dx * dx + dy * dy + 0.01;
        var dist = Math.sqrt(d2);
        var f = (REPULSION * alpha) / d2;
        var fx = (dx / dist) * f, fy = (dy / dist) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }

    // Weighted springs: a heavier tie has a shorter rest length, so friends who
    // reference each other more sit closer.
    for (i = 0; i < ve.length; i += 1) {
      var e = ve[i]; a = byId[e.from]; b = byId[e.to];
      var ex = b.x - a.x, ey = b.y - a.y;
      var elen = Math.sqrt(ex * ex + ey * ey) + 0.01;
      var rest = 220 - Math.min(140, Math.log(1 + e.n) * 45);
      var disp = (elen - rest) * SPRING * alpha;
      var ux = ex / elen, uy = ey / elen;
      a.vx += ux * disp; a.vy += uy * disp;
      b.vx -= ux * disp; b.vy -= uy * disp;
    }

    // Per-community cohesion: pull each node toward the centroid of its community
    // (visible members only) so clusters read as clusters. Plus a weak global
    // pull to centre so nothing drifts off-canvas.
    var cen = {}, cnt = {};
    for (i = 0; i < vn.length; i += 1) {
      a = vn[i]; var cm = a.community;
      if (!cen[cm]) { cen[cm] = { x: 0, y: 0 }; cnt[cm] = 0; }
      cen[cm].x += a.x; cen[cm].y += a.y; cnt[cm] += 1;
    }
    for (var k in cen) { if (cen.hasOwnProperty(k)) { cen[k].x /= cnt[k]; cen[k].y /= cnt[k]; } }
    for (i = 0; i < vn.length; i += 1) {
      a = vn[i];
      var c = cen[a.community];
      a.vx += (c.x - a.x) * COHESION * alpha;
      a.vy += (c.y - a.y) * COHESION * alpha;
      a.vx += (CX - a.x) * CENTER * alpha;
      a.vy += (CY - a.y) * CENTER * alpha;
    }

    // Integrate (skip pinned/dragged nodes).
    for (i = 0; i < vn.length; i += 1) {
      a = vn[i];
      if (a.fx != null) { a.x = a.fx; a.vx = 0; } else { a.vx *= DAMP; a.x += a.vx; }
      if (a.fy != null) { a.y = a.fy; a.vy = 0; } else { a.vy *= DAMP; a.y += a.vy; }
    }

    render();
    alpha *= 0.985;
    if (alpha > 0.02 || dragging) { requestAnimationFrame(tick); } else { running = false; }
  }

  function edgePath(e) {
    var a = byId[e.from], b = byId[e.to];
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len;
    var sign = e.from < e.to ? 1 : -1;
    var off = 16 * sign;
    var px = -uy * off, py = ux * off;
    var sx = a.x + ux * a.r, sy = a.y + uy * a.r;
    var ex = b.x - ux * (b.r + 7), ey = b.y - uy * (b.r + 7);
    var mx = (sx + ex) / 2 + px, my = (sy + ey) / 2 + py;
    return 'M' + sx.toFixed(1) + ' ' + sy.toFixed(1) + ' Q' + mx.toFixed(1) + ' ' + my.toFixed(1)
      + ' ' + ex.toFixed(1) + ' ' + ey.toFixed(1);
  }

  function render() {
    for (var i = 0; i < edgeEls.length; i += 1) edgeEls[i].path.setAttribute('d', edgePath(edgeEls[i].e));
    for (var j = 0; j < nodeEls.length; j += 1) {
      var ne = nodeEls[j];
      ne.g.setAttribute('transform', 'translate(' + ne.n.x.toFixed(1) + ',' + ne.n.y.toFixed(1) + ')');
    }
  }

  // ---- highlight ----------------------------------------------------------
  function applyHighlight() {
    var nbr = {};
    if (selectedSlug) {
      nbr[selectedSlug] = true;
      edges.forEach(function (e) {
        if (e.from === selectedSlug) nbr[e.to] = true;
        if (e.to === selectedSlug) nbr[e.from] = true;
      });
    }
    nodeEls.forEach(function (ne) {
      var on = !selectedSlug || nbr[ne.n.slug];
      ne.g.setAttribute('class', 'graph-node' + (on ? '' : ' dim') + (ne.n.slug === selectedSlug ? ' sel' : ''));
    });
    edgeEls.forEach(function (ee) {
      var on = !selectedSlug || ee.e.from === selectedSlug || ee.e.to === selectedSlug;
      ee.path.setAttribute('class', 'graph-edge' + (on ? '' : ' dim'));
    });
  }

  // ---- interaction: pan, zoom, drag ---------------------------------------
  var dragging = null, panning = null;
  // Distance the pointer travelled since it went down, so a pan (or a node drag)
  // is never mistaken for a click that would clear the selection.
  var pressX = 0, pressY = 0, movedFar = false;

  svg.addEventListener('pointerdown', function (e) {
    pressX = e.clientX; pressY = e.clientY; movedFar = false;
    var nodeEl = e.target.closest ? e.target.closest('[data-node]') : null;
    if (nodeEl) {
      var n = byId[nodeEl.getAttribute('data-node')];
      if (n) { dragging = n; n.fx = n.x; n.fy = n.y; svg.setPointerCapture(e.pointerId); e.preventDefault(); }
      return;
    }
    if (e.target.closest && e.target.closest('[data-edge]')) return;  // let the edge click through
    panning = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener('pointermove', function (e) {
    if (Math.abs(e.clientX - pressX) + Math.abs(e.clientY - pressY) > 4) movedFar = true;
    if (dragging) {
      var g = toGraph(e.clientX, e.clientY);
      dragging.fx = g.x; dragging.fy = g.y; reheat();
      return;
    }
    if (panning) {
      var s0 = toSvg(panning.sx, panning.sy), s1 = toSvg(e.clientX, e.clientY);
      view.x = panning.vx + (s1.x - s0.x); view.y = panning.vy + (s1.y - s0.y);
      applyView();
    }
  });

  function endPointer(e) {
    if (dragging) {
      var n = dragging; dragging = null;
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
      if (e.type === 'pointercancel') {
        n.fx = null; n.fy = null;               // interrupted gesture: unpin, don't select
      } else if (!movedFar) {
        n.fx = null; n.fy = null;               // a tap (within 4px): unpin and open the panel
        selectNode(n.slug);
      }
      // else: a real drag → keep n.fx/n.fy so the node stays where it was dropped
      // (a pin). Reset releases all pins. Uses the same 4px threshold as the
      // canvas-click test, so a touch tap with sub-pixel jitter still counts.
      reheat();
      return;
    }
    if (panning) { panning = null; try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ } }
  }
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);

  svg.addEventListener('wheel', function (e) {
    e.preventDefault();
    var s = toSvg(e.clientX, e.clientY);
    var factor = Math.exp(-e.deltaY * 0.0015);
    var nk = Math.max(0.25, Math.min(5, view.k * factor));
    view.x = s.x - ((s.x - view.x) / view.k) * nk;
    view.y = s.y - ((s.y - view.y) / view.k) * nk;
    view.k = nk; applyView();
  }, { passive: false });

  // ---- side panel: who this person mentions most --------------------------
  var panel = document.getElementById('graph-panel');
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function selectNode(slug) {
    selectedSlug = slug; applyHighlight();
    if (!panel) return;
    var n = byId[slug];
    var out = edges.filter(function (e) { return e.from === slug; }).sort(function (a, b) { return b.n - a.n; });
    var inb = edges.filter(function (e) { return e.to === slug; }).sort(function (a, b) { return b.n - a.n; });
    function row(e, otherSlug) {
      var href = '/graph/edge?from=' + encodeURIComponent(e.from) + '&to=' + encodeURIComponent(e.to) + suffix;
      return '<li><a href="' + href + '">' + esc(name(otherSlug)) + '</a> <span class="g-count">' + e.n + '</span></li>';
    }
    var html = '<button class="g-close" type="button" aria-label="Close">×</button>'
      + '<h3>' + esc(n.name) + '</h3>'
      + '<p class="sub">Mentioned ' + n.size + ' time' + (n.size === 1 ? '' : 's')
      + ' · ' + (G.ungroupedId != null && n.community === G.ungroupedId ? 'ungrouped' : 'community ' + (n.community + 1)) + '</p>'
      + '<h4>Mentions most</h4>'
      + (out.length ? '<ul class="g-list">' + out.slice(0, 12).map(function (e) { return row(e, e.to); }).join('') + '</ul>'
        : '<p class="sub">Doesn’t name anyone tracked.</p>')
      + '<h4>Mentioned by</h4>'
      + (inb.length ? '<ul class="g-list">' + inb.slice(0, 12).map(function (e) { return row(e, e.from); }).join('') + '</ul>'
        : '<p class="sub">Not named by anyone tracked.</p>');
    panel.innerHTML = html;
    panel.hidden = false;
    var close = panel.querySelector('.g-close');
    if (close) close.addEventListener('click', clearSelection);
  }
  function clearSelection() { selectedSlug = null; applyHighlight(); if (panel) panel.hidden = true; }

  // Clicking (not dragging) empty canvas clears the selection.
  svg.addEventListener('click', function (e) {
    if (movedFar) return;
    if (e.target === svg || e.target === vp) clearSelection();
  });

  // ---- controls: community dropdown, people checklist, fit/reset -----------
  var comSel = document.getElementById('graph-community');
  var peopleBox = document.getElementById('graph-people');
  var searchIn = document.getElementById('graph-search');
  var fitBtn = document.getElementById('graph-fit');
  var resetBtn = document.getElementById('graph-reset');

  // A programmatically-selected "Custom" entry the user can't pick, so the control
  // never claims "All communities" while a hand-edited subset is on screen.
  var customOpt = null;
  if (comSel) {
    customOpt = document.createElement('option');
    customOpt.value = 'custom'; customOpt.textContent = '— custom —'; customOpt.disabled = true;
    comSel.appendChild(customOpt);
  }
  function syncComLabel() {
    if (!comSel) return;
    if (selCount() === 0) comSel.value = 'all';
    else if (customOpt) customOpt.selected = true;
  }

  function membersOfCommunity(c) { return nodes.filter(function (n) { return n.community === c; }).map(function (n) { return n.slug; }); }
  function setSelection(slugs) {
    sel = {}; slugs.forEach(function (s) { sel[s] = true; });
    syncCheckboxes(); build();
  }
  function syncCheckboxes() {
    if (!peopleBox) return;
    var boxes = peopleBox.querySelectorAll('input[type=checkbox]');
    for (var i = 0; i < boxes.length; i += 1) boxes[i].checked = !!sel[boxes[i].value];
  }

  if (comSel) {
    comSel.addEventListener('change', function () {
      if (comSel.value === 'custom') return;              // not user-selectable, ignore
      if (comSel.value === 'all') setSelection([]);
      else setSelection(membersOfCommunity(parseInt(comSel.value, 10)));
    });
  }
  if (peopleBox) {
    peopleBox.addEventListener('change', function (e) {
      var cb = e.target;
      if (!cb || cb.type !== 'checkbox') return;
      if (cb.checked) sel[cb.value] = true; else delete sel[cb.value];
      syncComLabel();
      build();
    });
  }
  if (searchIn) {
    searchIn.addEventListener('input', function () {
      var q = searchIn.value.toLowerCase();
      var rows = peopleBox ? peopleBox.querySelectorAll('label') : [];
      for (var i = 0; i < rows.length; i += 1) {
        var txt = rows[i].textContent.toLowerCase();
        rows[i].style.display = txt.indexOf(q) === -1 ? 'none' : '';
      }
    });
  }
  // Frame every visible node: fit its bounding box (plus each node's radius and a
  // little room for the label below) into the viewBox, centred. Falls back to the
  // identity transform when there's nothing to frame.
  function fit() {
    var vn = visibleNodes();
    if (!vn.length) { view = { x: 0, y: 0, k: 1 }; applyView(); return; }
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    vn.forEach(function (n) {
      minx = Math.min(minx, n.x - n.r); maxx = Math.max(maxx, n.x + n.r);
      miny = Math.min(miny, n.y - n.r); maxy = Math.max(maxy, n.y + n.r + 16);
    });
    var pad = 48;
    var bw = Math.max(1, maxx - minx), bh = Math.max(1, maxy - miny);
    var k = Math.max(0.25, Math.min(5, Math.min((W - pad) / bw, (H - pad) / bh)));
    view.k = k;
    view.x = (W - (minx + maxx) * k) / 2;
    view.y = (H - (miny + maxy) * k) / 2;
    applyView();
  }
  if (fitBtn) fitBtn.addEventListener('click', fit);
  if (resetBtn) resetBtn.addEventListener('click', function () {
    clearSelection();
    nodes.forEach(function (n) { n.fx = null; n.fy = null; });   // release every pinned node
    if (searchIn) { searchIn.value = ''; }
    if (peopleBox) { var rows = peopleBox.querySelectorAll('label'); for (var i = 0; i < rows.length; i += 1) rows[i].style.display = ''; }
    setSelection([]);            // show everyone (also resets the dropdown via syncComLabel path)
    if (comSel) comSel.value = 'all';
    fit();
  });

  // ---- go -----------------------------------------------------------------
  applyView();
  build();
})();
