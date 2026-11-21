/* Tactical Loot Chess — клиент: сеть, рендер на Canvas, анимации, UI. */
(() => {
  'use strict';
  const R = window.TLC;
  const N = R.N;
  const $ = (id) => document.getElementById(id);
  const SIDE_GEN = { blue: 'СИНИХ', red: 'КРАСНЫХ' };
  const SIDE_RU = { blue: 'Синие', red: 'Красные' };
  const TEAM_COL = { blue: '#60a5fa', red: '#f87171' };

  Sprites.init();
  const socket = io();
  MenuBG.init($('menuBg'));
  if (window.innerWidth < 600) { const rd = document.querySelector('.rules'); if (rd) rd.removeAttribute('open'); }

  // ------------------------------------------------------------ идентичность (sessionStorage — переживает F5, своя у каждой вкладки)
  function rid() {
    if (window.crypto && crypto.getRandomValues) {
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  const store = {
    get(s, k) { try { return s.getItem(k); } catch (e) { return null; } },
    set(s, k, v) { try { s.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  let token = store.get(sessionStorage, 'tlc_token');
  if (!token) { token = rid(); store.set(sessionStorage, 'tlc_token', token); }
  let myName = store.get(localStorage, 'tlc_name') || ('Боец-' + Math.floor(1000 + Math.random() * 9000));

  // ------------------------------------------------------------ состояние клиента
  let lobby = null;
  let state = null;   // последнее авторитетное состояние
  let view = null;    // отображаемое (догоняет state через анимации событий)
  let gameId = null;
  let selectedId = null;
  let mode = 'normal'; // normal | shotgun | jetpack | mine
  let hover = null;
  let animating = false;
  let pending = false;
  let pendingTimer = null;
  const queue = [];
  let deadline = 0;
  let lastTickSec = -1;
  let overShownFor = null;
  let overHidden = false;
  let renderedLogKey = '';
  let flipped = false;
  let roomCode = normCode(new URLSearchParams(location.search).get('room'));
  let prevLobby = null;
  let screenNow = null;
  let countdownTimer = null;
  let countdownActive = false;
  let roomListTimer = null;

  // эффекты
  const anims = new Map();
  const flashes = new Map();
  const crateDrops = new Map();
  const projectiles = [];
  const booms = [];
  const particles = [];
  const floats = [];
  let shake = 0;

  // ------------------------------------------------------------ Canvas / HiDPI
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  let S = 4, C = 64, dpr = 1;

  function resize() {
    const wrap = $('boardWrap');
    const r = wrap.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const mb = $('movesBox');
    const reserve = mb ? mb.offsetHeight + 10 : 0;
    const avail = Math.max(128, Math.min(r.width, r.height - reserve) - 12);
    dpr = window.devicePixelRatio || 1;
    // целочисленный масштаб пикселя спрайта в физических пикселях → идеально резкие пиксели
    S = Math.max(1, Math.floor((avail * dpr) / (N * 16)));
    C = S * 16;
    const size = C * N;
    if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
    canvas.style.width = size / dpr + 'px';
    canvas.style.height = size / dpr + 'px';
    if (mb) mb.style.width = size / dpr + 'px';
    ctx.imageSmoothingEnabled = false;
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe($('boardWrap'));
  window.addEventListener('resize', resize);

  const fx = (v) => (flipped ? N - 1 - v : v); // разворот доски для Красных (свои внизу)
  const snap = (v) => Math.round(v / S) * S;

  // ------------------------------------------------------------ утилиты
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowMs = () => performance.now();
  const vUnit = (id) => (view ? view.units.find((u) => u.id === id) : null);
  const uName = (u) => R.UNIT_TYPES[u.type].name;

  function toast(text, cls) {
    const d = document.createElement('div');
    d.className = 'toast' + (cls ? ' ' + cls : '');
    d.textContent = text;
    $('toasts').appendChild(d);
    setTimeout(() => d.remove(), 2700);
  }
  function showBanner(text, cls) {
    const b = $('banner');
    b.textContent = text;
    b.className = 'banner';
    void b.offsetWidth;
    b.className = 'banner show ' + (cls || 'neutral');
  }

  function actingSide() {
    if (!view || !state || state.phase !== 'game' || view.winner) return null;
    if (view.you === 'both') return view.turn;
    return view.you === view.turn ? view.turn : null;
  }
  const canInput = () => !!actingSide() && !animating && !pending && !countdownActive;
  function selUnit() {
    if (!view || !selectedId) return null;
    return view.units.find((u) => u.id === selectedId && u.alive) || null;
  }

  // ------------------------------------------------------------ сеть
  function normCode(c) {
    const v = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    return v.length === 4 ? v : null;
  }
  function setRoomUrl(code) {
    const url = code ? `${location.pathname}?room=${code}` : location.pathname;
    if (location.pathname + location.search !== url) history.replaceState(null, '', url);
  }
  const inviteUrl = () => `${location.origin}${location.pathname}?room=${roomCode}`;

  socket.on('connect', () => {
    $('connState').classList.add('hidden');
    socket.emit('hello', { token, name: myName, code: roomCode, session });
  });
  socket.on('disconnect', () => $('connState').classList.remove('hidden'));
  socket.on('menu', () => goMenu());
  socket.on('roomGone', (code) => {
    toast(`Комната ${code} не найдена или уже закрыта`, 'err');
    goMenu();
  });
  socket.on('lobby', (l) => {
    const sameRoom = lobby && lobby.code === l.code;
    prevLobby = sameRoom ? lobby : null;
    lobby = l;
    roomCode = l.code;
    setRoomUrl(l.code);
    if (l.phase === 'lobby') resetClientGame();
    renderLobby();
    updateScreens();
  });
  function goMenu() {
    lobby = null; prevLobby = null; roomCode = null;
    setRoomUrl(null);
    resetClientGame();
    updateScreens();
    refreshRooms();
  }
  socket.on('state', (msg) => enqueue(msg));
  socket.on('errorMsg', (m) => {
    setPending(false);
    toast(m, 'err');
    Sound.error();
  });

  function resetClientGame() {
    state = null; view = null; gameId = null; queue.length = 0;
    selectedId = null; mode = 'normal'; overShownFor = null;
    anims.clear(); projectiles.length = 0; booms.length = 0; particles.length = 0; floats.length = 0;
    $('overlay').classList.add('hidden');
    stopCountdown();
    setPending(false);
    updateScreens();
  }
  function setPending(v) {
    pending = v;
    clearTimeout(pendingTimer);
    if (v) pendingTimer = setTimeout(() => { pending = false; renderHUD(); }, 3000);
    renderHUD();
  }
  function sendAction(a) {
    if (!canInput()) return;
    socket.emit('action', a);
    mode = 'normal';
    setPending(true);
  }

  // ------------------------------------------------------------ аккаунт, экономика, магазин, отряд
  let session = store.get(localStorage, 'tlc_session');
  let profile = null;
  let profileAt = 0;
  let modalKind = null;
  let draftSquad = null;
  const coinFmt = (n) => `${Math.floor(n).toLocaleString('ru-RU')} 💰`;
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function setProfile(p) {
    profile = p;
    profileAt = Date.now();
    if (p) { myName = p.name; }
    renderAccount();
    if (modalKind === 'shop') renderShop();
    if (modalKind === 'squad' && !draftSquad) renderSquad();
  }
  socket.on('profile', (p) => setProfile(p));
  socket.on('sessionExpired', () => {
    session = null;
    try { localStorage.removeItem('tlc_session'); } catch (e) { /* ignore */ }
    setProfile(null);
    toast('Сессия истекла — войдите снова', 'err');
  });

  function renderAccount() {
    const bar = $('accountBar'), eb = $('econBar');
    $('nameField').classList.toggle('hidden', !!profile);
    if (!profile) {
      bar.innerHTML = `<div class="acc-guest">Вы играете как гость — монеты, рудник и новые юниты доступны только с аккаунтом.</div>
        <div class="acc-btns"><button id="btnLogin" class="btn small primary">Войти</button><button id="btnRegister" class="btn small">Регистрация</button></div>`;
      $('btnLogin').onclick = () => openAuth('login');
      $('btnRegister').onclick = () => openAuth('register');
      eb.classList.add('hidden');
      return;
    }
    const st = profile.stats;
    bar.innerHTML = `<div class="acc-row"><span class="acc-name">👤 ${esc(profile.name)}</span><span id="coinBox" class="coins">${coinFmt(profile.coins)}</span>
        <span class="acc-stats">🏆 ${st.wins} · ✖ ${st.losses}${st.streak > 1 ? ` · 🔥 ${st.streak}` : ''}</span></div>
      <div class="acc-btns"><button id="btnShop" class="btn small primary">🛒 Магазин</button><button id="btnSquad" class="btn small primary">⚔ Отряд</button>${profile.admin ? '<button id="btnAdmin" class="btn small danger">🛠 Админ</button>' : ''}<button id="btnLogout" class="btn small">Выйти</button></div>`;
    $('btnShop').onclick = () => openModal('shop');
    if ($('btnAdmin')) $('btnAdmin').onclick = () => openModal('admin');
    $('btnSquad').onclick = () => openModal('squad');
    $('btnLogout').onclick = () => {
      if (!confirm('Выйти из аккаунта на этом устройстве?')) return;
      socket.emit('logout', session);
      session = null;
      try { localStorage.removeItem('tlc_session'); } catch (e) { /* ignore */ }
      setProfile(null);
    };
    eb.classList.remove('hidden');
    renderEcon();
  }

  function renderEcon() {
    if (!profile) return;
    const d = profile.daily, m = profile.mine;
    const rw = (i) => { const r = d.rewards[i]; return r === 'unit' ? 'юнит' : r + ' 💰'; };
    const daily = d.canClaim
      ? `<button id="btnDaily" class="btn small daily-btn">🎁 Забрать: день ${d.day} — ${rw(d.day - 1)}</button>`
      : `<span class="econ-dim">🎁 День ${d.day}/7 получен. Завтра: ${rw(d.day % 7)}</span>`;
    const left = Math.max(0, m.nextInMs - (Date.now() - profileAt));
    const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
    $('econBar').innerHTML = `<div class="econ-cell">${daily}</div>
      <div class="econ-cell mine-cell"><span>⛏ Рудник ур.${m.level}: <b>${m.stored}</b>/${m.cap} 💰 <span class="econ-dim">· +${m.rate}/ч${m.full ? ' · склад полон!' : ` · через ${mm}:${String(ss).padStart(2, '0')}`}</span></span>
        <button id="btnMine" class="btn small" ${m.stored > 0 ? '' : 'disabled'}>Собрать</button></div>`;
    const db = $('btnDaily');
    if (db) db.onclick = () => socket.emit('claimDaily', null, (r) => {
      if (r.error) return toast(r.error, 'err');
      Sound.legendary(false);
      toast(r.unit ? `🎁 День ${r.day}: открыт юнит «${R.UNIT_TYPES[r.unit].name}»!` : `🎁 День ${r.day}: +${r.coins} 💰`);
      setProfile(r.profile);
      bumpCoins();
    });
    $('btnMine').onclick = () => socket.emit('collectMine', null, (r) => {
      if (r.error) return toast(r.error, 'err');
      Sound.pickup(2);
      toast(`⛏ Собрано: +${r.amount} 💰`);
      setProfile(r.profile);
      bumpCoins();
    });
    if (left <= 0 && !m.full && Date.now() - profileAt > 2000) {
      profileAt = Date.now();
      socket.emit('profile', (p) => { if (p) setProfile(p); });
    }
  }
  function bumpCoins() {
    const c = $('coinBox');
    if (!c) return;
    c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump');
  }
  setInterval(() => { if (screenNow === 'menu' && profile) renderEcon(); }, 1000);

  // ---- модальное окно
  function openModal(kind) {
    modalKind = kind;
    draftSquad = null;
    $('modal').classList.remove('hidden');
    const box = $('modal').querySelector('.modal-box');
    box.classList.remove('enter'); void box.offsetWidth; box.classList.add('enter');
    if (kind === 'shop') renderShop();
    if (kind === 'squad') renderSquad();
    if (kind === 'admin') renderAdmin();
  }
  function closeModal() {
    modalKind = null;
    draftSquad = null;
    $('modal').classList.add('hidden');
  }
  $('modalClose').onclick = closeModal;
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

  function openAuth(kind) {
    modalKind = 'auth';
    $('modal').classList.remove('hidden');
    const reg = kind === 'register';
    $('modalBody').innerHTML = `<h2 class="modal-title">${reg ? 'РЕГИСТРАЦИЯ' : 'ВХОД'}</h2>
      <form id="authForm" class="auth-form">
        <label class="field">НИК<input id="authName" maxlength="16" autocomplete="username" spellcheck="false" value="${reg ? '' : esc(store.get(localStorage, 'tlc_last_login') || '')}"></label>
        <label class="field">ПАРОЛЬ<input id="authPass" type="password" maxlength="64" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
        ${reg ? '<label class="field">ПОВТОРИТЕ ПАРОЛЬ<input id="authPass2" type="password" maxlength="64" autocomplete="new-password"></label>' : ''}
        <div id="authErr" class="auth-err"></div>
        <button class="btn primary big" type="submit">${reg ? 'Создать аккаунт' : 'Войти'}</button>
        <div class="auth-switch">${reg ? 'Уже есть аккаунт? <a href="#" id="authSwitch">Войти</a>' : 'Нет аккаунта? <a href="#" id="authSwitch">Зарегистрироваться</a>'}</div>
        ${reg ? `<div class="econ-dim">Пароль — от 6 символов. Стартовый капитал: 200 💰. Пароль хранится только в виде хеша.</div>` : ''}
      </form>`;
    $('authSwitch').onclick = (e) => { e.preventDefault(); openAuth(reg ? 'login' : 'register'); };
    setTimeout(() => (reg || !$('authName').value ? $('authName') : $('authPass')).focus(), 50);
    $('authForm').onsubmit = (e) => {
      e.preventDefault();
      const name = $('authName').value.trim(), pass = $('authPass').value;
      if (reg && pass !== $('authPass2').value) { $('authErr').textContent = 'Пароли не совпадают'; return; }
      $('authErr').textContent = '…';
      socket.emit(reg ? 'register' : 'login', { name, pass }, (r) => {
        if (!r || r.error) { $('authErr').textContent = (r && r.error) || 'Ошибка'; Sound.error(); return; }
        session = r.session;
        store.set(localStorage, 'tlc_session', session);
        store.set(localStorage, 'tlc_last_login', name);
        closeModal();
        setProfile(r.profile);
        Sound.ready();
        toast(reg ? `Добро пожаловать, ${r.profile.name}! +200 💰 на старт` : `С возвращением, ${r.profile.name}!`);
      });
    };
  }

  function unitStatsLine(t) {
    const T = R.UNIT_TYPES[t];
    return `❤ ${T.hp} · 👣 ${T.move} · ⚔ ${T.dmg} · 🎯 ${T.minRange > 1 ? T.minRange + '–' : ''}${T.range}`;
  }
  function spriteCanvas(type, side, size) {
    const cv = document.createElement('canvas');
    drawSpriteTo(cv, type, side, size);
    return cv;
  }
  function mountSprites(root) {
    for (const el of root.querySelectorAll('[data-sprite]')) {
      el.replaceWith(spriteCanvas(el.dataset.sprite, el.dataset.side || 'blue', Number(el.dataset.size) || 48));
    }
  }

  // ---- админка: выдача монет и юнитов, сброс таймеров (права только у ников из ADMIN_NAMES на сервере)
  function renderAdmin() {
    if (!profile || !profile.admin) return closeModal();
    $('modalBody').innerHTML = `<h2 class="modal-title">🛠 АДМИНКА</h2>
      <div class="admin-form">
        <label class="field">ИГРОК (пусто — вы)<input id="admName" maxlength="16" spellcheck="false" placeholder="${esc(profile.name)}"></label>
        <button id="admFind" class="btn small">Найти</button>
      </div>
      <div id="admInfo" class="admin-info econ-dim">Введите ник или оставьте пустым, чтобы управлять своим аккаунтом.</div>
      <h3>// МОНЕТЫ</h3>
      <div class="btn-row admin-row">
        <button class="btn small" data-coins="1000">+1 000</button>
        <button class="btn small" data-coins="10000">+10 000</button>
        <button class="btn small" data-coins="100000">+100 000</button>
        <input id="admAmount" class="code-input admin-amount" type="number" placeholder="сумма">
        <button id="admGive" class="btn small primary">Выдать</button>
      </div>
      <h3>// ЮНИТЫ И ТАЙМЕРЫ</h3>
      <div class="btn-row admin-row">
        <button class="btn small primary" data-op="unlockAll">Открыть все юниты</button>
        <button class="btn small" data-op="resetTimers">Заполнить рудник + сбросить награду</button>
      </div>
      <h3>// ОСОБЫЕ ЮНИТЫ</h3>
      <div class="btn-row admin-row">${R.SPECIAL_UNITS.map((u) => `<button class="btn small primary" data-grant="${u}">🐘 Выдать: ${R.UNIT_TYPES[u].name}</button><button class="btn small danger" data-revoke="${u}">Забрать</button>`).join('')}</div>
      <h3>// УРОВЕНЬ РУДНИКА</h3>
      <div class="btn-row admin-row">${[1, 2, 3, 4, 5].map((l) => `<button class="btn small" data-mine="${l}">${l}</button>`).join('')}</div>
      <div class="econ-dim" style="margin-top:12px">Отрицательная сумма забирает монеты. Все действия записываются в лог сервера.</div>`;
    const run = (d) => {
      d.name = $('admName').value.trim() || profile.name;
      socket.emit('admin', d, (r) => {
        if (!r || r.error) { toast((r && r.error) || 'Ошибка', 'err'); Sound.error(); return; }
        const t = r.target;
        const spec = R.SPECIAL_UNITS.filter((x) => t.unlocked.includes(x)).map((x) => R.UNIT_TYPES[x].name);
        $('admInfo').innerHTML = `<b>${esc(t.name)}</b>: ${coinFmt(t.coins)} · юнитов открыто: ${t.unlocked.filter((x) => R.SHOP_UNITS.includes(x)).length}/${R.SHOP_UNITS.length}${spec.length ? ' · 🐘 ' + esc(spec.join(', ')) : ''} · рудник ур.${t.mine.level} (${t.mine.stored}/${t.mine.cap}) · 🏆 ${t.stats.wins} ✖ ${t.stats.losses}`;
        if (d.op !== 'find') { toast(`✔ ${t.name}: ${r.msg}`); Sound.ready(); }
      });
    };
    $('admFind').onclick = () => run({ op: 'find' });
    $('admName').addEventListener('keydown', (e) => { if (e.key === 'Enter') run({ op: 'find' }); });
    $('admGive').onclick = () => run({ op: 'coins', amount: Number($('admAmount').value) });
    for (const b of $('modalBody').querySelectorAll('[data-coins]')) b.onclick = () => run({ op: 'coins', amount: Number(b.dataset.coins) });
    for (const b of $('modalBody').querySelectorAll('[data-op]')) b.onclick = () => run({ op: b.dataset.op });
    for (const b of $('modalBody').querySelectorAll('[data-grant]')) b.onclick = () => run({ op: 'grantSpecial', unit: b.dataset.grant });
    for (const b of $('modalBody').querySelectorAll('[data-revoke]')) b.onclick = () => {
      if (confirm(`Забрать ${R.UNIT_TYPES[b.dataset.revoke].name} у игрока ${$('admName').value.trim() || profile.name}?`)) run({ op: 'revokeSpecial', unit: b.dataset.revoke });
    };
    for (const b of $('modalBody').querySelectorAll('[data-mine]')) b.onclick = () => run({ op: 'mineLevel', level: Number(b.dataset.mine) });
    run({ op: 'find' });
  }

  function renderShop() {
    if (!profile) return closeModal();
    const m = profile.mine;
    const units = R.SHOP_UNITS.map((t) => {
      const T = R.UNIT_TYPES[t];
      const own = profile.unlocked.includes(t);
      const can = profile.coins >= T.price;
      return `<div class="shop-item${own ? ' owned' : ''}">
        <span data-sprite="${t}" data-size="56"></span>
        <div class="shop-info"><div class="shop-name">${T.name} <span class="cost-tag">${T.cost} оч.</span></div>
          <div class="shop-stats">${unitStatsLine(t)}</div><div class="shop-desc">${T.desc}</div></div>
        ${own ? '<div class="owned-tag">✔ Открыт</div>' : `<button class="btn small ${can ? 'primary' : ''}" data-buy="${t}" ${can ? '' : 'disabled'}>${T.price} 💰</button>`}
      </div>`;
    }).join('');
    $('modalBody').innerHTML = `<h2 class="modal-title">🛒 МАГАЗИН <span class="coins">${coinFmt(profile.coins)}</span></h2>
      <h3>// ЮНИТЫ</h3><div class="shop-list">${units}</div>
      <h3>// РУДНИК</h3>
      <div class="shop-item"><div class="mine-icon">⛏</div>
        <div class="shop-info"><div class="shop-name">Рудник — уровень ${m.level}</div>
          <div class="shop-desc">Добывает ${m.rate} 💰 в час, копит до ${profile.mine.cap} 💰 (8 часов).${m.upgradePrice ? ` Следующий уровень: ${[20, 35, 55, 80, 120][m.level]} 💰/ч.` : ' Максимальный уровень.'}</div></div>
        ${m.upgradePrice ? `<button id="btnUpMine" class="btn small ${profile.coins >= m.upgradePrice ? 'primary' : ''}" ${profile.coins >= m.upgradePrice ? '' : 'disabled'}>${m.upgradePrice} 💰</button>` : '<div class="owned-tag">МАКС.</div>'}
      </div>`;
    mountSprites($('modalBody'));
    for (const b of $('modalBody').querySelectorAll('[data-buy]')) {
      b.onclick = () => {
        const t = b.dataset.buy;
        if (!confirm(`Открыть «${R.UNIT_TYPES[t].name}» за ${R.UNIT_TYPES[t].price} 💰?`)) return;
        socket.emit('buyUnit', t, (r) => {
          if (r.error) { toast(r.error, 'err'); Sound.error(); return; }
          Sound.legendary(false);
          toast(`Открыт: ${R.UNIT_TYPES[t].name}! Добавьте его в отряд.`);
          setProfile(r.profile);
          bumpCoins();
        });
      };
    }
    const um = $('btnUpMine');
    if (um) um.onclick = () => socket.emit('upgradeMine', null, (r) => {
      if (r.error) { toast(r.error, 'err'); Sound.error(); return; }
      Sound.pickup(3);
      toast(`⛏ Рудник улучшен до уровня ${r.level}!`);
      setProfile(r.profile);
    });
  }

  function renderSquad() {
    if (!profile) return closeModal();
    if (!draftSquad) draftSquad = profile.squad.slice();
    const avail = R.BASIC_UNITS.concat(R.SHOP_UNITS.filter((t) => profile.unlocked.includes(t)), R.SPECIAL_UNITS.filter((t) => profile.unlocked.includes(t)));
    const cost = R.squadCost(draftSquad);
    const err = R.squadError(draftSquad, profile.unlocked);
    const pct = Math.min(100, (cost / R.SQUAD_BUDGET) * 100);
    const members = ['commander'].concat(draftSquad).map((t, i) => `<div class="sq-member">
        <span data-sprite="${t}" data-size="48"></span><div class="sq-name">${R.UNIT_TYPES[t].name}</div>
        <div class="sq-cost">${i ? R.UNIT_TYPES[t].cost + ' оч.' : 'всегда'}</div>
        ${i ? `<button class="sq-del" data-del="${i - 1}" title="Убрать">✕</button>` : ''}</div>`).join('');
    const empties = Array.from({ length: R.SQUAD_MAX - draftSquad.length }, () => '<div class="sq-member empty">пусто</div>').join('');
    const pool = avail.map((t) => {
      const T = R.UNIT_TYPES[t];
      const can = draftSquad.length < R.SQUAD_MAX && cost + T.cost <= R.SQUAD_BUDGET;
      return `<button class="sq-pick${T.special ? ' special' : ''}" data-add="${t}" ${can ? '' : 'disabled'} title="${esc(T.desc)}">
        <span data-sprite="${t}" data-size="40"></span><span class="sq-pname">${T.name}</span><span class="cost-tag">${T.cost}</span></button>`;
    }).join('');
    const locked = R.SHOP_UNITS.filter((t) => !profile.unlocked.includes(t)).length;
    $('modalBody').innerHTML = `<h2 class="modal-title">⚔ ОТРЯД</h2>
      <div class="budget"><span>Очки отряда: <b>${cost}</b> / ${R.SQUAD_BUDGET}</span><div class="budget-bar"><div style="width:${pct}%"></div></div></div>
      <div class="sq-members">${members}${empties}</div>
      <h3>// ДОСТУПНЫЕ БОЙЦЫ (нажмите, чтобы добавить)</h3>
      <div class="sq-pool">${pool}</div>
      ${locked ? `<div class="econ-dim">Ещё ${locked} юнит(ов) можно открыть в магазине.</div>` : ''}
      <div id="sqErr" class="auth-err">${err || ''}</div>
      <div class="btn-row"><button id="btnSqReset" class="btn small">По умолчанию</button><button id="btnSqSave" class="btn primary" ${err ? 'disabled' : ''}>Сохранить отряд</button></div>`;
    mountSprites($('modalBody'));
    for (const b of $('modalBody').querySelectorAll('[data-add]')) b.onclick = () => { draftSquad.push(b.dataset.add); Sound.select(); renderSquad(); };
    for (const b of $('modalBody').querySelectorAll('[data-del]')) b.onclick = () => { draftSquad.splice(Number(b.dataset.del), 1); Sound.unready(); renderSquad(); };
    $('btnSqReset').onclick = () => { draftSquad = R.DEFAULT_SQUAD.slice(); renderSquad(); };
    $('btnSqSave').onclick = () => socket.emit('setSquad', draftSquad, (r) => {
      if (r.error) { $('sqErr').textContent = r.error; Sound.error(); return; }
      Sound.ready();
      toast('Отряд сохранён');
      draftSquad = null;
      setProfile(r.profile);
      closeModal();
    });
  }

  // ------------------------------------------------------------ очередь событий → анимации
  function enqueue(msg) {
    const s = msg.state;
    if (!s) return;
    if (!view || s.gameId !== gameId) {
      const isNew = true;
      queue.length = 0;
      gameId = s.gameId;
      state = s;
      view = clone(s);
      anims.clear();
      selectedId = null; mode = 'normal';
      overShownFor = s.phase === 'over' ? s.gameId : null;
      overHidden = false;
      onSynced();
      if (isNew && s.phase === 'game' && s.turnNo === 1 && s.activated.length === 0) {
        if (s.turnLeftMs > R.TURN_SECONDS * 1000 + 2500) startCountdown();
        else { showBanner('БОЙ НАЧАЛСЯ!', 'neutral'); Sound.turn(); }
      }
      return;
    }
    queue.push(msg);
    if (!animating) runQueue();
  }

  async function runQueue() {
    animating = true;
    renderHUD();
    while (queue.length) {
      const msg = queue.shift();
      state = msg.state;
      deadline = nowMs() + (state.turnLeftMs || 0);
      const fast = queue.length > 2 || document.hidden;
      setPending(false);
      if (!fast) {
        for (const e of msg.events || []) {
          try { await playEvent(e); } catch (err) { console.error(err); }
        }
      }
      view = clone(msg.state);
      anims.clear();
      onSynced();
    }
    animating = false;
    renderHUD();
    renderCard();
  }

  let noMovesFlash = null;
  function markUsed(u, kind) {
    if (!view || u.side !== view.turn) return;
    if (!view.activated.includes(u.id)) view.activated.push(u.id);
    if (kind === 'move') u.moved = true;
    else { u.acted = true; if (kind === 'attack') u.attacked = true; }
    renderHUD();
  }

  // ---- окошко «Осталось ходов» под доской
  function movesLeft() {
    const own = view.units.filter((u) => u.alive && u.side === view.turn && !R.UNIT_TYPES[u.type].static);
    let n = 0;
    const slots = [];
    for (let i = 0; i < 2; i++) {
      const id = view.activated[i];
      if (id) {
        const u = vUnit(id);
        const mv = !!(u && u.alive && R.canMove(view, u));
        const ac = !!(u && u.alive && R.canAct(view, u));
        n += mv + ac;
        slots.push({ u, mv, ac });
      } else {
        const free = own.filter((u) => !view.activated.includes(u.id)).length - slots.filter((s) => !s.u).length;
        if (free > 0) { n += 2; slots.push({ u: null, mv: true, ac: true }); }
        else slots.push({ u: null, mv: false, ac: false, none: true });
      }
    }
    return { n, slots };
  }
  function renderMoves() {
    const box = $('movesBox');
    if (!box || !view) return;
    const side = actingSide();
    let cls = 'moves-box', html;
    const noMoves = (sub) => { cls += ' empty'; return `<div class="mv-big">ХОДОВ НЕТ</div><div class="mv-sub">${sub}</div>`; };
    if (view.winner) {
      html = '<div class="mv-big mv-over">ИГРА ОКОНЧЕНА</div>';
    } else if (noMovesFlash) {
      html = noMoves(`Ход переходит к ${{ blue: "Синим", red: "Красным" }[R.other(noMovesFlash)]}…`);
    } else if (!side) {
      html = noMoves(view.you ? 'Сейчас ходит соперник — ждите своей очереди' : `Ходят ${SIDE_RU[view.turn].toLowerCase()}`);
    } else {
      const { n, slots } = movesLeft();
      if (n === 0) {
        html = noMoves('Нажмите «Завершить ход» или Enter');
      } else {
        const cells = slots.map((s, i) => {
          const name = s.none ? 'нет юнитов' : s.u ? R.UNIT_TYPES[s.u.type].name : 'любой юнит';
          return `<div class="mv-slot${s.u ? ' used' : ''}"><div class="mv-name">Юнит ${i + 1}: ${name}</div>` +
            `<span class="mv-cell ${s.mv ? 'ok' : 'no'}">ДВИЖЕНИЕ</span><span class="mv-cell ${s.ac ? 'ok' : 'no'}">ДЕЙСТВИЕ</span></div>`;
        }).join('');
        html = `<div class="mv-head"><span class="mv-label">ОСТАЛОСЬ ХОДОВ</span><span class="mv-count">${n}</span><span class="mv-of">из 4</span></div><div class="mv-slots">${cells}</div>`;
        if (n === 1 || n === 2) cls += ' low';
      }
    }
    box.className = cls + ' ' + view.turn;
    box.innerHTML = html;
  }

  function cellCenter(x, y) { return { x: (fx(x) + 0.5) * C, y: (fx(y) + 0.5) * C }; }

  async function playEvent(e) {
    const u = e.unitId ? vUnit(e.unitId) : null;
    switch (e.type) {
      case 'move': {
        if (!u) return;
        markUsed(u, 'move');
        const stepMs = 115;
        const dur = (e.path.length - 1) * stepMs;
        anims.set(u.id, { type: 'path', path: e.path, t0: nowMs(), dur });
        for (let i = 0; i < e.path.length - 1; i++) setTimeout(() => Sound.step(), i * stepMs + 40);
        await wait(dur);
        const last = e.path[e.path.length - 1];
        u.x = last[0]; u.y = last[1];
        anims.delete(u.id);
        return;
      }
      case 'jetpack': {
        if (!u) return;
        u.item = e.item || null;
        markUsed(u, 'move');
        anims.set(u.id, { type: 'jet', from: e.from, to: e.to, t0: nowMs(), dur: 520 });
        Sound.jet();
        burst(cellCenter(e.from.x, e.from.y), 14, ['#f97316', '#facc15', '#9ca3af'], 2.2);
        await wait(520);
        u.x = e.to.x; u.y = e.to.y;
        anims.delete(u.id);
        burst(cellCenter(e.to.x, e.to.y), 16, ['#9ca3af', '#6b7280', '#f97316'], 2);
        shake = Math.max(shake, 2);
        return;
      }
      case 'knockback': {
        if (!u) return;
        anims.set(u.id, { type: 'slide', from: e.from, to: e.to, t0: nowMs(), dur: 170 });
        await wait(170);
        u.x = e.to.x; u.y = e.to.y;
        anims.delete(u.id);
        return;
      }
      case 'shot': {
        if (u && e.kind === 'shotgun') u.item = e.item || null;
        if (u) markUsed(u, 'attack');
        const dur = addProjectile(e.from, e.to, e.kind, e.side);
        if (e.kind === 'grenade') { Sound.jet(); setTimeout(() => Sound.explosion(false), dur - 30); }
        else Sound.shot(e.kind);
        burst(cellCenter(e.from.x, e.from.y), 5, ['#fff', '#facc15'], 1.2);
        await wait(dur);
        return;
      }
      case 'damage': {
        if (!u) return;
        u.hp = e.hp;
        flashes.set(u.id, nowMs() + 140);
        addFloat(`-${e.amount}`, u.x, u.y, '#ff5a5a');
        burst(cellCenter(u.x, u.y), 10, ['#ef4444', '#fca5a5', '#fff'], 1.8);
        shake = Math.max(shake, 2.5);
        Sound.hit();
        await wait(170);
        return;
      }
      case 'shield': {
        if (!u) return;
        u.item = e.item || null;
        if (e.hp != null) u.hp = e.hp;
        addFloat(e.heal ? `БЛОК! +${e.heal}` : 'БЛОК!', u.x, u.y, '#22d3ee');
        ring(cellCenter(u.x, u.y), '#22d3ee');
        Sound.shield();
        await wait(260);
        return;
      }
      case 'heal': {
        if (!u) return;
        u.hp = e.hp;
        if (e.maxHp) u.maxHp = e.maxHp;
        addFloat(`+${e.amount}`, u.x, u.y, '#4ade80');
        burst(cellCenter(u.x, u.y), 12, ['#4ade80', '#bbf7d0'], 1.2, -1);
        Sound.heal();
        await wait(260);
        return;
      }
      case 'death': {
        if (u) u.alive = false;
        booms.push({ x: e.x, y: e.y, t0: nowMs(), big: true });
        burst(cellCenter(e.x, e.y), 34, ['#f97316', '#facc15', '#ef4444', '#4b5563', '#111'], 3.4);
        shake = Math.max(shake, 6);
        Sound.explosion(true);
        await wait(380);
        return;
      }
      case 'explosion': {
        booms.push({ x: e.x, y: e.y, t0: nowMs(), big: !!e.big });
        burst(cellCenter(e.x, e.y), e.big ? 30 : 16, ['#f97316', '#facc15', '#fff', '#6b7280'], e.big ? 3.2 : 2.2);
        shake = Math.max(shake, e.big ? 7 : 4);
        if (e.big) Sound.explosion(true);
        await wait(e.big ? 260 : 90);
        return;
      }
      case 'minetrigger': {
        view.mines = view.mines.filter((m) => !(m.x === e.x && m.y === e.y));
        addFloat('МИНА!', e.x, e.y, '#c4b5fd');
        await wait(60);
        return;
      }
      case 'pickup': {
        view.crates = view.crates.filter((c) => !(c.x === e.x && c.y === e.y));
        if (u && !R.ITEMS[e.item.type].instant) u.item = e.item;
        const rar = R.RARITIES[e.item.tier || 0];
        addFloat(R.ITEMS[e.item.type].name, e.x, e.y, rar.color, e.item.tier === 4);
        burst(cellCenter(e.x, e.y), 14 + e.item.tier * 8, [rar.color, '#fde68a', '#fff'], 1.6 + e.item.tier * 0.4, -1);
        if (e.item.tier >= 3) {
          showBanner(`${R.RARITIES[e.item.tier].m.toUpperCase()} ЛУТ!`, 'rar' + e.item.tier);
          ring(cellCenter(e.x, e.y), rar.color);
          shake = Math.max(shake, 3);
          Sound.legendary(e.item.tier === 4);
        } else Sound.pickup(e.item.tier);
        await wait(e.item.tier >= 3 ? 650 : 300);
        return;
      }
      case 'luck': {
        if (view.luck) view.luck[e.side] = e.luck;
        if (e.expired) { if (view.luckBuff) view.luckBuff[e.side] = null; renderHUD(); return; }
        if (u) addFloat(`+${e.amount} УДАЧА`, u.x, u.y, '#4ade80');
        if (u) burst(cellCenter(u.x, u.y), 18, ['#4ade80', '#86efac', '#facc15'], 1.4, -1);
        renderHUD();
        await wait(250);
        return;
      }
      case 'spawn': {
        view.units.push(clone(e.unit));
        burst(cellCenter(e.unit.x, e.unit.y), 14, ['#facc15', '#9ca3af', '#fff'], 1.6);
        Sound.crate();
        await wait(250);
        return;
      }
      case 'boost': {
        if (!u) return;
        u.boost = e.amount;
        addFloat(`+${e.amount} ХОД`, u.x, u.y, '#22d3ee');
        ring(cellCenter(u.x, u.y), '#22d3ee');
        Sound.turn();
        await wait(250);
        return;
      }
      case 'buff': {
        if (!u) return;
        u.buffs = e.buffs;
        const txt = { dmg: '+УРОН', range: '+ДАЛЬНОСТЬ', move: '+ХОД', steady: 'СТАБИЛИЗАЦИЯ' }[e.kind];
        addFloat(txt, u.x, u.y, '#f472b6');
        burst(cellCenter(u.x, u.y), 16, ['#f472b6', '#fbcfe8', '#fff'], 1.4, -1);
        await wait(250);
        return;
      }
      case 'backstab': {
        if (u) {
          addFloat('УДАР В СПИНУ!', u.x, u.y, '#c084fc', true);
          burst(cellCenter(u.x, u.y), 22, ['#c084fc', '#1f2937', '#fff'], 2.2);
        }
        shake = Math.max(shake, 5);
        Sound.shotgun();
        await wait(220);
        return;
      }
      case 'trumpet': {
        if (!u) return;
        addFloat('ТРУ-У-У!', u.x, u.y, '#4ade80', true);
        ring(cellCenter(u.x, u.y), '#4ade80');
        burst(cellCenter(u.x, u.y), 18, ['#4ade80', '#15803d', '#bbf7d0'], 2);
        shake = Math.max(shake, 4);
        Sound.trumpet();
        await wait(350);
        return;
      }
      case 'wallbreak': {
        view.walls = view.walls.filter((w) => !(w.x === e.x && w.y === e.y));
        booms.push({ x: e.x, y: e.y, t0: nowMs(), big: false });
        burst(cellCenter(e.x, e.y), 26, ['#9ca3af', '#6b7280', '#facc15', '#374151'], 2.6);
        addFloat('ХРЯСЬ!', e.x, e.y, '#facc15');
        shake = Math.max(shake, 6);
        Sound.explosion(false);
        await wait(200);
        return;
      }
      case 'ram': {
        if (u) addFloat('ТАРАН!', u.x, u.y, '#fb923c');
        shake = Math.max(shake, 4);
        Sound.hit();
        await wait(120);
        return;
      }
      case 'aura': {
        if (u) addFloat('ЩИТ −1', u.x, u.y, '#93c5fd');
        return;
      }
      case 'itemchange': {
        if (u) u.item = e.item || null;
        return;
      }
      case 'crate': {
        view.crates.push({ id: e.id, x: e.x, y: e.y });
        crateDrops.set(e.id, nowMs());
        if (e.bonus) { addFloat('ДВОЙНОЙ ДРОП!', e.x, e.y, '#facc15'); Sound.pickup(2); } else Sound.crate();
        await wait(220);
        burst(cellCenter(e.x, e.y), 10, ['#9ca3af', '#facc15'], 1.4);
        return;
      }
      case 'mineplaced': {
        if (u) { u.item = e.item || null; markUsed(u, 'act'); }
        view.mines.push({ id: 'tmp', x: e.x, y: e.y, side: e.side });
        Sound.mine();
        await wait(200);
        return;
      }
      case 'turn': {
        // показываем «ХОДОВ НЕТ» перед передачей хода, чтобы было видно, что ходы кончились
        noMovesFlash = view.turn;
        renderMoves();
        await wait(900);
        noMovesFlash = null;
        view.turn = e.turn;
        view.activated = [];
        for (const x of view.units) { x.moved = false; x.acted = false; x.attacked = false; }
        selectedId = null; mode = 'normal';
        const mine = view.you === 'both' || view.you === e.turn;
        showBanner(view.you === 'both' ? `ХОД ${SIDE_GEN[e.turn]}` : (mine ? 'ВАШ ХОД' : `ХОД ${SIDE_GEN[e.turn]}`), e.turn);
        if (mine) Sound.turn();
        renderHUD();
        await wait(350);
        return;
      }
      case 'gameover':
        await wait(400);
        return;
      default:
    }
  }

  // ------------------------------------------------------------ эффекты
  function addProjectile(from, to, kind, side) {
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    const DUR = {
      sniper: 110, shotgun: 130, grenade: 380, punch: 150,
      bolt: 90 + d * 40, burst: 220 + d * 40, dart: 120 + d * 45, syringe: 140 + d * 45,
      knife: 160 + d * 50, bone: 200 + d * 55, shield: 180 + d * 55, wave: 260 + d * 60,
    };
    const dur = Math.round(DUR[kind] != null ? DUR[kind] : 80 + d * 45);
    projectiles.push({ from, to, kind, side, t0: nowMs(), dur });
    return dur;
  }
  function burst(p, n, colors, speed, gravSign) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (0.4 + Math.random()) * speed * S * 30;
      particles.push({
        x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (gravSign === -1 ? S * 40 : 0),
        g: gravSign === -1 ? -S * 10 : S * 120, life: 0, max: 0.35 + Math.random() * 0.5,
        color: colors[(Math.random() * colors.length) | 0], size: Math.random() < 0.3 ? 2 : 1,
      });
    }
  }
  function ring(p, color) {
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      particles.push({ x: p.x, y: p.y, vx: Math.cos(a) * S * 45, vy: Math.sin(a) * S * 45, g: 0, life: 0, max: 0.4, color, size: 1 });
    }
  }
  function addFloat(text, x, y, color, rainbow) {
    floats.push({ text, x, y, color, rainbow, t0: nowMs(), dur: rainbow ? 1600 : 1000 });
  }

  // ------------------------------------------------------------ синхронизация UI
  function onSynced() {
    flipped = view.you === 'red';
    deadline = nowMs() + (state.turnLeftMs || 0);
    if (selectedId && !selUnit()) selectedId = null;
    const su = selUnit();
    if (mode === 'ability') {
      if (!su || su.side !== actingSide() || !R.abilityTargets(view, su).length) mode = 'normal';
    } else if (mode !== 'normal') {
      const need = { shotgun: 'shotgun', jetpack: 'jetpack', mine: 'landmine' }[mode];
      if (!su || !su.item || su.item.type !== need || su.side !== actingSide()) mode = 'normal';
    }
    updateScreens();
    renderHUD();
    renderCard();
    renderLog();
    renderOverlay();
  }

  function updateScreens() {
    const scr = !lobby ? 'menu' : (lobby.phase !== 'lobby' && view ? 'game' : 'lobby');
    for (const id of ['menu', 'lobby', 'game']) $(id).classList.toggle('hidden', id !== scr);
    if (scr === screenNow) { if (scr === 'game') resize(); return; }
    screenNow = scr;
    const el = $(scr);
    el.classList.remove('screen-in'); void el.offsetWidth; el.classList.add('screen-in');
    if (scr === 'game') {
      MenuBG.stop(); Sound.ambientStop(); resize();
    } else {
      MenuBG.start(); Sound.ambientStart();
    }
    clearInterval(roomListTimer);
    if (scr === 'menu') {
      renderMenu();
      refreshRooms();
      roomListTimer = setInterval(refreshRooms, 4000);
      typeSubtitle();
    }
  }

  // ------------------------------------------------------------ главное меню
  const SUBTITLE = '> пошаговая тактика · лут · оружие · онлайн';
  let typeTimer = null;
  function typeSubtitle() {
    const el = $('typeLine');
    clearInterval(typeTimer);
    let i = 0;
    el.textContent = '';
    typeTimer = setInterval(() => {
      el.textContent = SUBTITLE.slice(0, ++i);
      if (i >= SUBTITLE.length) clearInterval(typeTimer);
    }, 35);
  }
  function renderMenu() {
    const ni = $('nameInput');
    if (document.activeElement !== ni) ni.value = myName;
    renderAccount();
  }
  function refreshRooms() {
    if (!socket.connected || screenNow !== 'menu') return;
    socket.emit('listRooms', (d) => {
      if (!d || screenNow !== 'menu') return;
      const ul = $('roomList');
      const sig = JSON.stringify(d.open);
      if (ul.dataset.sig !== sig) {
        ul.dataset.sig = sig;
        ul.innerHTML = '';
        if (!d.open.length) {
          const li = document.createElement('li');
          li.className = 'empty';
          li.textContent = 'Пока пусто. Создайте комнату и отправьте ссылку другу — или зайдите по коду.';
          ul.appendChild(li);
        }
        for (const r of d.open) {
          const li = document.createElement('li');
          const c = document.createElement('span'); c.className = 'rc'; c.textContent = r.code;
          const h = document.createElement('span'); h.className = 'rh'; h.textContent = r.host;
          const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Войти';
          b.onclick = () => joinByCode(r.code);
          li.append(c, h, b);
          ul.appendChild(li);
        }
      }
      $('onlineInfo').innerHTML = `<span class="dot"></span>Онлайн: ${d.online | 0} · идёт матчей: ${d.games | 0}`;
    });
  }
  function joinByCode(code) {
    const c = normCode(code);
    if (!c) { toast('Код комнаты — 4 символа', 'err'); Sound.error(); return; }
    Sound.unlock();
    socket.emit('joinRoom', c, (r) => {
      if (r && r.error) { toast(r.error, 'err'); Sound.error(); }
    });
  }

  // ------------------------------------------------------------ отсчёт 3-2-1 перед боем
  function startCountdown() {
    stopCountdown();
    countdownActive = true;
    const box = $('countdown'), num = $('countNum');
    box.classList.remove('hidden', 'fade');
    const steps = ['3', '2', '1', 'В БОЙ!'];
    let i = 0;
    const next = () => {
      if (i >= steps.length) {
        box.classList.add('fade');
        countdownTimer = setTimeout(() => { box.classList.add('hidden'); countdownActive = false; renderHUD(); }, 350);
        return;
      }
      const last = i === steps.length - 1;
      num.textContent = steps[i];
      num.className = 'count-num';
      void num.offsetWidth;
      num.className = 'count-num tick' + (last ? ' go' : '');
      if (last) { Sound.go(); shake = Math.max(shake, 4); } else Sound.count();
      i++;
      countdownTimer = setTimeout(next, last ? 700 : 800);
    };
    next();
    renderHUD();
  }
  function stopCountdown() {
    clearTimeout(countdownTimer);
    countdownActive = false;
    $('countdown').classList.add('hidden');
  }

  function renderLobby() {
    if (!lobby) return;
    $('roomCode').textContent = lobby.code;
    for (const side of ['blue', 'red']) {
      const el = $(side === 'blue' ? 'slotBlue' : 'slotRed');
      const s = lobby.slots[side];
      const p = prevLobby ? prevLobby.slots[side] : undefined;
      const mine = lobby.you === side || lobby.you === 'both';
      el.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'slot-title';
      title.textContent = side === 'blue' ? '■ СИНИЕ' : '■ КРАСНЫЕ';
      if (mine) {
        const t = document.createElement('span');
        t.className = 'you-tag'; t.textContent = 'ВЫ';
        title.appendChild(t);
      }
      const nm = document.createElement('div');
      nm.className = 'slot-name';
      nm.textContent = s ? s.name : 'Ожидание…';
      const st = document.createElement('div');
      st.className = 'slot-status';
      if (!s) { st.textContent = '○ Свободно'; st.classList.add('st-free'); }
      else if (!s.connected) { st.textContent = '✖ Отключён (ожидание…)'; st.classList.add('st-off'); }
      else if (s.ready) { st.textContent = '✔ ГОТОВ'; st.classList.add('st-ready'); }
      else { st.textContent = '… Не готов'; st.classList.add('st-wait'); }
      el.append(title, nm, st);
      if (s) {
        const row = document.createElement('div');
        row.className = 'squad-row';
        for (const t of ['commander'].concat(s.squad || R.DEFAULT_SQUAD)) {
          const cv = spriteCanvas(t, side, 30);
          cv.title = R.UNIT_TYPES[t] ? R.UNIT_TYPES[t].name : t;
          row.appendChild(cv);
        }
        el.appendChild(row);
        if (s.account) title.insertAdjacentHTML('beforeend', ' <span class="acc-tag" title="Играет с аккаунтом">💰</span>');
      }
      el.classList.toggle('is-free', !s);
      el.classList.toggle('is-ready', !!(s && s.ready));
      // реакции на изменения
      const anim = (cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
      if (p !== undefined) {
        if (!p && s) { anim('joined'); if (!mine) { Sound.join(); toast(`${s.name} заходит в комнату`); } }
        else if (p && !s) { if (!mine) { Sound.leave(); toast(`${p.name} покидает комнату`); } }
        else if (p && s && !p.ready && s.ready) { anim('readied'); Sound.ready(); }
        else if (p && s && p.ready && !s.ready) Sound.unready();
      } else if (s) anim('joined');
    }
    const seated = lobby.you === 'blue' || lobby.you === 'red';
    const mySlot = seated ? lobby.slots[lobby.you] : null;
    const btn = $('btnReady');
    btn.disabled = !seated || lobby.phase !== 'lobby';
    btn.textContent = mySlot && mySlot.ready ? 'Отменить готовность' : 'Готов';
    btn.classList.toggle('active', !!(mySlot && mySlot.ready));
    let msg = '';
    const other = seated ? lobby.slots[lobby.you === 'blue' ? 'red' : 'blue'] : null;
    if (lobby.phase !== 'lobby' && !lobby.you) msg = 'Идёт матч — вы в режиме наблюдателя.';
    else if (!lobby.you) msg = 'Комната заполнена — вы наблюдатель.';
    else if (seated && !other) msg = 'Ждём второго игрока… Отправьте другу ссылку или код комнаты.';
    else if (seated && mySlot && !mySlot.ready) msg = 'Нажмите «Готов», чтобы начать.';
    else if (seated && other && !other.ready) msg = 'Ждём готовности соперника…';
    else if (seated) msg = 'Оба готовы — начинаем!';
    $('lobbyMsg').textContent = msg;
  }

  function renderLootInfo() {
    const el = $('lootInfo');
    if (!el || !view) return;
    const lv = R.lootLevel(view.round);
    const luck = view.luck || { blue: 0, red: 0 };
    const mySide = view.you === 'blue' || view.you === 'red' ? view.you : view.turn;
    const ch = R.rarityChances(luck[mySide], view.round);
    const bar = ch.map((p, i) => `<span class="lc r${i}" style="flex:${Math.max(p, 0.02)}" title="${R.RARITIES[i].m}: ${(p * 100).toFixed(1)}%"></span>`).join('');
    el.innerHTML = `<div class="li-row"><span>ЛУТ ур. <b>${lv}</b>/5</span><span class="li-luck">${['blue', 'red'].map((sd) => { const b = view.luckBuff && view.luckBuff[sd]; return `<span class="${sd === 'blue' ? 'pb' : 'pr'}" title="${b ? `Клевер действует ещё ${b.turns} ход.` : 'Клевер не активен'}">🍀${luck[sd]}${b ? `<small>·${b.turns}х</small>` : ''}</span>`; }).join(' ')}</span></div>` +
      `<div class="li-bar">${bar}</div><div class="li-sub">шанс ★+: ${((ch[3] + ch[4]) * 100).toFixed(0)}% · двойной дроп: ${(R.doubleDropChance(luck[mySide], view.round) * 100).toFixed(0)}%</div>`;
  }

  function renderHUD() {
    if (!view) return;
    const tl = $('turnLabel');
    const side = view.turn;
    let txt;
    if (view.winner) txt = 'ИГРА ОКОНЧЕНА';
    else if (view.you === 'both') txt = `ХОД ${SIDE_GEN[side]}`;
    else if (view.you === side) txt = '▶ ВАШ ХОД';
    else txt = `ХОД ${SIDE_GEN[side]}`;
    tl.textContent = txt;
    tl.className = 'turn-label ' + side;
    $('roundLabel').textContent = `Раунд ${view.round}` + (view.you === 'both' ? ' · тест на 1 ПК' : view.you ? ` · вы за ${SIDE_RU[view.you]}` : ' · наблюдатель');
    renderLootInfo();

    const box = $('actionsBox');
    box.innerHTML = '';
    for (let i = 0; i < 2; i++) {
      const d = document.createElement('div');
      const id = view.activated[i];
      const u = id ? vUnit(id) : null;
      if (!u) {
        d.className = 'aslot';
        d.innerHTML = `<span class="free">Юнит ${i + 1}: свободный слот</span>`;
      } else {
        d.className = 'aslot used';
        const nm = document.createElement('span');
        nm.className = 'nm'; nm.style.color = TEAM_COL[u.side];
        nm.textContent = `${i + 1}. ${uName(u)}${u.alive ? '' : ' ☠'}`;
        const mv = document.createElement('span');
        mv.className = 'pip ' + (u.alive && R.canMove(view, u) ? 'ok' : 'no'); mv.textContent = 'Движение';
        const ac = document.createElement('span');
        ac.className = 'pip ' + (u.alive && R.canAct(view, u) ? 'ok' : 'no'); ac.textContent = 'Действие';
        d.append(nm, mv, ac);
      }
      box.appendChild(d);
    }

    const pb = $('playersBox');
    pb.innerHTML = '';
    for (const s of ['blue', 'red']) {
      const p = view.players && view.players[s];
      const row = document.createElement('div');
      const dot = document.createElement('span');
      dot.className = 'dot ' + (p && p.connected ? 'on' : 'off');
      const nm = document.createElement('span');
      nm.className = s === 'blue' ? 'pb' : 'pr';
      nm.textContent = (p ? p.name : '—') + (view.solo && s === 'red' ? ' (тот же ПК)' : '');
      row.append(dot, nm);
      pb.appendChild(row);
    }
    $('btnEndTurn').disabled = !canInput();
    renderMoves();
    $('btnSurrender').disabled = !view.you || !!view.winner || state.phase !== 'game';
    $('btnSurrender').classList.toggle('hidden', !view.you);
    $('btnLeaveGame').classList.toggle('hidden', !!view.you);

    const w = $('warn');
    if (view.you === 'blue' || view.you === 'red') {
      const o = view.players[R.other(view.you)];
      if (!view.winner && (!o || !o.connected)) {
        w.textContent = '⚠ Соперник отключился — ожидание переподключения…';
        w.classList.remove('hidden');
      } else w.classList.add('hidden');
    } else w.classList.add('hidden');
  }

  function drawSpriteTo(cv, name, team, cssSize) {
    const d = window.devicePixelRatio || 1;
    const scale = Math.max(1, Math.floor((cssSize * d) / 16));
    cv.width = scale * 16; cv.height = scale * 16;
    cv.style.width = (scale * 16) / d + 'px';
    cv.style.height = (scale * 16) / d + 'px';
    const c = cv.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.drawImage(Sprites.get(name, team), 0, 0, cv.width, cv.height);
  }

  function renderCard() {
    const el = $('unitCard');
    const u = selUnit();
    if (!view || !u) {
      el.innerHTML = `<div class="help"><h4>// УПРАВЛЕНИЕ</h4>
        <b>ЛКМ</b> по своему юниту — выбрать.<br>
        <b>ЛКМ</b> по подсвеченной клетке — движение.<br>
        <b>ЛКМ</b> по врагу в красной рамке — атака.<br>
        <b>ПКМ / Esc</b> — отмена, <b>Enter</b> — конец хода.<br><br>
        За ход: до <b>2 разных юнитов</b>, у каждого <b>1 Движение</b> + <b>1 Действие</b>.<br>
        Наступите на <b>ящик</b>, чтобы получить лут. Наведите на врага — увидите превью урона.</div>`;
      return;
    }
    const T = R.UNIT_TYPES[u.type];
    const side = actingSide();
    const own = side && u.side === side;
    const pct = Math.round((u.hp / u.maxHp) * 100);
    const hpCol = pct > 60 ? '#4ade80' : pct > 30 ? '#facc15' : '#ef4444';
    const mvR = R.moveRange(u);
    const bf = u.buffs || {};
    const inh = [bf.dmg && `+${bf.dmg} урон`, bf.range && `+${bf.range} дальн.`, bf.move && `+${bf.move} ход`, bf.steady && 'ходит и стреляет'].filter(Boolean);
    const it = u.item ? R.ITEMS[u.item.type] : null;
    const rar = u.item ? R.RARITIES[u.item.tier || 0] : null;
    let status = '';
    if (T.static) {
      status = '<div class="status-row"><span class="pip ok">Стреляет сама в конце хода</span></div>';
    } else if (u.side === view.turn && !view.winner) {
      const usable = R.canUseUnit(view, u);
      status = usable
        ? `<div class="status-row"><span class="pip ${R.canMove(view, u) ? 'ok' : 'no'}">Движение</span><span class="pip ${R.canAct(view, u) ? 'ok' : 'no'}">Действие</span>${R.sniperLocked(u) ? '<span class="pip ' + (R.canShoot(view, u) ? 'ok' : 'no') + '">Выстрел</span>' : ''}</div>`
        : '<div class="status-row"><span class="pip no">Лимит: 2 юнита за ход</span></div>';
    }
    let deb = '';
    if (u.slowed) deb += '<div class="debuff">⚠ Контузия: −1 к движению в этот ход</div>';
    if (u.slowNext) deb += '<div class="debuff">⚠ Контузия: −1 к движению в следующий ход</div>';
    let btns = '';
    const AB = { trumpet: ['Трубный рёв', 'Нажмите на слоника — враги вокруг получат урон и отлетят'], heal: ['Лечить', 'Выберите раненого союзника рядом'], boost: ['Ускорить союзника', 'Выберите союзника в радиусе 2'], turret: ['Поставить турель', 'Выберите клетку рядом'] };
    if (own && T.ability && !view.winner) {
      const ok = R.abilityTargets(view, u).length > 0;
      const active = mode === 'ability';
      btns += `<div class="card-btns"><button id="btnAbility" class="btn ${active ? 'active' : 'primary'}" ${ok && canInput() ? '' : 'disabled'}>${active ? 'Отмена' : '★ ' + AB[T.ability][0]}</button></div>`;
    }
    if (own && it && it.active && !view.winner) {
      const modeKey = { shotgun: 'shotgun', jetpack: 'jetpack', landmine: 'mine' }[u.item.type];
      let ok = false;
      if (modeKey === 'shotgun') ok = R.canShoot(view, u);
      if (modeKey === 'jetpack') ok = R.canMove(view, u) && R.jetpackCells(view, u).length > 0;
      if (modeKey === 'mine') ok = R.canAct(view, u) && R.mineCells(view, u).length > 0;
      const active = mode === modeKey;
      btns += `<div class="card-btns"><button id="btnItem" class="btn ${active ? 'active' : 'primary'}" ${ok && canInput() ? '' : 'disabled'} data-mode="${modeKey}">${active ? 'Отмена' : 'Активировать: ' + it.name}</button></div>`;
    }
    el.innerHTML = `
      <div class="card-head">
        <canvas id="portrait" class="portrait"></canvas>
        <div>
          <div class="u-name ${u.side}">${T.name}</div>
          <div class="u-side">${SIDE_RU[u.side].toUpperCase()}${own ? ' · ваш юнит' : ''}</div>
          <div class="hpbar"><div style="width:${pct}%;background:${hpCol}"></div><span>${u.hp} / ${u.maxHp} HP</span></div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>${u.hp}</b><small>HP</small></div>
        <div class="stat"><b>${mvR}${u.slowed ? '↓' : ''}</b><small>ХОД</small></div>
        <div class="stat"><b>${R.unitDmg(u)}${bf.dmg ? '↑' : ''}</b><small>УРОН</small></div>
        <div class="stat"><b>${T.minRange > 1 ? T.minRange + '–' : ''}${R.unitRange(u)}${bf.range ? '↑' : ''}</b><small>ДАЛЬН.</small></div>
      </div>
      ${status}${deb}${inh.length ? `<div class="debuff" style="color:#f472b6">💉 Ингибиторы: ${inh.join(', ')}</div>` : ''}
      <div class="u-desc">${T.desc}${T.stealth ? (R.isHidden(view, u) ? ' <b style="color:#4ade80">Сейчас скрыт.</b>' : ' <b style="color:#facc15">Сейчас виден врагу.</b>') : ''}${u.boost ? ` <b style="color:#22d3ee">+${u.boost} к движению в этот ход.</b>` : ''}</div>
      <div class="item-box">
        <canvas id="itemIcon"></canvas>
        <div>${it ? `<div class="item-name" style="color:${rar.color}">${it.name}${(u.item.charges || 1) > 1 ? ` ×${u.item.charges}` : ''}</div><div class="rarity-tag r${u.item.tier || 0}">${R.rarityName(u.item.type, u.item.tier).toUpperCase()}</div><div class="item-desc">${R.itemDesc(u.item)}</div>` : '<div class="item-empty">Слот снаряжения пуст.<br>Подберите ящик с лутом.</div>'}</div>
      </div>
      ${btns}`;
    drawSpriteTo($('portrait'), u.type, u.side, 72);
    const ic = $('itemIcon');
    if (it) { drawSpriteTo(ic, 'i_' + u.item.type, null, 32); ic.style.borderColor = rar.color; }
    else { ic.width = 1; ic.height = 1; ic.style.width = '34px'; ic.style.height = '34px'; }
    const ab = $('btnAbility');
    if (ab) ab.onclick = () => {
      Sound.unlock();
      mode = mode === 'ability' ? 'normal' : 'ability';
      Sound.select();
      if (mode === 'ability') toast(AB[T.ability][1]);
      renderCard();
    };
    const b = $('btnItem');
    if (b) b.onclick = () => {
      Sound.unlock();
      const m = b.dataset.mode;
      mode = mode === m ? 'normal' : m;
      Sound.select();
      if (mode === 'shotgun') toast('Дробовик заряжен — выберите цель в 1–2 клетках');
      if (mode === 'jetpack') toast('Выберите клетку для прыжка');
      if (mode === 'mine') toast('Выберите соседнюю клетку для мины');
      renderCard();
    };
  }

  function renderLog() {
    if (!state) return;
    const log = state.log || [];
    const key = log.length ? log[log.length - 1].id + ':' + log.length : '0';
    if (key === renderedLogKey) return;
    renderedLogKey = key;
    const el = $('log');
    el.innerHTML = '';
    for (const l of log) {
      const d = document.createElement('div');
      d.className = (l.cls || '') + (l.tier ? ' r' + l.tier : '');
      d.textContent = l.text;
      el.appendChild(d);
    }
    el.scrollTop = el.scrollHeight;
  }

  function renderOverlay() {
    const ov = $('overlay');
    if (!state || state.phase !== 'over' || !view.winner) { ov.classList.add('hidden'); return; }
    const w = view.winner;
    const h = $('overTitle');
    let sub;
    if (view.you === 'both' || !view.you) {
      h.textContent = `ПОБЕДА ${SIDE_GEN[w]}`;
      h.className = w;
      sub = 'Вражеский Командир уничтожен.';
    } else if (view.you === w) {
      h.textContent = 'ПОБЕДА!'; h.className = 'win';
      sub = 'Вражеский Командир уничтожен. Отличная работа, командир.';
    } else {
      h.textContent = 'ПОРАЖЕНИЕ'; h.className = 'lose';
      sub = 'Ваш Командир пал. Реванш?';
    }
    const rb = $('btnRematch');
    if (view.you === 'both') { rb.textContent = 'Реванш'; rb.disabled = false; }
    else if (view.you) {
      const votes = (state.rematch.blue ? 1 : 0) + (state.rematch.red ? 1 : 0);
      const mine = state.rematch[view.you];
      rb.textContent = mine ? `Ждём соперника (${votes}/2)` : `Реванш (${votes}/2)`;
      rb.disabled = mine;
    } else { rb.textContent = 'Реванш'; rb.disabled = true; }
    $('btnToLobby').disabled = !view.you;
    $('btnToLobby').classList.toggle('hidden', view.you === 'both');
    $('overSub').textContent = sub;
    const rw = state.rewards, ore = $('overReward');
    let rt = '', rc = '';
    if (rw && rw.note) { rt = rw.note; rc = 'dim'; }
    else if (rw && (view.you === 'blue' || view.you === 'red') && rw[view.you] != null) {
      const d = rw[view.you];
      rt = d >= 0 ? `+${d} 💰` : `−${-d} 💰`; rc = d >= 0 ? 'plus' : 'minus';
    }
    ore.textContent = rt;
    ore.className = 'over-reward ' + rc;
    if (overShownFor !== state.gameId) {
      overShownFor = state.gameId;
      overHidden = false;
      if (view.you === 'both' || view.you === w || !view.you) Sound.victory(); else Sound.defeat();
      const c = cellCenter(3.5, 3.5);
      for (let i = 0; i < 4; i++) setTimeout(() => burst({ x: c.x + (Math.random() - 0.5) * C * 5, y: c.y + (Math.random() - 0.5) * C * 5 }, 30, ['#facc15', '#22d3ee', '#f472b6', '#4ade80', '#fff'], 3), i * 250);
    }
    ov.classList.toggle('hidden', overHidden);
  }

  // ------------------------------------------------------------ ввод
  function cellFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    const cx = Math.floor(((e.clientX - r.left) / r.width) * N);
    const cy = Math.floor(((e.clientY - r.top) / r.height) * N);
    if (cx < 0 || cy < 0 || cx >= N || cy >= N) return null;
    return { x: fx(cx), y: fx(cy) };
  }
  function select(id) {
    if (selectedId !== id && id) Sound.select();
    selectedId = id;
    mode = 'normal';
    renderCard();
  }
  function cancel() {
    if (mode !== 'normal') { mode = 'normal'; renderCard(); }
    else select(null);
  }

  function onCellClick(c) {
    if (!view) return;
    Sound.unlock();
    const side = actingSide();
    const cu = R.unitAt(view, c.x, c.y);
    const su = selUnit();
    if (!side || animating || pending) { select(cu ? cu.id : null); return; }
    const own = su && su.side === side;
    if (own && mode !== 'normal') {
      if (mode === 'ability') {
        if (R.abilityTargets(view, su).some((p) => p.x === c.x && p.y === c.y)) sendAction({ type: 'ability', unitId: su.id, x: c.x, y: c.y });
        else cancel();
        return;
      }
      if (mode === 'jetpack') {
        if (R.jetpackCells(view, su).some((p) => p.x === c.x && p.y === c.y)) sendAction({ type: 'jetpack', unitId: su.id, x: c.x, y: c.y });
        else cancel();
        return;
      }
      if (mode === 'mine') {
        if (R.mineCells(view, su).some((p) => p.x === c.x && p.y === c.y)) sendAction({ type: 'mine', unitId: su.id, x: c.x, y: c.y });
        else cancel();
        return;
      }
      if (mode === 'shotgun') {
        if (cu && cu.side !== side) {
          const inf = R.attackInfo(view, su, cu, 'shotgun');
          if (inf.ok) sendAction({ type: 'shotgun', unitId: su.id, targetId: cu.id });
          else { toast(inf.reason, 'err'); Sound.error(); }
        } else cancel();
        return;
      }
    }
    if (cu && cu.side === side) { select(cu.id); return; }
    if (own) {
      if (cu) {
        const inf = R.attackInfo(view, su, cu, 'normal');
        if (inf.ok) { sendAction({ type: 'attack', unitId: su.id, targetId: cu.id }); return; }
        if (su.item && su.item.type === 'shotgun') {
          const s2 = R.attackInfo(view, su, cu, 'shotgun');
          if (s2.ok) { sendAction({ type: 'shotgun', unitId: su.id, targetId: cu.id }); return; }
        }
        // слоник: если атаковать нельзя — таранит
        if (R.UNIT_TYPES[su.type].trample && R.canMove(view, su) && R.moveCells(view, su).some((p) => p.x === c.x && p.y === c.y)) {
          sendAction({ type: 'move', unitId: su.id, x: c.x, y: c.y });
          return;
        }
        toast(inf.reason, 'err'); Sound.error();
        return;
      }
      if (R.canMove(view, su) && R.moveCells(view, su).some((p) => p.x === c.x && p.y === c.y)) {
        sendAction({ type: 'move', unitId: su.id, x: c.x, y: c.y });
        return;
      }
      select(null);
      return;
    }
    select(cu ? cu.id : null);
  }

  canvas.addEventListener('click', (e) => { const c = cellFromEvent(e); if (c) onCellClick(c); });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); });
  canvas.addEventListener('mousemove', (e) => {
    hover = cellFromEvent(e);
    canvas.style.cursor = hover && view && (R.unitAt(view, hover.x, hover.y) || (selUnit() && actingSide())) ? 'pointer' : 'default';
  });
  canvas.addEventListener('mouseleave', () => { hover = null; });

  function endTurn() {
    if (!canInput()) return;
    Sound.unlock();
    sendAction({ type: 'endTurn' });
  }
  $('btnEndTurn').onclick = endTurn;
  $('btnSurrender').onclick = () => { if (confirm('Сдаться и завершить матч?')) socket.emit('surrender'); };
  $('btnLeaveGame').onclick = () => socket.emit('leaveRoom');
  $('btnCancel').onclick = () => cancel();
  $('btnRematch').onclick = () => { Sound.unlock(); socket.emit('rematch'); };
  $('btnToLobby').onclick = () => socket.emit('toLobby');
  $('btnToMenu').onclick = () => socket.emit('leaveRoom');
  $('btnHideOver').onclick = () => { overHidden = true; $('overlay').classList.add('hidden'); toast('Нажмите Esc, чтобы вернуть экран победы'); };
  $('btnReady').onclick = () => { Sound.unlock(); socket.emit('ready'); };
  $('btnSolo').onclick = () => { Sound.unlock(); socket.emit('solo'); };
  $('btnCreate').onclick = () => { Sound.unlock(); socket.emit('createRoom'); };
  $('btnJoin').onclick = () => joinByCode($('codeInput').value);
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinByCode(e.target.value); });
  $('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); });
  $('btnLeave').onclick = () => socket.emit('leaveRoom');
  $('btnCopy').onclick = async () => {
    const url = inviteUrl();
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'Tactical Loot Chess', text: `Заходи в комнату ${roomCode}!`, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована — отправьте её другу'); Sound.ready(); }
    catch (e) { window.prompt('Скопируйте ссылку:', url); }
  };
  // звуки интерфейса меню: наведение и нажатие
  document.addEventListener('pointerover', (e) => {
    const b = e.target.closest && e.target.closest('.btn');
    if (b && !b.disabled && e.pointerType === 'mouse' && !b.contains(e.relatedTarget)) Sound.hover();
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.menu-screen .btn');
    if (b && !b.disabled && b.id !== 'btnReady' && b.id !== 'btnCopy') Sound.click();
  });
  const muteBtn = $('btnMute');
  const syncMute = () => { muteBtn.textContent = Sound.isMuted() ? '🔇' : '🔊'; };
  muteBtn.onclick = () => { Sound.toggleMute(); syncMute(); };
  syncMute();

  let nameTimer = null;
  $('nameInput').addEventListener('input', (e) => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => {
      myName = e.target.value.trim().slice(0, 16) || myName;
      store.set(localStorage, 'tlc_name', myName);
      socket.emit('setName', myName);
    }, 300);
  });

  document.addEventListener('pointerdown', () => Sound.unlock(), { once: true });
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') {
      if (state && state.phase === 'over' && overHidden) { overHidden = false; renderOverlay(); return; }
      cancel();
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (!$('game').classList.contains('hidden')) { e.preventDefault(); endTurn(); }
    } else if (e.key === 'm' || e.key === 'M' || e.key === 'ь' || e.key === 'Ь') {
      Sound.toggleMute(); syncMute();
    } else if (e.key === 'Tab' && view && actingSide()) {
      e.preventDefault();
      const own = view.units.filter((u) => u.alive && u.side === actingSide() && R.canUseUnit(view, u));
      if (!own.length) return;
      const i = own.findIndex((u) => u.id === selectedId);
      select(own[(i + 1) % own.length].id);
    }
  });

  // ------------------------------------------------------------ рендер
  function unitPos(u, now) {
    const a = anims.get(u.id);
    if (!a) return { x: u.x, y: u.y, z: 0 };
    const p = Math.min(1, Math.max(0, (now - a.t0) / a.dur));
    if (a.type === 'path') {
      const segs = a.path.length - 1;
      const f = p * segs;
      const i = Math.min(segs - 1, Math.floor(f));
      const r = f - i;
      const A = a.path[i], B = a.path[i + 1];
      return { x: A[0] + (B[0] - A[0]) * r, y: A[1] + (B[1] - A[1]) * r, z: Math.sin(r * Math.PI) * 0.08 };
    }
    const e = a.type === 'jet' ? p * p * (3 - 2 * p) : 1 - (1 - p) * (1 - p);
    return {
      x: a.from.x + (a.to.x - a.from.x) * e,
      y: a.from.y + (a.to.y - a.from.y) * e,
      z: a.type === 'jet' ? Math.sin(p * Math.PI) * 1.3 : 0,
    };
  }

  function fillCell(x, y, color, inset) {
    const i = inset == null ? S : inset;
    ctx.fillStyle = color;
    ctx.fillRect(fx(x) * C + i, fx(y) * C + i, C - 2 * i, C - 2 * i);
  }
  function frameCell(x, y, color, t, inset) {
    const px = fx(x) * C + (inset || 0), py = fx(y) * C + (inset || 0), w = C - 2 * (inset || 0);
    ctx.fillStyle = color;
    ctx.fillRect(px, py, w, t); ctx.fillRect(px, py + w - t, w, t);
    ctx.fillRect(px, py, t, w); ctx.fillRect(px + w - t, py, t, w);
  }
  function brackets(px, py, size, color, len, t) {
    ctx.fillStyle = color;
    const L = len, e = size;
    ctx.fillRect(px, py, L, t); ctx.fillRect(px, py, t, L);
    ctx.fillRect(px + e - L, py, L, t); ctx.fillRect(px + e - t, py, t, L);
    ctx.fillRect(px, py + e - t, L, t); ctx.fillRect(px, py + e - L, t, L);
    ctx.fillRect(px + e - L, py + e - t, L, t); ctx.fillRect(px + e - t, py + e - L, t, L);
  }
  function pixLine(x0, y0, x1, y1, size, color, gap, offset) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const step = size * (gap || 1);
    ctx.fillStyle = color;
    for (let s = (offset || 0) % step; s <= d; s += step) {
      const t = d ? s / d : 0;
      ctx.fillRect(snap(x0 + (x1 - x0) * t - size / 2), snap(y0 + (y1 - y0) * t - size / 2), size, size);
    }
  }
  function label(text, cx, cy, color, bg) {
    const fs = Math.max(10, Math.round(C * 0.22));
    ctx.font = `bold ${fs}px Consolas, Menlo, "DejaVu Sans Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = Math.ceil(ctx.measureText(text).width) + S * 4;
    const h = fs + S * 2;
    ctx.fillStyle = bg || 'rgba(5,8,13,0.88)';
    ctx.fillRect(snap(cx - w / 2), snap(cy - h / 2), w, h);
    ctx.fillStyle = color;
    ctx.fillRect(snap(cx - w / 2), snap(cy + h / 2) - S, w, S);
    ctx.fillText(text, Math.round(cx), Math.round(cy));
  }
  function outlinedText(text, cx, cy, color, alpha) {
    const fs = Math.max(12, Math.round(C * 0.3));
    ctx.font = `bold ${fs}px Consolas, Menlo, "DejaVu Sans Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(2, S);
    ctx.strokeStyle = '#000';
    ctx.strokeText(text, Math.round(cx), Math.round(cy));
    ctx.fillStyle = color;
    ctx.fillText(text, Math.round(cx), Math.round(cy));
    ctx.globalAlpha = 1;
  }

  function drawBoard(now) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      ctx.drawImage(Sprites.get((x + y) % 2 ? 'floorA' : 'floorB'), fx(x) * C, fx(y) * C, C, C);
    }
    // зоны баз
    for (const [y, col] of [[0, 'rgba(239,68,68,0.07)'], [1, 'rgba(239,68,68,0.04)'], [6, 'rgba(59,130,246,0.04)'], [7, 'rgba(59,130,246,0.07)']]) {
      ctx.fillStyle = col;
      ctx.fillRect(0, fx(y) * C, C * N, C);
    }
  }

  function drawHighlights(now) {
    const side = actingSide();
    const su = selUnit();
    if (!su || !side || su.side !== side || animating) return;
    const pulse = 0.5 + 0.5 * Math.sin(now / 180);
    if (mode === 'normal') {
      if (R.canMove(view, su)) {
        for (const { x, y } of R.moveCells(view, su)) {
          if (R.rammable(view, su, x, y)) {
            fillCell(x, y, 'rgba(251,146,60,0.22)');
            frameCell(x, y, `rgba(251,146,60,${0.45 + 0.4 * pulse})`, S, S);
            continue;
          }
          fillCell(x, y, 'rgba(34,211,238,0.16)');
          frameCell(x, y, 'rgba(34,211,238,0.35)', S, S);
        }
      }
      if (R.canShoot(view, su)) {
        const T = R.UNIT_TYPES[su.type];
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          const d = R.cheb(su, { x, y });
          if (d < T.minRange || d > R.unitRange(su) || R.isWall(view, x, y) || (!T.lob && !R.hasLOS(view, su, { x, y }))) continue;
          ctx.fillStyle = 'rgba(248,113,113,0.35)';
          ctx.fillRect(fx(x) * C + C / 2 - S, fx(y) * C + C / 2 - S, 2 * S, 2 * S);
        }
        for (const t of R.targets(view, su, 'normal')) {
          const bs = R.attackInfo(view, su, t, 'normal').backstab;
          frameCell(t.x, t.y, bs ? `rgba(192,132,252,${0.6 + 0.4 * pulse})` : `rgba(248,80,80,${0.55 + 0.45 * pulse})`, S, 0);
          if (bs) frameCell(t.x, t.y, `rgba(192,132,252,${0.4 + 0.4 * pulse})`, S, S * 2);
        }
        if (su.item && su.item.type === 'shotgun') {
          for (const t of R.targets(view, su, 'shotgun')) frameCell(t.x, t.y, `rgba(251,146,60,${0.55 + 0.45 * pulse})`, S, S * 2);
        }
      }
    } else if (mode === 'ability') {
      for (const c of R.abilityTargets(view, su)) {
        fillCell(c.x, c.y, 'rgba(74,222,128,0.2)');
        frameCell(c.x, c.y, `rgba(74,222,128,${0.45 + 0.4 * pulse})`, S, S);
      }
    } else if (mode === 'jetpack') {
      for (const c of R.jetpackCells(view, su)) {
        fillCell(c.x, c.y, 'rgba(167,139,250,0.2)');
        frameCell(c.x, c.y, 'rgba(167,139,250,0.45)', S, S);
      }
    } else if (mode === 'mine') {
      for (const c of R.mineCells(view, su)) {
        fillCell(c.x, c.y, 'rgba(251,146,60,0.22)');
        frameCell(c.x, c.y, `rgba(251,146,60,${0.4 + 0.4 * pulse})`, S, S);
      }
    } else if (mode === 'shotgun') {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const d = R.cheb(su, { x, y });
        if (d < 1 || d > 2 || R.isWall(view, x, y) || !R.hasLOS(view, su, { x, y })) continue;
        fillCell(x, y, 'rgba(251,146,60,0.12)');
      }
      for (const t of R.targets(view, su, 'shotgun')) frameCell(t.x, t.y, `rgba(251,146,60,${0.55 + 0.45 * pulse})`, S, 0);
    }
  }

  function drawObjects(now) {
    for (const w of view.walls) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(fx(w.x) * C + 2 * S, fx(w.y) * C + 2 * S, C, C - S);
      ctx.drawImage(Sprites.get('wall'), fx(w.x) * C, fx(w.y) * C, C, C);
    }
    for (const c of view.crates) {
      let yo = ((Math.floor(now / 500) + c.x + c.y) % 2) * -S;
      const t0 = crateDrops.get(c.id);
      if (t0) {
        const p = Math.min(1, (now - t0) / 380);
        yo = -Math.pow(1 - p, 2) * C * 3;
        if (p >= 1) crateDrops.delete(c.id);
      }
      const px = fx(c.x) * C, py = fx(c.y) * C;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(px + 3 * S, py + 14 * S, 10 * S, 2 * S);
      ctx.drawImage(Sprites.get('crate'), px, snap(py + yo), C, C);
    }
    for (const m of view.mines) {
      const px = fx(m.x) * C, py = fx(m.y) * C;
      const s = Math.max(1, Math.floor(S / 2)) * 16;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(Sprites.icon('landmine'), px + (C - s) / 2 | 0, py + (C - s) / 2 + 2 * S | 0, s, s);
      ctx.globalAlpha = 1;
      if (Math.floor(now / 400) % 2) {
        ctx.fillStyle = m.side === 'blue' ? '#60a5fa' : '#f87171';
        ctx.fillRect(px + C / 2 - S, py + C / 2 - S, 2 * S, 2 * S);
      }
      frameCell(m.x, m.y, m.side === 'blue' ? 'rgba(96,165,250,0.35)' : 'rgba(248,113,113,0.35)', S, 3 * S);
    }
  }

  function drawUnits(now) {
    const list = view.units.filter((u) => u.alive).map((u) => ({ u, p: unitPos(u, now) }));
    list.sort((a, b) => fx(a.p.y) - fx(b.p.y));
    const sel = selUnit();
    for (const { u, p } of list) {
      const gx = snap(fx(p.x) * C);
      const gy = snap(fx(p.y) * C);
      // «дыхание»: все юниты покачиваются (у ходящей стороны — чаще); турель стоит неподвижно
      const ph = u.id.charCodeAt(u.id.length - 1) + u.id.length;
      const rate = u.side === view.turn ? 420 : 640;
      const idle = !anims.has(u.id) && !R.UNIT_TYPES[u.type].static && Math.floor(now / rate + ph) % 2 === 0 ? -S : 0;
      const py = snap(gy - p.z * C + idle);
      // тень и подставка команды
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(gx + 3 * S, gy + 14 * S, 10 * S, 2 * S);
      ctx.fillStyle = u.side === 'blue' ? 'rgba(59,130,246,0.55)' : 'rgba(239,68,68,0.55)';
      ctx.fillRect(gx + 4 * S, gy + 15 * S, 8 * S, S);

      let alpha = 1;
      const stat = R.UNIT_TYPES[u.type].static;
      if (u.side === view.turn && !view.winner && !stat) {
        if (!R.canUseUnit(view, u)) alpha = 0.45;
        else if (view.activated.includes(u.id) && !R.canMove(view, u) && !R.canAct(view, u)) alpha = 0.5;
      }
      if (R.isHidden(view, u)) alpha *= 0.45 + 0.1 * Math.sin(now / 300); // свой скрытый диверсант
      ctx.globalAlpha = alpha;
      const flash = (flashes.get(u.id) || 0) > now;
      ctx.drawImage(Sprites.get(u.type, u.side, flash ? 'flash' : ''), gx, py, C, C);
      if (u.item && u.item.type === 'shield') {
        ctx.globalAlpha = 0.45 + 0.35 * Math.sin(now / 160);
        ctx.drawImage(Sprites.get('shieldfx'), gx, py, C, C);
      }
      ctx.globalAlpha = 1;

      // полоска HP (над головой)
      const bw = 12 * S, bx = gx + 2 * S, by = py - S;
      ctx.fillStyle = '#111';
      ctx.fillRect(bx - S, by - S, bw + 2 * S, 3 * S);
      const ratio = u.hp / u.maxHp;
      ctx.fillStyle = ratio > 0.6 ? '#4ade80' : ratio > 0.3 ? '#facc15' : '#ef4444';
      ctx.fillRect(bx, by, Math.max(S, Math.round((bw * ratio) / S) * S), S);
      // иконка лута над головой
      if (u.item) {
        const s = Math.max(1, Math.floor(S / 2));
        const sz = 16 * s;
        const ix = gx + C - sz + S;
        const iy = py - sz + 2 * S + ((Math.floor(now / 350) % 2) ? 0 : -s);
        const tier = u.item.tier || 0;
        const rc = tier === 4 ? `hsl(${(now / 4) % 360},95%,62%)` : R.RARITIES[tier].color;
        ctx.fillStyle = rc;
        ctx.fillRect(ix - 2 * s, iy - 2 * s, sz + 4 * s, sz + 4 * s);
        ctx.fillStyle = 'rgba(5,8,13,0.92)';
        ctx.fillRect(ix - s, iy - s, sz + 2 * s, sz + 2 * s);
        ctx.drawImage(Sprites.icon(u.item.type), ix, iy, sz, sz);
        if ((u.item.charges || 1) > 1) {
          const fs = Math.max(9, Math.round(C * 0.17));
          ctx.font = `bold ${fs}px Consolas, Menlo, monospace`;
          ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
          ctx.lineWidth = Math.max(2, s); ctx.strokeStyle = '#000';
          ctx.strokeText('x' + u.item.charges, ix + sz + s, iy + sz + s);
          ctx.fillStyle = '#fff';
          ctx.fillText('x' + u.item.charges, ix + sz + s, iy + sz + s);
        }
      }
      // контузия
      if (u.slowed || u.slowNext) {
        ctx.fillStyle = Math.floor(now / 250) % 2 ? '#facc15' : '#a16207';
        ctx.fillRect(gx + S, py + 3 * S, 2 * S, S);
        ctx.fillRect(gx + S, py + 5 * S, 2 * S, S);
        ctx.fillRect(gx + 2 * S, py + 4 * S, S, S);
      }
      // индикаторы Движение/Действие у задействованного юнита
      if (u.side === view.turn && view.activated.includes(u.id) && !view.winner) {
        ctx.fillStyle = R.canMove(view, u) ? '#22d3ee' : '#334155';
        ctx.fillRect(gx + S, gy + C - 4 * S, 2 * S, 2 * S);
        ctx.fillStyle = R.canAct(view, u) ? '#f87171' : '#334155';
        ctx.fillRect(gx + S, gy + C - 7 * S, 2 * S, 2 * S);
      }
      if (sel && sel.id === u.id) {
        const o = Math.floor(now / 250) % 2 ? 0 : S;
        brackets(gx + o, gy + o, C - 2 * o, '#22d3ee', 4 * S, S);
      }
    }
  }

  function drawHover(now) {
    if (!hover || !view) return;
    const su = selUnit();
    const side = actingSide();
    brackets(fx(hover.x) * C, fx(hover.y) * C, C, 'rgba(255,255,255,0.35)', 3 * S, S);
    if (!su || !side || su.side !== side || animating) return;
    const hu = R.unitAt(view, hover.x, hover.y);
    const enemy = hu && hu.side !== su.side;
    const sp = unitPos(su, now);
    const from = { x: (fx(sp.x) + 0.5) * C, y: (fx(sp.y) + 0.5) * C };
    const dash = Math.floor(now / 40);

    const aim = (t, m, color) => {
      const inf = R.attackInfo(view, su, t, m);
      const to = cellCenter(t.x, t.y);
      if (!inf.ok) {
        label(inf.reason, to.x, fx(t.y) * C - S * 2, '#9ca3af');
        return;
      }
      pixLine(from.x, from.y, to.x, to.y, S, color, 3, dash * S);
      brackets(fx(t.x) * C - S, fx(t.y) * C - S, C + 2 * S, color, 5 * S, S);
      if (m === 'shotgun') {
        for (const [dx, dy] of R.DIR8) {
          const x = t.x + dx, y = t.y + dy;
          if (!R.inBounds(x, y)) continue;
          fillCell(x, y, 'rgba(251,146,60,0.22)', 2 * S);
          const o = R.unitAt(view, x, y);
          if (o && o !== su) {
            const c = cellCenter(x, y);
            label(o.item && o.item.type === 'shield' ? 'ЩИТ' : `-${R.itemStat('shotgun', su.item.tier, 'splash')}`, c.x, fx(y) * C - 2 * S, '#fb923c');
          }
        }
      }
      const shield = t.item && t.item.type === 'shield';
      const kill = !shield && inf.dmg >= t.hp;
      const txt = shield ? 'ЩИТ: 0 урона' : inf.backstab ? `В СПИНУ -${inf.dmg}${kill ? ' ☠' : ''}` : `-${inf.dmg} HP${kill ? ' ☠' : ''}`;
      label(txt, to.x, fx(t.y) * C - S * 2, shield ? '#22d3ee' : inf.backstab ? '#c084fc' : kill ? '#facc15' : '#f87171');
    };

    if (mode === 'normal') {
      const canRam = R.UNIT_TYPES[su.type].trample && R.canMove(view, su) && R.moveCells(view, su).some((p) => p.x === hover.x && p.y === hover.y);
      const ramEnemy = enemy && canRam && !R.attackInfo(view, su, hu, 'normal').ok;
      if (enemy && !ramEnemy) {
        const n = R.attackInfo(view, su, hu, 'normal');
        if (!n.ok && su.item && su.item.type === 'shotgun' && R.attackInfo(view, su, hu, 'shotgun').ok) aim(hu, 'shotgun', '#fb923c');
        else aim(hu, 'normal', '#f87171');
      } else if ((!hu || ramEnemy) && R.canMove(view, su)) {
        const path = R.pathTo(R.reachable(view, su), hover.x, hover.y);
        if (path && R.UNIT_TYPES[su.type].trample) {
          // подписи тарана: что сломает и кого протаранит на этом пути
          for (let i = 1; i < path.length; i++) {
            const [px, py] = path[i];
            const c = cellCenter(px, py);
            if (R.isWall(view, px, py)) label('ЛОМАЕТ', c.x, fx(py) * C - 2 * S, '#facc15');
            const o = R.unitAt(view, px, py);
            if (o && o.side !== su.side) label(`ТАРАН -${R.unitDmg(su)}`, c.x, fx(py) * C - 2 * S, '#fb923c');
          }
        }
        if (path && path.length > 1) {
          ctx.fillStyle = '#22d3ee';
          for (let i = 1; i < path.length; i++) {
            const c = cellCenter(path[i][0], path[i][1]);
            const sz = i === path.length - 1 ? 4 * S : 2 * S;
            ctx.fillRect(snap(c.x - sz / 2), snap(c.y - sz / 2), sz, sz);
          }
          const c = cellCenter(hover.x, hover.y);
          if (R.crateAt(view, hover.x, hover.y)) label('ЛУТ', c.x, fx(hover.y) * C + S * 2, '#facc15');
        }
      }
    } else if (mode === 'shotgun' && enemy) {
      aim(hu, 'shotgun', '#fb923c');
    } else if (mode === 'jetpack' && R.jetpackCells(view, su).some((c) => c.x === hover.x && c.y === hover.y)) {
      const to = cellCenter(hover.x, hover.y);
      for (let i = 1; i < 12; i++) {
        const t = i / 12;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * C * 1.3;
        ctx.fillStyle = '#a78bfa';
        ctx.fillRect(snap(x - S), snap(y - S), 2 * S, 2 * S);
      }
      ctx.globalAlpha = 0.5;
      ctx.drawImage(Sprites.get(su.type, su.side), fx(hover.x) * C, fx(hover.y) * C, C, C);
      ctx.globalAlpha = 1;
    } else if (mode === 'mine' && R.mineCells(view, su).some((c) => c.x === hover.x && c.y === hover.y)) {
      const s = Math.max(1, Math.floor(S / 2)) * 16;
      ctx.globalAlpha = 0.6;
      ctx.drawImage(Sprites.icon('landmine'), fx(hover.x) * C + (C - s) / 2 | 0, fx(hover.y) * C + (C - s) / 2 | 0, s, s);
      ctx.globalAlpha = 1;
    }
  }

  // Снаряды-спрайты: [имя, вращается, размер в долях клетки]
  const PROJ_SPRITE = {
    knife: ['p_knife', true, 0.6], bone: ['p_bone', true, 0.7], syringe: ['p_syringe', false, 0.6],
    dart: ['p_dart', false, 0.55], punch: ['p_fist', false, 0.75], shield: ['i_shield', true, 0.6],
  };
  function drawFx(now, dt) {
    // снаряды
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      const t = (now - p.t0) / p.dur;
      const a = cellCenter(p.from.x, p.from.y), b = cellCenter(p.to.x, p.to.y);
      if (t >= 1) {
        projectiles.splice(i, 1);
        const HIT = {
          shotgun: ['#fb923c', '#facc15'], knife: ['#e5e7eb', '#ef4444'], bone: ['#f8fafc', '#d1d5db'], syringe: ['#22d3ee', '#fff'],
          dart: ['#22d3ee', '#fff'], punch: ['#fb923c', '#9ca3af', '#fff'], shield: ['#22d3ee', '#93c5fd'], wave: ['#4ade80', '#bbf7d0'],
          bolt: ['#facc15', '#fde68a', '#fff'],
        };
        burst(b, p.kind === 'punch' ? 14 : 8, HIT[p.kind] || ['#fff', TEAM_COL[p.side] || '#fff'], 1.6);
        if (p.kind === 'punch' || p.kind === 'bone') shake = Math.max(shake, 2.5);
        continue;
      }
      const hx = a.x + (b.x - a.x) * t, hy = a.y + (b.y - a.y) * t;
      if (p.kind === 'sniper') {
        pixLine(a.x, a.y, hx, hy, S, '#fde68a', 1);
        ctx.fillStyle = '#fff';
        ctx.fillRect(snap(hx - S * 1.5), snap(hy - S * 1.5), 3 * S, 3 * S);
      } else if (PROJ_SPRITE[p.kind]) {
        // предметы-снаряды: нож и кость вращаются, шприц/дротик/кулак летят остриём вперёд
        const [name, spin, scale] = PROJ_SPRITE[p.kind];
        const ang = spin ? t * Math.PI * 6 : Math.atan2(b.y - a.y, b.x - a.x);
        const size = C * scale;
        ctx.save();
        ctx.translate(snap(hx), snap(hy));
        ctx.rotate(ang);
        ctx.drawImage(Sprites.get(name), -size / 2, -size / 2, size, size);
        ctx.restore();
      } else if (p.kind === 'bolt') {
        const tx = a.x + (b.x - a.x) * Math.max(0, t - 0.3), ty = a.y + (b.y - a.y) * Math.max(0, t - 0.3);
        pixLine(tx, ty, hx, hy, 4 * S, '#a16207', 1);
        pixLine(tx, ty, hx, hy, 2 * S, '#facc15', 1);
        ctx.fillStyle = '#fff';
        ctx.fillRect(snap(hx - 2 * S), snap(hy - 2 * S), 4 * S, 4 * S);
      } else if (p.kind === 'burst') {
        // очередь из трёх пуль
        for (let k = 0; k < 3; k++) {
          const tk = (t * 1.6) - k * 0.3;
          if (tk < 0 || tk > 1) continue;
          const bx = a.x + (b.x - a.x) * tk, by = a.y + (b.y - a.y) * tk;
          ctx.fillStyle = '#facc15';
          ctx.fillRect(snap(bx - S), snap(by - S), 2 * S, 2 * S);
          ctx.fillStyle = TEAM_COL[p.side] || '#fff';
          ctx.fillRect(snap(bx - S - (b.x - a.x) / Math.hypot(b.x - a.x, b.y - a.y || 1) * 2 * S), snap(by - S), S, S);
        }
      } else if (p.kind === 'wave') {
        // радиоволны: три дуги, расходящиеся к цели
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        for (let k = 0; k < 3; k++) {
          const tk = t - k * 0.18;
          if (tk < 0 || tk > 1) continue;
          const cx = a.x + (b.x - a.x) * tk, cy = a.y + (b.y - a.y) * tk;
          const r = C * (0.18 + 0.12 * k);
          ctx.fillStyle = k === 0 ? '#bbf7d0' : '#4ade80';
          for (let j = -3; j <= 3; j++) {
            const aa = ang + j * 0.22;
            ctx.fillRect(snap(cx + Math.cos(aa) * r - S / 2), snap(cy + Math.sin(aa) * r - S / 2), S, S);
          }
        }
      } else if (p.kind === 'grenade') {
        const z = Math.sin(t * Math.PI) * C * 1.3;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(snap(hx - S), snap(hy - S), 2 * S, 2 * S);
        ctx.fillStyle = '#111';
        ctx.fillRect(snap(hx - 2 * S), snap(hy - z - 2 * S), 4 * S, 4 * S);
        ctx.fillStyle = '#15803d';
        ctx.fillRect(snap(hx - S), snap(hy - z - S), 2 * S, 2 * S);
      } else if (p.kind === 'shotgun') {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const len = Math.hypot(b.x - a.x, b.y - a.y) * t;
        for (let k = -2; k <= 2; k++) {
          const an = ang + k * 0.13;
          ctx.fillStyle = k % 2 ? '#facc15' : '#fb923c';
          ctx.fillRect(snap(a.x + Math.cos(an) * len - S), snap(a.y + Math.sin(an) * len - S), 2 * S, 2 * S);
        }
      } else {
        const col = TEAM_COL[p.side] || '#fff';
        const tx = a.x + (b.x - a.x) * Math.max(0, t - 0.25), ty = a.y + (b.y - a.y) * Math.max(0, t - 0.25);
        pixLine(tx, ty, hx, hy, 2 * S, col, 1);
        ctx.fillStyle = '#fff';
        ctx.fillRect(snap(hx - S), snap(hy - S), 2 * S, 2 * S);
      }
    }
    // взрывы
    for (let i = booms.length - 1; i >= 0; i--) {
      const b = booms[i];
      const f = Math.floor((now - b.t0) / 90);
      if (f > 2) { booms.splice(i, 1); continue; }
      const scale = b.big ? 2 : 1;
      const size = C * scale;
      const c = cellCenter(b.x, b.y);
      ctx.drawImage(Sprites.get('boom' + (f + 1)), snap(c.x - size / 2), snap(c.y - size / 2), size, size);
    }
    // частицы
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }
      p.vy += p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.96;
      const sz = p.size * S;
      ctx.globalAlpha = 1 - p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.fillRect(snap(p.x), snap(p.y), sz, sz);
    }
    ctx.globalAlpha = 1;
    // всплывающие цифры
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      const t = (now - f.t0) / f.dur;
      if (t >= 1) { floats.splice(i, 1); continue; }
      const c = cellCenter(f.x, f.y);
      const y = c.y - C * 0.45 - t * C * 0.6;
      const col = f.rainbow ? `hsl(${(now / 3) % 360},95%,65%)` : f.color;
      outlinedText(f.text, c.x, snap(y), col, t > 0.7 ? (1 - t) / 0.3 : 1);
    }
  }

  let lastFrame = nowMs();
  function frame() {
    requestAnimationFrame(frame);
    const now = nowMs();
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    updateTimer(now);
    if ($('game').classList.contains('hidden')) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!view) return;
    let ox = 0, oy = 0;
    if (shake > 0.2) {
      ox = Math.round((Math.random() * 2 - 1) * shake) * S * 0.5;
      oy = Math.round((Math.random() * 2 - 1) * shake) * S * 0.5;
      ox = snap(ox); oy = snap(oy);
      shake *= Math.pow(0.02, dt);
    } else shake = 0;
    ctx.translate(ox, oy);
    drawBoard(now);
    drawHighlights(now);
    drawObjects(now);
    drawUnits(now);
    drawHover(now);
    drawFx(now, dt);
  }

  function updateTimer(now) {
    if (!state || !view) return;
    const el = $('timer');
    if (state.phase !== 'game') { el.textContent = '--'; el.classList.remove('warn'); $('timerFill').style.width = '0%'; return; }
    const left = Math.max(0, deadline - now);
    const sec = Math.ceil(left / 1000);
    if (el.textContent !== String(sec)) {
      el.textContent = String(Math.min(sec, R.TURN_SECONDS));
      $('timerFill').style.width = Math.min(100, (left / (R.TURN_SECONDS * 1000)) * 100) + '%';
    }
    el.classList.toggle('warn', sec <= 10);
    if (sec <= 5 && sec > 0 && sec !== lastTickSec && actingSide()) Sound.tick();
    lastTickSec = sec;
  }

  requestAnimationFrame(frame);
  updateScreens(); // меню с живым фоном видно сразу, пока идёт подключение
})();
