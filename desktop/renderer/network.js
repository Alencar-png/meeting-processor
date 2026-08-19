'use strict';

/**
 * Rede neural viva — a animação das telas de trabalho.
 *
 * Inspirada na "Neural Network visualization" de towc
 * (https://codepen.io/towc/pen/wGjXGY), reescrita para o tema do app e para o
 * que esta tela precisa: a rede não é enfeite, ela mostra que há trabalho
 * acontecendo e responde a quem está esperando.
 *
 * Como funciona: neurônios em camadas, ligados à camada seguinte. Sinais
 * nascem na primeira camada e caminham pelas conexões; ao chegar num neurônio
 * ele acende e dispara novos sinais adiante. O progresso do trabalho controla
 * quantos sinais nascem por segundo — no fim, a rede inteira está acesa.
 *
 * E dá para brincar: o ponteiro empurra os neurônios por perto, e clicar
 * dispara uma salva de sinais a partir dali.
 */

const LAYERS = 7;             // colunas de neurônios
const PER_LAYER = [3, 5, 6, 6, 5, 4, 2];
const SPEED = 0.0022;         // fração do caminho por milissegundo
const MOUSE_RADIUS = 90;
const MAX_SIGNALS = 260;

/**
 * Ruído determinístico em [0, 1): a mesma rede em toda execução, sem parecer
 * régua. O resto de divisão sozinho devolveria negativo e viraria índice
 * inválido na hora de escolher uma conexão.
 */
