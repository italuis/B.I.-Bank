(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(n);
  const COLORS = ['#1e9bd7', '#2fa56f', '#e08a1e', '#d64560', '#7b5fd0', '#139f9f'];
  const KIND = { pix: 'Pix', salary: 'Salário', rent: 'Aluguel ou taxa', loan: 'Empréstimo', repay: 'Pagamento ao Banco', fee: 'Taxa' };
  const SKEY = 'bi-session';

  const socket = io({ reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 4000 });
  let state = null, session = readSession(), inRoom = false, seen = null;
  let roleSel = 'player', picked = null, sheet = null, peekTimer;

  function readSession() { try { return JSON.parse(localStorage.getItem(SKEY)); } catch { return null; } }
  function saveSession() { try { localStorage.setItem(SKEY, JSON.stringify(session)); } catch {} }
  function clearSession() { try { localStorage.removeItem(SKEY); } catch {} }

  /* ---------- Telas e feedback ---------- */
  function showScreen(name) {
    $('#screen-join').hidden = name !== 'join';
    $('#screen-app').hidden = name !== 'app';
    $('#boot').hidden = name !== 'boot';
  }
  let toastT;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3000);
  }
  let flashT;
  function flash(title, text) {
    $('#flash-title').textContent = title; $('#flash-text').textContent = text;
    const f = $('#flash'); f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
    if (navigator.vibrate) navigator.vibrate(30);
    clearTimeout(flashT); flashT = setTimeout(() => f.classList.remove('show'), 1400);
  }
  const closeSheets = () => {
    $('#overlay').classList.remove('open'); $('#sheet').classList.remove('open'); $('#menu').classList.remove('open');
  };
  const openSheetEl = (id) => { $('#overlay').classList.add('open'); $(id).classList.add('open'); };
  $('#overlay').addEventListener('click', closeSheets);

  /* ---------- Conexão e reconexão ---------- */
  socket.on('connect', () => { $('#conn').hidden = true; if (session) join(session, true); });
  socket.on('disconnect', () => { $('#conn').hidden = false; });
  socket.on('connect_error', () => { $('#conn').hidden = false; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !socket.connected) socket.connect(); });
  window.addEventListener('online', () => { if (!socket.connected) socket.connect(); });

  socket.on('kicked', () => {
    session = null; clearSession(); inRoom = false; state = null; seen = null;
    closeSheets(); showScreen('join'); toast('Você não faz mais parte desta sala.');
  });

  socket.on('room:state', (s) => {
    state = s;
    track();
    if (inRoom) render();
  });

  function track() {
    if (seen === null) { seen = new Set(state.transactions.map((t) => t.id)); return; }
    for (const t of state.transactions) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (session && t.to === session.playerId && t.from !== session.playerId && !t.undone) {
        toast(`Você recebeu ${fmt(t.amount)} de ${t.fromName}`);
        if (navigator.vibrate) navigator.vibrate(60);
      }
    }
  }

  /* ---------- Entrada na sala ---------- */
  function join(data, silent) {
    if (!state || state.code !== data.code) seen = null;
    socket.emit('room:join', { ...data, create: silent && data.role === 'bank' }, (res) => {
      if (res && res.ok) {
        session = { code: res.code, role: res.role, playerId: res.playerId, name: res.name };
        saveSession(); inRoom = true; showScreen('app'); render();
      } else {
        if (silent) { session = null; clearSession(); inRoom = false; showScreen('join'); }
        $('#join-error').textContent = (res && res.error) || 'Não foi possível entrar.';
      }
    });
  }

  function peek() {
    const code = $('#code').value;
    if (code.length < 4) { $('#profiles-wrap').hidden = true; return; }
    socket.emit('room:peek', code, (res) => {
      if (!res || !res.ok || !res.players.length) { $('#profiles-wrap').hidden = true; return; }
      $('#profiles').innerHTML = res.players.map((p) =>
        `<button type="button" class="chip ${picked === p.id ? 'on' : ''}" data-id="${p.id}" data-name="${esc(p.name)}"><span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.name)}</button>`).join('');
      $('#profiles-wrap').hidden = roleSel !== 'player';
    });
  }

  function updateRole() {
    document.querySelectorAll('#role-seg button').forEach((b) => b.classList.toggle('on', b.dataset.role === roleSel));
    $('#name-field').hidden = roleSel === 'bank';
    $('#profiles-wrap').hidden = roleSel === 'bank' || !$('#profiles').children.length;
  }
  $('#role-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-role]'); if (!b) return;
    roleSel = b.dataset.role; updateRole();
  });
  $('#code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    clearTimeout(peekTimer); peekTimer = setTimeout(peek, 300);
  });
  $('#name').addEventListener('input', () => { picked = null; document.querySelectorAll('#profiles .chip').forEach((c) => c.classList.remove('on')); });
  $('#profiles').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    picked = c.dataset.id; $('#name').value = c.dataset.name;
    document.querySelectorAll('#profiles .chip').forEach((x) => x.classList.toggle('on', x === c));
  });
  $('#btn-create').addEventListener('click', () => {
    socket.emit('room:create', (res) => {
      if (!res || !res.ok) return;
      $('#code').value = res.code; $('#join-error').textContent = '';
      toast(`Sala ${res.code} criada. Compartilhe o código com a mesa.`);
      peek();
    });
  });
  $('#btn-join').addEventListener('click', () => {
    const err = $('#join-error'); err.textContent = '';
    const code = $('#code').value, name = $('#name').value.trim();
    if (code.length < 4) { err.textContent = 'Digite o código da sala.'; return; }
    if (roleSel === 'player' && !name) { err.textContent = 'Digite seu nome ou toque em um perfil.'; return; }
    join({ code, role: roleSel, name, playerId: roleSel === 'player' ? picked : null }, false);
  });

  /* ---------- Dados derivados ---------- */
  const role = () => session.role;
  const myPlayer = () => state.players.find((p) => p.id === session.playerId);
  const parties = () => [{ id: 'bank', name: 'Banco' }, ...state.players];
  const nameOf = (id) => id === 'bank' ? 'Banco' : id === session.playerId ? 'Você' : (state.players.find((p) => p.id === id)?.name || '?');
  const timeOf = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const lastTx = () => [...state.transactions].reverse().find((t) => !t.undone);
  const canUndo = () => { const t = lastTx(); return !!t && (role() === 'bank' || t.from === session.playerId || t.to === session.playerId); };

  function currentActions() {
    const me = session.playerId, salary = state.settings.salary;
    if (role() === 'bank') return [
      { label: 'Pagar salário', glyph: '★', from: 'bank', to: null, kind: 'salary', desc: 'Passagem pelo início', amount: salary, main: true },
      { label: 'Empréstimo', glyph: '＋', from: 'bank', to: null, kind: 'loan', desc: 'Empréstimo do Banco' },
      { label: 'Receber', glyph: '↙', from: null, to: 'bank', kind: 'repay', desc: 'Pagamento ao Banco' },
      { label: 'Transferir', glyph: '⇄', from: null, to: null, kind: 'pix', desc: '' },
    ];
    return [
      { label: 'Pix', title: 'Enviar Pix', glyph: '⇄', from: me, to: null, kind: 'pix', desc: '', main: true },
      { label: 'Salário', title: 'Receber salário', glyph: '★', from: 'bank', to: me, kind: 'salary', desc: 'Passagem pelo início', amount: salary },
      { label: 'Pagar aluguel', glyph: '⌂', from: me, to: null, kind: 'rent', desc: 'Aluguel' },
      { label: 'Cobrar', title: 'Cobrar de um jogador', glyph: '↙', from: null, to: me, kind: 'rent', desc: 'Aluguel', mode: 'charge', noBank: ['from'] },
      { label: 'Empréstimo', title: 'Empréstimo do Banco', glyph: '＋', from: 'bank', to: me, kind: 'loan', desc: 'Empréstimo do Banco' },
      { label: 'Pagar Banco', glyph: '↗', from: me, to: 'bank', kind: 'repay', desc: 'Pagamento ao Banco' },
    ];
  }

  /* ---------- Renderização ---------- */
  function render() {
    if (!state || !session) return;
    if (role() === 'player' && !myPlayer()) return;
    $('#room-code').textContent = state.code;
    renderBalance(); renderActions(); renderPending(); renderPlayers(); renderStatement();
    $('#btn-undo').disabled = !canUndo();
    $('#settings').hidden = role() !== 'bank';
    $('#m-import').hidden = role() !== 'bank';
  }

  function renderBalance() {
    if (role() === 'bank') {
      const total = state.players.reduce((s, p) => s + p.balance, 0);
      $('#balance').innerHTML = `<p class="who">Banco</p><p class="amount-big">${fmt(total)}</p><p class="sub">em circulação com ${state.players.length} jogador(es)</p>`;
    } else {
      const me = myPlayer();
      $('#balance').innerHTML = `<p class="who">Olá, ${esc(me.name)}</p><p class="amount-big ${me.balance < 0 ? 'neg' : ''}">${fmt(me.balance)}</p><p class="sub">Seu saldo</p>`;
    }
  }

  function renderActions() {
    $('#actions').innerHTML = currentActions().map((a, i) =>
      `<button type="button" class="act ${a.main ? 'main' : ''}" data-i="${i}"><i>${a.glyph}</i>${esc(a.label)}</button>`).join('');
  }

  function renderPending() {
    if (role() === 'bank') { $('#pending').innerHTML = ''; return; }
    const me = session.playerId;
    $('#pending').innerHTML = state.pending.filter((r) => r.from === me || r.to === me).map((r) => r.from === me
      ? `<div class="card charge"><p><b>${esc(r.toName)}</b> está cobrando <b>${fmt(r.amount)}</b>${r.description ? ` (${esc(r.description)})` : ''}</p>
         <div class="btns"><button class="btn small" data-resp="1" data-id="${r.id}">Pagar</button><button class="btn small ghost" data-resp="0" data-id="${r.id}">Recusar</button></div></div>`
      : `<div class="card charge"><p>Cobrança de <b>${fmt(r.amount)}</b> enviada a <b>${esc(r.fromName)}</b>. Aguardando pagamento.</p>
         <div class="btns"><button class="btn small ghost" data-resp="0" data-id="${r.id}">Cancelar cobrança</button></div></div>`).join('');
  }

  function renderPlayers() {
    if (!state.players.length) { $('#players').innerHTML = '<p class="empty">Nenhum jogador ainda. Compartilhe o código da sala.</p>'; return; }
    $('#players').innerHTML = state.players.map((p) =>
      `<button type="button" class="row-item" data-id="${p.id}">
        <span class="avatar" style="background:${COLORS[p.color % COLORS.length]}">${esc(p.name[0].toUpperCase())}</span>
        <span class="grow"><b>${esc(p.name)}${p.id === session.playerId ? ' (você)' : ''}</b><small><span class="dot ${p.online ? 'on' : ''}"></span>${p.online ? 'Online' : 'Offline'}</small></span>
        <span class="val ${p.balance < 0 ? 'neg' : ''}">${fmt(p.balance)}</span></button>`).join('')
      + `<div class="row-item"><span class="avatar" style="background:#0a6fb0">B</span><span class="grow"><b>Banco</b><small><span class="dot ${state.bankOnline ? 'on' : ''}"></span>${state.bankOnline ? 'Online' : 'Sem gerente conectado'}</small></span></div>`;
  }

  function renderStatement() {
    const list = [...state.transactions].reverse().slice(0, 60);
    if (!list.length) { $('#statement').innerHTML = '<p class="empty">Sem transações. Faça o primeiro Pix.</p>'; return; }
    const me = session.playerId;
    $('#statement').innerHTML = list.map((t) => {
      let title, sign = '', cls = '';
      if (t.from === me) { title = `Para ${t.toName}`; sign = '−'; cls = 'neg'; }
      else if (t.to === me) { title = `De ${t.fromName}`; sign = '+'; cls = 'pos'; }
      else title = `${t.fromName} para ${t.toName}`;
      return `<div class="row-item ${t.undone ? 'undone' : ''}">
        <span class="grow"><b>${esc(title)}</b><small>${esc(t.description || KIND[t.kind] || 'Pix')}</small></span>
        <span class="val ${cls}">${sign}${fmt(t.amount)}<small>${timeOf(t.ts)}${t.undone ? ' <span class="tag">DESFEITA</span>' : ''}</small></span></div>`;
    }).join('');
  }

  /* ---------- Folha de transação ---------- */
  function openSheet(act, preset = {}) {
    sheet = { act, from: act.from ?? preset.from ?? null, to: act.to ?? preset.to ?? null };
    $('#sheet-title').textContent = act.title || act.label;
    $('#amount').value = act.amount || '';
    $('#desc').value = act.desc || '';
    $('#sheet-error').textContent = '';
    $('#quick').innerHTML = [50, 100, 200, 500].map((v) => `<button type="button" class="chip" data-v="${v}">${fmt(v)}</button>`).join('');
    renderPick('from'); renderPick('to');
    openSheetEl('#sheet');
  }

  function renderPick(side) {
    const act = sheet.act, locked = act[side] != null;
    const other = side === 'from' ? sheet.to : sheet.from;
    const opts = locked ? [act[side]] : parties().map((p) => p.id)
      .filter((id) => id !== other && !(id === 'bank' && (act.noBank || []).includes(side)));
    $('#pick-' + side).innerHTML = `<span class="pick-label">${side === 'from' ? 'De' : 'Para'}</span><div class="chips">${opts.map((id) =>
      `<button type="button" class="chip ${sheet[side] === id ? 'on' : ''}" data-side="${side}" data-id="${id}" ${locked ? 'disabled' : ''}>${esc(nameOf(id))}</button>`).join('')}</div>`;
  }

  $('#sheet').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c || !sheet) return;
    if (c.dataset.v) { $('#amount').value = c.dataset.v; return; }
    const side = c.dataset.side, other = side === 'from' ? 'to' : 'from';
    sheet[side] = c.dataset.id;
    if (sheet[other] === sheet[side] && sheet.act[other] == null) sheet[other] = null;
    renderPick('from'); renderPick('to');
  });
  $('#amount').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 9); });

  $('#sheet').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#sheet-error'); err.textContent = '';
    const amount = parseInt($('#amount').value, 10);
    if (!sheet.from || !sheet.to) { err.textContent = 'Escolha quem envia e quem recebe.'; return; }
    if (!amount || amount < 1) { err.textContent = 'Informe um valor.'; return; }
    if (!socket.connected) { err.textContent = 'Sem conexão. Aguarde a reconexão.'; return; }
    const payload = { from: sheet.from, to: sheet.to, amount, kind: sheet.act.kind, description: $('#desc').value };
    const isCharge = sheet.act.mode === 'charge', btn = $('#sheet-ok');
    btn.disabled = true;
    socket.emit(isCharge ? 'charge:request' : 'tx:transfer', payload, (res) => {
      btn.disabled = false;
      if (!res || !res.ok) { err.textContent = (res && res.error) || 'Falha na operação.'; return; }
      const to = nameOf(payload.to);
      closeSheets();
      flash(isCharge ? 'Cobrança enviada' : 'Feito!', isCharge ? `${fmt(amount)} de ${nameOf(payload.from)}` : `${fmt(amount)} para ${to}`);
    });
  });

  /* ---------- Ações na tela principal ---------- */
  $('#actions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]'); if (b) openSheet(currentActions()[+b.dataset.i]);
  });
  $('#players').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]'); if (!b) return;
    if (role() === 'bank') openSheet(currentActions()[3], { from: 'bank', to: b.dataset.id });
    else if (b.dataset.id !== session.playerId) openSheet(currentActions()[0], { to: b.dataset.id });
  });
  $('#pending').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-resp]'); if (!b) return;
    socket.emit('charge:respond', { id: b.dataset.id, accept: b.dataset.resp === '1' }, (res) => {
      if (!res.ok) toast(res.error); else if (b.dataset.resp === '1') flash('Pago!', 'Cobrança quitada');
    });
  });
  $('#btn-undo').addEventListener('click', () => {
    const t = lastTx(); if (!t) return;
    if (!confirm(`Desfazer ${fmt(t.amount)} de ${t.fromName} para ${t.toName}?`)) return;
    socket.emit('tx:undo', (res) => toast(res.ok ? 'Transação desfeita.' : res.error));
  });
  $('#btn-code').addEventListener('click', async () => {
    const link = `${location.origin}/?sala=${state.code}`;
    try { await navigator.clipboard.writeText(link); toast('Link da sala copiado.'); } catch { toast(`Código da sala: ${state.code}`); }
  });

  /* ---------- Menu, JSON e configurações ---------- */
  $('#btn-menu').addEventListener('click', () => {
    $('#set-start').value = state.settings.startBalance;
    $('#set-salary').value = state.settings.salary;
    $('#remove-list').innerHTML = state.players.map((p) => `<button type="button" class="chip" data-rm="${p.id}">${esc(p.name)} ✕</button>`).join('');
    openSheetEl('#menu');
  });
  $('#remove-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    if (!confirm('Remover este jogador da partida?')) return;
    socket.emit('player:remove', { id: b.dataset.rm }, (res) => { toast(res.ok ? 'Jogador removido.' : res.error); if (res.ok) closeSheets(); });
  });
  $('#settings').addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('settings:update', { startBalance: $('#set-start').value, salary: $('#set-salary').value }, (res) => {
      toast(res.ok ? 'Configurações salvas.' : res.error); if (res.ok) closeSheets();
    });
  });
  $('#m-export').addEventListener('click', () => {
    const data = {
      app: 'banco-imobiliario', version: 1, exportedAt: new Date().toISOString(), roomCode: state.code,
      settings: state.settings,
      players: state.players.map(({ id, name, balance, color }) => ({ id, name, balance, color })),
      transactions: state.transactions,
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `banco-imobiliario-${state.code}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Partida salva em JSON.');
  });
  $('#m-import').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!confirm('Substituir jogadores, saldos e histórico desta sala pelos dados do arquivo?')) return;
      socket.emit('state:import', data, (res) => { toast(res.ok ? 'Partida restaurada para todos.' : res.error); if (res.ok) closeSheets(); });
    } catch { toast('Arquivo JSON inválido.'); }
  });
  $('#m-leave').addEventListener('click', () => {
    socket.emit('room:leave', () => {
      session = null; clearSession(); inRoom = false; state = null; seen = null;
      closeSheets(); showScreen('join');
    });
  });

  /* ---------- Início ---------- */
  const qs = new URLSearchParams(location.search).get('sala');
  if (qs) { $('#code').value = qs.toUpperCase().replace(/[^A-Z0-9]/g, ''); peek(); }
  showScreen(session ? 'boot' : 'join');
  updateRole();
})();
