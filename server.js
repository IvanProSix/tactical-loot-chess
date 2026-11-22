'use strict';
/* Tactical Loot Chess — авторитетный игровой сервер (Express + Socket.io).
 * Вся логика, проверка ходов, урон и лут — только здесь. */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const R = require('./public/shared.js');
const A = require('./accounts.js');

const PORT = Number(process.env.PORT) || 3000;
const N = R.N;
const SIDES = ['blue', 'red'];
const SIDE_NAME = { blue: 'Синие', red: 'Красные' };
const SIDE_GEN = { blue: 'Синих', red: 'Красных' };
const SIDE_ADJ = { blue: 'Синий', red: 'Красный' };
const TURN_MS = R.TURN_SECONDS * 1000;
const LOBBY_GRACE_MS = 20000;

const app = express();
app.disable('x-powered-by');
// Заголовки безопасности: запрет встраивания во фреймы (кликджекинг), CSP — только свои скрипты
app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 10000, maxHttpBufferSize: 16 * 1024 });

// ---------------------------------------------------------------- Ограничения (анти-спам / анти-перебор)
// IP клиента (для лимитов). Кому доверять — зависит от того, кто стоит перед игрой:
//  • Render (переменная RENDER задаётся автоматически) — Cloudflare, его True-Client-IP / CF-Connecting-IP
//    подделать нельзя;
//  • свой сервер с nginx — только X-Real-IP / последний адрес X-Forwarded-For, их ставит nginx.
//    Заголовки Cloudflare здесь присылает сам клиент, поэтому им не верим.
// Первый адрес из X-Forwarded-For клиент может подставить сам — его не берём нигде.
const BEHIND_CLOUDFLARE = !!process.env.RENDER || process.env.TRUST_CLOUDFLARE === '1';
function ipOf(socket) {
  const h = socket.handshake.headers;
  const xf = String(h['x-forwarded-for'] || '').split(',').map((v) => v.trim()).filter(Boolean);
  const ip = BEHIND_CLOUDFLARE
    ? (h['true-client-ip'] || h['cf-connecting-ip'] || xf[xf.length - 1])
    : (h['x-real-ip'] || xf[xf.length - 1]);
  return String(ip || socket.handshake.address || '?').slice(0, 64);
}
// Счётчик событий в скользящем окне: hit(key, limit, windowMs) → true, если лимит превышен
const hits = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > limit;
}
function overLimit(key, limit, windowMs) {
  const now = Date.now();
  return (hits.get(key) || []).filter((t) => now - t < windowMs).length >= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.length || now - arr[arr.length - 1] > 3600e3) hits.delete(k);
}, 60e3).unref();
const MAX_CONN_PER_IP = 20;
const connPerIp = new Map();
io.use((socket, next) => {
  const ip = ipOf(socket);
  const n = connPerIp.get(ip) || 0;
  if (n >= MAX_CONN_PER_IP) return next(new Error('too_many_connections'));
  connPerIp.set(ip, n + 1);
  socket.once('disconnect', () => {
    const m = (connPerIp.get(ip) || 1) - 1;
    if (m <= 0) connPerIp.delete(ip); else connPerIp.set(ip, m);
  });
  next();
});

// ---------------------------------------------------------------- Комнаты
// Каждая партия живёт в своей комнате с 4-символьным кодом (ссылка вида /?room=AB12).
const rooms = new Map(); // code -> room
const socketsInfo = new Map(); // socket.id -> { token, name, code }
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов (0/O, 1/I)
const CODE_LEN = 4;
const MAX_ROOMS = 300;
const LOBBY_IDLE_MS = 3 * 60 * 1000; // пустое лобби удаляется через 3 минуты
const GAME_IDLE_MS = 10 * 60 * 1000; // брошенный матч — через 10 минут
const START_DELAY_MS = 3500; // отсчёт «3-2-1» на клиенте перед первым ходом

const rnd = (n) => Math.floor(Math.random() * n);
function cleanName(n) {
  const s = String(n == null ? '' : n).replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Боец';
}
function normCode(c) {
  const s = String(c == null ? '' : c).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
  return s.length === CODE_LEN ? s : null;
}
function newCode() {
  let c;
  do { c = Array.from({ length: CODE_LEN }, () => CODE_ABC[rnd(CODE_ABC.length)]).join(''); } while (rooms.has(c));
  return c;
}
function createRoom(solo) {
  const room = {
    code: newCode(),
    slots: { blue: null, red: null }, // { token, name, ready, connected, socketId, graceTimer }
    phase: 'lobby', // lobby | game | over
    solo: !!solo,
    game: null,
    rematch: { blue: false, red: false },
    turnTimer: null,
    emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}
// ---------------------------------------------------------------- Сохранение матчей (переживают перезапуск сервера)
const RESTORE_MAX_AGE_MS = 30 * 60 * 1000; // восстанавливаем комнаты, менявшиеся за последние 30 минут
const RESTORE_GRACE_MS = 45 * 1000; // после перезапуска к ходу добавляется время на переподключение
const persistTimers = new Map();
function serializeRoom(room) {
  const slots = {};
  for (const s of SIDES) {
    const sl = room.slots[s];
    slots[s] = sl ? { token: sl.token, name: sl.name, ready: sl.ready, playerId: sl.playerId || null, squad: sl.squad } : null;
  }
  // g.room — неперечисляемое свойство, в JSON не попадает
  return { slots, phase: room.phase, solo: room.solo, tutorial: !!room.tutorial, game: room.game, rematch: room.rematch, rewards: room.rewards || null };
}
function persistRoom(room) {
  if (!rooms.has(room.code)) return;
  clearTimeout(persistTimers.get(room.code));
  persistTimers.set(room.code, setTimeout(() => {
    persistTimers.delete(room.code);
    if (!rooms.has(room.code)) return;
    A.rooms.save(room.code, serializeRoom(room)).catch((e) => console.error('[db] сохранение комнаты', room.code, e.message));
  }, 700));
}
async function persistAllNow() {
  for (const t of persistTimers.values()) clearTimeout(t);
  persistTimers.clear();
  await Promise.all([...rooms.values()].map((room) =>
    A.rooms.save(room.code, serializeRoom(room)).catch((e) => console.error('[db]', e.message))));
}
async function restoreRooms() {
  let list = [];
  try { list = await A.rooms.load(RESTORE_MAX_AGE_MS); } catch (e) { console.error('[db] загрузка комнат', e.message); return; }
  let n = 0;
  for (const { code, data } of list) {
    if (!data || rooms.has(code)) continue;
    // матч с юнитом, которого больше нет в игре (например, удалённой секреткой), не восстанавливаем
    if (data.game && (data.game.units || []).some((u) => !R.UNIT_TYPES[u.type])) { A.rooms.del(code).catch(() => {}); continue; }
    for (const s of SIDES) {
      const sl = data.slots && data.slots[s];
      if (sl && Array.isArray(sl.squad) && sl.squad.some((t) => !R.UNIT_TYPES[t])) sl.squad = R.DEFAULT_SQUAD.slice();
    }
    const room = {
      code, slots: { blue: null, red: null }, phase: data.phase || 'lobby', solo: !!data.solo, tutorial: !!data.tutorial, game: data.game || null,
      rematch: data.rematch || { blue: false, red: false }, rewards: data.rewards || null, turnTimer: null, emptySince: Date.now(),
    };
    for (const s of SIDES) {
      const sl = data.slots && data.slots[s];
      if (sl) room.slots[s] = Object.assign({}, sl, { connected: false, socketId: null, graceTimer: null, ready: room.phase === 'lobby' ? false : sl.ready });
      if (sl && sl.playerId) await A.loadById(sl.playerId).catch(() => null); // чтобы награды начислились, даже если игрок не вернётся
    }
    if (room.game) {
      Object.defineProperty(room.game, 'room', { value: room });
      room.game.events = null;
      if (room.phase === 'game') room.game.turnEndsAt = Date.now() + TURN_MS + RESTORE_GRACE_MS;
    } else if (room.phase !== 'lobby') room.phase = 'lobby';
    rooms.set(code, room);
    if (room.phase === 'game') scheduleTurnTimer(room);
    if (room.phase === 'lobby') {
      // в лобби место того, кто не вернулся за минуту, освобождается
      for (const s of SIDES) {
        const sl = room.slots[s];
        if (sl) sl.graceTimer = setTimeout(() => { if (room.slots[s] === sl && !sl.connected) { room.slots[s] = null; emitLobby(room); } }, 60000);
      }
    }
    n++;
  }
  if (n) console.log(`[room] восстановлено после перезапуска: ${n}`);
}

function deleteRoom(room) {
  clearTimeout(persistTimers.get(room.code));
  persistTimers.delete(room.code);
  A.rooms.del(room.code).catch(() => {});
  clearTimeout(room.turnTimer);
  for (const s of SIDES) if (room.slots[s]) clearTimeout(room.slots[s].graceTimer);
  rooms.delete(room.code);
  for (const info of socketsInfo.values()) if (info.code === room.code) info.code = null;
  console.log(`[room] ${room.code} закрыта (комнат: ${rooms.size})`);
}
function sideOfToken(room, token) {
  for (const s of SIDES) if (room.slots[s] && room.slots[s].token === token) return s;
  return null;
}
function viewerOf(socket, room) {
  const info = socketsInfo.get(socket.id);
  if (!info || !room) return null;
  if (room.solo && room.slots.blue && room.slots.blue.token === info.token) return 'both';
  return sideOfToken(room, info.token);
}
function roomSockets(room) {
  const ids = io.sockets.adapter.rooms.get('r:' + room.code);
  const out = [];
  if (ids) for (const id of ids) { const s = io.sockets.sockets.get(id); if (s && socketsInfo.has(id)) out.push(s); }
  return out;
}

// ---------------------------------------------------------------- Создание партии
function createGame(room) {
  const g = {
    id: Math.random().toString(36).slice(2, 10),
    walls: [], units: [], crates: [], mines: [],
    turn: 'blue', round: 1, turnNo: 1, activated: [], winner: null, luck: { blue: 0, red: 0 }, luckBuff: { blue: null, red: null },
    log: [], seq: 1, turnEndsAt: Date.now() + TURN_MS, events: null,
  };
  Object.defineProperty(g, 'room', { value: room }); // не сериализуется
  generateWalls(g);
  placeUnits(g, {
    blue: room.slots.blue && room.slots.blue.squad,
    red: room.slots.red && room.slots.red.squad,
  });
  spawnInitialCrates(g);
  addLog(g, 'Матч начался! Цель — уничтожить вражеского Командира.', 'sys');
  addLog(g, '— Раунд 1: ход Синих', 'turn');
  return g;
}

function boardConnected(g) {
  const free = N * N - g.walls.length;
  let sx = -1, sy = -1;
  for (let y = 0; y < N && sx < 0; y++) for (let x = 0; x < N; x++) if (!R.isWall(g, x, y)) { sx = x; sy = y; break; }
  const seen = new Set([R.key(sx, sy)]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of R.DIR4) {
      const nx = x + dx, ny = y + dy;
      if (!R.inBounds(nx, ny) || R.isWall(g, nx, ny) || seen.has(R.key(nx, ny))) continue;
      seen.add(R.key(nx, ny));
      q.push([nx, ny]);
    }
  }
  return seen.size === free;
}

