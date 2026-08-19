'use strict';

/**
 * Mock da window.api — SÓ para abrir o frontend fora do Electron.
 *
 * No app real o preload.js define window.api antes de qualquer script desta
 * página; aí este arquivo não faz nada. Fora do Electron ele simula o motor,
 * a biblioteca e os jobs com dados de demonstração, para dar para ver e
 * testar a interface abrindo o index.html direto no navegador.
 */

(function mockApi() {
  if (window.api) return;

  const listeners = new Map();
  function on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, []);
    listeners.get(channel).push(fn);
  }
  function emit(channel, payload) {
    for (const fn of listeners.get(channel) || []) fn(payload);
  }

  let settings = {
    outputDir: 'C:\\Users\\voce\\Reunioes',
    engine: 'native',
    model: 'large-v3',
    nativeModel: 'models/ggml-large-v3-turbo.bin',
    language: 'pt',
    formats: ['md', 'txt'],
  };

  let groups = [
    { id: 'g-produto', name: 'Produto', context: 'Acompanhamento semanal do time de produto. Documentos vão para o time todo: linguagem direta, sem jargão executivo.', count: 2 },
    { id: 'g-eng', name: 'Engenharia', context: '', count: 1 },
  ];

  const files = (id, exts) => exts.map((ext) => ({
    name: `${id}.${ext}`,
    ext,
    path: `${settings.outputDir}\\${id}\\${id}.${ext}`,
    sizeKB: ext === 'pdf' ? 182 : 46,
  }));

  let meetings = [
    {
      id: 'weekly-produto-17-08', name: 'Weekly Produto',
      modified: Date.now() - 1000 * 60 * 60 * 20,
      groupId: 'g-produto', hasTarefas: true, hasResumo: true,
      meta: { duration_seconds: 3480, segments: 214, model: 'large-v3-turbo', language: 'pt', source_file: 'weekly-produto.mkv', recorded_at_local: '2026-08-17 10:02' },
      exts: ['md', 'txt', 'pdf'],
    },
    {
      id: 'review-sprint-42', name: 'Review Sprint 42',
      modified: Date.now() - 1000 * 60 * 60 * 48,
      groupId: 'g-eng', hasTarefas: true, hasResumo: false,
      meta: { duration_seconds: 2712, segments: 158, model: 'large-v3-turbo', language: 'pt', source_file: 'review-sprint-42.mp4', recorded_at_local: '2026-08-16 15:31' },
      exts: ['md', 'txt', 'pdf'],
    },
    {
      id: 'kickoff-onboarding', name: 'Kickoff Onboarding',
      modified: Date.now() - 1000 * 60 * 60 * 24 * 5,
      groupId: 'g-produto', hasTarefas: false, hasResumo: true,
      meta: { duration_seconds: 5405, segments: 341, model: 'large-v3', language: 'pt', source_file: 'kickoff-onboarding.mkv', recorded_at_local: '2026-08-13 09:00' },
      exts: ['md', 'txt'],
    },
    {
      id: 'conversa-fornecedor', name: 'Conversa com fornecedor',
      modified: Date.now() - 1000 * 60 * 60 * 24 * 9,
      groupId: '', hasTarefas: false, hasResumo: false,
      meta: null,
      exts: ['md', 'txt'],
    },
  ];

  const groupOf = (id) => groups.find((g) => g.id === id) || null;

  function toListItem(m) {
    return {
      id: m.id, name: m.name, modified: m.modified,
      hasTarefas: m.hasTarefas, hasResumo: m.hasResumo,
      group: groupOf(m.groupId), meta: m.meta,
      files: files(m.id, m.exts),
    };
  }

  const SAMPLE_TEXT = [
    '[00:00:04] Ana: Bom dia, gente. Vamos começar pela revisão das metas da semana passada.',
    '[00:00:19] Bruno: A migração do banco terminou ontem à noite. Ficou faltando só o índice de busca.',
    '[00:01:02] Ana: Ótimo. E o onboarding novo, como ficou o teste com os cinco primeiros usuários?',
    '[00:01:33] Carla: Dois travaram na etapa do convite. Já mapeei: o e-mail de confirmação está caindo em spam.',
    '[00:02:10] Bruno: Consigo ajustar o SPF hoje ainda. É configuração, não é código.',
    '[00:02:41] Ana: Fechado. Então as tarefas da semana: Bruno ajusta o e-mail, Carla refaz o teste na quinta.',
    '[00:03:12] Carla: Combinado. Trago os números na próxima weekly.',
  ].join('\n\n');

  let jobTimers = [];
  let docTimer = null;

  function clearJob() {
    jobTimers.forEach(clearTimeout);
    jobTimers = [];
  }

  window.api = {
    on,

    async getSettings() { return { ...settings }; },
    async setSettings(patch) { settings = { ...settings, ...patch }; return { ...settings }; },

    async enginesStatus() {
      return {
        active: settings.engine,
        native: {
          ok: true,
          models: [
            { id: 'large-v3-turbo', path: 'models/ggml-large-v3-turbo.bin', sizeMB: 1624 },
            { id: 'medium', path: 'models/ggml-medium.bin', sizeMB: 1533 },
          ],
        },
        docker: { ok: false, docker: true, version: '27.1', message: 'A imagem de transcrição ainda não foi construída (demonstração).' },
      };
    },
    async dockerStatus() { return { ok: false }; },
    async buildImage() {
      emit('build:log', '[demo] docker build -t synapse-whisper .');
      return { ok: false, message: 'construção indisponível na demonstração' };
    },

    async listMeetings() {
      return meetings.slice().sort((a, b) => b.modified - a.modified).map(toListItem);
    },
    async getMeeting(id) {
      const m = meetings.find((x) => x.id === id);
      if (!m) return null;
      const item = toListItem(m);
      item.transcript = `${settings.outputDir}\\${m.id}\\${m.id}.md`;
      return item;
    },
    async renameMeeting(id, newName) {
      const name = String(newName || '').trim();
      if (!name) return { ok: false, message: 'Dê um nome à reunião.' };
      const m = meetings.find((x) => x.id === id);
      if (!m) return { ok: false, message: 'Reunião não encontrada.' };
      m.name = name;
      return { ok: true, id: m.id };
    },
    async deleteMeeting(id) {
      meetings = meetings.filter((x) => x.id !== id);
      return { ok: true };
    },
    async readFile() { return { ok: true, text: SAMPLE_TEXT }; },
    async downloadFile() { return { ok: true }; },

    async listGroups() {
      return groups.map((g) => ({
        ...g,
        count: meetings.filter((m) => m.groupId === g.id).length,
      }));
    },
    async saveGroup({ id, name, context }) {
      const nome = String(name || '').trim();
      if (!nome) return { ok: false, message: 'Dê um nome ao projeto.' };
      if (id) {
        const g = groups.find((x) => x.id === id);
        if (!g) return { ok: false, message: 'Projeto não encontrado.' };
        g.name = nome; g.context = context || '';
        return { ok: true, id };
      }
      const novo = { id: `g-${Date.now()}`, name: nome, context: context || '', count: 0 };
      groups.push(novo);
      return { ok: true, id: novo.id };
    },
    async deleteGroup(id) {
      groups = groups.filter((g) => g.id !== id);
      meetings.forEach((m) => { if (m.groupId === id) m.groupId = ''; });
      return { ok: true };
    },
    async assignGroup(meetingId, groupId) {
      const m = meetings.find((x) => x.id === meetingId);
      if (!m) return { ok: false, message: 'Reunião não encontrada.' };
      m.groupId = groupId || '';
      return { ok: true };
    },

    async pickVideo() { return 'C:\\videos\\gravacao-demo.mkv'; },
    async pickOutputDir() { return null; },
    async showInFolder() {}, 
    async openPath() {},
    pathForFile(file) { return file?.name || ''; },

    async startJob({ videoPath, name }) {
      clearJob();
      const stages = [
        ...Array.from({ length: 4 }, (_, i) => ({ at: 300 + i * 350, key: 'audio', progress: (i + 1) * 25, detail: 'ffmpeg extraindo o áudio' })),
        ...Array.from({ length: 12 }, (_, i) => ({ at: 1800 + i * 420, key: 'transcription', progress: (i + 1) * (100 / 12), detail: `whisper.cpp · segmento ${i * 14 + 3}` })),
        { at: 7000, key: 'export', progress: 60, detail: 'gravando .md e .txt' },
        { at: 7400, key: 'export', progress: 100, detail: '' },
      ];
      for (const s of stages) {
        jobTimers.push(setTimeout(() => emit('job:event', { event: 'stage', ...s }), s.at));
      }
      jobTimers.push(setTimeout(() => {
        const id = (name || 'nova-reuniao').toLowerCase().replace(/\s+/g, '-');
        meetings.unshift({
          id, name: name || 'Nova reunião', modified: Date.now(), groupId: '',
          hasTarefas: false, hasResumo: false,
          meta: { duration_seconds: 1934, segments: 118, model: 'large-v3-turbo', language: settings.language, source_file: videoPath.split(/[\\/]/).pop(), recorded_at_local: '2026-08-18 09:12' },
          exts: ['md', 'txt'],
        });
        emit('job:event', {
          event: 'done', duration: 1934, elapsed: 8, segments: 118,
          files: files(id, ['md', 'txt']).map((f) => f.path),
        });
      }, 7900));
      return { started: true };
    },
    async cancelJob() {
      clearJob();
      emit('job:event', { event: 'canceled' });
    },

    async startDoc({ kind, transcriptPath }) {
      const passos = ['lendo a transcrição', 'estruturando o documento', 'escrevendo o HTML', 'convertendo em PDF'];
      let i = 0;
      docTimer = setInterval(() => {
        if (i < passos.length) emit('doc:progress', { description: passos[i++] });
        else {
          clearInterval(docTimer);
          const id = transcriptPath.split(/[\\/]/).slice(-2, -1)[0];
          const m = meetings.find((x) => x.id === id);
          if (m) {
            if (kind === 'tarefas') m.hasTarefas = true;
            else m.hasResumo = true;
            if (!m.exts.includes('pdf')) m.exts.push('pdf');
          }
          emit('doc:done', { ok: true, pdfPath: '' });
        }
      }, 1200);
      return { started: true };
    },
    async cancelDoc() {
      if (docTimer) clearInterval(docTimer);
      emit('doc:done', { ok: false, canceled: true });
    },
  };
})();
