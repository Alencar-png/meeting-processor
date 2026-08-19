'use strict';

/**
 * Synapse — a rede neural do palco, o elemento de assinatura do app.
 *
 * Não é decoração: é o estado do trabalho desenhado como sinapses.
 * Em repouso a rede respira baixinho; ao arrastar um arquivo ela inteira
 * se excita; durante a transcrição o sinal se propaga da esquerda para a
 * direita — os neurônios acendem conforme o progresso e pulsos correm
 * pelos axônios na frente de onda. Pronto = rede toda acesa.
 */

const NEURAL_COLORS = {
  idle: {
    node: '#232c49', lit: '#39466f', edge: 'rgba(84, 105, 165, 0.16)',
    edgeLit: 'rgba(84, 105, 165, 0.16)', pulse: 'rgba(122, 148, 214, 0.5)', glow: 'rgba(83, 213, 253, 0)',
  },
  dragging: {
    node: '#2a3a5a', lit: '#53d5fd', edge: 'rgba(83, 213, 253, 0.10)',
    edgeLit: 'rgba(83, 213, 253, 0.32)', pulse: 'rgba(157, 139, 250, 0.9)', glow: 'rgba(83, 213, 253, 0.55)',
  },
  working: {
    node: '#25304f', lit: '#53d5fd', edge: 'rgba(84, 105, 165, 0.14)',
    edgeLit: 'rgba(83, 213, 253, 0.38)', pulse: 'rgba(157, 139, 250, 1)', glow: 'rgba(83, 213, 253, 0.6)',
  },
  done: {
    node: '#25304f', lit: '#5eead4', edge: 'rgba(84, 105, 165, 0.12)',
    edgeLit: 'rgba(94, 234, 212, 0.30)', pulse: 'rgba(94, 234, 212, 0.9)', glow: 'rgba(94, 234, 212, 0.5)',
  },
  error: {
    node: '#242033', lit: '#fb7185', edge: 'rgba(120, 90, 110, 0.14)',
    edgeLit: 'rgba(251, 113, 133, 0.22)', pulse: 'rgba(251, 113, 133, 0.7)', glow: 'rgba(251, 113, 133, 0.35)',
  },
};

// Energia geral de cada modo: escala de brilho, pulsação e frequência de pulsos.
const ENERGY = { idle: 0.25, dragging: 0.95, working: 1, done: 0.6, error: 0.2 };

const COLUMNS = 10;

