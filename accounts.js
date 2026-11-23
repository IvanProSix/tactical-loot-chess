'use strict';
/* Аккаунты и экономика Tactical Loot Chess.
 * Хранилище: Postgres, если задан DATABASE_URL (Render + Neon), иначе JSON-файл data/players.json (локально).
 * Все игроки, к которым обращались, держатся в памяти; запись в хранилище — с небольшой задержкой. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const R = require('./public/shared.js');

// ---------------------------------------------------------------- Баланс экономики
const ECON = {
  START_COINS: 200,
  WIN_BASE: 100,
  WIN_STREAK_STEP: 10, // +10 за каждую победу подряд
  WIN_STREAK_MAX: 50,
  LOSS_PCT: 0.15,
  MIN_ROUNDS: 3, // более короткие матчи не влияют на баланс
  FARM_LIMIT: 3, // наград за победы над одним и тем же соперником в день
  DAILY_WIN_LIMIT: 10, // всего оплачиваемых побед в день (защита от фарма на «твинках»)
  MINE_RATE: [20, 35, 55, 80, 120], // монет в час по уровням рудника
  MINE_UPGRADE: [400, 900, 1800, 3500], // цена перехода на следующий уровень
  MINE_CAP_HOURS: 8,
  DAILY: [50, 75, 100, 150, 200, 250, 'unit'], // 7-й день — новый юнит (или 500, если открыто всё)
  DAILY_FALLBACK: 500,
};
const HOUR = 3600 * 1000;
// «Сегодня» по Москве (UTC+3) — сутки для ежедневной награды и лимитов
const dayKey = (t = Date.now()) => new Date(t + 3 * HOUR).toISOString().slice(0, 10);
const prevDayKey = () => dayKey(Date.now() - 24 * HOUR);

// ---------------------------------------------------------------- Хранилище
class FileStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.timer = null;
  }
  async init() {
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { this.data = {}; }
    this.roomsFile = path.join(path.dirname(this.file), 'rooms.json');
    try { this.rooms = JSON.parse(fs.readFileSync(this.roomsFile, 'utf8')); } catch (e) { this.rooms = {}; }
    console.log(`[db] JSON-файл ${this.file} (игроков: ${Object.keys(this.data).length})`);
  }
  async getById(id) { return this.data[id] ? JSON.parse(JSON.stringify(this.data[id])) : null; }
  async getByName(lc) {
    const p = Object.values(this.data).find((x) => x.nameLc === lc);
    return p ? JSON.parse(JSON.stringify(p)) : null;
  }
  async insert(p) {
    if (Object.values(this.data).some((x) => x.nameLc === p.nameLc)) throw new Error('name_taken');
    this.data[p.id] = JSON.parse(JSON.stringify(p));
    this.flush();
  }
  async save(p) { this.data[p.id] = JSON.parse(JSON.stringify(p)); this.flush(); }
  flush() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.writeNow(), 300);
  }
  writeNow() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
  async close() { this.writeNow(); this.writeRoomsNow(); }
  // ---- сохранённые матчи
  async saveRoom(code, data) { this.rooms[code] = { data, t: Date.now() }; this.flushRooms(); }
  async deleteRoom(code) { if (this.rooms[code]) { delete this.rooms[code]; this.flushRooms(); } }
  async loadRooms(maxAgeMs) {
    const now = Date.now();
    return Object.entries(this.rooms).filter(([, v]) => now - v.t < maxAgeMs).map(([code, v]) => ({ code, data: v.data }));
  }
  flushRooms() { clearTimeout(this.roomsTimer); this.roomsTimer = setTimeout(() => this.writeRoomsNow(), 300); }
  writeRoomsNow() {
    clearTimeout(this.roomsTimer);
    fs.mkdirSync(path.dirname(this.roomsFile), { recursive: true });
    fs.writeFileSync(this.roomsFile + '.tmp', JSON.stringify(this.rooms));
    fs.renameSync(this.roomsFile + '.tmp', this.roomsFile);
  }
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    url = url.replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, ''); // не нужен node-pg
    url = url.replace(/sslmode=(require|prefer|verify-ca)/, 'sslmode=verify-full'); // проверка сертификата сервера БД
    this.pool = new Pool({ connectionString: url, max: 4 });
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY, name_lc TEXT UNIQUE NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await this.pool.query("DELETE FROM rooms WHERE updated_at < now() - interval '1 day'");
    const r = await this.pool.query('SELECT count(*)::int AS n FROM players');
    console.log(`[db] Postgres подключён (игроков: ${r.rows[0].n})`);
  }
  async getById(id) {
    const r = await this.pool.query('SELECT data FROM players WHERE id = $1', [id]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  async getByName(lc) {
    const r = await this.pool.query('SELECT data FROM players WHERE name_lc = $1', [lc]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  async insert(p) {
    try {
      await this.pool.query('INSERT INTO players (id, name_lc, data) VALUES ($1, $2, $3)', [p.id, p.nameLc, p]);
    } catch (e) {
      if (e.code === '23505') throw new Error('name_taken');
      throw e;
    }
  }
  async save(p) {
    await this.pool.query('UPDATE players SET data = $2, updated_at = now() WHERE id = $1', [p.id, p]);
  }
  async close() { await this.pool.end(); }
  // ---- сохранённые матчи
  async saveRoom(code, data) {
    await this.pool.query(`INSERT INTO rooms (code, data, updated_at) VALUES ($1, $2, now())
      ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [code, JSON.stringify(data)]);
  }
  async deleteRoom(code) { await this.pool.query('DELETE FROM rooms WHERE code = $1', [code]); }
  async loadRooms(maxAgeMs) {
    const r = await this.pool.query('SELECT code, data FROM rooms WHERE updated_at > now() - ($1::int * interval \'1 millisecond\')', [maxAgeMs]);
    return r.rows;
  }
}

const store = process.env.DATABASE_URL
  ? new PgStore(process.env.DATABASE_URL)
  : new FileStore(path.join(__dirname, 'data', 'players.json'));
const cache = new Map(); // id -> player
const saveTimers = new Map();

function save(p) {
  clearTimeout(saveTimers.get(p.id));
  saveTimers.set(p.id, setTimeout(() => {
    saveTimers.delete(p.id);
    store.save(p).catch((e) => console.error('[db] ошибка сохранения', p.name, e.message));
  }, 400));
}
// Немедленно записать все отложенные изменения (при остановке сервера)
async function flushAll() {
  const ids = [...saveTimers.keys()];
  for (const id of ids) clearTimeout(saveTimers.get(id));
  saveTimers.clear();
  await Promise.all(ids.map((id) => cache.get(id) && store.save(cache.get(id)).catch((e) => console.error('[db]', e.message))));
  await store.close();
}
async function loadById(id) {
  if (cache.has(id)) return cache.get(id);
  const p = await store.getById(id);
  if (!p) return null;
  normalize(p);
  if (!cache.has(id)) cache.set(id, p);
  return cache.get(id);
}
async function loadByName(lc) {
  for (const p of cache.values()) if (p.nameLc === lc) return p;
  const p = await store.getByName(lc);
  if (!p) return null;
  normalize(p);
  if (!cache.has(p.id)) cache.set(p.id, p);
  return cache.get(p.id);
}
// Поля, добавленные в новых версиях, — со значениями по умолчанию
function normalize(p) {
  p.coins = Math.max(0, Math.floor(p.coins || 0));
  p.unlocked = Array.isArray(p.unlocked) ? p.unlocked.filter((t) => R.SHOP_UNITS.includes(t) || R.SPECIAL_UNITS.includes(t)) : [];
  if (R.squadError(p.squad, p.unlocked)) p.squad = R.DEFAULT_SQUAD.slice();
  p.mine = p.mine || { level: 1, last: Date.now() };
  p.daily = p.daily || { streak: 0, last: null };
  p.stats = p.stats || { wins: 0, losses: 0, streak: 0, earned: 0 };
  p.farm = p.farm || { day: null, vs: {} };
  p.campaign = Math.max(0, Math.min(R.CAMPAIGN.length, Math.floor(p.campaign || 0))); // пройдено уровней кампании
  p.sessions = Array.isArray(p.sessions) ? p.sessions : [];
}

// Админы: список ников только из переменной окружения ADMIN_NAMES (через запятую)
const ADMINS = new Set(String(process.env.ADMIN_NAMES || '').split(',').map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean));
const isAdmin = (p) => !!p && ADMINS.has(p.nameLc);

// ---------------------------------------------------------------- Аутентификация
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function hashPass(pass, salt) {
  return new Promise((res, rej) => crypto.scrypt(pass, salt, 32, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
}
function cleanAccName(n) { return String(n == null ? '' : n).replace(/\s+/g, ' ').trim(); }
function nameError(name) {
  if (name.length < 3 || name.length > 16) return 'Ник: от 3 до 16 символов';
  if (!/^[\p{L}\p{N}_\- ]+$/u.test(name)) return 'Ник: только буквы, цифры, пробел, _ и -';
  return null;
}
function newSession(p) {
  const secret = crypto.randomBytes(24).toString('hex');
  p.sessions.unshift(sha(secret));
  p.sessions = p.sessions.slice(0, 5);
  save(p);
  return `${p.id}.${secret}`;
}

async function register(rawName, pass) {
  const name = cleanAccName(rawName);
  const err = nameError(name);
  if (err) return { error: err };
  if (typeof pass !== 'string' || pass.length < 6 || pass.length > 64) return { error: 'Пароль: от 6 до 64 символов' };
  const nameLc = name.toLowerCase();
  // ник из ADMIN_NAMES нельзя зарегистрировать: иначе его мог бы занять кто угодно и получить права
  if (ADMINS.has(nameLc)) return { error: 'Этот ник зарезервирован' };
  if (await loadByName(nameLc)) return { error: 'Такой ник уже занят' };
  const salt = crypto.randomBytes(16).toString('hex');
  const p = {
    id: crypto.randomBytes(8).toString('hex'), name, nameLc,
    pass: { salt, hash: await hashPass(pass, salt) },
    coins: ECON.START_COINS, unlocked: [], squad: R.DEFAULT_SQUAD.slice(),
    mine: { level: 1, last: Date.now() }, daily: { streak: 0, last: null },
    stats: { wins: 0, losses: 0, streak: 0, earned: 0 }, farm: { day: null, vs: {} },
    sessions: [], created: Date.now(),
  };
  try { await store.insert(p); } catch (e) {
    if (e.message === 'name_taken') return { error: 'Такой ник уже занят' };
    console.error('[db] ошибка регистрации', e.message);
    return { error: 'Ошибка сервера, попробуйте позже' };
  }
  cache.set(p.id, p);
  console.log(`[acc] новый игрок: ${p.name}`);
  return { player: p, session: newSession(p) };
}

async function login(rawName, pass) {
  const p = await loadByName(cleanAccName(rawName).toLowerCase());
  if (!p || typeof pass !== 'string') return { error: 'Неверный ник или пароль' };
  const h = await hashPass(pass, p.pass.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(p.pass.hash, 'hex'))) return { error: 'Неверный ник или пароль' };
  return { player: p, session: newSession(p) };
}

async function resume(session) {
  const [id, secret] = String(session || '').split('.');
  if (!id || !secret || id.length > 32 || secret.length > 64) return null;
  const p = await loadById(id);
  if (!p || !p.sessions.includes(sha(secret))) return null;
  return p;
}
// Смена пароля игроком: нужен старый пароль; остальные устройства выходят из аккаунта
async function changePassword(p, oldPass, newPass, keepSession) {
  if (typeof oldPass !== 'string' || typeof newPass !== 'string') return { error: 'Неверные данные' };
  const h = await hashPass(oldPass, p.pass.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(p.pass.hash, 'hex'))) return { error: 'Старый пароль неверный', wrong: true };
  if (newPass.length < 6 || newPass.length > 64) return { error: 'Новый пароль: от 6 до 64 символов' };
  const salt = crypto.randomBytes(16).toString('hex');
  p.pass = { salt, hash: await hashPass(newPass, salt) };
  const keep = String(keepSession || '').split('.')[1];
  p.sessions = keep ? p.sessions.filter((x) => x === sha(keep)) : [];
  save(p);
  return { ok: true };
}
// Временный пароль из понятных символов (без 0/O, 1/l/I)
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(10);
  return Array.from(b, (x) => abc[x % abc.length]).join('');
}
function logout(p, session) {
  const secret = String(session || '').split('.')[1];
  if (!secret) return;
  p.sessions = p.sessions.filter((h) => h !== sha(secret));
  save(p);
}

// ---------------------------------------------------------------- Экономика
function mineInfo(p) {
  const lvl = Math.min(ECON.MINE_RATE.length, p.mine.level);
  const rate = ECON.MINE_RATE[lvl - 1];
  const hours = Math.floor(Math.min(ECON.MINE_CAP_HOURS, (Date.now() - p.mine.last) / HOUR));
  const full = hours >= ECON.MINE_CAP_HOURS;
  return {
    level: lvl, rate, stored: hours * rate, cap: rate * ECON.MINE_CAP_HOURS, full,
    nextInMs: full ? 0 : HOUR - ((Date.now() - p.mine.last) % HOUR),
    upgradePrice: ECON.MINE_UPGRADE[lvl - 1] || null,
  };
}
function collectMine(p) {
  const m = mineInfo(p);
  if (m.stored <= 0) return { error: 'Рудник ещё ничего не добыл — монеты капают раз в час' };
  p.coins += m.stored;
  // недоработанный час сохраняется; при переполнении отсчёт начинается заново
  p.mine.last = m.full ? Date.now() : p.mine.last + (m.stored / m.rate) * HOUR;
  save(p);
  return { amount: m.stored };
}
function upgradeMine(p) {
  const m = mineInfo(p);
  if (!m.upgradePrice) return { error: 'Рудник уже максимального уровня' };
  if (p.coins < m.upgradePrice) return { error: 'Не хватает монет' };
  if (m.stored > 0) collectMine(p); // сначала забираем добытое по старому тарифу
  p.coins -= m.upgradePrice;
  p.mine.level++;
  save(p);
  return { level: p.mine.level };
}

function dailyInfo(p) {
  const today = dayKey();
  const canClaim = p.daily.last !== today;
  const streak = !canClaim ? p.daily.streak : (p.daily.last === prevDayKey() ? p.daily.streak % 7 : 0);
  const day = canClaim ? streak + 1 : p.daily.streak; // какой день сейчас забирается/забран
  return { canClaim, day, rewards: ECON.DAILY };
}
function claimDaily(p) {
  const d = dailyInfo(p);
  if (!d.canClaim) return { error: 'Награда за сегодня уже получена' };
  p.daily = { streak: d.day, last: dayKey() };
  const r = ECON.DAILY[d.day - 1];
  let unit = null, coins = 0;
  if (r === 'unit') {
    const locked = R.SHOP_UNITS.filter((t) => !p.unlocked.includes(t)).sort((a, b) => R.UNIT_TYPES[a].price - R.UNIT_TYPES[b].price);
    if (locked.length) { unit = locked[0]; p.unlocked.push(unit); } else coins = ECON.DAILY_FALLBACK;
  } else coins = r;
  p.coins += coins;
  save(p);
  return { day: d.day, coins, unit };
}

function buyUnit(p, type) {
  const T = R.UNIT_TYPES[type];
  if (!T || !R.SHOP_UNITS.includes(type)) return { error: 'Такого юнита нет в магазине' };
  if (p.unlocked.includes(type)) return { error: 'Уже открыт' };
  if (p.coins < T.price) return { error: 'Не хватает монет' };
  p.coins -= T.price;
  p.unlocked.push(type);
  save(p);
  return { type };
}
function setSquad(p, squad) {
  const err = R.squadError(squad, p.unlocked);
  if (err) return { error: err };
  p.squad = squad.slice();
  save(p);
  return { ok: true };
}

// Итог рейтингового матча. Возвращает изменения баланса или причину, почему матч не засчитан.
function matchResult(winner, loser, rounds) {
  if (rounds < ECON.MIN_ROUNDS) return { note: `Матч короче ${ECON.MIN_ROUNDS} раундов — монеты не начисляются` };
  const today = dayKey();
  if (winner.farm.day !== today) winner.farm = { day: today, vs: {} };
  const n = winner.farm.vs[loser.id] || 0;
  if (n >= ECON.FARM_LIMIT) return { note: `Лимит: не больше ${ECON.FARM_LIMIT} оплачиваемых побед над одним соперником в день` };
  const total = Object.values(winner.farm.vs).reduce((s, v) => s + v, 0);
  if (total >= ECON.DAILY_WIN_LIMIT) return { note: `Лимит: не больше ${ECON.DAILY_WIN_LIMIT} оплачиваемых побед в день` };
  winner.farm.vs[loser.id] = n + 1;
  const win = ECON.WIN_BASE + Math.min(ECON.WIN_STREAK_MAX, winner.stats.streak * ECON.WIN_STREAK_STEP);
  const lose = Math.floor(loser.coins * ECON.LOSS_PCT);
  winner.coins += win;
  winner.stats.wins++; winner.stats.streak++; winner.stats.earned += win;
  loser.coins -= lose;
  loser.stats.losses++; loser.stats.streak = 0;
  save(winner); save(loser);
  return { win, lose };
}

// ---------------------------------------------------------------- Админы
async function adminAction(admin, d) {
  if (!isAdmin(admin)) return { error: 'Нет прав администратора' };
  const name = cleanAccName((d && d.name) || admin.name);
  const t = await loadByName(name.toLowerCase());
  if (!t) return { error: `Игрок «${name}» не найден` };
  let msg = 'найден';
  switch (d && d.op) {
    case 'find': break;
    case 'coins': {
      const n = Math.trunc(Number(d.amount));
      if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 1e7) return { error: 'Неверная сумма' };
      t.coins = Math.max(0, t.coins + n);
      msg = `монеты ${n > 0 ? '+' : ''}${n} → ${t.coins}`;
      break;
    }
    case 'unlockAll':
      t.unlocked = R.SHOP_UNITS.concat(t.unlocked.filter((x) => R.SPECIAL_UNITS.includes(x))); // особых не трогаем
      msg = 'открыты все юниты';
      break;
    case 'resetTimers':
      t.mine.last = Date.now() - ECON.MINE_CAP_HOURS * HOUR;
      t.daily.last = null;
      msg = 'рудник заполнен, ежедневная награда снова доступна';
      break;
    case 'grantSpecial':
    case 'revokeSpecial': {
      const unit = String(d.unit || '');
      if (!R.SPECIAL_UNITS.includes(unit)) return { error: 'Неизвестный особый юнит' };
      const has = t.unlocked.includes(unit);
      if (d.op === 'grantSpecial') {
        if (has) return { error: `У игрока «${t.name}» уже есть ${R.UNIT_TYPES[unit].name}` };
        t.unlocked.push(unit);
        msg = `выдан ${R.UNIT_TYPES[unit].name}`;
      } else {
        if (!has) return { error: `У игрока «${t.name}» нет ${R.UNIT_TYPES[unit].name}` };
        t.unlocked = t.unlocked.filter((x) => x !== unit);
        if (t.squad.includes(unit)) t.squad = t.squad.filter((x) => x !== unit); // убираем из отряда
        if (R.squadError(t.squad, t.unlocked)) t.squad = R.DEFAULT_SQUAD.slice();
        msg = `забран ${R.UNIT_TYPES[unit].name}`;
      }
      break;
    }
    case 'resetPassword': {
      // временный пароль видит только админ; все сессии игрока завершаются
      const temp = tempPassword();
      const salt = crypto.randomBytes(16).toString('hex');
      t.pass = { salt, hash: await hashPass(temp, salt) };
      t.sessions = [];
      save(t);
      console.log(`[admin] ${admin.name} → ${t.name}: пароль сброшен`);
      return { target: Object.assign({ id: t.id }, profileView(t)), msg: 'пароль сброшен', tempPassword: temp };
    }
    case 'mineLevel': {
      const lvl = Math.trunc(Number(d.level));
      if (!(lvl >= 1 && lvl <= ECON.MINE_RATE.length)) return { error: 'Уровень рудника: 1–' + ECON.MINE_RATE.length };
      t.mine.level = lvl;
      msg = `рудник ур.${lvl}`;
      break;
    }
    default: return { error: 'Неизвестная команда' };
  }
  if (d.op !== 'find') {
    save(t);
    console.log(`[admin] ${admin.name} → ${t.name}: ${msg}`);
  }
  return { target: Object.assign({ id: t.id }, profileView(t)), msg };
}

// Победа на уровне кампании: открывает следующий; монеты — только за первое прохождение
function campaignWin(p, level) {
  if (level < 1 || level > R.CAMPAIGN.length || level > (p.campaign || 0) + 1) return { coins: 0 };
  if (level <= (p.campaign || 0)) return { coins: 0, repeat: true };
  p.campaign = level;
  const coins = R.CAMPAIGN[level - 1].reward;
  p.coins += coins;
  save(p);
  return { coins };
}

function profileView(p) {
  return {
    name: p.name, admin: isAdmin(p), coins: p.coins, campaign: p.campaign || 0, unlocked: p.unlocked.slice(), squad: p.squad.slice(),
    stats: Object.assign({}, p.stats), mine: mineInfo(p), daily: dailyInfo(p),
  };
}

module.exports = {
  rooms: {
    save: (code, data) => store.saveRoom(code, data),
    del: (code) => store.deleteRoom(code),
    load: (maxAgeMs) => store.loadRooms(maxAgeMs),
  },
  ECON, init: async () => {
    await store.init();
    for (const n of ADMINS) if (!(await loadByName(n))) console.warn(`[admin] ⚠ ник «${n}» из ADMIN_NAMES не зарегистрирован`);
    if (ADMINS.size) console.log(`[admin] админов в ADMIN_NAMES: ${ADMINS.size}`);
  }, flushAll, peek: (id) => cache.get(id) || null, register, login, resume, logout, loadById,
  profileView, adminAction, changePassword, campaignWin, collectMine, upgradeMine, claimDaily, buyUnit, setSquad, matchResult,
};