// 4–6 симметричных (поворот на 180°) неразрушаемых укрытий в центральных рядах
function generateWalls(g) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const pairs = 2 + rnd(2);
    const walls = [];
    const used = new Set();
    for (let i = 0; i < pairs; i++) {
      for (let t = 0; t < 60; t++) {
        const x = rnd(N), y = 2 + rnd(2);
        const mx = N - 1 - x, my = N - 1 - y;
        if (used.has(R.key(x, y)) || used.has(R.key(mx, my))) continue;
        // не лепим стены вплотную друг к другу по горизонтали в один ряд-забор
        if (walls.some((w) => w.y === y && Math.abs(w.x - x) === 1 && walls.filter((v) => v.y === y).length >= 2)) continue;
        used.add(R.key(x, y)); used.add(R.key(mx, my));
        walls.push({ x, y }, { x: mx, y: my });
        break;
      }
    }
    if (walls.length < 4) continue;
    g.walls = walls;
    if (boardConnected(g)) return;
  }
  g.walls = [{ x: 2, y: 3 }, { x: 5, y: 4 }, { x: 5, y: 2 }, { x: 2, y: 5 }];
}

// Позиции отряда (для Синих; Красные — зеркально): Командир в центре заднего ряда
const COMMANDER_POS = [3, 7];
const SQUAD_POS = [[1, 7], [6, 7], [2, 6], [5, 6], [4, 6]];
function makeUnit(g, id, type, side, x, y) {
  const T = R.UNIT_TYPES[type];
  const u = {
    id, type, side, x, y, hp: T.hp, maxHp: T.hp, alive: true, item: null,
    moved: false, acted: false, attacked: false, slowed: false, slowNext: false, boost: 0, revealUntil: null,
    buffs: { dmg: 0, range: 0, move: 0, steady: 0 }, frozen: 0, freezeCd: 0,
    poisoned: 0, poisonStacks: 0, raiseCd: 0, reviveUses: 0, diedRound: null, life: null,
  };
  g.units.push(u);
  return u;
}
function placeUnits(g, squads) {
  for (const side of SIDES) {
    const list = [['commander', ...COMMANDER_POS]].concat((squads[side] || R.DEFAULT_SQUAD).slice(0, R.SQUAD_MAX).map((t, i) => [t, ...SQUAD_POS[i]]));
    list.forEach(([type, x, y], i) => {
      const px = side === 'blue' ? x : N - 1 - x;
      const py = side === 'blue' ? y : N - 1 - y;
      makeUnit(g, (side === 'blue' ? 'b' : 'r') + i, type, side, px, py);
    });
  }
}

function weightedPick(weights) {
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}
// Содержимое ящика определяется в момент открытия — по удаче команды открывшего и прогрессу матча
function rollLoot(g, side, u) {
  // пока клевер команды действует, новый клевер ей не выпадает;
  // Ингибитор стабилизации выпадает только Снайперу, у которого его ещё нет
  const pool = R.ITEM_KEYS.filter((k) => !(k === 'luck' && g.luckBuff[side]) &&
    !(R.ITEMS[k].sniperOnly && (!u || u.type !== 'sniper' || (u.buffs && u.buffs.steady))));
  const type = pool[weightedPick(pool.map((k) => R.ITEMS[k].weight))];
  const tier = weightedPick(R.rarityWeights(g.luck[side], g.round));
  return { type, tier, charges: R.itemStat(type, tier, 'charges') || 1 };
}
function cellFree(g, x, y) {
  return R.inBounds(x, y) && !R.isWall(g, x, y) && !R.unitAt(g, x, y) && !R.crateAt(g, x, y) &&
    !g.mines.some((m) => m.x === x && m.y === y);
}
function addCrate(g, x, y) {
  const c = { id: 'c' + (g.seq++), x, y };
  g.crates.push(c);
  return c;
}
// Первая пара ящиков — симметрично, на равном удалении от баз
function spawnInitialCrates(g) {
  const xs = [...Array(N).keys()].sort(() => Math.random() - 0.5);
  for (const x of xs) {
    if (cellFree(g, x, 3) && cellFree(g, N - 1 - x, 4)) {
      addCrate(g, x, 3);
      addCrate(g, N - 1 - x, 4);
      return;
    }
  }
}
function spawnCrates(g, count) {
  let spawned = 0;
  for (let i = 0; i < count && g.crates.length < R.maxCrates(g.round); i++) {
    const free = [];
    for (let y = 1; y < N - 1; y++) for (let x = 0; x < N; x++) if (cellFree(g, x, y)) free.push([x, y]);
    if (!free.length) break;
    const [x, y] = free[rnd(free.length)];
    const c = addCrate(g, x, y);
    ev(g, 'crate', { id: c.id, x, y });
    spawned++;
  }
  if (spawned) addLog(g, `📦 Сброшены припасы: ${spawned} шт. (уровень лута ${R.lootLevel(g.round)})`, 'loot');
}

// ---------------------------------------------------------------- Лог и события
function addLog(g, text, cls = '', vis = 'all', tier) {
  g.log.push({ id: g.seq++, text, cls, vis, tier });
  if (g.log.length > 200) g.log.shift();
}
function ev(g, type, data = {}, vis = 'all') {
  if (g.events) g.events.push(Object.assign({ type, vis }, data));
}
const label = (u) => `${SIDE_ADJ[u.side]} ${R.UNIT_TYPES[u.type].name}`;

// ---------------------------------------------------------------- Механики
function damage(g, t, amount, opts) {
  if (!t.alive || amount <= 0) return 0;
  // аура Щитоносца: −1 урона союзникам вокруг (но не меньше 1); удар в спину её игнорирует
  if (amount > 1 && !(opts && opts.pierce) && g.units.some((o) => o.alive && o !== t && o.side === t.side && R.UNIT_TYPES[o.type].aura && R.cheb(o, t) <= 1)) {
    amount -= 1;
    ev(g, 'aura', { unitId: t.id });
  }
  if (t.item && t.item.type === 'shield' && !(opts && opts.noShield)) {
    const heal = R.itemStat('shield', t.item.tier, 'heal');
    t.item.charges--;
    const left = t.item.charges;
    if (left <= 0) t.item = null;
    const before = t.hp;
    if (heal) t.hp = Math.min(t.maxHp, t.hp + heal);
    ev(g, 'shield', { unitId: t.id, item: t.item ? Object.assign({}, t.item) : null, heal: t.hp - before, hp: t.hp });
    addLog(g, `🛡 Энергощит: ${label(t)} поглотил ${amount} урона${t.hp > before ? `, +${t.hp - before} HP` : ''}${left > 0 ? ` (осталось блоков: ${left})` : ''}`, 'shield');
    return 0;
  }
  t.hp = Math.max(0, t.hp - amount);
  ev(g, 'damage', { unitId: t.id, amount, hp: t.hp });
  addLog(g, `${label(t)}: −${amount} HP (${t.hp}/${t.maxHp})`, 'dmg');
  if (t.hp <= 0) {
    t.alive = false;
    t.item = null;
    t.diedRound = g.round; // для воскрешения Парамедиком
    t.poisoned = 0; t.poisonStacks = 0; t.frozen = 0;
    ev(g, 'death', { unitId: t.id, x: t.x, y: t.y });
    addLog(g, `☠ ${label(t)} уничтожен!`, 'death');
    if (t.type === 'necromancer') crumbleZombies(g, t);
  }
  return amount;
}
// Некромант погиб — его зомби рассыпаются
function crumbleZombies(g, necro) {
  const zs = g.units.filter((z) => z.alive && z.type === 'zombie' && z.owner === necro.id);
  for (const z of zs) {
    z.alive = false; z.hp = 0; z.item = null; z.diedRound = g.round;
    ev(g, 'death', { unitId: z.id, x: z.x, y: z.y, crumble: true });
  }
  if (zs.length) addLog(g, `💀 Зомби ${SIDE_GEN[necro.side]} рассыпаются в прах (${zs.length})`, 'death');
}
// Яд: в конце хода своей команды отравленный теряет HP
function poisonTick(g, side) {
  for (const u of g.units) {
    if (!u.alive || u.side !== side || !(u.poisoned > 0)) continue;
    const stacks = Math.max(1, u.poisonStacks || 1);
    let dmg = stacks * R.POISON.dmg;
    if (u.type === 'commander') dmg = Math.min(dmg, R.POISON.commanderCap); // Командир устойчив к яду
    u.poisoned--;
    if (!u.poisoned) u.poisonStacks = 0;
    ev(g, 'poisontick', { unitId: u.id, left: u.poisoned, stacks: u.poisonStacks, dmg });
    addLog(g, `☠ Яд${stacks > 1 ? ` ×${stacks}` : ''}: ${label(u)} −${dmg} HP${u.poisoned ? ` (ещё ${u.poisoned})` : ' — яд выветрился'}`, 'dmg');
    damage(g, u, dmg, { pierce: true, noShield: true });
  }
}

