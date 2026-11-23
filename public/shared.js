/* Tactical Loot Chess — общие правила (используются и сервером, и клиентом).
 * Сервер — единственный источник истины; клиент использует эти функции
 * только для подсветки доступных ходов и превью урона. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TLC = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const N = 8;
  const TURN_SECONDS = 60;

  // cost — стоимость в очках отряда; price — цена открытия в магазине (0 — доступен сразу)
  // role — роль юнита (показывается значком): dmg урон, tank танк, support поддержка, scout разведка,
  //        control контроль, summon призыв, special специалист
  const UNIT_TYPES = {
    commander: { name: 'Командир', role: 'special', hp: 10, move: 2, dmg: 2, range: 2, minRange: 1, cost: 0, price: 0,
      desc: 'Лидер отряда. Если Командир погибает — команда проигрывает.' },
    assault: { name: 'Штурмовик', role: 'dmg', hp: 6, move: 3, dmg: 2, range: 2, minRange: 1, cost: 2, price: 0,
      desc: 'Крепкий боец передовой линии.' },
    sniper: { name: 'Снайпер', role: 'dmg', hp: 4, move: 2, dmg: 3, range: 4, minRange: 2, cost: 3, price: 0,
      desc: 'Не стреляет вплотную (1 клетка). Не может двигаться и стрелять в один ход.' },
    scout: { name: 'Разведчик', role: 'scout', hp: 5, move: 4, dmg: 2, range: 1, minRange: 1, cost: 2, price: 0,
      desc: 'Самый быстрый юнит. Идеален для сбора ящиков с лутом.' },
    skeleton: { name: 'Скелет', role: 'dmg', hp: 3, move: 3, dmg: 1, range: 1, minRange: 1, cost: 1, price: 150,
      desc: 'Дешёвый боец за 1 очко: им удобно добить бюджет отряда, закрыть клетку или отвлечь врага.' },
    medic: { name: 'Медик', role: 'support', hp: 5, move: 3, dmg: 1, range: 1, minRange: 1, cost: 2, price: 300, ability: 'heal',
      desc: 'Способность (Действие): лечит союзника рядом на 2 HP и снимает 1 стак яда.' },
    drone: { name: 'Дрон', role: 'scout', hp: 3, move: 4, dmg: 1, range: 2, minRange: 1, cost: 2, price: 300, fly: true, ability: 'detonate',
      desc: 'Летает над стенами (но не может на них остановиться). Способность (Действие): самоподрыв — 3 урона всем врагам вокруг, дрон погибает.' },
    shieldbearer: { name: 'Щитоносец', role: 'tank', hp: 7, move: 2, dmg: 2, range: 1, minRange: 1, cost: 2, price: 350, aura: true,
      desc: 'Союзники вокруг него (8 клеток) получают на 1 урона меньше (но не меньше 1).' },
    signaller: { name: 'Связист', role: 'support', hp: 4, move: 2, dmg: 1, range: 2, minRange: 1, cost: 2, price: 350, ability: 'boost',
      desc: 'Способность (Действие): союзник в радиусе 2, ещё не ходивший, получает +2 к движению в этот ход.' },
    defender: { name: 'Защитник', role: 'tank', hp: 6, move: 2, dmg: 1, range: 1, minRange: 1, cost: 2, price: 400, ability: 'barrier',
      desc: 'Способность (Действие): ставит рядом Преграду (4 HP) — сквозь неё нельзя ни пройти, ни выстрелить (гранаты летят навесом). Не больше 2 преград, перезарядка 2 хода.' },
    grenadier: { name: 'Гренадёр', role: 'dmg', hp: 5, move: 2, dmg: 2, range: 3, minRange: 2, cost: 3, price: 500, lob: true,
      desc: 'Граната летит навесом — стены и преграды не мешают. +1 урона врагам рядом с целью (своих не задевает).' },
    heavy: { name: 'Тяжёлый пехотинец', role: 'tank', hp: 9, move: 1, dmg: 3, range: 1, minRange: 1, cost: 3, price: 500, knockback: true,
      desc: 'Очень живучий, но медленный. Мощный удар отбрасывает цель на клетку.' },
    engineer: { name: 'Инженер', role: 'support', hp: 4, move: 2, dmg: 2, range: 2, minRange: 1, cost: 3, price: 600, ability: 'turret',
      desc: 'Способность (Действие): ставит турель рядом (одна на инженера). Турель сама стреляет в конце вашего хода.' },
    sapper: { name: 'Сапёр', role: 'control', hp: 5, move: 3, dmg: 2, range: 2, minRange: 1, cost: 2, price: 450, ability: 'mines', mineSight: 2,
      desc: 'Видит вражеские мины в радиусе 2 (их видит вся команда) и обезвреживает их, наступив. Способность (Действие): ставит 2 мины рядом, перезарядка 2 хода. Мины из ящиков у него — с двойным запасом.' },
    saboteur: { name: 'Диверсант', role: 'dmg', hp: 4, move: 3, dmg: 3, range: 1, minRange: 1, cost: 3, price: 600, stealth: true, backstab: true,
      desc: 'Невидим для врага, пока не атакует или не окажется вплотную к вражескому юниту. Удар в спину (с любой из 3 клеток позади цели) убивает мгновенно, а Командиру наносит двойной урон (не больше 6). Спасает только Энергощит.' },
    tracker: { name: 'Следопыт', role: 'scout', hp: 5, move: 3, dmg: 2, range: 2, minRange: 1, cost: 2, price: 400, detect: 2,
      desc: 'Чует скрытых врагов: Диверсанты в радиусе 2 клеток от него становятся видны всем. Удар в спину на нём не срабатывает.' },
    necromancer: { name: 'Некромант', role: 'summon', hp: 5, move: 2, dmg: 2, range: 2, minRange: 1, cost: 3, price: 600, ability: 'raise', maxInSquad: 1,
      desc: 'Способность (Действие): поднимает зомби на соседних клетках (перезарядка 5 ходов; у команды не больше 3 зомби одновременно). Если Некромант погибает — его зомби рассыпаются. В отряде — только один.' },
    zombie: { name: 'Зомби', role: 'summon', hp: 2, move: 2, dmg: 1, range: 1, minRange: 1, cost: 0, price: 0, noShop: true, summon: true, auto: true,
      desc: 'Поднят Некромантом. Ходит сам: в конце вашего хода идёт к ближайшему видимому врагу и бьёт, если оказался рядом. Не тратит ваши активации. Живёт 3 хода, ящики не подбирает, рассыпается вместе с Некромантом.' },
    paramedic: { name: 'Парамедик', role: 'support', hp: 5, move: 3, dmg: 1, range: 1, minRange: 1, cost: 3, price: 550, ability: 'revive',
      desc: 'Способность (Действие): воскрешает союзника, погибшего не больше 3 раундов назад, если его надгробие в радиусе 2. Воскрешённый встаёт с половиной HP и ходит со следующего хода. Только 2 раза за игру. Командира воскресить нельзя.' },
    poisoner: { name: 'Дротист', role: 'control', hp: 4, move: 3, dmg: 1, range: 3, minRange: 1, cost: 3, price: 450, poisonOnHit: true,
      desc: 'Отравленный дротик: +1 стак яда (максимум 3) и срок 2 хода. В конце своего хода цель теряет по 1 HP за каждый стак (щит не спасает). Командир устойчив: не больше 1 урона от яда за ход. Каждое лечение Медика снимает 1 стак.' },
    // Особые юниты: в магазине их нет, выдаёт только администратор
    elephant: { name: 'Зелёный слоник', role: 'special', hp: 8, move: 3, dmg: 2, range: 2, minRange: 1, cost: 3, price: 0, special: true, ability: 'trumpet', knockback: true, trample: true,
      desc: 'Особый юнит — выдаёт только администратор. ТАРАН: ходит сквозь стены, ломая их, и сквозь врагов — враг на пути получает урон и отлетает (если некуда — +1 урона, и слоник останавливается). Атака отбрасывает цель. Способность: трубный рёв — враги вокруг получают 1 урона и отлетают.' },
    icemage: { name: 'Ледяной маг', role: 'special', hp: 6, move: 2, dmg: 1, range: 3, minRange: 1, cost: 3, price: 0, special: true, ability: 'freeze', freezeOnHit: 1,
      desc: 'Особый юнит — выдаёт только администратор. Способность (Действие): ледяной залп — враг в радиусе 4 на линии огня получает 1 урона и не может двигаться 3 своих хода (стрелять может). Перезарядка — 3 хода. Обычная атака замораживает на 1 ход.' },
    turret: { name: 'Турель', role: 'summon', hp: 2, move: 0, dmg: 1, range: 3, minRange: 1, cost: 0, price: 0, static: true, noShop: true,
      desc: 'Стоит на месте. В конце хода своей команды стреляет по самому раненому врагу в радиусе 3.' },
    barrier: { name: 'Преграда', role: 'summon', hp: 4, move: 0, dmg: 0, range: 0, minRange: 1, cost: 0, price: 0, static: true, noShop: true, blocksLOS: true,
      desc: 'Поставлена Защитником. Сквозь неё нельзя пройти и выстрелить (кроме гранат). Её можно разрушить: 4 HP.' },
  };
  const ROLES = {
    dmg: { name: 'Урон', icon: '⚔', color: '#f87171' },
    tank: { name: 'Танк', icon: '🛡', color: '#60a5fa' },
    support: { name: 'Поддержка', icon: '✚', color: '#4ade80' },
    scout: { name: 'Разведка', icon: '👁', color: '#22d3ee' },
    control: { name: 'Контроль', icon: '⌛', color: '#c084fc' },
    summon: { name: 'Призыв', icon: '💀', color: '#a78bfa' },
    special: { name: 'Особый', icon: '★', color: '#facc15' },
  };
  const SQUAD_SAME_MAX = 2; // одинаковых юнитов в отряде — не больше 2 (некоторых — 1)

  // ---- Кампания против ИИ: 10 уровней + секретный 11-й. Игрок воюет своим отрядом.
  // enemy — отряд ИИ (без Командира), cmdHp — здоровье вражеского Командира, ai — сложность,
  // mines — заранее спрятанные мины ИИ, reward — монеты за первое прохождение (с аккаунтом)
  const CAMPAIGN = [
    { name: 'Учебная тревога', desc: 'Пара разведчиков проверяет оборону. Разомнись.', enemy: ['scout', 'scout'], cmdHp: 6, ai: 'easy', reward: 100 },
    { name: 'Первая кровь', desc: 'Небольшой отряд с дешёвым скелетом в прикрытии.', enemy: ['assault', 'scout', 'skeleton'], cmdHp: 8, ai: 'easy', reward: 200 },
    { name: 'Снайперская аллея', desc: 'Два снайпера держат дальнюю линию. Используй укрытия.', enemy: ['sniper', 'sniper', 'assault'], cmdHp: 10, ai: 'medium', reward: 300 },
    { name: 'Мёртвые встают', desc: 'Некромант и его скелеты. Убей Некроманта — зомби рассыплются.', enemy: ['necromancer', 'skeleton', 'skeleton', 'poisoner', 'grenadier'], cmdHp: 12, ai: 'hard', reward: 400 },
    { name: 'Полевой госпиталь', desc: 'Медик лечит, Щитоносец прикрывает. Бей лекаря первым.', enemy: ['medic', 'assault', 'assault', 'shieldbearer'], cmdHp: 10, ai: 'medium', reward: 500 },
    { name: 'Тени', desc: 'Диверсанты невидимы, пока не ударят. Следи за тылом.', enemy: ['saboteur', 'saboteur', 'tracker', 'poisoner', 'skeleton'], cmdHp: 12, ai: 'hard', reward: 600 },
    { name: 'Крепость', desc: 'Защитники строят преграды, турели простреливают подходы. Гранаты летят через преграды.', enemy: ['defender', 'defender', 'engineer', 'sniper', 'heavy'], cmdHp: 12, ai: 'hard', reward: 700 },
    { name: 'Яд и сталь', desc: 'Дротисты травят, тяжёлая пехота давит. Береги Медика.', enemy: ['poisoner', 'poisoner', 'medic', 'grenadier', 'heavy'], cmdHp: 12, ai: 'hard', reward: 800 },
    { name: 'Минное поле', desc: 'В центре спрятаны мины, Сапёр ставит новые. Свой Сапёр их увидит.', enemy: ['sapper', 'grenadier', 'assault', 'sniper'], cmdHp: 12, ai: 'hard', reward: 900,
      mines: [[1, 3], [4, 3], [6, 4], [3, 4], [2, 4]] },
    { name: 'Генерал', desc: 'Элитный отряд и закалённый Командир. Финал основной кампании.', enemy: ['heavy', 'sniper', 'sniper', 'grenadier', 'paramedic'], cmdHp: 14, ai: 'hard', reward: 1000 },
    { name: 'Враги админа', desc: 'Секретный уровень. Против тебя — личная гвардия админа: Зелёный слоник и Ледяной маг.', secret: true,
      enemy: ['elephant', 'icemage', 'necromancer', 'heavy', 'sniper'], cmdHp: 15, ai: 'hard', reward: 2000 },
  ];
  const AI_LEVELS = { easy: 'Лёгкий', medium: 'Средний', hard: 'Сложный' };
  // Вид снаряда у каждого юнита (влияет только на анимацию и звук)
  const SHOT_KIND = {
    commander: 'bolt', assault: 'burst', sniper: 'sniper', scout: 'dart', medic: 'syringe', grenadier: 'grenade',
    heavy: 'punch', engineer: 'laser', saboteur: 'knife', drone: 'laser', shieldbearer: 'shield', signaller: 'wave',
    elephant: 'bone', turret: 'laser', tracker: 'scan', icemage: 'ice',
    necromancer: 'skull', zombie: 'claw', paramedic: 'syringe', poisoner: 'poison',
    skeleton: 'bone', defender: 'shield', sapper: 'laser', barrier: 'laser',
  };
  const BARRIER = { max: 2, cooldown: 2 }; // Защитник
  const MINES = { count: 2, cooldown: 2, dmg: 3 }; // Сапёр
  const DETONATE = { dmg: 3 }; // Дрон
  const FREEZE = { range: 4, turns: 3, cooldown: 3 };
  const RAISE = { count: 3, max: 3, cooldown: 5, life: 3 }; // Некромант; зомби живут 3 хода
  const REVIVE = { uses: 2, rounds: 3, radius: 2 }; // Парамедик
  const POISON = { turns: 2, dmg: 1, maxStacks: 3, commanderCap: 1 }; // Дротист: стаки яда
  // Можно ли воскресить павшего юнита (для Парамедика и надгробий)
  // Есть ли у команды живой Парамедик с неизрасходованными воскрешениями (иначе надгробий нет)
  function hasReviver(g, side) {
    return g.units.some((p) => p.alive && p.side === side && UNIT_TYPES[p.type].ability === 'revive' && (p.reviveUses || 0) < REVIVE.uses);
  }
  function revivable(g, d) {
    if (!d || d.alive || d.diedRound == null) return false;
    const T = UNIT_TYPES[d.type];
    if (!T || d.type === 'commander' || T.static || T.summon) return false;
    return g.round - d.diedRound <= REVIVE.rounds;
  }
  const BASIC_UNITS = ['assault', 'sniper', 'scout'];
  const SHOP_UNITS = Object.keys(UNIT_TYPES).filter((k) => UNIT_TYPES[k].price > 0);
  const SPECIAL_UNITS = Object.keys(UNIT_TYPES).filter((k) => UNIT_TYPES[k].special);
  const SQUAD_BUDGET = 12;
  const SQUAD_MAX = 5; // без Командира
  const DEFAULT_SQUAD = ['sniper', 'assault', 'scout', 'assault', 'sniper'];
  const HEAL_AMOUNT = 2;
  const BOOST_AMOUNT = 2;
  // Проверка отряда: только открытые юниты, бюджет очков, не больше 5 бойцов
  function squadError(squad, unlocked) {
    if (!Array.isArray(squad)) return 'Неверный отряд';
    if (squad.length < 1) return 'Нужен хотя бы один боец кроме Командира';
    if (squad.length > SQUAD_MAX) return `Не больше ${SQUAD_MAX} бойцов`;
    let cost = 0;
    const count = {};
    for (const t of squad) {
      const T = UNIT_TYPES[t];
      if (!T || T.noShop || t === 'commander') return 'Неизвестный юнит';
      if (!BASIC_UNITS.includes(t) && !(unlocked || []).includes(t)) return `${T.name} ещё не открыт`;
      cost += T.cost;
      count[t] = (count[t] || 0) + 1;
      const lim = T.maxInSquad || SQUAD_SAME_MAX;
      if (count[t] > lim) return lim === 1 ? `${T.name} — не больше одного в отряде` : `${T.name} — не больше ${lim} в отряде`;
    }
    if (cost > SQUAD_BUDGET) return `Превышен бюджет: ${cost}/${SQUAD_BUDGET}`;
    return null;
  }
  const squadCost = (squad) => (squad || []).reduce((a, t) => a + ((UNIT_TYPES[t] && UNIT_TYPES[t].cost) || 0), 0);

  // ---- Редкость лута
  const RARITIES = [
    { key: 'common', m: 'Обычный', f: 'Обычная', color: '#cbd5e1', weight: 55 },
    { key: 'rare', m: 'Редкий', f: 'Редкая', color: '#38bdf8', weight: 28 },
    { key: 'epic', m: 'Эпический', f: 'Эпическая', color: '#c084fc', weight: 12 },
    { key: 'legendary', m: 'Легендарный', f: 'Легендарная', color: '#f59e0b', weight: 4 },
    { key: 'mythic', m: 'Мифический', f: 'Мифическая', color: '#f43f5e', weight: 1 },
  ];
  const MAX_LUCK = 10;

  const ITEMS = {
    shotgun: { name: 'Дробовик', g: 'm', active: true, weight: 1 },
    shield: { name: 'Энергощит', g: 'm', active: false, weight: 1 },
    jetpack: { name: 'Джетпак', g: 'm', active: true, weight: 1 },
    medkit: { name: 'Нано-аптечка', g: 'f', active: false, instant: true, weight: 1 },
    landmine: { name: 'Мина', g: 'f', active: true, weight: 1 },
    luck: { name: 'Клевер удачи', g: 'm', active: false, instant: true, weight: 2 },
    // Ингибиторы: действуют мгновенно и до конца матча, усиливают юнита, который их подобрал
    inh_dmg: { name: 'Ингибитор ярости', g: 'm', active: false, instant: true, inhibitor: 'dmg', weight: 1 },
    inh_range: { name: 'Ингибитор прицела', g: 'm', active: false, instant: true, inhibitor: 'range', weight: 1 },
    inh_move: { name: 'Ингибитор скорости', g: 'm', active: false, instant: true, inhibitor: 'move', weight: 1 },
    inh_steady: { name: 'Ингибитор стабилизации', g: 'm', active: false, instant: true, inhibitor: 'steady', weight: 1.5, sniperOnly: true },
  };
  // Потолок усиления одного юнита ингибиторами
  const BUFF_CAP = { dmg: 4, range: 3, move: 3 };
  const ITEM_KEYS = Object.keys(ITEMS);

  // Характеристики предметов по уровню редкости (0 — Обычный … 4 — Мифический)
  const ITEM_STATS = {
    shotgun: { dmg: [4, 5, 6, 6, 8], splash: [2, 2, 2, 3, 4], charges: [1, 1, 1, 2, 2] },
    shield: { charges: [1, 2, 2, 3, 3], heal: [0, 0, 1, 1, 2] },
    jetpack: { range: [4, 5, 5, 6, 8], charges: [1, 1, 2, 2, 3] },
    medkit: { heal: [3, 4, 5, 7, 99], maxHp: [0, 0, 0, 1, 2] },
    landmine: { dmg: [3, 4, 5, 6, 7], charges: [1, 1, 2, 2, 3] },
    luck: { luck: [2, 3, 4, 6, 8], turns: [2, 3, 3, 4, 5] },
    inh_dmg: { amount: [1, 1, 2, 2, 3] },
    inh_range: { amount: [1, 1, 1, 2, 2] },
    inh_move: { amount: [1, 1, 2, 2, 3] },
    inh_steady: { amount: [0, 0, 1, 1, 2] }, // бонус к дальности для редких
  };
  function itemStat(type, tier, stat) {
    const t = ITEM_STATS[type] && ITEM_STATS[type][stat];
    return t ? t[Math.max(0, Math.min(4, tier || 0))] : 0;
  }
  function rarityName(type, tier) {
    const r = RARITIES[tier || 0];
    return ITEMS[type].g === 'f' ? r.f : r.m;
  }
  function itemFullName(it) {
    return `${ITEMS[it.type].name} [${rarityName(it.type, it.tier)}]`;
  }
  function itemDesc(it) {
    const st = (k) => itemStat(it.type, it.tier, k);
    const ch = it.charges != null ? it.charges : st('charges');
    const z = (n) => `${n} ${n === 1 ? 'заряд' : n < 5 ? 'заряда' : 'зарядов'}`;
    switch (it.type) {
      case 'shotgun': return `${z(ch)}. Выстрел в упор (1–2 кл.): ${st('dmg')} урона цели, ${st('splash')} урона соседним клеткам и отталкивание. Тратит Действие.`;
      case 'shield': return `Пассивно. Полностью поглощает ${ch === 1 ? 'следующее попадание' : `следующие ${ch} попадания`}${st('heal') ? `; каждый блок лечит +${st('heal')} HP` : ''}.`;
      case 'jetpack': return `${z(ch)}. Прыжок на свободную клетку в радиусе ${st('range')} (сквозь стены и юнитов). Тратит Движение.`;
      case 'medkit': return `Мгновенно: ${st('heal') >= 99 ? 'полное лечение' : `+${st('heal')} HP`}${st('maxHp') ? `, +${st('maxHp')} к макс. HP` : ''}, снятие дебаффов.`;
      case 'landmine': return `${z(ch)}. Скрытая мина на соседнюю клетку: ${st('dmg')} урона врагу, остановка и контузия. Тратит Действие.`;
      case 'inh_dmg': return `Мгновенно и до конца матча: +${st('amount')} к урону атак этого юнита.`;
      case 'inh_range': return `Мгновенно и до конца матча: +${st('amount')} к дальности атак этого юнита.`;
      case 'inh_move': return `Мгновенно и до конца матча: +${st('amount')} к дальности движения этого юнита.`;
      case 'inh_steady': return `Только для Снайпера. До конца матча может двигаться и стрелять в один ход${st('amount') ? `, +${st('amount')} к дальности` : ''}.`;
      case 'luck': return `Мгновенно: удача команды +${st('luck')} на ${st('turns')} ${st('turns') < 5 ? 'хода' : 'ходов'} (включая текущий). Удача повышает шанс редкого лута и двойного дропа. Пока клевер действует, новый клевер команде не выпадает.`;
      default: return '';
    }
  }

  // ---- Прогресс матча: чем дольше бой, тем больше лута
  function lootLevel(round) { return 1 + Math.min(4, Math.floor((round - 1) / 5)); }
  function cratesPerDrop(round) { return Math.min(4, 1 + lootLevel(round)); }
  function maxCrates(round) { return Math.min(7, 3 + lootLevel(round)); }
  function dropInterval(round) { return round >= 11 ? 1 : 2; }
  // Шансы редкости: удача команды и прогресс матча смещают вес к редким уровням
  function rarityWeights(luck, round) {
    const bonus = (luck || 0) * 0.3 + (lootLevel(round) - 1) * 0.15;
    return RARITIES.map((r, i) => r.weight * Math.pow(1 + bonus, i));
  }
  function rarityChances(luck, round) {
    const w = rarityWeights(luck, round);
    const tot = w.reduce((a, b) => a + b, 0);
    return w.map((x) => x / tot);
  }
  function doubleDropChance(luck, round) {
    return Math.min(0.45, 0.1 + (luck || 0) * 0.03 + (lootLevel(round) - 1) * 0.04);
  }

  const SHOTGUN = { minRange: 1, range: 2 };
  const MEDKIT_HEAL = 3;

  const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIR8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  const key = (x, y) => y * N + x;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
  const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const manh = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const other = (s) => (s === 'blue' ? 'red' : 'blue');

  function isWall(g, x, y) {
    for (const w of g.walls) if (w.x === x && w.y === y) return true;
    return false;
  }
  function unitAt(g, x, y) {
    for (const u of g.units) if (u.alive && u.x === x && u.y === y) return u;
    return null;
  }
  function crateAt(g, x, y) {
    for (const c of g.crates) if (c.x === x && c.y === y) return c;
    return null;
  }

  // Алгоритм Брезенхэма: список клеток от (x0,y0) до (x1,y1) включительно
  function bresenham(x0, y0, x1, y1) {
    const pts = [];
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      pts.push([x0, y0]);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return pts;
  }
  function lineClear(g, pts) {
    for (let i = 1; i < pts.length - 1; i++) {
      if (isWall(g, pts[i][0], pts[i][1])) return false;
      const b = unitAt(g, pts[i][0], pts[i][1]);
      if (b && UNIT_TYPES[b.type].blocksLOS) return false; // Преграда Защитника
    }
    return true;
  }
  // Симметричная проверка линии видимости (стены блокируют, юниты — нет)
  function hasLOS(g, a, b) {
    return lineClear(g, bresenham(a.x, a.y, b.x, b.y)) || lineClear(g, bresenham(b.x, b.y, a.x, a.y));
  }

  // ---- Правила хода: до 2 разных юнитов за ход, у каждого 1 Движение + 1 Действие
  function canUseUnit(g, u) {
    if (UNIT_TYPES[u.type].static || UNIT_TYPES[u.type].auto) return false; // турели и зомби действуют сами
    return g.activated.includes(u.id) || g.activated.length < 2;
  }
  // Диверсант скрыт, пока не атаковал недавно и рядом нет врагов
  function isHidden(g, u) {
    if (!u.alive || !UNIT_TYPES[u.type].stealth) return false;
    if (u.revealUntil != null && g.turnNo <= u.revealUntil) return false;
    // раскрывает любой враг вплотную или Следопыт в радиусе своего чутья
    return !g.units.some((o) => o.alive && o.side !== u.side && cheb(o, u) <= Math.max(1, UNIT_TYPES[o.type].detect || 0));
  }
  function canMove(g, u) {
    return !!u && u.alive && u.side === g.turn && !u.moved && !(u.frozen > 0) &&
      !(sniperLocked(u) && u.attacked) && canUseUnit(g, u);
  }
  function canAct(g, u) {
    return !!u && u.alive && u.side === g.turn && !u.acted && canUseUnit(g, u);
  }
  function canShoot(g, u) {
    return canAct(g, u) && !(sniperLocked(u) && u.moved);
  }
  const buff = (u, k) => (u.buffs && u.buffs[k]) || 0;
  // Итоговые характеристики юнита с учётом ингибиторов
  function unitDmg(u) { return UNIT_TYPES[u.type].dmg + buff(u, 'dmg'); }
  function unitRange(u) { return UNIT_TYPES[u.type].range + buff(u, 'range'); }
  // Снайпер не может двигаться и стрелять в один ход, если нет Ингибитора стабилизации
  const sniperLocked = (u) => u.type === 'sniper' && !buff(u, 'steady');
  function moveRange(u) {
    if (UNIT_TYPES[u.type].static) return 0;
    const r = UNIT_TYPES[u.type].move + buff(u, 'move') - (u.slowed ? 1 : 0) + (u.boost || 0);
    // после прыжка на джетпаке можно пройти ещё, но на 1 клетку меньше
    return u.jetted ? Math.max(0, r - 1) : Math.max(1, r);
  }
  // Прыжок на джетпаке: только до обычного движения и один раз за ход
  function canJet(g, u) {
    return canMove(g, u) && !u.jetted && !!u.item && u.item.type === 'jetpack';
  }
  // «Спина» юнита — сторона его базы: у Синих снизу (y больше), у Красных сверху
  function isBehind(attacker, target) {
    const dir = target.side === 'blue' ? 1 : -1;
    return (attacker.y - target.y) * dir > 0;
  }

  // Таран (Зелёный слоник): путь сквозь стены и врагов, но не сквозь своих.
  // Препятствие стоит чуть дороже свободной клетки — при равной длине слоник идёт в обход.
  function trampleReachable(g, u) {
    const range = moveRange(u);
    const start = key(u.x, u.y);
    const cost = new Map([[start, 0]]);
    const steps = new Map([[start, 0]]);
    const prev = new Map([[start, -1]]);
    const open = [start];
    while (open.length) {
      open.sort((a, b) => cost.get(a) - cost.get(b));
      const k = open.shift();
      const x = k % N, y = Math.floor(k / N);
      const st = steps.get(k);
      if (st >= range) continue;
      for (const [dx, dy] of DIR4) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const o = unitAt(g, nx, ny);
        if (o && o.side === u.side) continue;
        const nk = key(nx, ny);
        const c = cost.get(k) + 1 + ((o || isWall(g, nx, ny)) ? 0.01 : 0);
        if (cost.has(nk) && cost.get(nk) <= c) continue;
        cost.set(nk, c); steps.set(nk, st + 1); prev.set(nk, k);
        open.push(nk);
      }
    }
    return prev;
  }
  // Клетка на пути тарана, где слоник что-то ломает или кого-то таранит
  function rammable(g, u, x, y) {
    if (!UNIT_TYPES[u.type].trample) return false;
    const o = unitAt(g, x, y);
    return isWall(g, x, y) || !!(o && o.side !== u.side);
  }

  // BFS по 4 направлениям. Возвращает Map(key -> prevKey)
  function reachable(g, u) {
    if (UNIT_TYPES[u.type].trample) return trampleReachable(g, u);
    const range = moveRange(u);
    const fly = !!UNIT_TYPES[u.type].fly;
    const start = key(u.x, u.y);
    const dist = new Map([[start, 0]]);
    const prev = new Map([[start, -1]]);
    const q = [[u.x, u.y]];
    while (q.length) {
      const [x, y] = q.shift();
      const d = dist.get(key(x, y));
      if (d >= range) continue;
      for (const [dx, dy] of DIR4) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const k = key(nx, ny);
        if (dist.has(k) || (!fly && isWall(g, nx, ny)) || unitAt(g, nx, ny)) continue;
        dist.set(k, d + 1);
        prev.set(k, key(x, y));
        q.push([nx, ny]);
      }
    }
    return prev;
  }
  // Клетки, где юнит может закончить движение (дрон не может стоять на стене)
  function moveCells(g, u) {
    const out = [];
    const tr = !!UNIT_TYPES[u.type].trample;
    for (const k of reachable(g, u).keys()) {
      const x = k % N, y = Math.floor(k / N);
      if ((x === u.x && y === u.y) || (!tr && isWall(g, x, y))) continue;
      out.push({ x, y });
    }
    return out;
  }
  function pathTo(prev, x, y) {
    let k = key(x, y);
    if (!prev.has(k)) return null;
    const p = [];
    while (k !== -1) { p.push([k % N, Math.floor(k / N)]); k = prev.get(k); }
    return p.reverse();
  }

  function attackInfo(g, u, t, mode) {
    if (!u || !t || !t.alive) return { ok: false, reason: 'Нет цели' };
    if (t.side === u.side) return { ok: false, reason: 'Это союзник' };
    if (!canAct(g, u)) return { ok: false, reason: 'Действие уже потрачено' };
    if (sniperLocked(u) && u.moved) return { ok: false, reason: 'Снайпер уже двигался' };
    let min, max, dmg;
    if (mode === 'shotgun') {
      if (!u.item || u.item.type !== 'shotgun') return { ok: false, reason: 'Нет дробовика' };
      min = SHOTGUN.minRange; max = SHOTGUN.range; dmg = itemStat('shotgun', u.item.tier, 'dmg');
    } else {
      const T = UNIT_TYPES[u.type];
      min = T.minRange; max = unitRange(u); dmg = unitDmg(u);
    }
    const d = cheb(u, t);
    if (d < min) return { ok: false, reason: 'Слишком близко' };
    if (d > max) return { ok: false, reason: 'Вне дальности' };
    if (!(mode !== 'shotgun' && UNIT_TYPES[u.type].lob) && !hasLOS(g, u, t)) return { ok: false, reason: 'Нет линии огня' };
    if (mode !== 'shotgun' && UNIT_TYPES[u.type].backstab && !UNIT_TYPES[t.type].detect && isBehind(u, t)) {
      // Командира удар в спину не убивает мгновенно: двойной урон, но не больше 6 (у Командира 10 HP)
      return { ok: true, dmg: t.type === 'commander' ? Math.min(dmg * 2, 6) : Math.max(dmg, t.hp), backstab: true };
    }
    return { ok: true, dmg };
  }
  function targets(g, u, mode) {
    return g.units.filter((t) => t.alive && t.side !== u.side && attackInfo(g, u, t, mode).ok);
  }
  function jetpackCells(g, u) {
    const out = [];
    const range = u.item && u.item.type === 'jetpack' ? itemStat('jetpack', u.item.tier, 'range') : 4;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const d = manh(u, { x, y });
      if (d === 0 || d > range) continue;
      if (isWall(g, x, y) || unitAt(g, x, y)) continue;
      out.push({ x, y });
    }
    return out;
  }
  // Клетки для установки мины (видимые мины своей стороны блокируют клетку)
  function mineCells(g, u) {
    const out = [];
    for (const [dx, dy] of DIR8) {
      const x = u.x + dx, y = u.y + dy;
      if (!inBounds(x, y) || isWall(g, x, y) || unitAt(g, x, y) || crateAt(g, x, y)) continue;
      if (g.mines.some((m) => m.x === x && m.y === y && m.side === u.side)) continue;
      out.push({ x, y });
    }
    return out;
  }
  // Клетки/цели способностей: heal — раненый союзник рядом, turret — свободная клетка рядом, boost — союзник в радиусе 2
  function abilityTargets(g, u) {
    const ab = UNIT_TYPES[u.type].ability;
    if (ab === 'mines') {
      // Сапёр ставит 2 мины: первая тратит Действие, вторую можно поставить сразу следом
      const second = u.minesLeft > 0 && u.side === g.turn && u.alive;
      if (!second && (!canAct(g, u) || u.minesCd > 0)) return [];
      const out = [];
      for (const [dx, dy] of DIR8) {
        const x = u.x + dx, y = u.y + dy;
        if (!inBounds(x, y) || isWall(g, x, y) || unitAt(g, x, y) || crateAt(g, x, y)) continue;
        if (g.mines.some((m) => m.x === x && m.y === y)) continue;
        out.push({ x, y });
      }
      return out;
    }
    if (!ab || !canAct(g, u)) return [];
    if (ab === 'heal') {
      // лечит раненых и снимает яд (даже при полном HP)
      return g.units.filter((o) => o.alive && o !== u && o.side === u.side && !UNIT_TYPES[o.type].static &&
        cheb(o, u) <= 1 && (o.hp < o.maxHp || o.poisoned > 0)).map((o) => ({ x: o.x, y: o.y, id: o.id }));
    }
    if (ab === 'detonate') {
      // Дрон: самоподрыв, если рядом есть видимый враг
      return g.units.some((o) => o.alive && o.side !== u.side && !isHidden(g, o) && cheb(o, u) <= 1) ? [{ x: u.x, y: u.y, id: u.id }] : [];
    }
    if (ab === 'barrier') {
      if (u.barrierCd > 0) return [];
      if (g.units.filter((o) => o.alive && o.type === 'barrier' && o.owner === u.id).length >= BARRIER.max) return [];
      const out = [];
      for (const [dx, dy] of DIR8) {
        const x = u.x + dx, y = u.y + dy;
        if (inBounds(x, y) && !isWall(g, x, y) && !unitAt(g, x, y) && !crateAt(g, x, y)) out.push({ x, y });
      }
      return out;
    }
    if (ab === 'raise') {
      if (u.raiseCd > 0) return [];
      const alive = g.units.filter((o) => o.alive && o.type === 'zombie' && o.side === u.side).length;
      if (alive >= RAISE.max) return []; // у команды не больше 3 зомби одновременно
      const free = DIR8.some(([dx, dy]) => { const x = u.x + dx, y = u.y + dy; return inBounds(x, y) && !isWall(g, x, y) && !unitAt(g, x, y) && !crateAt(g, x, y); });
      return free ? [{ x: u.x, y: u.y, id: u.id }] : [];
    }
    if (ab === 'revive') {
      if ((u.reviveUses || 0) >= REVIVE.uses) return [];
      return g.units.filter((d) => d.side === u.side && revivable(g, d) && cheb(d, u) <= REVIVE.radius &&
        !unitAt(g, d.x, d.y) && !isWall(g, d.x, d.y)).map((d) => ({ x: d.x, y: d.y, id: d.id }));
    }
    if (ab === 'boost') {
      return g.units.filter((o) => o.alive && o !== u && o.side === u.side && !UNIT_TYPES[o.type].static &&
        cheb(o, u) <= 2 && !o.moved && !o.boost && !(o.frozen > 0)).map((o) => ({ x: o.x, y: o.y, id: o.id }));
    }
    if (ab === 'freeze') {
      if (u.freezeCd > 0) return [];
      return g.units.filter((o) => o.alive && o.side !== u.side && !UNIT_TYPES[o.type].static && !(o.frozen >= FREEZE.turns) &&
        !isHidden(g, o) && cheb(o, u) <= FREEZE.range && hasLOS(g, u, o)).map((o) => ({ x: o.x, y: o.y, id: o.id }));
    }
    if (ab === 'trumpet') {
      // применяется на себя, если рядом есть хотя бы один враг
      return g.units.some((o) => o.alive && o.side !== u.side && cheb(o, u) <= 1) ? [{ x: u.x, y: u.y, id: u.id }] : [];
    }
    if (ab === 'turret') {
      if (g.units.some((o) => o.alive && o.type === 'turret' && o.owner === u.id)) return [];
      const out = [];
      for (const [dx, dy] of DIR8) {
        const x = u.x + dx, y = u.y + dy;
        if (!inBounds(x, y) || isWall(g, x, y) || unitAt(g, x, y) || crateAt(g, x, y)) continue;
        out.push({ x, y });
      }
      return out;
    }
    return [];
  }
  function hasUsefulMove(g, u) {
    if (!canMove(g, u)) return false;
    if (u.item && u.item.type === 'jetpack' && jetpackCells(g, u).length) return true;
    return moveCells(g, u).length > 0;
  }
  function hasUsefulAct(g, u) {
    if (!canAct(g, u)) return false;
    if (abilityTargets(g, u).length) return true;
    if (u.item && u.item.type === 'landmine' && mineCells(g, u).length) return true;
    if (!canShoot(g, u)) return false;
    if (targets(g, u, 'normal').length) return true;
    if (u.item && u.item.type === 'shotgun' && targets(g, u, 'shotgun').length) return true;
    return false;
  }
  // Ход завершается автоматически, если ни один доступный юнит не может сделать ничего полезного
  function shouldAutoEnd(g) {
    const own = g.units.filter((u) => u.alive && u.side === g.turn && !UNIT_TYPES[u.type].static && !UNIT_TYPES[u.type].auto);
    const cands = g.activated.length >= 2 ? own.filter((u) => g.activated.includes(u.id)) : own;
    return cands.every((u) => !hasUsefulMove(g, u) && !hasUsefulAct(g, u));
  }

  return {
    N, TURN_SECONDS, UNIT_TYPES, ITEMS, ITEM_KEYS, SHOTGUN, MEDKIT_HEAL,
    RARITIES, MAX_LUCK, ITEM_STATS, itemStat, rarityName, itemFullName, itemDesc,
    lootLevel, cratesPerDrop, maxCrates, dropInterval, rarityWeights, rarityChances, doubleDropChance,
    DIR4, DIR8, key, inBounds, cheb, manh, other, isWall, unitAt, crateAt, bresenham, hasLOS,
    BUFF_CAP, rammable, unitDmg, unitRange, isBehind, sniperLocked,
    canUseUnit, canMove, canAct, canShoot, moveRange, reachable, moveCells, pathTo, attackInfo, targets,
    CAMPAIGN, AI_LEVELS, ROLES, SQUAD_SAME_MAX, BARRIER, MINES, DETONATE, canJet, SHOT_KIND, FREEZE, RAISE, REVIVE, POISON, revivable, hasReviver, BASIC_UNITS, SHOP_UNITS, SPECIAL_UNITS, SQUAD_BUDGET, SQUAD_MAX, DEFAULT_SQUAD, HEAL_AMOUNT, BOOST_AMOUNT,
    squadError, squadCost, isHidden, abilityTargets,
    jetpackCells, mineCells, hasUsefulMove, hasUsefulAct, shouldAutoEnd,
  };
});
