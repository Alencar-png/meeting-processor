/* ============================================================
   Meeting Processor — comportamento da interface
   Carregado uma vez no <head>. Usa delegação de eventos e os
   eventos do HTMX para sobreviver à navegação sem reload (boost).
   ============================================================ */
(function () {
  'use strict';

  /* ---------- Tema (claro/escuro) ---------------------------- */
  function toggleTheme() {
    var html = document.documentElement;
    var dark = html.classList.toggle('dark');
    try { localStorage.setItem('mp-theme', dark ? 'dark' : 'light'); } catch (e) {}
  }

  /* ---------- Sidebar mobile -------------------------------- */
  function toggleSidebar() {
    var sb = document.getElementById('sidebar');
    var bd = document.getElementById('sidebar-backdrop');
    if (!sb) return;
    var open = sb.classList.toggle('-translate-x-full');
    if (bd) bd.classList.toggle('hidden', open);
  }
  function closeSidebar() {
    var sb = document.getElementById('sidebar');
    var bd = document.getElementById('sidebar-backdrop');
    if (sb) sb.classList.add('-translate-x-full');
    if (bd) bd.classList.add('hidden');
  }

  /* ---------- Delegação global de cliques -------------------- */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action]');
    if (!t) return;
    var action = t.dataset.action;
    if (action === 'toggle-theme') { toggleTheme(); }
    else if (action === 'toggle-sidebar') { toggleSidebar(); }
    else if (action === 'close-sidebar') { closeSidebar(); }
  });

  /* ---------- Toast ----------------------------------------- */
  function toast(msg, type) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    el.style.color = type === 'err' ? 'var(--err)' : 'var(--ok)';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.add('hidden'); }, 3500);
  }

  /* ---------- Kanban: Sortable (idempotente) ---------------- */
  function initKanban() {
    if (typeof Sortable === 'undefined') { setTimeout(initKanban, 120); return; }
    document.querySelectorAll('.kanban-col-body').forEach(function (col) {
      if (col._sortable) return;        // já inicializado
      col._sortable = true;
      Sortable.create(col, {
        group: 'tasks', animation: 150,
        ghostClass: 'sortable-ghost', chosenClass: 'sortable-chosen',
        onEnd: function (evt) {
          if (evt.from === evt.to) return;
          var card = evt.item;
          fetch('/actions/tasks/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              task_id: card.dataset.taskId,
              meeting_id: card.dataset.meetingId,
              to_column: evt.to.dataset.column,
            }),
          })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(function () { toast('Tarefa movida', 'ok'); updateCounts(); })
          .catch(function (err) {
            toast('Falha ao mover: ' + err.message, 'err');
            evt.from.insertBefore(card, evt.from.children[evt.oldIndex]);
          });
        },
      });
    });
  }
  function updateCounts() {
    document.querySelectorAll('.kanban-col').forEach(function (col) {
      var body = col.querySelector('.kanban-col-body');
      var badge = col.querySelector('.kanban-count');
      if (body && badge) badge.textContent = body.querySelectorAll('.kanban-card').length;
    });
  }

  /* ---------- Confirmação de remoção do histórico ----------- */
  window.confirmRemoveHistoryStatus = function (form) {
    var title = form.dataset.meetingTitle || 'esta entrada';
    return confirm('Remover do histórico?\n\n' + title +
      '\n\nApenas o registro é apagado. Não afeta arquivos no vault.');
  };

  /* ---------- Inicialização (load + cada navegação boost) --- */
  function boot() { initKanban(); }
  document.addEventListener('DOMContentLoaded', boot);
  document.body && boot();
  // HTMX dispara htmx:load no carregamento inicial e após cada swap/boost
  document.addEventListener('htmx:load', boot);
  document.addEventListener('htmx:afterSwap', function () { initKanban(); updateCounts(); });
  // Fecha a sidebar mobile ao navegar
  document.addEventListener('htmx:beforeSwap', closeSidebar);
})();