// ---- ИИ зомби: в конце хода своей команды идут к ближайшему видимому врагу и бьют, если рядом
function zombieHit(g, z, t) {
  ev(g, 'shot', { unitId: z.id, from: { x: z.x, y: z.y }, to: { x: t.x, y: t.y }, kind: 'claw', side: z.side });
  addLog(g, `🧟 ${label(z)} кусает ${label(t)}`, 'atk');
  damage(g, t, R.unitDmg(z));
}
function zombiesAct(g, side) {
  const zs = g.units.filter((z) => z.alive && z.side === side && R.UNIT_TYPES[z.type].auto);
  for (const z of zs) {
    if (!z.alive || g.winner) continue;
    const foes = () => g.units.filter((o) => o.alive && o.side !== side && !R.isHidden(g, o));
    if (!foes().length) return;
    const adjFoe = (p) => foes().filter((f) => R.cheb(p, f) <= 1);
    const strike = () => {
      const t = adjFoe(z).sort((a, b) => a.hp - b.hp)[0];
      if (!t) return false;
      zombieHit(g, z, t);
      return true;
    };
    if (strike()) continue;
    if (z.frozen > 0) continue; // замороженный зомби стоит
    // BFS по свободным клеткам (юниты, стены и ящики — препятствия; лут зомби не подбирают)
    const start = R.key(z.x, z.y);
    const prev = new Map([[start, -1]]);
    const dist = new Map([[start, 0]]);
    const q = [[z.x, z.y]];
    let goal = null;
    while (q.length) {
      const [x, y] = q.shift();
      const d = dist.get(R.key(x, y));
      if (d > 0 && adjFoe({ x, y }).length) { goal = [x, y]; break; }
      for (const [dx, dy] of R.DIR4) {
        const nx = x + dx, ny = y + dy, k = R.key(nx, ny);
        if (!R.inBounds(nx, ny) || dist.has(k) || R.isWall(g, nx, ny) || R.unitAt(g, nx, ny) || R.crateAt(g, nx, ny)) continue;
        dist.set(k, d + 1); prev.set(k, R.key(x, y)); q.push([nx, ny]);
      }
    }
    if (!goal) {
      // к врагу не подойти вплотную — просто сближаемся
      let bestK = null, bestD = Infinity;
      const near = (k) => Math.min(...foes().map((f) => R.cheb({ x: k % N, y: Math.floor(k / N) }, f)));
      for (const k of dist.keys()) { const dd = near(k); if (dd < bestD || (dd === bestD && dist.get(k) < dist.get(bestK))) { bestD = dd; bestK = k; } }
      if (bestK != null && bestK !== start && bestD < near(start)) goal = [bestK % N, Math.floor(bestK / N)];
    }
    if (goal) {
      const path = R.pathTo(prev, goal[0], goal[1]).slice(0, R.moveRange(z) + 1);
      if (path.length > 1) travel(g, z, path);
    }
    if (z.alive) strike();
  }
}
// Время жизни зомби: в конце хода своей команды −1; на нуле — рассыпается
function zombiesDecay(g, side) {
  for (const z of g.units) {
    if (!z.alive || z.side !== side || z.life == null) continue;
    z.life--;
    if (z.life <= 0) {
      z.alive = false; z.hp = 0; z.diedRound = g.round; z.poisoned = 0; z.poisonStacks = 0;
      ev(g, 'death', { unitId: z.id, x: z.x, y: z.y, crumble: true });
      addLog(g, `💀 ${label(z)} рассыпается в прах`, 'death');
    }
  }
}

const itemCopy = (it) => (it ? Object.assign({}, it) : null);
const RARITY_ICON = ['', '◆ ', '◆◆ ', '★ ', '✦ '];

function pickup(g, u, crate) {
  g.crates = g.crates.filter((c) => c !== crate);
  let loot;
  if (g.room && g.room.tutorial && !g.tutLoot) {
    g.tutLoot = true;
    loot = { type: 'shield', tier: 1, charges: R.itemStat('shield', 1, 'charges') };
  } else loot = rollLoot(g, u.side, u);
  giveLoot(g, u, loot, crate.x, crate.y);
  // Двойной дроп: рядом выпадает ещё один ящик
  if (Math.random() < R.doubleDropChance(g.luck[u.side], g.round)) {
    const spots = R.DIR8.map(([dx, dy]) => [crate.x + dx, crate.y + dy]).filter(([x, y]) => cellFree(g, x, y));
    if (spots.length) {
      const [x, y] = spots[rnd(spots.length)];
      const c = addCrate(g, x, y);
      ev(g, 'crate', { id: c.id, x, y, bonus: true });
      addLog(g, '🎁 ДВОЙНОЙ ДРОП! Рядом выпал ещё один ящик', 'loot');
    }
  }
}

function giveLoot(g, u, it, x, y) {
  const full = R.itemFullName(it);
  const tag = RARITY_ICON[it.tier];
  ev(g, 'pickup', { unitId: u.id, item: itemCopy(it), x, y });
  if (it.type === 'medkit') {
    const before = u.hp;
    const addMax = R.itemStat('medkit', it.tier, 'maxHp');
    u.maxHp += addMax;
    u.hp = Math.min(u.maxHp, u.hp + R.itemStat('medkit', it.tier, 'heal'));
    u.slowed = false; u.slowNext = false; u.poisoned = 0; u.poisonStacks = 0;
    ev(g, 'heal', { unitId: u.id, amount: u.hp - before, hp: u.hp, maxHp: u.maxHp });
    addLog(g, `✚ ${tag}${label(u)}: ${full} — +${u.hp - before} HP${addMax ? `, макс. HP +${addMax}` : ''}`, 'heal', 'all', it.tier);
  } else if (R.ITEMS[it.type].inhibitor) {
    const kind = R.ITEMS[it.type].inhibitor;
    const amount = R.itemStat(it.type, it.tier, 'amount');
    u.buffs = u.buffs || { dmg: 0, range: 0, move: 0, steady: 0 };
    let text;
    if (kind === 'steady') {
      u.buffs.steady = 1;
      u.buffs.range = Math.min(R.BUFF_CAP.range, u.buffs.range + amount);
      text = `может двигаться и стрелять в один ход${amount ? `, +${amount} к дальности` : ''}`;
    } else {
      const before = u.buffs[kind];
      u.buffs[kind] = Math.min(R.BUFF_CAP[kind], before + amount);
      const got = u.buffs[kind] - before;
      text = got > 0 ? `+${got} ${{ dmg: 'к урону', range: 'к дальности', move: 'к движению' }[kind]}` : 'уже на максимуме усиления';
    }
    ev(g, 'buff', { unitId: u.id, kind, buffs: Object.assign({}, u.buffs) });
    addLog(g, `💉 ${tag}${label(u)}: ${full} — ${text}`, 'loot', 'all', it.tier);
  } else if (it.type === 'luck') {
    const add = R.itemStat('luck', it.tier, 'luck');
    const turns = R.itemStat('luck', it.tier, 'turns');
    g.luckBuff[u.side] = { amount: add, turns, tier: it.tier };
    g.luck[u.side] = Math.min(R.MAX_LUCK, add);
    ev(g, 'luck', { unitId: u.id, side: u.side, amount: add, luck: g.luck[u.side] });
    addLog(g, `🍀 ${tag}${label(u)}: ${full} — удача ${SIDE_GEN[u.side]} ${add} на ${turns} ход.`, 'loot', 'all', it.tier);
  } else {
    const old = u.item;
    u.item = itemCopy(it);
    addLog(g, `📦 ${tag}${label(u)} подбирает: ${full}${old ? ` (выброшен: ${R.ITEMS[old.type].name})` : ''}`, 'loot', 'all', it.tier);
  }
}

// Расход заряда предмета
function useCharge(u) {
  u.item.charges--;
  if (u.item.charges <= 0) u.item = null;
  return itemCopy(u.item);
}

// Вход юнита в клетку: мина / ящик. Возвращает true, если движение прервано.
function enterCell(g, u, flush) {
  const mine = g.mines.find((m) => m.x === u.x && m.y === u.y && m.side !== u.side);
  if (mine) {
    if (flush) flush();
    g.mines = g.mines.filter((m) => m !== mine);
    ev(g, 'minetrigger', { x: u.x, y: u.y, side: mine.side });
    ev(g, 'explosion', { x: u.x, y: u.y, big: true });
    addLog(g, `💥 ${label(u)} подорвался на мине!`, 'death');
    const dealt = damage(g, u, mine.dmg);
    if (u.alive && dealt > 0) {
      u.slowNext = true;
      addLog(g, `${label(u)} контужен: −1 к движению на следующий ход`, 'dmg');
    }
    return true;
  }
  const crate = R.crateAt(g, u.x, u.y);
  if (crate) {
    if (flush) flush();
    pickup(g, u, crate);
  }
  return false;
}

