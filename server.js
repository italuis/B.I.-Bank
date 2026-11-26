'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manifest.json', (_req, res) => res.type('application/manifest+json').sendFile(path.join(__dirname, 'manifest.json')));
app.get(['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'], (req, res) => res.sendFile(path.join(__dirname, req.path.slice(1))));
app.get('/healthz', (_req, res) => res.send('ok'));

/* ---------- Estado em memória ---------- */
const rooms = new Map();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULTS = { startBalance: 1500, salary: 200 };
const KINDS = new Set(['pix', 'salary', 'rent', 'loan', 'repay', 'fee']);
const COLORS = 6;
const MAX_AMOUNT = 1e9;
const MAX_PLAYERS = 12;
const MAX_TX = 3000;
const PROP_MAX = 60;

const uid = () => crypto.randomBytes(6).toString('hex');
const pid = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const normCode = (c) => clean(c, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
const parseAmount = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= MAX_AMOUNT ? n : null;
};
const parseMoney = (v, min) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= MAX_AMOUNT ? n : null;
};

function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(code = newCode()) {
  const room = {
    code,
    settings: { ...DEFAULTS },
    players: [],
    transactions: [],
    pending: [],
    properties: [],
    sockets: new Map(), // socket.id -> { room, role, playerId }
    touched: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

const findPlayer = (room, id) => room.players.find((p) => p.id === id);
const isOnline = (room, pid) => [...room.sockets.values()].some((c) => c.playerId === pid);
const partyName = (room, id) => (id === 'bank' ? 'Banco' : findPlayer(room, id)?.name || 'Jogador removido');

function snapshot(room) {
  return {
    code: room.code,
    settings: room.settings,
    players: room.players.map((p) => ({ ...p, online: isOnline(room, p.id) })),
    bankOnline: [...room.sockets.values()].filter((c) => c.role === 'bank').length,
    transactions: room.transactions,
    pending: room.pending,
    properties: room.properties,
    endVote: room.endVote ? { total: room.players.length, votes: [...room.endVote.votes] } : null,
    result: room.result || null,
    turns: room.turns ? { enabled: room.turns.enabled, order: room.turns.order, current: room.turns.current } : null,
  };
}

function broadcast(room) {
  room.touched = Date.now();
  io.to(room.code).emit('room:state', snapshot(room));
}

function kickWhere(room, predicate) {
  for (const [sid, c] of room.sockets) {
    if (!predicate(c)) continue;
    room.sockets.delete(sid);
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.leave(room.code);
      s.emit('kicked');
    }
  }
}

/* ---------- Turnos ---------- */
function currentTurnId(room) {
  const t = room.turns;
  if (!t || !t.enabled) return null;
  const order = t.order.filter((id) => findPlayer(room, id));
  if (!order.length) return null;
  return order[t.current % order.length];
}

/* ---------- Resultado final ---------- */
function computeResult(room) {
  const ranking = room.players.map((p) => {
    const props = room.properties.filter((x) => x.owner === p.id).map((x) => ({
      name: x.name, mortgaged: x.mortgaged, value: x.mortgaged ? x.mortgage : x.price,
    }));
    const propValue = props.reduce((sum, x) => sum + x.value, 0);
    return { id: p.id, name: p.name, cash: p.balance, props, propValue, total: p.balance + propValue };
  }).sort((a, b) => b.total - a.total || b.cash - a.cash || a.name.localeCompare(b.name));
  ranking.forEach((r, i) => { r.rank = i + 1; });
  return { endedAt: Date.now(), ranking };
}

/* ---------- Regras de transação ---------- */
function applyTransfer(room, { from, to, amount, kind, description }) {
  if (from === to) throw new Error('Origem e destino devem ser diferentes.');
  const a = from === 'bank' ? null : findPlayer(room, from);
  const b = to === 'bank' ? null : findPlayer(room, to);
  if ((from !== 'bank' && !a) || (to !== 'bank' && !b)) throw new Error('Jogador não encontrado.');
  if (a && a.balance < amount) throw new Error('Saldo insuficiente.');
  if (a) a.balance -= amount;
  if (b) b.balance += amount;
  const tx = {
    id: uid(),
    ts: Date.now(),
    from,
    to,
    fromName: partyName(room, from),
    toName: partyName(room, to),
    amount,
    kind: KINDS.has(kind) ? kind : 'pix',
    description: clean(description, 80),
    undone: false,
  };
  room.transactions.push(tx);
  if (room.transactions.length > MAX_TX) room.transactions.shift();
  return tx;
}

function canMove(c, from) {
  return c.role === 'bank' || from === c.playerId;
}

/* ---------- Socket.IO ---------- */
io.on('connection', (socket) => {
  let ctx = null;
  const reply = (ack, data) => typeof ack === 'function' && ack(data);
  const run = (ack, fn) => {
    try {
      reply(ack, { ok: true, ...(fn() || {}) });
    } catch (e) {
      reply(ack, { ok: false, error: e.message || 'Erro inesperado.' });
    }
  };
  const active = (allowEnded = false, allowAnyTurn = false) => {
    if (!ctx || !ctx.room.sockets.has(socket.id)) throw new Error('Você não está em uma sala.');
    if (ctx.room.result && !allowEnded) throw new Error('A partida está encerrada.');
    if (ctx.role === 'player' && !allowAnyTurn && currentTurnId(ctx.room) && currentTurnId(ctx.room) !== ctx.playerId) {
      throw new Error('Não é a sua vez. Você só pode visualizar.');
    }
    return ctx;
  };
  const bankOnly = () => {
    const c = active(true);
    if (c.role !== 'bank') throw new Error('Somente o Banco pode fazer isso.');
    return c;
  };
  const detach = () => {
    if (!ctx) return;
    const { room } = ctx;
    room.sockets.delete(socket.id);
    socket.leave(room.code);
    ctx = null;
    broadcast(room);
  };

  socket.on('room:create', (d, ack) => {
    if (typeof d === 'function') { ack = d; d = {}; }
    run(ack, () => {
      const want = normCode(d && d.code);
      const code = want.length >= 4 && !rooms.has(want) ? want : undefined;
      return { code: createRoom(code).code };
    });
  });

  socket.on('room:peek', (code, ack) =>
    run(ack, () => {
      const room = rooms.get(normCode(code));
      if (!room) throw new Error('Sala não encontrada.');
      return {
        code: room.code,
        players: room.players.map((p) => ({ id: p.id, name: p.name, online: isOnline(room, p.id) })),
      };
    })
  );

  socket.on('room:join', (data = {}, ack) =>
    run(ack, () => {
      const code = normCode(data.code);
      let room = rooms.get(code);
      const role = data.role === 'bank' ? 'bank' : 'player';
      if (!room && role === 'bank' && data.create && code.length >= 4) room = createRoom(code);
      if (!room) throw new Error('Sala não encontrada. Confira o código ou crie uma nova sala.');
      if (ctx) detach();

      let playerId = null;
      let name = 'Banco';
      const wantsPlayer = role === 'player' || !!clean(data.name, 20);
      if (wantsPlayer) {
        const wanted = clean(data.name, 20);
        let p = data.playerId ? findPlayer(room, data.playerId) : null;
        if (!p && data.playerCode) p = room.players.find((x) => x.id.toUpperCase() === clean(data.playerCode, 12).toUpperCase()) || null;
        if (!p && wanted) {
          const same = room.players.find((x) => x.name.toLowerCase() === wanted.toLowerCase());
          if (same && isOnline(room, same.id)) throw new Error('Esse nome está em uso por alguém conectado.');
          p = same || null;
        }
        if (!p) {
          if (!wanted) throw new Error('Digite seu nome.');
          if (room.players.length >= MAX_PLAYERS) throw new Error('A sala está cheia.');
          p = { id: pid(), name: wanted, balance: room.settings.startBalance, color: room.players.length % COLORS };
          room.players.push(p);
        }
        playerId = p.id;
        name = p.name;
      }

      ctx = { room, role, playerId };
      room.sockets.set(socket.id, ctx);
      socket.join(room.code);
      broadcast(room);
      return { code: room.code, role, playerId, name };
    })
  );

  socket.on('room:leave', (ack) => run(ack, () => detach()));

  socket.on('tx:transfer', (d = {}, ack) =>
    run(ack, () => {
      const c = active();
      const amount = d.kind === 'salary' && c.role === 'bank' ? c.room.settings.salary : parseAmount(d.amount);
      if (!amount) throw new Error('Informe um valor válido.');
      if (!canMove(c, d.from)) throw new Error('Você só pode usar a sua própria conta.');
      applyTransfer(c.room, { from: d.from, to: d.to, amount, kind: d.kind, description: d.description });
      broadcast(c.room);
    })
  );

  socket.on('charge:request', (d = {}, ack) =>
    run(ack, () => {
      const c = active();
      const amount = parseAmount(d.amount);
      if (!amount) throw new Error('Informe um valor válido.');
      if (d.from === 'bank' || !findPlayer(c.room, d.from)) throw new Error('Escolha quem vai pagar.');
      if (d.to !== 'bank' && !findPlayer(c.room, d.to)) throw new Error('Destinatário inválido.');
      if (d.from === d.to) throw new Error('Origem e destino devem ser diferentes.');
      if (c.role === 'player' && d.to !== c.playerId) throw new Error('Você só pode cobrar para a sua conta.');
      c.room.pending.push({
        id: uid(), ts: Date.now(), from: d.from, to: d.to, amount,
        fromName: partyName(c.room, d.from), toName: partyName(c.room, d.to),
        description: clean(d.description, 80),
      });
      broadcast(c.room);
    })
  );

  socket.on('charge:respond', (d = {}, ack) =>
    run(ack, () => {
      const c = active(false, true);
      const i = c.room.pending.findIndex((r) => r.id === d.id);
      if (i < 0) throw new Error('Cobrança não encontrada.');
      const req = c.room.pending[i];
      const isPayer = c.role === 'bank' || c.playerId === req.from;
      const isReceiver = c.playerId === req.to;
      if (d.accept && !isPayer) throw new Error('Só quem paga pode aceitar.');
      if (!d.accept && !isPayer && !isReceiver) throw new Error('Sem permissão.');
      if (d.accept && req.type === 'build') {
        const pr = c.room.properties.find((p) => p.id === req.propId);
        if (!pr || pr.owner !== req.from) throw new Error('Esse título não está mais disponível.');
        if (pr.mortgaged || (pr.houses || 0) >= 5) throw new Error('Não é possível construir agora.');
        if (req.amount > 0) applyTransfer(c.room, { from: req.from, to: 'bank', amount: req.amount, kind: 'fee', description: 'Construção: ' + pr.name });
        pr.houses = (pr.houses || 0) + 1;
        pr.rent = req.rent;
      } else if (d.accept && req.type === 'trade') {
        const pr = c.room.properties.find((p) => p.id === req.propId);
        if (!pr || pr.owner !== req.to) throw new Error('Esse título não está mais disponível.');
        if (pr.mortgaged) throw new Error('Título hipotecado não pode ser trocado.');
        if (req.amount > 0) applyTransfer(c.room, { from: req.from, to: req.to, amount: req.amount, kind: 'pix', description: 'Troca: ' + pr.name });
        pr.owner = req.from;
      } else if (d.accept) {
        applyTransfer(c.room, { from: req.from, to: req.to, amount: req.amount, kind: 'rent', description: req.description });
      }
      c.room.pending.splice(i, 1);
      broadcast(c.room);
    })
  );

  socket.on('tx:undo', (ack) =>
    run(ack, () => {
      const c = active();
      const last = [...c.room.transactions].reverse().find((t) => !t.undone);
      if (!last) throw new Error('Nada para desfazer.');
      if (c.role !== 'bank' && last.from !== c.playerId && last.to !== c.playerId) {
        throw new Error('A última transação não envolve você.');
      }
      const a = findPlayer(c.room, last.from);
      const b = findPlayer(c.room, last.to);
      if (a) a.balance += last.amount;
      if (b) b.balance -= last.amount;
      last.undone = true;
      last.undoneAt = Date.now();
      broadcast(c.room);
    })
  );

  socket.on('settings:update', (d = {}, ack) =>
    run(ack, () => {
      const c = bankOnly();
      const startBalance = parseMoney(d.startBalance, 0);
      const salary = parseMoney(d.salary, 1);
      if (startBalance === null || salary === null) throw new Error('Valores inválidos.');
      c.room.settings = { startBalance, salary };
      broadcast(c.room);
    })
  );

  socket.on('player:remove', (d = {}, ack) =>
    run(ack, () => {
      const c = bankOnly();
      c.room.players = c.room.players.filter((p) => p.id !== d.id);
      c.room.pending = c.room.pending.filter((r) => r.from !== d.id && r.to !== d.id);
      c.room.properties.forEach((p) => { if (p.owner === d.id) { p.owner = null; p.mortgaged = false; } });
      kickWhere(c.room, (x) => x.playerId === d.id);
      broadcast(c.room);
    })
  );

  socket.on('state:import', (data, ack) =>
    run(ack, () => {
      const c = bankOnly();
      if (!data || typeof data !== 'object' || !Array.isArray(data.players)) throw new Error('Arquivo JSON inválido.');
      const ids = new Set();
      const players = data.players.slice(0, MAX_PLAYERS).map((p, i) => {
        let id = clean(p?.id, 40) || uid();
        if (ids.has(id)) id = uid();
        ids.add(id);
        return {
          id,
          name: clean(p?.name, 20),
          balance: Math.round(Number(p?.balance)) || 0,
          photo: typeof p?.photo === 'string' && p.photo.startsWith('data:image/jpeg;base64,') && p.photo.length < 120000 ? p.photo : null,
          color: Number.isInteger(p?.color) ? Math.abs(p.color) % COLORS : i % COLORS,
        };
      }).filter((p) => p.name);
      const txs = (Array.isArray(data.transactions) ? data.transactions : []).slice(-MAX_TX).map((t) => ({
        id: clean(t?.id, 40) || uid(),
        ts: Number(t?.ts) || Date.now(),
        from: clean(t?.from, 40),
        to: clean(t?.to, 40),
        fromName: clean(t?.fromName, 20) || '?',
        toName: clean(t?.toName, 20) || '?',
        amount: Math.round(Number(t?.amount)) || 0,
        kind: KINDS.has(t?.kind) ? t.kind : 'pix',
        description: clean(t?.description, 80),
        undone: !!t?.undone,
      }));
      const room = c.room;
      room.settings = {
        startBalance: parseMoney(data.settings?.startBalance, 0) ?? DEFAULTS.startBalance,
        salary: parseMoney(data.settings?.salary, 1) ?? DEFAULTS.salary,
      };
      room.players = players;
      room.transactions = txs;
      room.pending = [];
      room.turns = data.turns && Array.isArray(data.turns.order)
        ? { enabled: !!data.turns.enabled, order: [...new Set(data.turns.order)].filter((id) => ids.has(id)), current: 0 }
        : null;
      room.endVote = null;
      room.result = null;
      room.properties = (Array.isArray(data.properties) ? data.properties : []).slice(0, PROP_MAX).map((p) => ({
        id: clean(p?.id, 40) || uid(),
        name: clean(p?.name, 30),
        price: parseMoney(p?.price, 1) || 0,
        mortgage: parseMoney(p?.mortgage, 0) || 0,
        rent: parseMoney(p?.rent, 0) || 0,
        type: p?.type === 'companhia' ? 'companhia' : 'imovel',
        houses: Math.max(0, Math.min(5, parseInt(p?.houses, 10) || 0)),
        color: /^#[0-9a-f]{6}$/i.test(String(p?.color || '')) ? String(p.color) : '#8ED8F8',
        owner: ids.has(p?.owner) ? p.owner : null,
        mortgaged: !!p?.mortgaged,
      })).filter((p) => p.name);
      kickWhere(room, (x) => x.role === 'player' && !ids.has(x.playerId));
      broadcast(room);
    })
  );

  socket.on('player:photo', (d = {}, ack) =>
    run(ack, () => {
      const c = active();
      if (!c.playerId) throw new Error('Só jogadores têm foto.');
      const p = findPlayer(c.room, c.playerId);
      if (!p) throw new Error('Jogador não encontrado.');
      const photo = String(d.photo || '');
      if (!photo.startsWith('data:image/jpeg;base64,') || photo.length > 120000) throw new Error('Foto muito grande ou inválida.');
      p.photo = photo;
      broadcast(c.room);
    })
  );

  socket.on('prop:create', (d = {}, ack) =>
    run(ack, () => {
      const c = bankOnly();
      const name = clean(d.name, 30);
      const price = parseMoney(d.price, 1);
      const mortgage = parseMoney(d.mortgage, 0);
      const rent = parseMoney(d.rent, 0);
      const type = d.type === 'companhia' ? 'companhia' : 'imovel';
      const color = /^#[0-9a-f]{6}$/i.test(String(d.color || '')) ? String(d.color) : '#8ED8F8';
      if (!name) throw new Error('Dê um nome ao título.');
      if (price === null || mortgage === null || rent === null) throw new Error('Valores inválidos.');
      if (c.room.properties.length >= PROP_MAX) throw new Error('Limite de títulos atingido.');
      c.room.properties.push({ id: uid(), name, price, mortgage, rent, type, color, houses: 0, owner: null, mortgaged: false });
      broadcast(c.room);
    })
  );

  socket.on('prop:assign', (d = {}, ack) =>
    run(ack, () => {
      const c = bankOnly();
      const pr = c.room.properties.find((p) => p.id === d.id);
      if (!pr) throw new Error('Título não encontrado.');
      const toBank = !d.owner || d.owner === 'bank';
      const owner = toBank ? null : findPlayer(c.room, d.owner);
      if (!toBank && !owner) throw new Error('Jogador não encontrado.');
      if (owner && d.charge) applyTransfer(c.room, { from: owner.id, to: 'bank', amount: pr.price, kind: 'pix', description: 'Compra: ' + pr.name });
      pr.owner = owner ? owner.id : null;
      broadcast(c.room);
    })
  );

  socket.on('prop:mortgage', (d = {}, ack) =>
    run(ack, () => {
      const c = bankOnly();
      const pr = c.room.properties.find((p) => p.id === d.id);
      if (!pr || !pr.owner) throw new Error('Título sem dono.');
      const owner = findPlayer(c.room, pr.owner);
      if (!owner) throw new Error('Jogador não encontrado.');
      if (!pr.mortgaged) {
        applyTransfer(c.room, { from: 'bank', to: owner.id, amount: pr.mortgage, kind: 'loan', description: 'Hipoteca: ' + pr.name });
        pr.mortgaged = true;
      } else {
        applyTransfer(c.room, { from: owner.id, to: 'bank', amount: Math.round(pr.mortgage * 1.1), kind: 'repay', description: 'Resgate da hipoteca: ' + pr.name });
        pr.mortgaged = false;
      }
      broadcast(c.room);
    })
  );

  socket.on('prop:delete', (d = {}, ack) =>
    run(ack, () => {
      const c = bankOnly();
      const i = c.room.properties.findIndex((p) => p.id === d.id);
      if (i < 0) throw new Error('Título não encontrado.');
      if (c.room.properties[i].mortgaged) throw new Error('Resgate a hipoteca antes de remover.');
      c.room.properties.splice(i, 1);
      broadcast(c.room);
    })
  );

  socket.on('prop:trade', (d = {}, ack) =>
    run(ack, () => {
      const c = active();
      const pr = c.room.properties.find((p) => p.id === d.id);
      if (!pr) throw new Error('Título não encontrado.');
      if (!pr.owner) throw new Error('Título sem dono.');
      if (c.role !== 'bank' && c.playerId !== pr.owner) throw new Error('Só o dono pode propor a troca.');
      if (pr.mortgaged) throw new Error('Título hipotecado não pode ser trocado.');
      const to = findPlayer(c.room, d.to);
      if (!to || to.id === pr.owner) throw new Error('Escolha outro jogador para receber.');
      const price = parseMoney(d.price, 0);
      if (price === null) throw new Error('Valor inválido.');
      if (c.room.pending.some((r) => r.type === 'trade' && r.propId === pr.id)) throw new Error('Já existe uma proposta para este título.');
      c.room.pending.push({
        id: uid(), type: 'trade', ts: Date.now(), propId: pr.id,
        from: to.id, to: pr.owner, amount: price,
        fromName: to.name, toName: findPlayer(c.room, pr.owner)?.name || 'Banco',
        description: pr.name,
      });
      broadcast(c.room);
    })
  );

  socket.on('prop:rent', (d = {}, ack) =>
    run(ack, () => {
      const c = active();
      if (!c.playerId) throw new Error('Só jogadores pagam aluguel.');
      const pr = c.room.properties.find((p) => p.id === d.id);
      if (!pr || !pr.owner) throw new Error('Título sem dono.');
      if (pr.owner === c.playerId) throw new Error('Este título é seu.');
      if (pr.mortgaged) throw new Error('Título hipotecado não cobra aluguel.');
      if (!pr.rent) throw new Error('Este título não tem aluguel.');
      const dice = Math.round(Number(d.dice)) || 0;
      if (pr.type === 'companhia' && (dice < 2 || dice > 12)) throw new Error('Informe os dados (de 2 a 12).');
      const amount = pr.type === 'companhia' ? dice * pr.rent : pr.rent;
      applyTransfer(c.room, { from: c.playerId, to: pr.owner, amount, kind: 'rent', description: 'Aluguel: ' + pr.name + (pr.type === 'companhia' ? ` (${dice} dados)` : '') });
      broadcast(c.room);
    })
  );

  socket.on('game:propose-end', (ack) =>
    run(ack, () => {
      const c = bankOnly();
      if (!c.room.players.length) throw new Error('Não há jogadores na sala.');
      if (c.room.endVote) throw new Error('Já existe uma proposta em andamento.');
      c.room.endVote = { votes: new Set() };
      broadcast(c.room);
    })
  );

  socket.on('game:vote-end', (d = {}, ack) =>
    run(ack, () => {
      const c = active(false, true);
      if (!c.room.endVote) throw new Error('Nenhuma proposta em andamento.');
      if (!c.playerId) throw new Error('Só jogadores votam.');
      if (!d.accept) {
        c.room.endVote = null;
      } else {
        c.room.endVote.votes.add(c.playerId);
        if (c.room.players.every((p) => c.room.endVote.votes.has(p.id))) {
          c.room.result = computeResult(c.room);
          c.room.endVote = null;
        }
      }
      broadcast(c.room);
    })
  );

  socket.on('game:cancel-end', (ack) =>
    run(ack, () => {
      const c = bankOnly();
      c.room.endVote = null;
      broadcast(c.room);
    })
  );

  socket.on('game:reopen', (ack) =>
    run(ack, () => {
      const c = bankOnly();
      c.room.result = null;
      broadcast(c.room);
    })
  );

  socket.on('turns:set', (d = {}, ack) =>
    run(ack, () => {
      const c = bankOnly();
      const order = [...new Set(Array.isArray(d.order) ? d.order : [])].filter((id) => findPlayer(c.room, id));
      if (d.enabled && !order.length) throw new Error('Escolha a ordem dos jogadores.');
      c.room.turns = { enabled: !!d.enabled, order, current: 0 };
      broadcast(c.room);
    })
  );

  socket.on('turn:next', (ack) =>
    run(ack, () => {
      const c = active();
      const t = c.room.turns;
      if (!t || !t.enabled) throw new Error('Os turnos estão desativados.');
      const order = t.order.filter((id) => findPlayer(c.room, id));
      if (!order.length) throw new Error('Ordem de turnos vazia.');
      t.current = (t.current + 1) % order.length;
      t.order = order;
      broadcast(c.room);
    })
  );

  socket.on('prop:build', (d = {}, ack) =>
    run(ack, () => {
      const c = bankOnly();
      const pr = c.room.properties.find((p) => p.id === d.id);
      if (!pr || !pr.owner) throw new Error('Título sem dono.');
      if (pr.type === 'companhia') throw new Error('Companhias não recebem construções.');
      if (pr.mortgaged) throw new Error('Título hipotecado não pode ser construído.');
      if ((pr.houses || 0) >= 5) throw new Error('Já é um hotel.');
      const rent = parseMoney(d.rent, 0);
      const cost = parseMoney(d.cost, 0);
      if (rent === null || cost === null) throw new Error('Valores inválidos.');
      if (c.room.pending.some((r) => r.type === 'build' && r.propId === pr.id)) throw new Error('Já existe uma proposta de construção neste título.');
      const owner = findPlayer(c.room, pr.owner);
      c.room.pending.push({
        id: uid(), type: 'build', ts: Date.now(), propId: pr.id,
        from: pr.owner, to: 'bank', amount: cost, rent,
        fromName: owner ? owner.name : '?', toName: 'Banco',
        description: pr.name,
      });
      broadcast(c.room);
    })
  );

  socket.on('prop:demolish', (d = {}, ack) =>
    run(ack, () => {
      const c = bankOnly();
      const pr = c.room.properties.find((p) => p.id === d.id);
      if (!pr || !(pr.houses > 0)) throw new Error('Não há construções para demolir.');
      const rent = parseMoney(d.rent, 0);
      if (rent === null) throw new Error('Informe o novo aluguel.');
      pr.houses -= 1;
      pr.rent = rent;
      broadcast(c.room);
    })
  );

  socket.on('disconnect', detach);
});

/* Limpa salas vazias e paradas há mais de 24h */
setInterval(() => {
  const limit = Date.now() - 24 * 3600 * 1000;
  for (const [code, room] of rooms) if (room.sockets.size === 0 && room.touched < limit) rooms.delete(code);
}, 30 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`Banco Imobiliário rodando na porta ${PORT}`));