/** Pseudo-aleatório determinístico: a mesma rede em toda execução. */
function rand(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function createNeural(canvas) {
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let mode = 'idle';
  let targetProgress = 0;
  let progress = 0;
  let energy = ENERGY.idle;
  let frame = 0;
  let rafId = null;
  let nodes = [];
  let edges = [];
  let pulses = [];

  /** Gera a topologia: colunas de neurônios ligadas às vizinhas. */
  function build(width, height) {
    nodes = [];
    edges = [];
    pulses = [];
    const marginX = width * 0.03;
    const spanX = width - marginX * 2;
    const columns = [];

    for (let c = 0; c < COLUMNS; c += 1) {
      const count = 3 + Math.round(rand(c * 7.3) * 2); // 3 a 5 por coluna
      const col = [];
      for (let i = 0; i < count; i += 1) {
        const jx = (rand(c * 13.7 + i * 3.1) - 0.5) * (spanX / COLUMNS) * 0.55;
        const y = height * (0.14 + 0.72 * ((i + 0.5) / count))
          + (rand(c * 5.9 + i * 11.3) - 0.5) * height * 0.16;
        const node = {
          x: marginX + (spanX * c) / (COLUMNS - 1) + jx,
          y,
          col: c,
          frac: c / (COLUMNS - 1),
          r: 2 + rand(c * 3.3 + i * 17.9) * 1.8,
          phase: rand(c + i * 29.7) * Math.PI * 2,
        };
        col.push(node);
        nodes.push(node);
      }
      columns.push(col);
    }

    for (let c = 0; c < COLUMNS - 1; c += 1) {
      const from = columns[c];
      const to = columns[c + 1];
      from.forEach((a, i) => {
        const links = 1 + Math.round(rand(c * 19.1 + i * 7.7) * 1.6); // 1 a 3
        for (let k = 0; k < links; k += 1) {
          const j = Math.min(
            to.length - 1,
            Math.max(0, Math.round((i / from.length) * to.length) + k - 1),
          );
          edges.push({ a, b: to[j], frac: a.frac, seed: c * 31 + i * 7 + k });
        }
      });
    }
  }

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    build(width, height);
  }

  /** Solta pulsos nos axônios: na frente de onda (working) ou na rede toda (dragging). */
  function spawnPulses() {
    if (reduceMotion || pulses.length > 26) return;
    const rate = mode === 'working' ? 0.35 : mode === 'dragging' ? 0.5 : mode === 'idle' ? 0.05 : 0;
    if (Math.random() > rate) return;

    const candidates = mode === 'working'
      ? edges.filter((e) => Math.abs(e.frac - progress) < 0.18)
      : edges;
    if (!candidates.length) return;
    const edge = candidates[Math.floor(Math.random() * candidates.length)];
    pulses.push({ edge, t: 0, speed: 0.02 + Math.random() * 0.025 });
  }

  function draw() {
    const { width, height } = canvas.getBoundingClientRect();
    const colors = NEURAL_COLORS[mode] || NEURAL_COLORS.idle;

    energy += ((ENERGY[mode] ?? ENERGY.idle) - energy) * 0.08;
    progress += (targetProgress - progress) * 0.08;

    ctx.clearRect(0, 0, width, height);

    // Axônios.
    for (const e of edges) {
      const lit = mode === 'dragging' || e.frac <= progress + 0.001;
      ctx.strokeStyle = lit ? colors.edgeLit : colors.edge;
      ctx.lineWidth = lit ? 1.2 : 1;
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y);
      // Curva leve: sinapses não são retas de circuito.
      const mx = (e.a.x + e.b.x) / 2;
      const my = (e.a.y + e.b.y) / 2 + (rand(e.seed) - 0.5) * 14;
      ctx.quadraticCurveTo(mx, my, e.b.x, e.b.y);
      ctx.stroke();
    }

    // Pulsos correndo pelos axônios.
    for (let i = pulses.length - 1; i >= 0; i -= 1) {
      const p = pulses[i];
      p.t += p.speed * (0.5 + energy);
      if (p.t >= 1) { pulses.splice(i, 1); continue; }
      const { a, b, seed } = p.edge;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 + (rand(seed) - 0.5) * 14;
      const t = p.t;
      const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mx + t * t * b.x;
      const y = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * my + t * t * b.y;
      ctx.fillStyle = colors.pulse;
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Neurônios.
    for (const n of nodes) {
      const lit = mode === 'dragging' || n.frac <= progress + 0.001;
      const breathe = reduceMotion ? 1 : 1 + 0.22 * energy * Math.sin(frame * 0.05 + n.phase);
      const r = n.r * (lit ? breathe : 1);

      if (lit && energy > 0.3) {
        ctx.shadowBlur = 10 * energy;
        ctx.shadowColor = colors.glow;
      }
      ctx.fillStyle = lit ? colors.lit : colors.node;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Frente de onda: a coluna vertical onde o sinal está chegando.
    if (mode === 'working' && progress > 0.001 && progress < 0.999) {
      const x = width * 0.03 + (width - width * 0.06) * progress;
      const grad = ctx.createLinearGradient(x, 0, x, height);
      grad.addColorStop(0, 'rgba(83, 213, 253, 0)');
      grad.addColorStop(0.5, 'rgba(83, 213, 253, 0.35)');
      grad.addColorStop(1, 'rgba(83, 213, 253, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, 0, 1, height);
    }

    spawnPulses();
    frame += 1;
    rafId = window.requestAnimationFrame(draw);
  }

  const onResize = () => resize();
  window.addEventListener('resize', onResize);
  resize();
  rafId = window.requestAnimationFrame(draw);

  return {
    setMode(next) {
      mode = next;
      if (next === 'done') targetProgress = 1;
      if (next === 'idle' || next === 'dragging' || next === 'error') targetProgress = 0;
    },
    setProgress(value) {
      targetProgress = Math.min(1, Math.max(0, value));
    },
    destroy() {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    },
  };
}

window.createNeural = createNeural;