function travel(g, u, path) {
  let seg = [path[0]];
  const flush = () => {
    if (seg.length > 1) ev(g, 'move', { unitId: u.id, path: seg });
    seg = [[u.x, u.y]];
  };
  for (let i = 1; i < path.length; i++) {
    u.x = path[i][0]; u.y = path[i][1];
    seg.push([u.x, u.y]);
    if (enterCell(g, u, flush)) return;
  }
  if (seg.length > 1) ev(g, 'move', { unitId: u.id, path: seg });
}

function activate(g, u) {
  if (!g.activated.includes(u.id)) g.activated.push(u.id);
}
function getOwnUnit(g, side, id) {
  const u = g.units.find((x) => x.id === id);
  return u && u.alive && u.side === side ? u : null;
}
const toInt = (v) => (Number.isInteger(v) ? v : -999);

function actMove(g, side, a) {
  const u = getOwnUnit(g, side, a.unitId);
  if (!u) return 'Юнит недоступен';
  if (!R.canMove(g, u)) return u.type === 'sniper' && u.attacked ? 'Снайпер уже стрелял и не может двигаться' : 'Этот юнит не может двигаться';
  const x = toInt(a.x), y = toInt(a.y);
  const trample = !!R.UNIT_TYPES[u.type].trample;
  if (!R.inBounds(x, y) || (x === u.x && y === u.y) || (!trample && R.isWall(g, x, y))) return 'Неверная клетка';
  const prev = R.reachable(g, u);
  const path = R.pathTo(prev, x, y);
  if (!path) return 'Клетка недостижима';
  activate(g, u);
  u.moved = true;
  if (trample) trampleTravel(g, u, path);
  else travel(g, u, path);
  return null;
}

// Таран Зелёного слоника: стены на пути ломаются, враги получают урон и отлетают по ходу движения.
// Если врагу некуда отлететь — он получает +1 урона, а слоник останавливается перед ним.
function trampleTravel(g, u, path) {
  let seg = [path[0]];
  const flush = () => {
    if (seg.length > 1) ev(g, 'move', { unitId: u.id, path: seg });
    seg = [[u.x, u.y]];
  };
  for (let i = 1; i < path.length; i++) {
    const [nx, ny] = path[i];
    const dx = nx - u.x, dy = ny - u.y;
    if (R.isWall(g, nx, ny)) {
      flush();
      g.walls = g.walls.filter((w) => !(w.x === nx && w.y === ny));
      ev(g, 'wallbreak', { unitId: u.id, x: nx, y: ny });
      addLog(g, `🐘 ${label(u)} проламывает стену!`, 'atk');
    }
    const t = R.unitAt(g, nx, ny);
    if (t && t.side !== u.side) {
      flush();
      reveal(g, t);
      const px = nx + dx, py = ny + dy;
      const free = R.inBounds(px, py) && !R.isWall(g, px, py) && !R.unitAt(g, px, py);
      ev(g, 'ram', { unitId: t.id, by: u.id });
      addLog(g, `🐘 ${label(u)} таранит ${label(t)}!`, 'atk');
      if (free) {
        damage(g, t, R.unitDmg(u));
        if (t.alive) {
          t.x = px; t.y = py;
          ev(g, 'knockback', { unitId: t.id, from: { x: nx, y: ny }, to: { x: px, y: py } });
          enterCell(g, t, null);
        }
      } else {
        damage(g, t, R.unitDmg(u) + 1);
        if (t.alive) { addLog(g, `${label(t)} прижат — слоник остановился`, 'atk'); return; }
      }
      if (R.unitAt(g, nx, ny)) return; // клетку так и не освободили
    }
    u.x = nx; u.y = ny;
    seg.push([nx, ny]);
    if (enterCell(g, u, flush)) return;
  }
  flush();
}

function reveal(g, u) {
  if (R.UNIT_TYPES[u.type].stealth) u.revealUntil = g.turnNo + 1; // виден до конца хода соперника
}
function pushAway(g, from, t) {
  if (!t.alive) return;
  const tx = t.x, ty = t.y;
  const nx = tx + Math.sign(tx - from.x), ny = ty + Math.sign(ty - from.y);
  if (R.inBounds(nx, ny) && !R.isWall(g, nx, ny) && !R.unitAt(g, nx, ny)) {
    t.x = nx; t.y = ny;
    ev(g, 'knockback', { unitId: t.id, from: { x: tx, y: ty }, to: { x: nx, y: ny } });
    addLog(g, `${label(t)} отброшен назад`, 'atk');
    enterCell(g, t, null);
  }
}

function actAttack(g, side, a) {
  const u = getOwnUnit(g, side, a.unitId);
  const t = g.units.find((x) => x.id === a.targetId && x.alive);
  if (!u || !t || R.isHidden(g, t)) return 'Неверная цель';
  const info = R.attackInfo(g, u, t, 'normal');
  if (!info.ok) return info.reason;
  activate(g, u);
  u.acted = true; u.attacked = true;
  reveal(g, u);
  const T = R.UNIT_TYPES[u.type];
  const kind = R.SHOT_KIND[u.type] || 'laser';
  ev(g, 'shot', { unitId: u.id, from: { x: u.x, y: u.y }, to: { x: t.x, y: t.y }, kind, side: u.side });
  addLog(g, `${label(u)} ${T.lob ? 'бросает гранату в' : 'атакует:'} ${label(t)}`, 'atk');
  if (T.lob) {
    const tx = t.x, ty = t.y;
    ev(g, 'explosion', { x: tx, y: ty, big: false });
    const splash = g.units.filter((o) => o.alive && o !== t && o.side !== u.side && R.cheb(o, { x: tx, y: ty }) === 1);
    damage(g, t, info.dmg);
    for (const o of splash) damage(g, o, 1);
  } else if (info.backstab) {
    ev(g, 'backstab', { unitId: t.id, by: u.id });
    addLog(g, `🗡 УДАР В СПИНУ! ${label(u)} атакует ${label(t)} сзади`, 'death');
    damage(g, t, info.dmg, { pierce: true });
  } else {
    damage(g, t, info.dmg);
    if (T.knockback) pushAway(g, u, t);
    // Дротист: +1 стак яда (до 3), срок обновляется до 2 ходов
    if (T.poisonOnHit && t.alive && !R.UNIT_TYPES[t.type].static) {
      t.poisonStacks = Math.min(R.POISON.maxStacks, (t.poisonStacks || 0) + 1);
      t.poisoned = R.POISON.turns;
      ev(g, 'poison', { unitId: t.id, turns: t.poisoned, stacks: t.poisonStacks });
      addLog(g, `☠ ${label(t)} отравлен: яд ×${t.poisonStacks} на ${R.POISON.turns} хода`, 'dmg');
    }
    // Ледяной маг: обычная атака замораживает (не сокращает уже наложенную заморозку)
    if (T.freezeOnHit && t.alive && !R.UNIT_TYPES[t.type].static && (t.frozen || 0) < T.freezeOnHit) {
      t.frozen = T.freezeOnHit;
      ev(g, 'freeze', { unitId: t.id, turns: t.frozen });
      addLog(g, `${label(t)} заморожен на ${t.frozen} ход`, 'shield');
    }
  }
  return null;
}

