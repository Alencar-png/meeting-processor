'use strict';

/**
 * O documento da reunião, em HTML pronto para virar PDF.
 *
 * Antes o Claude escrevia o HTML; agora ele só analisa, e o app monta a página
 * a partir da análise. O ganho é que a tabela de tarefas do PDF é exatamente a
 * lista que foi para o Kanban, e o visual não muda de uma reunião para outra.
 *
 * Só string entra e só string sai: dá para testar sem navegador.
 */

const PRIORITY_LABEL = { high: 'alta', medium: 'média', low: 'baixa' };

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const pad = (n) => String(n).padStart(2, '0');

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h${pad(m)}` : `${m} min`;
}

const section = (title, body) => (body ? `<section><h2>${escapeHtml(title)}</h2>${body}</section>` : '');
const paragraphs = (items) => items.map((t) => `<p>${escapeHtml(t)}</p>`).join('');
const bullets = (items) => (items.length ? `<ul>${items.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : '');

function topicsHtml(topics) {
  if (!topics.length) return '';
  return topics.map((t) => {
    const title = t.title ? `<h3>${escapeHtml(t.title)}</h3>` : '';
    return `<div class="topic">${title}<p>${escapeHtml(t.summary)}</p></div>`;
  }).join('');
}

function decisionsHtml(decisions) {
  const fechadas = decisions.filter((d) => !d.open);
  const abertas = decisions.filter((d) => d.open);
  if (!fechadas.length && !abertas.length) return '';
  return [
    fechadas.length ? `<h3>Decidido</h3>${bullets(fechadas.map((d) => d.text))}` : '',
    abertas.length ? `<h3>Em aberto</h3>${bullets(abertas.map((d) => d.text))}` : '',
  ].join('');
}

function tasksHtml(tasks) {
  if (!tasks.length) {
    return '<p class="muted">A reunião não gerou tarefas.</p>';
  }
  const urgente = tasks.find((t) => t.priority === 'high');
  const resumo = `${tasks.length} ${tasks.length === 1 ? 'tarefa saiu' : 'tarefas saíram'} desta reunião`
    + (urgente ? `; a mais urgente: ${urgente.title}.` : '.');
  const linhas = tasks.map((t) => `
      <tr class="prio-${escapeHtml(t.priority)}">
        <td><span class="dot"></span>${escapeHtml(t.title)}${t.description ? `<div class="desc">${escapeHtml(t.description)}</div>` : ''}</td>
        <td>${escapeHtml(t.assignee || 'não definido')}</td>
        <td>${escapeHtml(t.deadline || 'não definido')}</td>
        <td>${escapeHtml(PRIORITY_LABEL[t.priority] || t.priority)}</td>
        <td class="mono">${escapeHtml(t.origin)}</td>
      </tr>`).join('');
  return `<p>${escapeHtml(resumo)}</p>
    <table>
      <thead><tr><th>Tarefa</th><th>Responsável</th><th>Prazo</th><th>Prioridade</th><th>Origem</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>`;
}

const STYLE = `
  @page { size: A4; margin: 2cm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #1c1f26; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 11pt; line-height: 1.5; }
  header { border-bottom: 1.5px solid #1c1f26; padding-bottom: 10px; margin-bottom: 22px; }
  h1 { margin: 0 0 4px; font-family: Georgia, "Times New Roman", serif; font-size: 22pt; font-weight: 600; letter-spacing: -0.01em; }
  .meta { margin: 0; color: #5a6070; font-size: 9.5pt; }
  .meta span + span::before { content: " · "; }
  .note { margin: 0 0 18px; padding: 8px 12px; background: #f3f4f7; border-left: 3px solid #9aa0ad; font-size: 10pt; color: #444a57; }
  section { margin-bottom: 20px; break-inside: avoid-page; }
  h2 { margin: 0 0 8px; font-size: 10pt; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: #5a6070; border-bottom: 1px solid #d9dce3; padding-bottom: 4px; }
  h3 { margin: 10px 0 4px; font-size: 11pt; font-weight: 600; }
  p { margin: 0 0 8px; }
  ul { margin: 0 0 8px; padding-left: 18px; }
  li { margin-bottom: 3px; }
  .topic { margin-bottom: 8px; }
  .muted { color: #5a6070; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-top: 6px; }
  th { text-align: left; padding: 6px 8px; background: #f3f4f7; border-bottom: 1px solid #c9ccd4; font-weight: 600; font-size: 9pt; }
  td { padding: 7px 8px; border-bottom: 1px solid #e3e5ea; vertical-align: top; }
  td .desc { margin-top: 2px; color: #5a6070; font-size: 9pt; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 7px; background: #b9bdc7; vertical-align: middle; }
  .prio-high .dot { background: #d64550; }
  .prio-medium .dot { background: #e0a53a; }
  .mono { font-family: Consolas, "SF Mono", monospace; font-size: 9pt; color: #5a6070; white-space: nowrap; }
  footer { margin-top: 28px; padding-top: 8px; border-top: 1px solid #d9dce3; color: #8a90a0; font-size: 8.5pt; }
`;

/**
 * Página completa e autocontida do documento.
 *
 * Seções sem conteúdo real são omitidas em vez de aparecerem vazias — exceto a
 * de tarefas, que diz explicitamente quando não houve nenhuma.
 */
function renderDocumentHtml({ meeting, analysis }) {
  const nome = analysis.title || meeting.name;
  const meta = [
    formatDate(meeting.recordedAt),
    formatDuration(meeting.duration),
    meeting.project?.name || meeting.projectName || '',
  ].filter(Boolean).map((v) => `<span>${escapeHtml(v)}</span>`).join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${escapeHtml(nome)}</title>
<style>${STYLE}</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(nome)}</h1>
    <p class="meta">${meta}</p>
  </header>
  ${analysis.note ? `<p class="note">${escapeHtml(analysis.note)}</p>` : ''}
  ${section('Visão geral', paragraphs(analysis.overview))}
  ${section('Pontos discutidos', topicsHtml(analysis.topics))}
  ${section('Decisões', decisionsHtml(analysis.decisions))}
  ${section('Riscos e bloqueios', bullets(analysis.risks))}
  ${section('Tarefas', tasksHtml(analysis.tasks))}
  ${section('Pendências de decisão', bullets(analysis.pending))}
  <footer>Documento gerado pelo Synapse a partir da transcrição da reunião${meeting.name && nome !== meeting.name ? ` “${escapeHtml(meeting.name)}”` : ''}.</footer>
</body>
</html>
`;
}

module.exports = { escapeHtml, renderDocumentHtml };
