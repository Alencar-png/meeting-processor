'use strict';

/**
 * Mock da window.api — SÓ para rodar o frontend fora do Electron.
 *
 * No app real o preload.js define window.api antes; aí este arquivo é inerte.
 * Fora do Electron ele simula todo o backend do Synapse: projetos, reuniões,
 * tarefas estruturadas, pipeline de processamento, chat RAG e configurações.
 * Também documenta o contrato que o processo principal precisa expor.
 */

(function mockApi() {
  if (window.api) return;

  const listeners = new Map();
  const on = (ch, fn) => {
    if (!listeners.has(ch)) listeners.set(ch, []);
    listeners.get(ch).push(fn);
  };
  const emit = (ch, payload) => {
    for (const fn of listeners.get(ch) || []) fn(payload);
  };

  let settings = {
    outputDir: 'C:\\Users\\voce\\Synapse',
    engine: 'native',
    nativeModel: 'models/ggml-large-v3-turbo.bin',
    model: 'large-v3',
    language: 'pt',
  };

  let seq = 100;
  const nid = (p) => `${p}-${seq++}`;

  let projects = [
    { id: 'p-alpha', name: 'Projeto Alpha', context: 'Plataforma de autenticação e onboarding. Time: Ana (PM), Bruno (backend), Carla (frontend). Documentos vão para o time todo: linguagem direta, sem jargão executivo.' },
    { id: 'p-beta', name: 'Projeto Beta', context: 'Migração da infraestrutura para a AWS. Decisões técnicas devem citar custo estimado.' },
  ];

  const T = [
    '[00:00:04] Ana: Bom dia, gente. Vamos começar pela revisão das metas da semana passada.',
    '[00:00:19] Bruno: A migração do banco terminou ontem à noite. Ficou faltando só o índice de busca.',
    '[00:01:02] Ana: Ótimo. E o onboarding novo, como ficou o teste com os cinco primeiros usuários?',
    '[00:01:33] Carla: Dois travaram na etapa do convite. O e-mail de confirmação está caindo em spam.',
    '[00:02:10] Bruno: Consigo ajustar o SPF hoje ainda. É configuração, não é código.',
    '[00:02:41] Ana: Fechado. Bruno ajusta o e-mail, Carla refaz o teste na quinta.',
    '[00:03:12] Carla: Combinado. Trago os números na próxima weekly.',
  ].join('\n\n');

  const now = Date.now();
  const H = 3600 * 1000;

  let meetings = [
    {
      id: 'm-1808', projectId: 'p-alpha', name: 'Weekly Produto 18/08',
      recordedAt: now - 4 * H, duration: 3480, segments: 214,
      model: 'large-v3-turbo', language: 'pt', source: 'weekly-produto.mkv',
      hasResumo: true, hasTarefas: true, transcript: T,
      concepts: ['Autenticação', 'Onboarding'],
      insights: ['a equipe optou por **OAuth2** no lugar do JWT decidido antes', 'o e-mail de confirmação do onboarding está caindo em spam'],
    },
    {
      id: 'm-1208', projectId: 'p-alpha', name: 'Decisão de arquitetura 12/08',
      recordedAt: now - 6 * 24 * H, duration: 2712, segments: 158,
      model: 'large-v3-turbo', language: 'pt', source: 'arquitetura.mp4',
      hasResumo: true, hasTarefas: false, transcript: T,
      concepts: ['Autenticação', 'API'],
      insights: ['foi decidido utilizar **JWT** inicialmente para a autenticação'],
    },
    {
      id: 'm-0908', projectId: 'p-beta', name: 'Kickoff migração AWS',
      recordedAt: now - 9 * 24 * H, duration: 5405, segments: 341,
      model: 'large-v3', language: 'pt', source: 'kickoff-aws.mkv',
      hasResumo: false, hasTarefas: true, transcript: T,
      concepts: ['Deploy AWS', 'Custos'],
      insights: ['o deploy será feito por etapas, começando pelo serviço de mídia'],
    },
    {
      id: 'm-solo', projectId: '', name: 'Conversa com fornecedor',
      recordedAt: now - 12 * 24 * H, duration: 1934, segments: 96,
      model: 'large-v3-turbo', language: 'pt', source: 'fornecedor.mkv',
      hasResumo: false, hasTarefas: false, transcript: T, concepts: [], insights: [],
    },
  ];

  let tasks = [
    { id: 't-42', projectId: 'p-alpha', meetingId: 'm-1808', title: 'Implementar OAuth2', description: 'Substituir o fluxo JWT pelo OAuth2 decidido na weekly.', assignee: 'Bruno', priority: 'high', status: 'doing', createdAt: now - 4 * H },
    { id: 't-43', projectId: 'p-alpha', meetingId: 'm-1808', title: 'Corrigir SPF do e-mail de convite', description: 'E-mails de confirmação caindo em spam no onboarding.', assignee: 'Bruno', priority: 'high', status: 'backlog', createdAt: now - 4 * H },
    { id: 't-44', projectId: 'p-alpha', meetingId: 'm-1808', title: 'Refazer teste de onboarding', description: 'Repetir o teste com 5 usuários após o ajuste do e-mail.', assignee: 'Carla', priority: 'medium', status: 'backlog', createdAt: now - 4 * H },
    { id: 't-30', projectId: 'p-alpha', meetingId: 'm-1208', title: 'Definir escopo do endpoint de auth', description: '', assignee: 'Ana', priority: 'low', status: 'done', createdAt: now - 6 * 24 * H },
    { id: 't-50', projectId: 'p-beta', meetingId: 'm-0908', title: 'Levantar custo do S3 + CloudFront', description: '', assignee: 'Bruno', priority: 'medium', status: 'doing', createdAt: now - 9 * 24 * H },
  ];

  const projOf = (id) => projects.find((p) => p.id === id) || null;
  const publicMeeting = (m) => ({ ...m, project: projOf(m.projectId) });

  let jobTimers = [];
  const clearJob = () => { jobTimers.forEach(clearTimeout); jobTimers = []; };

  /** Pipeline simulado: áudio → transcrição → export → extração (resumo + tasks). */
  function runPipeline({ name, projectId, source }) {
    clearJob();
    const stages = [
      ...Array.from({ length: 3 }, (_, i) => ({ at: 250 + i * 300, key: 'audio', progress: (i + 1) * 33.4 })),
      ...Array.from({ length: 8 }, (_, i) => ({ at: 1400 + i * 380, key: 'transcription', progress: (i + 1) * 12.5, detail: `whisper.cpp · segmento ${i * 21 + 4}` })),
      { at: 4600, key: 'export', progress: 100 },
      { at: 5100, key: 'extract', progress: 40, detail: 'Claude lendo a transcrição' },
      { at: 6100, key: 'extract', progress: 100, detail: 'resumo e tarefas extraídos' },
    ];
    for (const s of stages) {
      jobTimers.push(setTimeout(() => emit('job:event', { event: 'stage', ...s }), s.at));
    }
    jobTimers.push(setTimeout(() => {
      const meeting = {
        id: nid('m'), projectId: projectId || '', name,
        recordedAt: Date.now(), duration: 1934, segments: 118,
        model: 'large-v3-turbo', language: settings.language, source,
        hasResumo: true, hasTarefas: true, transcript: T,
        concepts: ['Onboarding'],
        insights: ['ficou combinado repetir o teste de onboarding na quinta'],
      };
      meetings.unshift(meeting);
      // AI-02: as ações extraídas viram cards automaticamente.
      const created = projectId ? [
        { id: nid('t'), projectId, meetingId: meeting.id, title: 'Ajustar e-mail de confirmação', description: 'Extraída automaticamente da reunião.', assignee: 'Bruno', priority: 'high', status: 'backlog', createdAt: Date.now() },
        { id: nid('t'), projectId, meetingId: meeting.id, title: 'Repetir teste com 5 usuários', description: 'Extraída automaticamente da reunião.', assignee: 'Carla', priority: 'medium', status: 'backlog', createdAt: Date.now() },
      ] : [];
      tasks.push(...created);
      emit('job:event', { event: 'done', meetingId: meeting.id, tasksCreated: created.length });
    }, 6600));
    return { started: true };
  }

  window.api = {
    on,

    // --- Configurações ---
    async getSettings() { return { ...settings }; },
    async setSettings(patch) { settings = { ...settings, ...patch }; return { ...settings }; },
    async enginesStatus() {
      return {
        active: settings.engine,
        native: { ok: true, models: [
          { id: 'large-v3-turbo', path: 'models/ggml-large-v3-turbo.bin', sizeMB: 1624 },
          { id: 'medium', path: 'models/ggml-medium.bin', sizeMB: 1533 },
        ] },
        docker: { ok: false, docker: true, version: '27.1', message: 'Imagem não construída (demonstração).' },
      };
    },
    async pickOutputDir() { return null; },
    async pickVideo() { return 'C:\\videos\\gravacao-demo.mkv'; },
    pathForFile(file) { return file?.name || ''; },
    async openPath() {},

    // --- Projetos ---
    async listProjects() {
      return projects.map((p) => ({
        ...p,
        meetings: meetings.filter((m) => m.projectId === p.id).length,
        openTasks: tasks.filter((t) => t.projectId === p.id && t.status !== 'done').length,
      }));
    },
    async saveProject({ id, name, context }) {
      const nome = String(name || '').trim();
      if (!nome) return { ok: false, message: 'Dê um nome ao projeto.' };
      if (id) {
        const p = projects.find((x) => x.id === id);
        if (!p) return { ok: false, message: 'Projeto não encontrado.' };
        p.name = nome; p.context = context || '';
        return { ok: true, id };
      }
      const novo = { id: nid('p'), name: nome, context: context || '' };
      projects.push(novo);
      return { ok: true, id: novo.id };
    },
    async deleteProject(id) {
      projects = projects.filter((p) => p.id !== id);
      meetings.forEach((m) => { if (m.projectId === id) m.projectId = ''; });
      tasks = tasks.filter((t) => t.projectId !== id);
      return { ok: true };
    },

    // --- Reuniões ---
    async listMeetings(projectId) {
      const list = projectId ? meetings.filter((m) => m.projectId === projectId) : meetings;
      return list.slice().sort((a, b) => b.recordedAt - a.recordedAt).map(publicMeeting);
    },
    async getMeeting(id) {
      const m = meetings.find((x) => x.id === id);
      return m ? publicMeeting(m) : null;
    },
    async renameMeeting(id, name) {
      const nome = String(name || '').trim();
      if (!nome) return { ok: false, message: 'Dê um nome à reunião.' };
      const m = meetings.find((x) => x.id === id);
      if (!m) return { ok: false, message: 'Reunião não encontrada.' };
      m.name = nome;
      return { ok: true, id };
    },
    async deleteMeeting(id) {
      meetings = meetings.filter((x) => x.id !== id);
      tasks.forEach((t) => { if (t.meetingId === id) t.meetingId = ''; });
      return { ok: true };
    },
    async assignProject(meetingId, projectId) {
      const m = meetings.find((x) => x.id === meetingId);
      if (!m) return { ok: false, message: 'Reunião não encontrada.' };
      m.projectId = projectId || '';
      return { ok: true };
    },

    // --- Tarefas (Kanban) ---
    async listTasks(projectId) {
      return tasks.filter((t) => t.projectId === projectId)
        .map((t) => ({ ...t, meeting: meetings.find((m) => m.id === t.meetingId) || null }));
    },
    async saveTask(data) {
      const title = String(data.title || '').trim();
      if (!title) return { ok: false, message: 'Dê um título à tarefa.' };
      if (data.id) {
        const t = tasks.find((x) => x.id === data.id);
        if (!t) return { ok: false, message: 'Tarefa não encontrada.' };
        Object.assign(t, data, { title });
        return { ok: true, id: t.id };
      }
      const nova = { ...data, title, id: nid('t'), createdAt: Date.now() };
      tasks.push(nova);
      return { ok: true, id: nova.id };
    },
    async moveTask(id, status) {
      const t = tasks.find((x) => x.id === id);
      if (t) t.status = status;
      return { ok: true };
    },
    async deleteTask(id) {
      tasks = tasks.filter((t) => t.id !== id);
      return { ok: true };
    },

    // --- Pipeline: importação e gravação ---
    async startJob({ videoPath, name, projectId }) {
      return runPipeline({ name, projectId, source: videoPath.split(/[\\/]/).pop() });
    },
    async processRecording({ projectId, name, duration }) {
      return runPipeline({ name, projectId, source: `gravacao-${Math.round(duration)}s.wav`, duration });
    },
    async cancelJob() {
      clearJob();
      emit('job:event', { event: 'canceled' });
    },

    // --- Documentos ---
    async generateDoc({ kind, meetingId }) {
      const passos = ['lendo a transcrição', 'estruturando o documento', 'convertendo em PDF'];
      let i = 0;
      const timer = setInterval(() => {
        if (i < passos.length) emit('doc:progress', { description: passos[i++] });
        else {
          clearInterval(timer);
          const m = meetings.find((x) => x.id === meetingId);
          if (m) {
            if (kind === 'tarefas') m.hasTarefas = true;
            else m.hasResumo = true;
          }
          emit('doc:done', { ok: true, kind, meetingId });
        }
      }, 900);
      return { started: true };
    },

    // --- Chat RAG (por projeto) ---
    async chatAsk({ projectId, question }) {
      await new Promise((r) => setTimeout(r, 1400));
      const ms = meetings
        .filter((m) => m.projectId === projectId && m.insights.length)
        .sort((a, b) => a.recordedAt - b.recordedAt);
      const open = tasks.filter((t) => t.projectId === projectId && t.status !== 'done');
      const fmt = (ts) => {
        const d = new Date(ts);
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      };

      if (!ms.length) {
        return { answer: 'Ainda não há reuniões indexadas neste projeto. Grave ou importe uma reunião para eu ter contexto.', sources: [] };
      }

      const partes = ms.slice(-2).map((m) => `Na reunião de **${fmt(m.recordedAt)}**, ${m.insights[0]}.`);
      if (ms.length > 1) partes.push('Repare que a decisão mais recente substitui a anterior.');
      if (open.length) partes.push(`Há ${open.length} tarefa(s) aberta(s) relacionada(s) — a mais urgente: **${open[0].title}**.`);

      return {
        answer: partes.join('\n\n'),
        sources: [
          ...ms.slice(-2).map((m) => ({ type: 'meeting', id: m.id, label: `📄 ${m.name}` })),
          ...open.slice(0, 1).map((t) => ({ type: 'task', id: t.id, label: `📋 ${t.title}` })),
        ],
      };
    },
  };
})();