// Способности: Медик — лечение, Связист — ускорение, Инженер — турель
function actAbility(g, side, a) {
  const u = getOwnUnit(g, side, a.unitId);
  if (!u) return 'Юнит недоступен';
  const ab = R.UNIT_TYPES[u.type].ability;
  if (!ab) return 'У юнита нет способности';
  if (!R.canAct(g, u)) return 'Действие уже потрачено';
  const x = toInt(a.x), y = toInt(a.y);
  const cell = R.abilityTargets(g, u).find((c) => c.x === x && c.y === y);
  if (!cell) return 'Сюда применить нельзя';
  activate(g, u);
  u.acted = true;
  if (ab === 'heal') {
    const t = R.unitAt(g, x, y);
    const before = t.hp;
    const cured = t.poisoned > 0;
    t.hp = Math.min(t.maxHp, t.hp + R.HEAL_AMOUNT);
    t.poisoned = 0; t.poisonStacks = 0;
    ev(g, 'heal', { unitId: t.id, amount: t.hp - before, hp: t.hp, cured });
    addLog(g, `✚ ${label(u)} лечит ${label(t)}: +${t.hp - before} HP${cured ? ', яд снят' : ''}`, 'heal');
  } else if (ab === 'raise') {
    const alive = g.units.filter((o) => o.alive && o.type === 'zombie' && o.owner === u.id).length;
    const cells = R.DIR8.map(([dx, dy]) => [u.x + dx, u.y + dy])
      .filter(([cx, cy]) => R.inBounds(cx, cy) && !R.isWall(g, cx, cy) && !R.unitAt(g, cx, cy) && !R.crateAt(g, cx, cy));
    // ближе к врагу — в первую очередь
    const dir = u.side === 'blue' ? 1 : -1; // синие наступают вверх (к меньшему y), красные — вниз
    cells.sort((a, b) => (a[1] - b[1]) * dir);
    const n = Math.min(R.RAISE.count, R.RAISE.max - alive, cells.length);
    ev(g, 'raise', { unitId: u.id, count: n });
    for (let i = 0; i < n; i++) {
      const z = makeUnit(g, u.side[0] + 'z' + (g.seq++), 'zombie', u.side, cells[i][0], cells[i][1]);
      z.owner = u.id;
      z.life = R.RAISE.life; // зомби живут 3 хода; ходят сами в конце хода
      ev(g, 'spawn', { unit: Object.assign({}, z), kind: 'zombie' });
    }
    u.raiseCd = R.RAISE.cooldown;
    addLog(g, `💀 ${label(u)} поднимает мертвецов: ${n} зомби`, 'death');
  } else if (ab === 'revive') {
    const t = g.units.find((d) => d.side === u.side && !d.alive && d.x === x && d.y === y && R.revivable(g, d));
    t.alive = true;
    t.hp = Math.ceil(t.maxHp / 2);
    t.poisoned = 0; t.poisonStacks = 0; t.frozen = 0; t.slowed = false; t.slowNext = false; t.boost = 0;
    t.moved = true; t.acted = true; t.attacked = true; // в этот ход не действует
    t.diedRound = null;
    u.reviveUses = (u.reviveUses || 0) + 1;
    ev(g, 'revive', { unitId: t.id, hp: t.hp, x: t.x, y: t.y, unit: Object.assign({}, t) });
    addLog(g, `✨ ${label(u)} воскрешает ${label(t)} (${t.hp} HP), осталось воскрешений: ${R.REVIVE.uses - u.reviveUses}`, 'heal');
    enterCell(g, t, null);
  } else if (ab === 'boost') {
    const t = R.unitAt(g, x, y);
    t.boost = R.BOOST_AMOUNT;
    ev(g, 'boost', { unitId: t.id, amount: R.BOOST_AMOUNT });
    addLog(g, `📡 ${label(u)} даёт ${label(t)} +${R.BOOST_AMOUNT} к движению`, 'sys');
  } else if (ab === 'freeze') {
    const t = R.unitAt(g, x, y);
    ev(g, 'shot', { unitId: u.id, from: { x: u.x, y: u.y }, to: { x: t.x, y: t.y }, kind: 'frost', side: u.side });
    addLog(g, `❄ ${label(u)}: ледяной залп по ${label(t)}!`, 'shield');
    damage(g, t, 1);
    u.freezeCd = R.FREEZE.cooldown;
    if (t.alive) {
      t.frozen = Math.max(t.frozen || 0, R.FREEZE.turns);
      ev(g, 'freeze', { unitId: t.id, turns: t.frozen });
      addLog(g, `${label(t)} заморожен: не может двигаться ${R.FREEZE.turns} хода`, 'shield');
    }
  } else if (ab === 'trumpet') {
    ev(g, 'trumpet', { unitId: u.id });
    addLog(g, `🐘 ${label(u)}: ТРУБНЫЙ РЁВ!`, 'atk');
    const foes = g.units.filter((o) => o.alive && o.side !== u.side && R.cheb(o, u) <= 1);
    for (const t of foes) {
      damage(g, t, 1);
      pushAway(g, u, t);
    }
  } else if (ab === 'turret') {
    const t = makeUnit(g, u.side[0] + 't' + (g.seq++), 'turret', u.side, x, y);
    t.owner = u.id;
    ev(g, 'spawn', { unit: Object.assign({}, t) });
    addLog(g, `🔧 ${label(u)} ставит турель`, 'sys');
  }
  return null;
}

// Турели стреляют в конце хода своей команды по самому раненому врагу в радиусе
function turretsFire(g, side) {
  for (const tu of g.units) {
    if (!tu.alive || tu.side !== side || tu.type !== 'turret') continue;
    const T = R.UNIT_TYPES.turret;
    const foes = g.units.filter((o) => o.alive && o.side !== side && !R.isHidden(g, o) &&
      R.cheb(o, tu) >= T.minRange && R.cheb(o, tu) <= T.range && R.hasLOS(g, tu, o));
    if (!foes.length) continue;
    foes.sort((a, b) => a.hp - b.hp);
    const t = foes[0];
    ev(g, 'shot', { unitId: tu.id, from: { x: tu.x, y: tu.y }, to: { x: t.x, y: t.y }, kind: 'laser', side });
    addLog(g, `${label(tu)} открывает огонь по ${label(t)}`, 'atk');
    damage(g, t, T.dmg);
  }
}

function actShotgun(g, side, a) {
  const u = getOwnUnit(g, side, a.unitId);
  const t = g.units.find((x) => x.id === a.targetId && x.alive);
  if (!u || !t) return 'Неверная цель';
  if (R.isHidden(g, t)) return 'Неверная цель';
  const info = R.attackInfo(g, u, t, 'shotgun');
  if (!info.ok) return info.reason;
  activate(g, u);
  u.acted = true; u.attacked = true;
  reveal(g, u);
  const splashDmg = R.itemStat('shotgun', u.item.tier, 'splash');
  const after = useCharge(u);
  const tx = t.x, ty = t.y;
  ev(g, 'shot', { unitId: u.id, from: { x: u.x, y: u.y }, to: { x: tx, y: ty }, kind: 'shotgun', side: u.side, item: after });
  ev(g, 'explosion', { x: tx, y: ty, big: false });
  addLog(g, `💥 ${label(u)} стреляет из Дробовика в ${label(t)}!`, 'atk');
  const splash = g.units.filter((o) => o.alive && o !== u && o !== t && R.cheb(o, { x: tx, y: ty }) === 1);
  damage(g, t, info.dmg);
  for (const o of splash) damage(g, o, splashDmg);
  if (t.alive) {
    const nx = tx + Math.sign(tx - u.x), ny = ty + Math.sign(ty - u.y);
    if (R.inBounds(nx, ny) && !R.isWall(g, nx, ny) && !R.unitAt(g, nx, ny)) {
      t.x = nx; t.y = ny;
      ev(g, 'knockback', { unitId: t.id, from: { x: tx, y: ty }, to: { x: nx, y: ny } });
      addLog(g, `${label(t)} отброшен назад`, 'atk');
      enterCell(g, t, null);
    }
  }
  return null;
}

function actJetpack(g, side, a) {
  const u = getOwnUnit(g, side, a.unitId);
  if (!u) return 'Юнит недоступен';
  if (!u.item || u.item.type !== 'jetpack') return 'Нет джетпака';
  if (!R.canMove(g, u)) return 'Движение уже потрачено';
  const x = toInt(a.x), y = toInt(a.y);
  if (!R.jetpackCells(g, u).some((c) => c.x === x && c.y === y)) return 'Сюда прыгнуть нельзя';
  activate(g, u);
  u.moved = true;
  const after = useCharge(u);
  const from = { x: u.x, y: u.y };
  u.x = x; u.y = y;
  ev(g, 'jetpack', { unitId: u.id, from, to: { x, y }, item: after });
  addLog(g, `🚀 ${label(u)} совершает прыжок на джетпаке`, 'loot');
  enterCell(g, u, null);
  return null;
}

function actMine(g, side, a) {
  const u = getOwnUnit(g, side, a.unitId);
  if (!u) return 'Юнит недоступен';
  if (!u.item || u.item.type !== 'landmine') return 'Нет мины';
  if (!R.canAct(g, u)) return 'Действие уже потрачено';
  const x = toInt(a.x), y = toInt(a.y);
  if (!R.mineCells(g, u).some((c) => c.x === x && c.y === y)) return 'Сюда мину поставить нельзя';
  activate(g, u);
  u.acted = true;
  const dmg = R.itemStat('landmine', u.item.tier, 'dmg');
  const after = useCharge(u);
  g.mines.push({ id: 'm' + (g.seq++), x, y, side: u.side, dmg });
  ev(g, 'mineplaced', { unitId: u.id, x, y, side: u.side, item: after }, u.side);
  // противнику сообщаем только, что предмет у юнита изменился (без координат мины)
  ev(g, 'itemchange', { unitId: u.id, item: after }, R.other(u.side));
  addLog(g, `💣 ${label(u)} скрытно устанавливает мину`, 'mine', u.side);
  return null;
}

function endTurn(g, reason) {
  const side = g.turn;
  if (reason === 'timeout') addLog(g, `⏱ Время ${SIDE_GEN[side]} истекло — ход передан`, 'sys');
  zombiesAct(g, side);
  if (checkWinner(g, side)) return;
  turretsFire(g, side);
  if (checkWinner(g, side)) return;
  poisonTick(g, side);
  if (checkWinner(g, R.other(side))) return;
  zombiesDecay(g, side);
  for (const u of g.units) {
    if (u.side !== side) continue;
    u.moved = false; u.acted = false; u.attacked = false; u.slowed = false; u.boost = 0;
    // заморозка и перезарядка считаются в конце хода своей команды
    if (u.frozen > 0) { u.frozen--; if (!u.frozen && u.alive) ev(g, 'thaw', { unitId: u.id }); }
    if (u.freezeCd > 0) u.freezeCd--;
    if (u.raiseCd > 0) u.raiseCd--;
  }
  g.activated = [];
  if (side === 'red') {
    g.round++;
    if ((g.round - 1) % R.dropInterval(g.round) === 0) spawnCrates(g, R.cratesPerDrop(g.round));
  }
  g.turn = R.other(side);
  g.turnNo++;
  for (const u of g.units) {
    if (u.side === g.turn && u.alive && u.slowNext) { u.slowed = true; u.slowNext = false; }
  }
  // отсчёт действия клевера (в начале каждого своего хода)
  const lb = g.luckBuff[g.turn];
  if (lb) {
    lb.turns--;
    if (lb.turns <= 0) {
      g.luckBuff[g.turn] = null;
      g.luck[g.turn] = 0;
      ev(g, 'luck', { side: g.turn, amount: 0, luck: 0, expired: true });
      addLog(g, `🍀 Клевер ${SIDE_GEN[g.turn]} закончился — удача сброшена, клевер снова может выпасть`, 'loot');
    }
  }
  g.turnEndsAt = Date.now() + (g.room && g.room.tutorial ? 3600e3 : TURN_MS);
  ev(g, 'turn', { turn: g.turn, round: g.round });
  addLog(g, `— Раунд ${g.round}: ход ${SIDE_GEN[g.turn]}`, 'turn');
  scheduleTurnTimer(g.room);
}