function noise(i, j) {
  const v = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function createNetwork(canvas) {
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let neurons = [];
  let links = [];
  let signals = [];
  let progress = 0;
  let target = 0;
  let mode = 'idle';
  let raf = null;
  let last = 0;
  let acc = 0;
  const mouse = { x: -999, y: -999, active: false };

  function build() {
    const { width, height } = canvas.getBoundingClientRect();
    neurons = [];
    links = [];

    for (let layer = 0; layer < LAYERS; layer += 1) {
      const total = PER_LAYER[layer];
      const x = ((layer + 0.5) / LAYERS) * width;
      for (let i = 0; i < total; i += 1) {
        const espalha = 0.16 + 0.68 * ((i + 0.5) / total);
        const desvio = (noise(layer, i) - 0.5) * (height * 0.14);
        neurons.push({
          layer,
          x,
          y: espalha * height + desvio,
          // Casa de origem: o empurrão do ponteiro é sempre temporário.
          hx: x,
          hy: espalha * height + desvio,
          vx: 0,
          vy: 0,
          charge: 0,
          radius: 2.2 + noise(i, layer) * 1.8,
        });
      }
    }

    for (const [index, n] of neurons.entries()) {
      const proximos = neurons
        .map((m, j) => ({ m, j }))
        .filter(({ m }) => m.layer === n.layer + 1);
      for (const { j } of proximos) {
        // Nem toda ligação existe: a rede fica orgânica em vez de tabelada.
        if (noise(index, j * 3) > 0.62) continue;
        links.push({ from: index, to: j });
      }
    }

    // Neurônio sem saída vira beco sem saída visual: liga ao primeiro adiante.
    for (const [index, n] of neurons.entries()) {
      if (n.layer === LAYERS - 1) continue;
      if (links.some((l) => l.from === index)) continue;
      const j = neurons.findIndex((m) => m.layer === n.layer + 1);
      if (j !== -1) links.push({ from: index, to: j });
    }
  }

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    build();
  }

  /** Solta um sinal por uma das saídas do neurônio. */
  function fire(fromIndex) {
    if (signals.length >= MAX_SIGNALS) return;
    const saidas = links.filter((l) => l.from === fromIndex);
    if (!saidas.length) return;
    const sorteio = Math.floor(noise(fromIndex, signals.length) * saidas.length);
    const escolha = saidas[Math.min(saidas.length - 1, Math.max(0, sorteio))];
    signals.push({ link: escolha, t: 0 });
  }

  function spawn() {
    const entradas = neurons.filter((n) => n.layer === 0);
    const alvo = entradas[Math.floor(Math.random() * entradas.length)];
    const index = neurons.indexOf(alvo);
    alvo.charge = 1;
    fire(index);
  }

  function step(dt) {
    // Quanto mais adiantado o trabalho, mais tráfego na rede.
    const ritmo = mode === 'working' ? 60 + progress * 260 : 26;
    acc += dt;
    const intervalo = 1000 / ritmo;
    while (acc > intervalo) {
      acc -= intervalo;
      spawn();
    }

    for (const s of signals) s.t += dt * SPEED;

    const chegaram = signals.filter((s) => s.t >= 1);
    signals = signals.filter((s) => s.t < 1);
    for (const s of chegaram) {
      const destino = neurons[s.link.to];
      destino.charge = 1;
      if (destino.layer < LAYERS - 1) fire(s.link.to);
    }

    for (const n of neurons) {
      n.charge *= 0.955;

      // Empurrão do ponteiro e volta para casa: o desenho não se desfaz.
      if (mouse.active) {
        const dx = n.x - mouse.x;
        const dy = n.y - mouse.y;
        const d = Math.hypot(dx, dy);
        if (d < MOUSE_RADIUS && d > 0.001) {
          const força = (1 - d / MOUSE_RADIUS) * 2.4;
          n.vx += (dx / d) * força;
          n.vy += (dy / d) * força;
          n.charge = Math.max(n.charge, 0.35);
        }
      }
      n.vx += (n.hx - n.x) * 0.012;
      n.vy += (n.hy - n.y) * 0.012;
      n.vx *= 0.9;
      n.vy *= 0.9;
      n.x += n.vx;
      n.y += n.vy;
    }

    progress += (target - progress) * 0.06;
  }

  function draw() {
    const { width, height } = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, width, height);

    // Conexões: acendem conforme os neurônios das pontas estão carregados.
    for (const l of links) {
      const a = neurons[l.from];
      const b = neurons[l.to];
      const carga = Math.max(a.charge, b.charge);
      ctx.strokeStyle = `rgba(83, 213, 253, ${0.05 + carga * 0.28})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Sinais em trânsito.
    for (const s of signals) {
      const a = neurons[s.link.from];
      const b = neurons[s.link.to];
      const x = a.x + (b.x - a.x) * s.t;
      const y = a.y + (b.y - a.y) * s.t;
      const rastro = 0.14;
      const rx = a.x + (b.x - a.x) * Math.max(0, s.t - rastro);
      const ry = a.y + (b.y - a.y) * Math.max(0, s.t - rastro);

      ctx.strokeStyle = 'rgba(157, 139, 250, 0.55)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(x, y);
      ctx.stroke();

      ctx.fillStyle = '#bfefff';
      ctx.beginPath();
      ctx.arc(x, y, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Neurônios.
    for (const n of neurons) {
      const acesa = n.charge;
      if (acesa > 0.05) {
        ctx.fillStyle = `rgba(83, 213, 253, ${acesa * 0.14})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + 7 + acesa * 5, 0, Math.PI * 2);
        ctx.fill();
      }
      const c = Math.min(1, 0.28 + acesa);
      ctx.fillStyle = acesa > 0.5
        ? `rgba(190, 240, 255, ${c})`
        : `rgba(83, 213, 253, ${c})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius + acesa * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function frame(now) {
    const dt = Math.min(48, now - (last || now));
    last = now;
    if (!reduceMotion) step(dt);
    draw();
    raf = window.requestAnimationFrame(frame);
  }

  // --- Brincar com a rede ---------------------------------------------------

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  const onMove = (e) => {
    const { x, y } = pointerPos(e);
    mouse.x = x;
    mouse.y = y;
    mouse.active = true;
  };
  const onLeave = () => { mouse.active = false; mouse.x = -999; mouse.y = -999; };
  const onDown = (e) => {
    const { x, y } = pointerPos(e);
    // Salva de sinais a partir dos neurônios mais próximos do clique.
    const perto = neurons
      .map((n, i) => ({ i, d: Math.hypot(n.x - x, n.y - y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    for (const { i } of perto) {
      neurons[i].charge = 1;
      fire(i);
      fire(i);
    }
  };

  const onResize = () => resize();
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('resize', onResize);

  resize();
  raf = window.requestAnimationFrame(frame);

  return {
    setMode(next) { mode = next; },
    setProgress(value) { target = Math.min(1, Math.max(0, value)); },
    destroy() {
      window.cancelAnimationFrame(raf);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', onResize);
    },
  };
}

window.createNetwork = createNetwork;
