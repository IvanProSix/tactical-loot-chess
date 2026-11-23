'use strict';
/* ИИ-противник: выбирает одно действие за раз, оценивая все допустимые ходы.
 * Честный: не видит скрытых Диверсантов и чужих мин (использует только то, что видно его стороне).
 * Сложность: easy — много случайности и без охоты на Командира, medium — разумно, hard — точно и агрессивно. */
const R = require('./public/shared.js');

const NOISE = { easy: 18, medium: 5, hard: 0 };
const rnd = () => Math.random();

function visibleFoes(g, side) {
  return g.units.filter((o) => o.alive && o.side !== side && !R.isHidden(g, o));
}
// Может ли юнит u ударить врага f, стоя в клетке cell (для оценки позиции)
function canHitFrom(g, u, cell, f) {
  if (R.UNIT_TYPES[u.type].dmg <= 0) return false;
  // для оценки клетки сам юнит «переносится» — свою старую клетку линию не закрывает
  if (R.UNIT_TYPES[u.type].bishop) { const ox = u.x, oy = u.y; u.x = -9; u.y = -9; const r = R.canFireAt(g, u, cell, f); u.x = ox; u.y = oy; return r; }
  return R.canFireAt(g, u, cell, f);
}
// Сколько врагов могут ударить по клетке (грубая оценка опасности)
function danger(g, side, cell) {
  let n = 0;
  for (const f of visibleFoes(g, side)) {
    const T = R.UNIT_TYPES[f.type];
    if (T.dmg <= 0) continue;
    const reach = (R.UNIT_TYPES[f.type].static ? 0 : R.moveRange(f)) + R.unitRange(f);
    if (R.cheb(cell, f) <= reach) n += R.unitDmg(f);
  }
  return n;
}

function scoreAttack(g, u, t, info, level) {
  let s = 10 + info.dmg * 3;
  if (info.dmg >= t.hp) s += 40; // добить
  if (t.type === 'commander') {
    s += level === 'easy' ? 0 : 25;
    if (info.dmg >= t.hp) s += 1000; // победа
  }
  if (info.backstab) s += 30;
  if (t.type === 'barrier') s -= 2; // преграду бить можно, но живые цели важнее
  s += (R.UNIT_TYPES[t.type].dmg || 0) * 2; // опасных — первыми
  return s;
}

function scoreAbility(g, u, c, side, level) {
  const ab = R.UNIT_TYPES[u.type].ability;
  const foes = visibleFoes(g, side);
  switch (ab) {
    case 'heal': {
      const t = R.unitAt(g, c.x, c.y);
      const miss = t.maxHp - t.hp;
      return miss >= 2 || t.poisoned > 0 ? 8 + Math.min(miss, 2) * 6 + (t.poisonStacks || 0) * 6 + (t.type === 'commander' ? 10 : 0) : 0;
    }
    case 'revive': return 35;
    case 'raise': return foes.length ? 28 : 0;
    case 'turret': return 16;
    case 'boost': return 3;
    case 'freeze': { const t = R.unitAt(g, c.x, c.y); return t ? 14 + R.unitDmg(t) * 3 + (t.type === 'commander' ? 8 : 0) : 0; }
    case 'trumpet': return foes.filter((f) => R.cheb(f, u) <= 1).length * 9;
    case 'detonate': {
      const hit = foes.filter((f) => R.cheb(f, u) <= 1);
      const kills = hit.filter((f) => f.hp <= R.DETONATE.dmg).length;
      const cmd = hit.some((f) => f.type === 'commander' && f.hp <= R.DETONATE.dmg);
      const v = hit.length * 9 + kills * 25 + (cmd ? 1000 : 0) - (u.hp >= 2 ? 10 : 0);
      return hit.length >= 2 || kills ? v : 0;
    }
    case 'barrier': {
      // преграда между собой и ближайшим стрелком врага
      const near = foes.filter((f) => R.cheb(f, u) <= 4).length;
      return near ? 7 + near * 2 : 0;
    }
    case 'mines': {
      const near = foes.filter((f) => R.cheb(f, c) <= 3).length;
      return near ? 6 + near * 2 : 0;
    }
    default: return 0;
  }
}

