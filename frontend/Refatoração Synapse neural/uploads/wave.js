'use strict';

/**
 * Forma de onda do palco — o elemento de assinatura do app.
 *
 * Não é decoração: em repouso é uma linha de sinal quase plana, ao arrastar
 * um arquivo ela ganha amplitude, e durante a transcrição o progresso avança
 * pela onda como um cabeçote de leitura. O estado do trabalho é a imagem.
 */

const WAVE_COLORS = {
  idle: { played: '#3a322c', pending: '#2a2420' },
  dragging: { played: '#8a6428', pending: '#3a322c' },
  working: { played: '#e8a33d', pending: '#302a25' },
  done: { played: '#74d6be', pending: '#2a2420' },
  error: { played: '#e5674b', pending: '#2a2420' },
};

const AMPLITUDE = {
  idle: 0.22,
  dragging: 0.78,
  working: 0.88,
  done: 0.5,
  error: 0.16,
};

const BAR_WIDTH = 3;
const BAR_GAP = 4;

/** Ruído determinístico: a mesma onda em toda execução, sem parecer regular. */
function shape(index, total) {
  const t = index / total;
  const envelope = 0.35 + 0.65 * Math.sin(Math.PI * t) ** 0.6;
  const detail =
    Math.sin(index * 0.7) * 0.5 +
    Math.sin(index * 1.9 + 1.2) * 0.3 +
    Math.sin(index * 4.3 + 0.4) * 0.2;
  return envelope * (0.35 + 0.65 * Math.abs(detail));
}

function createWave(canvas) {
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let mode = 'idle';
  let targetProgress = 0;
  let progress = 0;
  let amplitude = AMPLITUDE.idle;
  let frame = 0;
  let rafId = null;

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function draw() {
    const { width, height } = canvas.getBoundingClientRect();
    const middle = height / 2;
    const step = BAR_WIDTH + BAR_GAP;
    const count = Math.max(1, Math.floor(width / step));
    const colors = WAVE_COLORS[mode] || WAVE_COLORS.idle;

    // Interpolação: amplitude e progresso chegam ao alvo sem salto.
    amplitude += ((AMPLITUDE[mode] ?? AMPLITUDE.idle) - amplitude) * 0.12;
    progress += (targetProgress - progress) * 0.08;

    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < count; i += 1) {
      const x = i * step + (width - count * step) / 2;
      // Só o estado "working" respira; nos outros a onda fica parada.
      const pulse =
        mode === 'working' && !reduceMotion
          ? 0.82 + 0.18 * Math.sin(frame * 0.08 + i * 0.35)
          : 1;
      const barHeight = Math.max(2, shape(i, count) * amplitude * height * pulse);
      const played = i / count <= progress;

      ctx.fillStyle = played ? colors.played : colors.pending;
      ctx.fillRect(x, middle - barHeight / 2, BAR_WIDTH, barHeight);
    }

    // Cabeçote de leitura: só faz sentido enquanto algo está sendo lido.
    if (mode === 'working' && progress > 0.001) {
      const headX = (width - count * step) / 2 + progress * count * step;
      ctx.fillStyle = 'rgba(232, 163, 61, 0.75)';
      ctx.fillRect(headX, middle - height * 0.42, 1, height * 0.84);
    }

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

window.createWave = createWave;
