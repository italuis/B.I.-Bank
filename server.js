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

const MANIFEST = {
  name: 'B.I. Bank', short_name: 'B.I. Bank', lang: 'pt-BR', id: '/', start_url: '/', scope: '/',
  display: 'standalone', orientation: 'portrait', background_color: '#eef9ff', theme_color: '#1aa6e4',
  icons: [{ src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%231aa6e4'/%3E%3Ccircle cx='50' cy='50' r='34' fill='%23fff'/%3E%3Ctext x='50' y='64' font-size='42' font-weight='700' text-anchor='middle' fill='%230a6fb0' font-family='Arial'%3EB%3C/text%3E%3C/svg%3E", sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
};
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manifest.json', (_req, res) => res.type('application/manifest+json').json(MANIFEST));
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

const uid = () => crypto.randomBytes(6).toString('hex');
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

function canMove(c, from, to, kind) {
  if (c.role === 'bank' || from === c.playerId) return true;
  return from === 'bank' && to === c.playerId && (kind === 'salary' || kind === 'loan');
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
  const active = () => {
    if (!ctx || !ctx.room.sockets.has(socket.id)) throw new Error('Você não está em uma sala.');
    return ctx;
  };
  const bankOnly = () => {
    const c = active();
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

  socket.on('room:create', (ack) => run(ack, () => ({ code: createRoom().code })));

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
      if (role === 'player') {
        const wanted = clean(data.name, 20);
        let p = data.playerId ? findPlayer(room, data.playerId) : null;
        if (!p && wanted) {
          const same = room.players.find((x) => x.name.toLowerCase() === wanted.toLowerCase());
          if (same && isOnline(room, same.id)) throw new Error('Esse nome está em uso por alguém conectado.');
          p = same || null;
        }
        if (!p) {
          if (!wanted) throw new Error('Digite seu nome.');
          if (room.players.length >= MAX_PLAYERS) throw new Error('A sala está cheia.');
          p = { id: uid(), name: wanted, balance: room.settings.startBalance, color: room.players.length % COLORS };
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
      const amount = parseAmount(d.amount);
      if (!amount) throw new Error('Informe um valor válido.');
      if (!canMove(c, d.from, d.to, d.kind)) throw new Error('Você só pode usar a sua própria conta.');
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
      const c = active();
      const i = c.room.pending.findIndex((r) => r.id === d.id);
      if (i < 0) throw new Error('Cobrança não encontrada.');
      const req = c.room.pending[i];
      const isPayer = c.role === 'bank' || c.playerId === req.from;
      const isReceiver = c.playerId === req.to;
      if (d.accept && !isPayer) throw new Error('Só quem paga pode aceitar.');
      if (!d.accept && !isPayer && !isReceiver) throw new Error('Sem permissão.');
      if (d.accept) applyTransfer(c.room, { from: req.from, to: req.to, amount: req.amount, kind: 'rent', description: req.description });
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
      kickWhere(room, (x) => x.role === 'player' && !ids.has(x.playerId));
      broadcast(room);
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