function checkWinner(g, actingSide) {
  const cmdAlive = (s) => g.units.some((u) => u.side === s && u.type === 'commander' && u.alive);
  const b = cmdAlive('blue'), r = cmdAlive('red');
  if (b && r) return false;
  g.winner = !b && !r ? actingSide : (b ? 'blue' : 'red');
  finishGame(g);
  return true;
}
function finishGame(g, surrendered) {
  const room = g.room;
  room.phase = 'over';
  clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.rematch = { blue: false, red: false };
  if (surrendered) addLog(g, `🏳 ${SIDE_NAME[surrendered]} сдаются`, 'sys');
  ev(g, 'gameover', { winner: g.winner });
  addLog(g, `🏆 ПОБЕДА: ${SIDE_NAME[g.winner]}!`, 'win');
  settleRewards(room, g);
}

function performAction(g, side, a) {
  g.events = [];
  const logStart = g.log.length;
  const actor = typeof a.unitId === 'string' ? g.units.find((x) => x.id === a.unitId && x.side === side) : null;
  const hiddenBefore = !!(actor && R.isHidden(g, actor));
  const stealthHidden = g.units.filter((x) => R.UNIT_TYPES[x.type].stealth && R.isHidden(g, x));
  let err = null;
  try {
    switch (a.type) {
      case 'move': err = actMove(g, side, a); break;
      case 'attack': err = actAttack(g, side, a); break;
      case 'shotgun': err = actShotgun(g, side, a); break;
      case 'jetpack': err = actJetpack(g, side, a); break;
      case 'mine': err = actMine(g, side, a); break;
      case 'ability': err = actAbility(g, side, a); break;
      case 'endTurn': endTurn(g, 'manual'); break;
      default: err = 'Неизвестное действие';
    }
    if (!err && a.type !== 'endTurn' && !checkWinner(g, side) && R.shouldAutoEnd(g)) {
      endTurn(g, 'auto');
    }
  } catch (e) {
    console.error('Ошибка обработки действия:', e);
    err = 'Внутренняя ошибка сервера';
  }
  // Диверсант, которого раскрыли (подошли вплотную или учуял Следопыт), — «ОБНАРУЖЕН!»
  if (!err) {
    for (const x of stealthHidden) {
      const selfRevealed = x === actor && x.revealUntil != null && g.turnNo <= x.revealUntil; // раскрыл себя атакой
      if (x.alive && !R.isHidden(g, x) && !selfRevealed) {
        ev(g, 'detected', { unitId: x.id, x: x.x, y: x.y });
        addLog(g, `👁 ${label(x)} обнаружен!`, 'sys');
      }
    }
  }
  // Скрытый Диверсант: противник не видит его перемещений и находок
  if (!err && actor && actor.alive && (hiddenBefore || R.isHidden(g, actor))) {
    const own = ['move', 'jetpack', 'pickup', 'heal', 'luck', 'itemchange', 'crate', 'buff'];
    for (const e of g.events) if (e.unitId === actor.id && own.includes(e.type) && e.vis === 'all') e.vis = side;
    if (R.isHidden(g, actor)) for (let i = logStart; i < g.log.length; i++) if (g.log[i].vis === 'all') g.log[i].vis = side;
  }
  const events = g.events;
  g.events = null;
  return { err, events };
}

function scheduleTurnTimer(room) {
  clearTimeout(room.turnTimer);
  const g = room.game;
  if (!g || room.phase !== 'game') return;
  const turnNo = g.turnNo;
  room.turnTimer = setTimeout(() => {
    if (room.game !== g || room.phase !== 'game' || g.turnNo !== turnNo) return;
    g.events = [];
    endTurn(g, 'timeout');
    const events = g.events;
    g.events = null;
    broadcastState(room, events);
  }, Math.max(0, g.turnEndsAt - Date.now()) + 250);
}

// ---------------------------------------------------------------- Фильтрация состояния (анти-чит / туман войны)
function stateFor(room, viewer) {
  const g = room.game;
  if (!g) return null;
  const seeAll = viewer === 'both';
  const pl = (s) => (room.slots[s] ? { name: room.slots[s].name, connected: room.slots[s].connected } : null);
  return {
    gameId: g.id,
    phase: room.phase,
    solo: room.solo,
    you: viewer,
    turn: g.turn,
    round: g.round,
    turnNo: g.turnNo,
    turnLeftMs: room.phase === 'game' ? Math.max(0, g.turnEndsAt - Date.now()) : 0,
    activated: g.activated.slice(),
    winner: g.winner,
    walls: g.walls.map((w) => ({ x: w.x, y: w.y })),
    units: g.units.filter((u) => seeAll || u.side === viewer || !R.isHidden(g, u))
      .map((u) => Object.assign({}, u, { item: itemCopy(u.item) })),
    luck: Object.assign({}, g.luck),
    luckBuff: { blue: g.luckBuff.blue && Object.assign({}, g.luckBuff.blue), red: g.luckBuff.red && Object.assign({}, g.luckBuff.red) },
    crates: g.crates.map((c) => ({ id: c.id, x: c.x, y: c.y })), // содержимое ящика скрыто
    mines: g.mines.filter((m) => seeAll || m.side === viewer).map((m) => ({ id: m.id, x: m.x, y: m.y, side: m.side, dmg: m.dmg })),
    log: g.log.filter((l) => l.vis === 'all' || seeAll || l.vis === viewer).slice(-100)
      .map((l) => ({ id: l.id, text: l.text, cls: l.cls, tier: l.tier })),
    players: { blue: pl('blue'), red: pl('red') },
    rematch: Object.assign({}, room.rematch),
    rewards: room.phase === 'over' ? room.rewards : null,
    tutorial: !!room.tutorial,
  };
}
function eventsFor(viewer, events) {
  const seeAll = viewer === 'both';
  return (events || []).filter((e) => e.vis === 'all' || seeAll || e.vis === viewer).map((e) => {
    const c = Object.assign({}, e);
    delete c.vis;
    return c;
  });
}
function broadcastState(room, events) {
  if (!room.game) return;
  persistRoom(room);
  if (room.tutorial && room.phase === 'game' && room.game.turn === 'red' && !room.botTimer) {
    const g = room.game;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (room.game !== g || room.phase !== 'game' || g.turn !== 'red') return;
      g.events = [];
      endTurn(g, 'manual');
      const evs = g.events;
      g.events = null;
      broadcastState(room, evs);
    }, 1200);
  }
  for (const socket of roomSockets(room)) {
    const v = viewerOf(socket, room);
    socket.emit('state', { state: stateFor(room, v), events: eventsFor(v, events) });
  }
}
function lobbyFor(socket, room) {
  const pub = (s) => (s ? { name: s.name, ready: s.ready, connected: s.connected, squad: s.squad, account: !!s.playerId } : null);
  return {
    code: room.code, phase: room.phase, solo: room.solo, tutorial: !!room.tutorial, you: viewerOf(socket, room),
    slots: { blue: pub(room.slots.blue), red: pub(room.slots.red) },
  };
}
function emitLobby(room) {
  persistRoom(room);
  for (const socket of roomSockets(room)) socket.emit('lobby', lobbyFor(socket, room));
}

function startGame(room, solo) {
  clearTimeout(room.turnTimer);
  room.solo = solo;
  room.rewards = null;
  room.game = createGame(room);
  room.game.turnEndsAt += START_DELAY_MS; // первый ход начинается после отсчёта
  room.phase = 'game';
  room.rematch = { blue: false, red: false };
  scheduleTurnTimer(room);
  emitLobby(room);
  broadcastState(room, []);
  console.log(`[game] ${room.code}: новая партия ${room.game.id}${solo ? ' (1 экран)' : ''}`);
}

// ---------------------------------------------------------------- Обучение
// Заготовленная позиция: раненый Командир (для Медика), ящик на пути Штурмовика,
// мишени-разведчики и ослабленный вражеский Командир для финала.
function createTutorialGame(room) {
  const g = createGame(room);
  g.walls = [{ x: 1, y: 3 }, { x: 5, y: 4 }, { x: 6, y: 4 }];
  g.units = []; g.crates = []; g.mines = []; g.log = [];
  const mk = (id, type, side, x, y, hp) => { const u = makeUnit(g, id, type, side, x, y); if (hp) u.hp = hp; return u; };
  mk('b0', 'commander', 'blue', 3, 7, 6);
  mk('b1', 'assault', 'blue', 2, 6);
  mk('b2', 'sniper', 'blue', 5, 7);
  mk('b3', 'medic', 'blue', 4, 6);
  mk('r0', 'commander', 'red', 4, 1, 4);
  mk('r1', 'scout', 'red', 2, 2, 2);
  mk('r2', 'scout', 'red', 6, 2, 2);
  addCrate(g, 2, 4);
  addLog(g, '🎓 Обучение: враги — неподвижные мишени, таймера нет.', 'sys');
  addLog(g, '— Раунд 1: ход Синих', 'turn');
  return g;
}
function startTutorial(room) {
  clearTimeout(room.turnTimer);
  clearTimeout(room.botTimer); room.botTimer = null;
  room.rewards = null;
  room.game = createTutorialGame(room);
  room.game.turnEndsAt = Date.now() + 3600e3;
  room.phase = 'game';
  room.rematch = { blue: false, red: false };
  scheduleTurnTimer(room);
  emitLobby(room);
  broadcastState(room, []);
  console.log(`[game] ${room.code}: обучение`);
}

