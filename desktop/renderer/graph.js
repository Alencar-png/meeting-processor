'use strict';

/**
 * Grafo neural do projeto — estilo Obsidian.
 *
 * Força dirigida simples: nós se repelem, arestas puxam. O nó do projeto
 * fica ancorado ao centro. Clicar num nó abre o item (reunião ou tarefa);
 * arrastar reposiciona; a física acomoda o resto.
 */

const GRAPH_COLORS = {
  project: { fill: '#5eead4', glow: 'rgba(94, 234, 212, 0.5)', r: 11 },
  meeting: { fill: '#53d5fd', glow: 'rgba(83, 213, 253, 0.5)', r: 8 },
  task: { fill: '#9d8bfa', glow: 'rgba(157, 139, 250, 0.5)', r: 6 },
  concept: { fill: '#5d6784', glow: 'rgba(93, 103, 132, 0.4)', r: 5 },
};

function createGraph(canvas, { onOpen } = {}) {
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let nodes = [];
  let edges = [];
  let rafId = null;
  let dragging = null;
  let hovered = null;
  let running = false;

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function setData(data) {
    const { width, height } = canvas.getBoundingClientRect();
    const cx = width / 2 || 400;
    const cy = height / 2 || 260;
    nodes = data.nodes.map((n, i) => {
      const angle = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
      const dist = n.type === 'project' ? 0 : 90 + (i % 5) * 34;
      return {
        ...n,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        vx: 0, vy: 0,
        pinned: n.type === 'project',
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    edges = data.edges
      .map((e) => ({ a: byId.get(e.from), b: byId.get(e.to) }))
      .filter((e) => e.a && e.b);
  }

  function physics() {
    const { width, height } = canvas.getBoundingClientRect();
    const cx = width / 2;
    const cy = height / 2;

    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      if (a.pinned || a === dragging) continue;
      // Repulsão entre todos os nós.
      for (let j = 0; j < nodes.length; j += 1) {
        if (i === j) continue;
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = Math.max(120, dx * dx + dy * dy);
        const f = 2600 / d2;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
      }
      // Gravidade fraca para o centro.
      a.vx += (cx - a.x) * 0.0012;
      a.vy += (cy - a.y) * 0.0012;
    }

    // Molas nas arestas.
    for (const e of edges) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const rest = 95;
      const f = (d - rest) * 0.004;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (!e.a.pinned && e.a !== dragging) { e.a.vx += fx; e.a.vy += fy; }
      if (!e.b.pinned && e.b !== dragging) { e.b.vx -= fx; e.b.vy -= fy; }
    }

    for (const n of nodes) {
      if (n.pinned) { n.x = cx; n.y = cy; continue; }
      if (n === dragging) continue;
      n.vx *= 0.86;
      n.vy *= 0.86;
      n.x = Math.min(width - 20, Math.max(20, n.x + n.vx));
      // Margem maior embaixo: o rótulo fica abaixo do nó e não pode ser cortado.
      n.y = Math.min(height - 30, Math.max(20, n.y + n.vy));
    }
  }

  function draw() {
    const { width, height } = canvas.getBoundingClientRect();
    if (!reduceMotion || dragging) physics();
    ctx.clearRect(0, 0, width, height);

    for (const e of edges) {
      const lit = hovered && (e.a === hovered || e.b === hovered);
      ctx.strokeStyle = lit ? 'rgba(83, 213, 253, 0.45)' : 'rgba(84, 105, 165, 0.18)';
      ctx.lineWidth = lit ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
      ctx.stroke();
    }

    for (const n of nodes) {
      const c = GRAPH_COLORS[n.type] || GRAPH_COLORS.concept;
      const r = c.r * (n === hovered ? 1.25 : 1);
      ctx.shadowBlur = n === hovered ? 18 : 10;
      ctx.shadowColor = c.glow;
      ctx.fillStyle = c.fill;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = n === hovered ? '#e9edf8' : 'rgba(151, 161, 187, 0.85)';
      ctx.font = `${n.type === 'project' ? 12 : 11}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(n.label, n.x, n.y + r + 14);
    }

    rafId = window.requestAnimationFrame(draw);
  }

  function nodeAt(x, y) {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const n = nodes[i];
      const r = (GRAPH_COLORS[n.type] || GRAPH_COLORS.concept).r + 8;
      if ((n.x - x) ** 2 + (n.y - y) ** 2 <= r * r) return n;
    }
    return null;
  }

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  let moved = false;
  canvas.addEventListener('pointerdown', (e) => {
    const p = pos(e);
    dragging = nodeAt(p.x, p.y);
    moved = false;
    if (dragging) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pos(e);
    if (dragging) {
      dragging.x = p.x;
      dragging.y = p.y;
      moved = true;
    } else {
      hovered = nodeAt(p.x, p.y);
      canvas.style.cursor = hovered ? 'pointer' : 'grab';
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (dragging && !moved && onOpen) onOpen(dragging);
    dragging = null;
  });
  canvas.addEventListener('pointerleave', () => { hovered = null; });

  const onResize = () => resize();
  window.addEventListener('resize', onResize);

  return {
    setData,
    start() {
      if (running) return;
      running = true;
      resize();
      rafId = window.requestAnimationFrame(draw);
    },
    stop() {
      running = false;
      window.cancelAnimationFrame(rafId);
    },
    destroy() {
      this.stop();
      window.removeEventListener('resize', onResize);
    },
  };
}

window.createGraph = createGraph;
