'use strict';
/* Tactical Loot Chess — авторитетный игровой сервер (Express + Socket.io).
 * Вся логика, проверка ходов, урон и лут — только здесь. */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const R = require('./public/shared.js');

const PORT = Number(process.env.PORT) || 3000;
const N = R.N;
const SIDES = ['blue', 'red'];
const SIDE_NAME = { blue: 'Синие', red: 'Красные' };
const SIDE_GEN = { blue: 'Синих', red: 'Красных' };
const SIDE_ADJ = { blue: 'Синий', red: 'Красный' };
const TURN_MS = R.TURN_SECONDS * 1000;
const LOBBY_GRACE_MS = 20000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 10000 });

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
function deleteRoom(room) {
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
  placeUnits(g);
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

const LAYOUT = [
  ['sniper', 1, 7], ['commander', 3, 7], ['sniper', 6, 7],
  ['assault', 2, 6], ['scout', 4, 6], ['assault', 5, 6],
];
function placeUnits(g) {
  for (const side of SIDES) {
    LAYOUT.forEach(([type, x, y], i) => {
      const T = R.UNIT_TYPES[type];
      const px = side === 'blue' ? x : N - 1 - x;
      const py = side === 'blue' ? y : N - 1 - y;
      g.units.push({
        id: (side === 'blue' ? 'b' : 'r') + i, type, side, x: px, y: py,
        hp: T.hp, maxHp: T.hp, alive: true, item: null,
        moved: false, acted: false, attacked: false, slowed: false, slowNext: false,
      });
    });
  }
}

function weightedPick(weights) {
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}
// Содержимое ящика определяется в момент открытия — по удаче команды открывшего и прогрессу матча
function rollLoot(g, side) {
  // пока клевер команды действует, новый клевер ей не выпадает
  const pool = R.ITEM_KEYS.filter((k) => !(k === 'luck' && g.luckBuff[side]));
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
function damage(g, t, amount) {
  if (!t.alive || amount <= 0) return 0;
  if (t.item && t.item.type === 'shield') {
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
    ev(g, 'death', { unitId: t.id, x: t.x, y: t.y });
    addLog(g, `☠ ${label(t)} уничтожен!`, 'death');
  }
  return amount;
}

const itemCopy = (it) => (it ? Object.assign({}, it) : null);
const RARITY_ICON = ['', '◆ ', '◆◆ ', '★ ', '✦ '];

function pickup(g, u, crate) {
  g.crates = g.crates.filter((c) => c !== crate);
  const loot = rollLoot(g, u.side);
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
    u.slowed = false; u.slowNext = false;
    ev(g, 'heal', { unitId: u.id, amount: u.hp - before, hp: u.hp, maxHp: u.maxHp });
    addLog(g, `✚ ${tag}${label(u)}: ${full} — +${u.hp - before} HP${addMax ? `, макс. HP +${addMax}` : ''}`, 'heal', 'all', it.tier);
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
  if (!R.inBounds(x, y) || (x === u.x && y === u.y)) return 'Неверная клетка';
  const prev = R.reachable(g, u);
  const path = R.pathTo(prev, x, y);
  if (!path) return 'Клетка недостижима';
  activate(g, u);
  u.moved = true;
  travel(g, u, path);
  return null;
}

function actAttack(g, side, a) {
  const u = getOwnUnit(g, side, a.unitId);
  const t = g.units.find((x) => x.id === a.targetId && x.alive);
  if (!u || !t) return 'Неверная цель';
  const info = R.attackInfo(g, u, t, 'normal');
  if (!info.ok) return info.reason;
  activate(g, u);
  u.acted = true; u.attacked = true;
  ev(g, 'shot', { unitId: u.id, from: { x: u.x, y: u.y }, to: { x: t.x, y: t.y }, kind: u.type === 'sniper' ? 'sniper' : 'laser', side: u.side });
  addLog(g, `${label(u)} атакует: ${label(t)}`, 'atk');
  damage(g, t, info.dmg);
  return null;
}

function actShotgun(g, side, a) {
  const u = getOwnUnit(g, side, a.unitId);
  const t = g.units.find((x) => x.id === a.targetId && x.alive);
  if (!u || !t) return 'Неверная цель';
  const info = R.attackInfo(g, u, t, 'shotgun');
  if (!info.ok) return info.reason;
  activate(g, u);
  u.acted = true; u.attacked = true;
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
  for (const u of g.units) {
    if (u.side !== side) continue;
    u.moved = false; u.acted = false; u.attacked = false; u.slowed = false;
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
  g.turnEndsAt = Date.now() + TURN_MS;
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
}

function performAction(g, side, a) {
  g.events = [];
  let err = null;
  try {
    switch (a.type) {
      case 'move': err = actMove(g, side, a); break;
      case 'attack': err = actAttack(g, side, a); break;
      case 'shotgun': err = actShotgun(g, side, a); break;
      case 'jetpack': err = actJetpack(g, side, a); break;
      case 'mine': err = actMine(g, side, a); break;
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
    units: g.units.map((u) => Object.assign({}, u, { item: itemCopy(u.item) })),
    luck: Object.assign({}, g.luck),
    luckBuff: { blue: g.luckBuff.blue && Object.assign({}, g.luckBuff.blue), red: g.luckBuff.red && Object.assign({}, g.luckBuff.red) },
    crates: g.crates.map((c) => ({ id: c.id, x: c.x, y: c.y })), // содержимое ящика скрыто
    mines: g.mines.filter((m) => seeAll || m.side === viewer).map((m) => ({ id: m.id, x: m.x, y: m.y, side: m.side, dmg: m.dmg })),
    log: g.log.filter((l) => l.vis === 'all' || seeAll || l.vis === viewer).slice(-100)
      .map((l) => ({ id: l.id, text: l.text, cls: l.cls, tier: l.tier })),
    players: { blue: pl('blue'), red: pl('red') },
    rematch: Object.assign({}, room.rematch),
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
  for (const socket of roomSockets(room)) {
    const v = viewerOf(socket, room);
    socket.emit('state', { state: stateFor(room, v), events: eventsFor(v, events) });
  }
}
function lobbyFor(socket, room) {
  const pub = (s) => (s ? { name: s.name, ready: s.ready, connected: s.connected } : null);
  return {
    code: room.code, phase: room.phase, solo: room.solo, you: viewerOf(socket, room),
    slots: { blue: pub(room.slots.blue), red: pub(room.slots.red) },
  };
}
function emitLobby(room) {
  for (const socket of roomSockets(room)) socket.emit('lobby', lobbyFor(socket, room));
}

function startGame(room, solo) {
  clearTimeout(room.turnTimer);
  room.solo = solo;
  room.game = createGame(room);
  room.game.turnEndsAt += START_DELAY_MS; // первый ход начинается после отсчёта
  room.phase = 'game';
  room.rematch = { blue: false, red: false };
  scheduleTurnTimer(room);
  emitLobby(room);
  broadcastState(room, []);
  console.log(`[game] ${room.code}: новая партия ${room.game.id}${solo ? ' (1 экран)' : ''}`);
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
    if (free) room.slots[free] = { token: info.token, name: info.name, ready: false, connected: true, socketId: socket.id, graceTimer: null };
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
  if (viewer === 'both') return deleteRoom(room);
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

function publicRooms() {
  const open = [];
  let games = 0;
  for (const room of rooms.values()) {
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
  const cur = () => {
    const info = socketsInfo.get(socket.id);
    return info && info.code ? rooms.get(info.code) || null : null;
  };

  socket.on('hello', (d) => {
    const token = String((d && d.token) || '').slice(0, 64);
    if (!token) return;
    socketsInfo.set(socket.id, { token, name: cleanName(d && d.name), code: null });
    const code = normCode(d && d.code);
    if (!code) return socket.emit('menu');
    const room = rooms.get(code);
    if (room) joinRoom(socket, room);
    else socket.emit('roomGone', code);
  });

  socket.on('listRooms', (cb) => { if (typeof cb === 'function') cb(publicRooms()); });

  socket.on('createRoom', (cb) => {
    if (!socketsInfo.has(socket.id)) return;
    if (rooms.size >= MAX_ROOMS) return socket.emit('errorMsg', 'Сервер переполнен, попробуйте позже');
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
  socket.on('solo', () => {
    const info = socketsInfo.get(socket.id);
    if (!info) return;
    if (rooms.size >= MAX_ROOMS) return socket.emit('errorMsg', 'Сервер переполнен, попробуйте позже');
    if (info.code) leaveRoom(socket);
    const room = createRoom(true);
    info.code = room.code;
    socket.join('r:' + room.code);
    for (const s of SIDES) {
      room.slots[s] = { token: info.token, name: info.name, ready: true, connected: true, socketId: socket.id, graceTimer: null };
    }
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
    room.rematch[viewer] = true;
    if (room.rematch.blue && room.rematch.red) startGame(room, false);
    else broadcastState(room, []);
  });

  socket.on('toLobby', () => {
    const room = cur();
    if (!room) return;
    const viewer = viewerOf(socket, room);
    if (!viewer || room.phase === 'lobby') return;
    if (room.solo) { leaveRoom(socket); return socket.emit('menu'); }
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  TACTICAL LOOT CHESS — сервер запущен: http://localhost:${PORT}\n`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Порт ${PORT} занят. Запустите с другим портом: PORT=3001 node server.js`);
  else console.error(e);
  process.exit(1);
});