function surrender(room, loser) {
  const g = room.game;
  if (!g || room.phase !== 'game') return;
  g.events = [];
  g.winner = R.other(loser);
  finishGame(g, loser);
  const events = g.events;
  g.events = null;
  broadcastState(room, events);
}

// ---------------------------------------------------------------- Награды и профиль
function socketsOfPlayer(playerId) {
  const out = [];
  for (const [id, info] of socketsInfo) if (info.playerId === playerId) { const s = io.sockets.sockets.get(id); if (s) out.push(s); }
  return out;
}
function emitProfile(playerId) {
  const p = A.peek(playerId);
  if (!p) return;
  const view = A.profileView(p);
  for (const s of socketsOfPlayer(playerId)) s.emit('profile', view);
}
function settleRewards(room, g) {
  room.rewards = null;
  if (room.solo || room.tutorial) return;
  const ws = room.slots[g.winner], ls = room.slots[R.other(g.winner)];
  if (!ws || !ls || !ws.playerId || !ls.playerId || ws.playerId === ls.playerId) {
    room.rewards = { note: 'Монеты получают только игроки с аккаунтами' };
    return;
  }
  const wp = A.peek(ws.playerId), lp = A.peek(ls.playerId);
  if (!wp || !lp) return;
  const r = A.matchResult(wp, lp, g.round);
  room.rewards = r.note ? { note: r.note } : { [g.winner]: r.win, [R.other(g.winner)]: -r.lose };
  if (!r.note) addLog(g, `💰 ${wp.name}: +${r.win} · ${lp.name}: −${r.lose}`, 'loot');
  else addLog(g, `💰 ${r.note}`, 'sys');
  emitProfile(wp.id); emitProfile(lp.id);
}
// Обновить имя/аккаунт/отряд игрока на его месте в лобби
function refreshSeat(socket) {
  const info = socketsInfo.get(socket.id);
  const room = info && info.code ? rooms.get(info.code) : null;
  if (!room || room.phase !== 'lobby' || room.solo) return;
  const side = sideOfToken(room, info.token);
  if (!side) return;
  const sl = room.slots[side];
  const p = info.playerId ? A.peek(info.playerId) : null;
  sl.name = info.name;
  sl.playerId = info.playerId || null;
  sl.squad = p ? p.squad.slice() : R.DEFAULT_SQUAD.slice();
  sl.ready = false;
  emitLobby(room);
}

function joinRoom(socket, room) {
  const info = socketsInfo.get(socket.id);
  if (!info) return;
  if (info.code && info.code !== room.code) leaveRoom(socket);
  info.code = room.code;
  socket.join('r:' + room.code);
  room.emptySince = null;
  const side = sideOfToken(room, info.token);
  if (side) {
    for (const s of SIDES) {
      const sl = room.slots[s];
      if (sl && sl.token === info.token) {
        sl.socketId = socket.id;
        sl.connected = true;
        clearTimeout(sl.graceTimer);
        sl.graceTimer = null;
        if (room.phase === 'lobby') sl.name = info.name;
      }
    }
  } else if (room.phase === 'lobby' && !room.solo) {
    const free = SIDES.find((s) => !room.slots[s]);
    const other = free && room.slots[R.other(free)];
    const sameAccount = other && info.playerId && other.playerId === info.playerId;
    if (free && !sameAccount) room.slots[free] = seatFor(info, socket, false);
  }
  emitLobby(room);
  if (room.game) {
    if (side) broadcastState(room, []);
    else socket.emit('state', { state: stateFor(room, viewerOf(socket, room)), events: [] });
  }
}

// Добровольный выход из комнаты (кнопка «Выйти»). Выход посреди матча = сдача.
function leaveRoom(socket) {
  const info = socketsInfo.get(socket.id);
  if (!info || !info.code) return;
  const room = rooms.get(info.code);
  socket.leave('r:' + info.code);
  info.code = null;
  if (!room) return;
  const viewer = viewerOf(socket, room);
  if (viewer === 'both' || room.tutorial) { clearTimeout(room.botTimer); return deleteRoom(room); }
  if (viewer === 'blue' || viewer === 'red') {
    const sl = room.slots[viewer];
    if (room.phase === 'game') surrender(room, viewer);
    if (room.phase === 'lobby') { clearTimeout(sl.graceTimer); room.slots[viewer] = null; }
    else { sl.connected = false; sl.socketId = null; }
  }
  if (!roomSockets(room).length) room.emptySince = Date.now();
  emitLobby(room);
  if (room.game) broadcastState(room, []);
}

function seatFor(info, socket, ready) {
  const p = info.playerId ? A.peek(info.playerId) : null;
  return {
    token: info.token, name: info.name, ready, connected: true, socketId: socket.id, graceTimer: null,
    playerId: info.playerId || null, squad: p ? p.squad.slice() : R.DEFAULT_SQUAD.slice(),
  };
}

function publicRooms() {
  const open = [];
  let games = 0;
  for (const room of rooms.values()) {
    if (room.tutorial) continue;
    if (room.phase !== 'lobby') { if (!room.solo) games++; continue; }
    if (room.solo) continue;
    const seated = SIDES.map((s) => room.slots[s]).filter(Boolean);
    if (seated.length === 1 && seated[0].connected) open.push({ code: room.code, host: seated[0].name });
  }
  return { open: open.slice(0, 20), games, online: socketsInfo.size };
}

// Уборка брошенных комнат
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (roomSockets(room).length) { room.emptySince = null; continue; }
    if (!room.emptySince) room.emptySince = now;
    if (now - room.emptySince > (room.phase === 'lobby' ? LOBBY_IDLE_MS : GAME_IDLE_MS)) deleteRoom(room);
  }
}, 30000).unref();