function scoreMove(g, u, cell, side, level) {
  const foes = visibleFoes(g, side);
  if (!foes.length) return 0;
  const T = R.UNIT_TYPES[u.type];
  const near = (p) => Math.min(...foes.map((f) => R.cheb(p, f)));
  const before = near(u), after = near(cell);
  const late = g.round >= 8; // затянувшийся бой — все в атаку
  const ec = foes.find((f) => f.type === 'commander');
  const towardCmd = ec ? R.cheb(u, ec) - R.cheb(cell, ec) : 0;
  const lethal = Math.max(0, danger(g, side, cell) - u.hp + 1); // >0 — клетка смертельна
  if (u.type === 'commander') {
    const dB = danger(g, side, u), dA = danger(g, side, cell);
    // Остался один (или бой затянулся) — Командир сам идёт в бой каждый ход, а не отсиживается
    const alone = !g.units.some((o) => o.alive && o.side === side && o !== u && !R.UNIT_TYPES[o.type].static && !R.UNIT_TYPES[o.type].auto);
    if (alone || g.round >= 14) {
      let c = 3 + (before - after) * 2 + towardCmd - (dA - dB) - lethal * 3;
      if (foes.some((f) => canHitFrom(g, u, cell, f))) c += 10 + (R.canAct(g, u) ? 4 : 0);
      if (R.crateAt(g, cell.x, cell.y)) c += 6;
      return Math.max(1.5, c); // ход всегда лучше, чем простой
    }
    // Иначе держится в тылу и уходит от смертельной опасности
    let c = (dB - dA) * 2 - lethal * 4;
    if (foes.some((f) => canHitFrom(g, u, cell, f) && f.hp <= R.unitDmg(u))) c += 8;
    return c - 1;
  }
  let s = 0;
  const hitNow = foes.some((f) => canHitFrom(g, u, cell, f));
  if (hitNow) s += 10 + (R.canAct(g, u) ? 6 : 0);
  s += (before - after) * (T.range >= 3 ? 1.5 : 3); // стрелкам не обязательно лезть вплотную
  s += towardCmd * (level === 'hard' ? 2.5 : level === 'medium' ? 1.5 : 0.5); // давим на Командира
  if (R.crateAt(g, cell.x, cell.y)) s += 7;
  if (T.range >= 3 && after < T.minRange + 1) s -= 6; // снайпер не любит ближний бой
  if (level !== 'easy' && !late) s -= lethal * 3; // не умирать зря (пока бой не затянулся)
  if (R.rammable(g, u, cell.x, cell.y)) s += 4; // слоник любит таранить
  return s;
}

// Все допустимые действия стороны с оценкой
function candidates(g, side, level) {
  const out = [];
  for (const u of g.units) {
    if (!u.alive || u.side !== side || !R.canUseUnit(g, u)) continue;
    if (R.canShoot(g, u)) {
      for (const t of R.targets(g, u, 'normal')) {
        if (R.isHidden(g, t)) continue;
        const info = R.attackInfo(g, u, t, 'normal');
        out.push({ a: { type: 'attack', unitId: u.id, targetId: t.id }, s: scoreAttack(g, u, t, info, level) });
      }
      if (u.item && u.item.type === 'shotgun') {
        for (const t of R.targets(g, u, 'shotgun')) {
          if (R.isHidden(g, t)) continue;
          const info = R.attackInfo(g, u, t, 'shotgun');
          out.push({ a: { type: 'shotgun', unitId: u.id, targetId: t.id }, s: scoreAttack(g, u, t, info, level) + 4 });
        }
      }
    }
    for (const c of R.abilityTargets(g, u)) {
      if (level === 'easy' && rnd() < 0.4) continue;
      const s = scoreAbility(g, u, c, side, level);
      if (s > 0) out.push({ a: { type: 'ability', unitId: u.id, x: c.x, y: c.y }, s });
    }
    if (u.item && u.item.type === 'landmine' && R.canAct(g, u)) {
      const c = R.mineCells(g, u)[0];
      if (c && visibleFoes(g, side).some((f) => R.cheb(f, c) <= 3)) out.push({ a: { type: 'mine', unitId: u.id, x: c.x, y: c.y }, s: 5 });
    }
    if (R.canMove(g, u)) {
      for (const c of R.moveCells(g, u)) {
        const s = scoreMove(g, u, c, side, level);
        if (s > 0) out.push({ a: { type: 'move', unitId: u.id, x: c.x, y: c.y }, s });
      }
    }
  }
  return out;
}

// Лучшее действие (или конец хода), исключая уже отклонённые сервером
function chooseAction(g, side, level, banned) {
  const noise = NOISE[level] != null ? NOISE[level] : 5;
  let best = null;
  for (const c of candidates(g, side, level)) {
    const key = JSON.stringify(c.a);
    if (banned && banned.has(key)) continue;
    const s = c.s + rnd() * noise;
    if (!best || s > best.s) best = { s, a: c.a };
  }
  return best && best.s > 1 ? best.a : { type: 'endTurn' };
}

module.exports = { chooseAction };