// ---------------------------------------------------------------- Сокеты
io.on('connection', (socket) => {
  const ip = ipOf(socket);
  // не больше 40 сообщений в секунду с одного соединения; при злоупотреблении — отключение
  let floodN = 0, floodT = Date.now(), floodStrikes = 0;
  socket.use((packet, next) => {
    const now = Date.now();
    if (now - floodT > 1000) { floodT = now; floodN = 0; }
    if (++floodN > 40) {
      if (++floodStrikes > 20) socket.disconnect(true);
      return;
    }
    next();
  });
  const cur = () => {
    const info = socketsInfo.get(socket.id);
    return info && info.code ? rooms.get(info.code) || null : null;
  };

  let helloDone = false;
  socket.on('hello', async (d) => {
    const token = String((d && d.token) || '').slice(0, 64);
    if (!token || helloDone) return; // повторный hello на том же соединении игнорируем
    helloDone = true;
    let player = null;
    if (d && d.session) {
      try { player = await A.resume(d.session); } catch (e) { console.error('[acc] resume', e.message); }
      if (!player) socket.emit('sessionExpired');
    }
    if (!socket.connected) return;
    socketsInfo.set(socket.id, { token, name: player ? player.name : cleanName(d && d.name), code: null, playerId: player ? player.id : null, fails: 0 });
    if (player) socket.emit('profile', A.profileView(player));
    const code = normCode(d && d.code);
    if (!code) return socket.emit('menu');
    const room = rooms.get(code);
    if (room) joinRoom(socket, room);
    else socket.emit('roomGone', code);
  });

  // ---- аккаунт
  const authHandler = (kind, fn) => async (d, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const info = socketsInfo.get(socket.id);
    if (!info) return reply({ error: 'Нет связи с сервером' });
    const name = String((d && d.name) || '').slice(0, 32);
    const acc = 'acc:' + name.replace(/\s+/g, ' ').trim().toLowerCase();
    // перебор паролей: 10 неудач с IP или 10 неудач по одному нику за 15 минут — пауза
    if (overLimit('fail:' + ip, 10, 15 * 60e3) || overLimit('fail:' + acc, 10, 15 * 60e3)) {
      return reply({ error: 'Слишком много неудачных попыток, подождите 15 минут' });
    }
    // регистрация: не больше 5 аккаунтов с одного IP в час
    if (kind === 'register' && overLimit('reg:' + ip, 5, 3600e3)) return reply({ error: 'Слишком много регистраций, попробуйте позже' });
    let r;
    try { r = await fn(name, d && d.pass); } catch (e) {
      console.error('[acc]', e.message);
      return reply({ error: 'Ошибка сервера, попробуйте позже' });
    }
    if (r.error) {
      if (kind === 'login') { hit('fail:' + ip, 1e9, 15 * 60e3); hit('fail:' + acc, 1e9, 15 * 60e3); }
      return reply({ error: r.error });
    }
    if (kind === 'register') hit('reg:' + ip, 1e9, 3600e3);
    info.playerId = r.player.id;
    info.name = r.player.name;
    reply({ session: r.session, profile: A.profileView(r.player) });
    refreshSeat(socket);
  };
  socket.on('register', authHandler('register', A.register));
  socket.on('login', authHandler('login', A.login));
  socket.on('changePassword', async (d, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const info = socketsInfo.get(socket.id);
    const p = info && info.playerId ? A.peek(info.playerId) : null;
    if (!p) return reply({ error: 'Войдите в аккаунт' });
    if (overLimit('fail:' + ip, 10, 15 * 60e3) || overLimit('fail:acc:' + p.nameLc, 10, 15 * 60e3)) return reply({ error: 'Слишком много неудачных попыток, подождите 15 минут' });
    let r;
    try { r = await A.changePassword(p, d && d.old, d && d.new, d && d.session); } catch (e) { console.error('[acc]', e.message); return reply({ error: 'Ошибка сервера' }); }
    if (r.wrong) { hit('fail:' + ip, 1e9, 15 * 60e3); hit('fail:acc:' + p.nameLc, 1e9, 15 * 60e3); }
    if (r.ok) console.log(`[acc] ${p.name}: пароль изменён`);
    reply(r.error ? { error: r.error } : { ok: true });
  });

  socket.on('logout', (session) => {
    const info = socketsInfo.get(socket.id);
    if (!info || !info.playerId) return;
    const p = A.peek(info.playerId);
    if (p) A.logout(p, session);
    info.playerId = null;
    refreshSeat(socket);
  });

  // ---- экономика: все операции возвращают свежий профиль
  const econ = (fn) => (arg, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const info = socketsInfo.get(socket.id);
    const p = info && info.playerId ? A.peek(info.playerId) : null;
    if (!p) return reply({ error: 'Войдите в аккаунт' });
    const r = fn(p, arg);
    if (r.error) return reply({ error: r.error });
    reply(Object.assign({ profile: A.profileView(p) }, r));
    emitProfile(p.id);
    return r;
  };
  socket.on('collectMine', econ((p) => A.collectMine(p)));
  socket.on('upgradeMine', econ((p) => A.upgradeMine(p)));
  socket.on('claimDaily', econ((p) => A.claimDaily(p)));
  socket.on('buyUnit', econ((p, type) => A.buyUnit(p, String(type))));
  socket.on('setSquad', econ((p, squad) => {
    const r = A.setSquad(p, squad);
    if (!r.error) refreshSeat(socket);
    return r;
  }));
  socket.on('admin', async (d, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const info = socketsInfo.get(socket.id);
    const p = info && info.playerId ? A.peek(info.playerId) : null;
    if (!p) return reply({ error: 'Войдите в аккаунт' });
    let r;
    if (hit('admin:' + ip, 60, 60e3)) return reply({ error: 'Слишком часто' });
    try { r = await A.adminAction(p, d || {}); } catch (e) {
      console.error('[admin]', e.message);
      return reply({ error: 'Ошибка сервера' });
    }
    if (!r.error && r.target) emitProfile(r.target.id);
    reply(r);
  });

  socket.on('profile', (cb) => {
    const info = socketsInfo.get(socket.id);
    const p = info && info.playerId ? A.peek(info.playerId) : null;
    if (typeof cb === 'function') cb(p ? A.profileView(p) : null);
  });

  socket.on('listRooms', (cb) => { if (typeof cb === 'function') cb(publicRooms()); });

  const roomSpam = () => hit('room:' + ip, 15, 10 * 60e3); // не больше 15 комнат за 10 минут с одного IP
  socket.on('createRoom', (cb) => {
    if (!socketsInfo.has(socket.id)) return;
    if (rooms.size >= MAX_ROOMS) return socket.emit('errorMsg', 'Сервер переполнен, попробуйте позже');
    if (roomSpam()) return socket.emit('errorMsg', 'Слишком много комнат, подождите немного');
    const room = createRoom(false);
    joinRoom(socket, room);
    console.log(`[room] ${room.code} создана (комнат: ${rooms.size})`);
    if (typeof cb === 'function') cb({ code: room.code });
  });

  socket.on('joinRoom', (c, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!socketsInfo.has(socket.id)) return reply({ error: 'Нет связи' });
    const code = normCode(c);
    const room = code && rooms.get(code);
    if (!room) return reply({ error: 'Комната не найдена' });
    joinRoom(socket, room);
    reply({ code: room.code });
  });

  socket.on('leaveRoom', () => { leaveRoom(socket); socket.emit('menu'); });

  socket.on('setName', (n) => {
    const info = socketsInfo.get(socket.id);
    if (!info) return;
    info.name = cleanName(n);
    const room = cur();
    if (!room || room.phase !== 'lobby') return;
    for (const s of SIDES) if (room.slots[s] && room.slots[s].token === info.token) room.slots[s].name = info.name;
    emitLobby(room);
  });

  socket.on('ready', () => {
    const room = cur();
    if (!room || room.phase !== 'lobby') return;
    const side = viewerOf(socket, room);
    if (side !== 'blue' && side !== 'red') return;
    room.slots[side].ready = !room.slots[side].ready;
    emitLobby(room);
    const b = room.slots.blue, r = room.slots.red;
    if (b && r && b.ready && r.ready && b.connected && r.connected) startGame(room, false);
  });

  // Тренировка: отдельная приватная комната, обе команды у одного игрока
  socket.on('tutorial', () => {
    const info = socketsInfo.get(socket.id);
    if (!info) return;
    if (rooms.size >= MAX_ROOMS) return socket.emit('errorMsg', 'Сервер переполнен, попробуйте позже');
    if (roomSpam()) return socket.emit('errorMsg', 'Слишком много комнат, подождите немного');
    if (info.code) leaveRoom(socket);
    const room = createRoom(false);
    room.tutorial = true;
    info.code = room.code;
    socket.join('r:' + room.code);
    room.slots.blue = Object.assign(seatFor(info, socket, true), { squad: ['sniper', 'assault', 'medic'] });
    room.slots.red = { token: 'tutorial-bot', name: 'Мишени', ready: true, connected: true, socketId: null, graceTimer: null, playerId: null, squad: [] };
    startTutorial(room);
  });

  socket.on('solo', () => {
    const info = socketsInfo.get(socket.id);
    if (!info) return;
    if (rooms.size >= MAX_ROOMS) return socket.emit('errorMsg', 'Сервер переполнен, попробуйте позже');
    if (roomSpam()) return socket.emit('errorMsg', 'Слишком много комнат, подождите немного');
    if (info.code) leaveRoom(socket);
    const room = createRoom(true);
    info.code = room.code;
    socket.join('r:' + room.code);
    for (const s of SIDES) room.slots[s] = seatFor(info, socket, true);
    startGame(room, true);
  });

  socket.on('action', (a) => {
    const room = cur();
    if (!room || room.phase !== 'game' || !room.game || !a || typeof a !== 'object') return;
    const g = room.game;
    const viewer = viewerOf(socket, room);
    if (!viewer) return socket.emit('errorMsg', 'Вы наблюдатель');
    if (viewer !== 'both' && viewer !== g.turn) return socket.emit('errorMsg', 'Сейчас не ваш ход');
    const { err, events } = performAction(g, g.turn, a);
    if (err) return socket.emit('errorMsg', err);
    broadcastState(room, events);
  });

  socket.on('surrender', () => {
    const room = cur();
    if (!room) return;
    const viewer = viewerOf(socket, room);
    if (!viewer) return;
    surrender(room, viewer === 'both' ? room.game && room.game.turn : viewer);
  });

  socket.on('rematch', () => {
    const room = cur();
    if (!room || room.phase !== 'over') return;
    const viewer = viewerOf(socket, room);
    if (!viewer) return;
    if (viewer === 'both') return startGame(room, true);
    if (room.tutorial) return startTutorial(room); // «ещё раз» в обучении
    room.rematch[viewer] = true;
    if (room.rematch.blue && room.rematch.red) startGame(room, false);
    else broadcastState(room, []);
  });

  socket.on('toLobby', () => {
    const room = cur();
    if (!room) return;
    const viewer = viewerOf(socket, room);
    if (!viewer || room.phase === 'lobby') return;
    if (room.solo || room.tutorial) { leaveRoom(socket); return socket.emit('menu'); }
    clearTimeout(room.turnTimer);
    room.phase = 'lobby';
    room.game = null;
    room.rematch = { blue: false, red: false };
    for (const s of SIDES) {
      if (!room.slots[s]) continue;
      if (!room.slots[s].connected) room.slots[s] = null;
      else room.slots[s].ready = false;
    }
    emitLobby(room);
  });

  socket.on('disconnect', () => {
    const room = cur();
    socketsInfo.delete(socket.id);
    if (!room) return;
    for (const s of SIDES) {
      const sl = room.slots[s];
      if (!sl || sl.socketId !== socket.id) continue;
      sl.connected = false;
      sl.socketId = null;
      if (room.phase === 'lobby') {
        sl.ready = false;
        clearTimeout(sl.graceTimer);
        sl.graceTimer = setTimeout(() => {
          if (room.slots[s] === sl && !sl.connected) { room.slots[s] = null; emitLobby(room); }
        }, LOBBY_GRACE_MS);
      }
    }
    if (!roomSockets(room).length) room.emptySince = Date.now();
    emitLobby(room);
    if (room.game) broadcastState(room, []);
  });
});

// ---------------------------------------------------------------- Не даём бесплатному Render «уснуть»
// Render сам задаёт RENDER_EXTERNAL_URL. Отключить: переменная окружения KEEP_AWAKE=0.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL && process.env.KEEP_AWAKE !== '0' && typeof fetch === 'function') {
  setInterval(() => { fetch(SELF_URL + '/health').catch(() => {}); }, 10 * 60 * 1000).unref();
}

// Render при деплое шлёт SIGTERM: успеваем сохранить прогресс игроков
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${sig}] сохраняю данные и выключаюсь…`);
    try { await persistAllNow(); } catch (e) { console.error(e); }
    try { await A.flushAll(); } catch (e) { console.error(e); }
    process.exit(0);
  });
}

A.init().then(restoreRooms).then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  TACTICAL LOOT CHESS — сервер запущен: http://localhost:${PORT}\n`);
  });
}).catch((e) => {
  console.error('Не удалось подключиться к базе данных:', e.message);
  process.exit(1);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Порт ${PORT} занят. Запустите с другим портом: PORT=3001 node server.js`);
  else console.error(e);
  process.exit(1);
});
