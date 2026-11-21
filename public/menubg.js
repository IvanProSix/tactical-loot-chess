/* Живой фон главного меню: медленно плывущее поле, по которому бродят пиксельные юниты,
 * перестреливаются, падают ящики с лутом. Рисуется в низком разрешении (1 пиксель спрайта =
 * несколько CSS-пикселей) и не чаще 30 кадров/с — нагрузка минимальная. */
const MenuBG = (() => {
  'use strict';
  const CELL = 16;
  const FRAME_MS = 1000 / 30;
  const TYPES = ['commander', 'assault', 'sniper', 'scout', 'medic', 'grenadier', 'heavy', 'engineer',
    'saboteur', 'drone', 'shieldbearer', 'signaller'];
  const RARITY = ['#cbd5e1', '#38bdf8', '#c084fc', '#f59e0b', '#f43f5e'];

  let cv = null, ctx = null, W = 0, H = 0, GW = 0, GH = 0, WW = 0, WH = 0;
  let running = false, raf = 0, last = 0, time = 0;
  let cam = { x: 0, y: 0 };
  let vignette = null;
  let units = [], crates = [], shots = [], booms = [], sparks = [];
  let walls = new Set();
  let crateTimer = 2;
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const lowPower = (navigator.hardwareConcurrency || 4) <= 2;

  const rnd = (a, b) => a + Math.random() * (b - a);
  const irnd = (n) => (Math.random() * n) | 0;
  const key = (x, y) => x + ',' + y;
  const wrap = (v, m) => ((v % m) + m) % m;

  function occupied(x, y, except) {
    if (walls.has(key(x, y))) return true;
    return units.some((u) => u !== except && u.alive && ((u.gx === x && u.gy === y) || (u.tx === x && u.ty === y)));
  }
  function freeCell() {
    for (let i = 0; i < 60; i++) {
      const x = irnd(GW), y = irnd(GH);
      if (!occupied(x, y)) return { x, y };
    }
    return { x: irnd(GW), y: irnd(GH) };
  }

  function build() {
    const scale = Math.max(3, Math.min(5, Math.round(window.innerWidth / 400)));
    W = Math.ceil(window.innerWidth / scale);
    H = Math.ceil(window.innerHeight / scale);
    cv.width = W; cv.height = H;
    ctx.imageSmoothingEnabled = false;
    // мир-«тор» немного больше экрана: камера едет по нему бесконечно
    GW = Math.ceil(W / CELL) + 4;
    GH = Math.ceil(H / CELL) + 4;
    WW = GW * CELL; WH = GH * CELL;
    walls = new Set();
    const nw = Math.floor((GW * GH) / 22);
    for (let i = 0; i < nw; i++) walls.add(key(irnd(GW), irnd(GH)));
    units = [];
    const n = Math.min(lowPower ? 8 : 16, Math.max(6, Math.floor((GW * GH) / 26)));
    const order = TYPES.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < n; i++) spawnUnit(i % 2 ? 'red' : 'blue', order[i % order.length]);
    crates = []; shots = []; booms = []; sparks = [];
    vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
    vignette.addColorStop(0, 'rgba(5,8,13,0.5)');
    vignette.addColorStop(1, 'rgba(5,8,13,0.9)');
  }

  function spawnUnit(side, type, fadeIn) {
    const c = freeCell();
    units.push({
      side, type, gx: c.x, gy: c.y, tx: c.x, ty: c.y, t: 1, steps: 0,
      idle: rnd(0.3, 2.5), cd: rnd(1, 4), hp: 3, alive: true, flash: 0, born: fadeIn ? time : -10,
    });
  }

  function pos(u) {
    const e = u.t < 1 ? u.t * u.t * (3 - 2 * u.t) : 1;
    // шаг через «шов» тора: двигаемся по кратчайшему пути
    let dx = u.tx - u.gx, dy = u.ty - u.gy;
    if (Math.abs(dx) > 1) dx = -Math.sign(dx);
    if (Math.abs(dy) > 1) dy = -Math.sign(dy);
    return { x: (u.gx + dx * e) * CELL, y: (u.gy + dy * e) * CELL };
  }
  function screen(wx, wy) {
    let x = wrap(wx - cam.x, WW), y = wrap(wy - cam.y, WH);
    if (x > W + CELL) x -= WW;
    if (y > H + CELL) y -= WH;
    return { x: Math.round(x), y: Math.round(y) };
  }
  // кратчайшая разница координат на торе (в клетках)
  const tdist = (a, b, m) => { const d = Math.abs(a - b); return Math.min(d, m - d); };

  function update(dt) {
    time += dt;
    if (!reduced) { cam.x = wrap(cam.x + dt * 5, WW); cam.y = wrap(cam.y + dt * 2.5, WH); }

    for (const u of units) {
      if (!u.alive) continue;
      if (u.flash > 0) u.flash -= dt;
      if (u.t < 1) {
        u.t = Math.min(1, u.t + dt / 0.32);
        if (u.t >= 1) {
          u.gx = u.tx; u.gy = u.ty;
          const c = crates.find((k) => k.x === u.gx && k.y === u.gy && k.drop >= 1);
          if (c) {
            crates.splice(crates.indexOf(c), 1);
            burst((u.gx + 0.5) * CELL, (u.gy + 0.5) * CELL, 14, [RARITY[c.tier], '#fde68a', '#fff'], -1);
          }
          if (u.steps > 0) { u.steps--; stepRandom(u); } else u.idle = rnd(0.5, 2.2);
        }
        continue;
      }
      u.idle -= dt;
      u.cd -= dt;
      if (!reduced && u.cd <= 0) {
        const range = u.type === 'sniper' ? 5 : 3;
        const foe = units.find((v) => v.alive && v.side !== u.side && v.t >= 1 &&
          tdist(v.gx, u.gx, GW) + tdist(v.gy, u.gy, GH) <= range);
        if (foe) { fire(u, foe); u.cd = rnd(2.5, 6); u.idle = Math.max(u.idle, 0.6); continue; }
        u.cd = rnd(0.5, 1.5);
      }
      if (u.idle <= 0) { u.steps = irnd(3); stepRandom(u); }
    }

    // падающие ящики
    crateTimer -= dt;
    if (crateTimer <= 0 && crates.length < 6) {
      crateTimer = rnd(2.5, 5);
      const c = freeCell();
      crates.push({ x: c.x, y: c.y, drop: 0, tier: Math.random() < 0.08 ? 4 : Math.random() < 0.2 ? 3 : irnd(3), life: 25 });
    }
    for (let i = crates.length - 1; i >= 0; i--) {
      const c = crates[i];
      c.drop = Math.min(1, c.drop + dt / 0.45);
      c.life -= dt;
      if (c.drop >= 1 && !c.landed) { c.landed = true; burst((c.x + 0.5) * CELL, (c.y + 0.9) * CELL, 8, ['#9ca3af', '#facc15']); }
      if (c.life <= 0) crates.splice(i, 1);
    }

    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i];
      s.t += dt / s.dur;
      if (s.t >= 1) {
        shots.splice(i, 1);
        const v = s.target;
        if (!v.alive) continue;
        v.flash = 0.12;
        v.hp--;
        burst(s.x1, s.y1, 8, ['#ef4444', '#fca5a5', '#fff']);
        if (v.hp <= 0) {
          v.alive = false;
          booms.push({ x: s.x1, y: s.y1, t: 0 });
          burst(s.x1, s.y1, 22, ['#f97316', '#facc15', '#ef4444', '#4b5563']);
          setTimeout(() => {
            const i = units.indexOf(v);
            if (i < 0) return; // фон успели пересобрать
            units.splice(i, 1);
            spawnUnit(v.side, v.type, true);
          }, 2500);
        }
      }
    }
    for (let i = booms.length - 1; i >= 0; i--) { booms[i].t += dt / 0.45; if (booms[i].t >= 1) booms.splice(i, 1); }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.life += dt;
      if (p.life >= p.max) { sparks.splice(i, 1); continue; }
      p.vy += p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
  }

  function stepRandom(u) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => Math.random() - 0.5);
    for (const [dx, dy] of dirs) {
      const nx = wrap(u.gx + dx, GW), ny = wrap(u.gy + dy, GH);
      if (!occupied(nx, ny, u)) { u.tx = nx; u.ty = ny; u.t = 0; return; }
    }
    u.idle = rnd(0.5, 1.5);
  }

  function fire(u, v) {
    const a = pos(u), b = pos(v);
    // цель берём по кратчайшему пути на торе
    let bx = b.x, by = b.y;
    if (bx - a.x > WW / 2) bx -= WW; else if (a.x - bx > WW / 2) bx += WW;
    if (by - a.y > WH / 2) by -= WH; else if (a.y - by > WH / 2) by += WH;
    const d = Math.hypot(bx - a.x, by - a.y);
    shots.push({
      x0: a.x + CELL / 2, y0: a.y + CELL / 2, x1: bx + CELL / 2, y1: by + CELL / 2, t: 0,
      dur: u.type === 'sniper' ? 0.12 : 0.08 + d / 260, side: u.side, sniper: u.type === 'sniper', target: v,
    });
    burst(a.x + CELL / 2, a.y + CELL / 2, 4, ['#fff', '#facc15']);
  }

  function burst(x, y, n, colors, up) {
    if (sparks.length > 220) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = rnd(10, 45);
      sparks.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (up ? 25 : 0), g: up ? -10 : 90,
        life: 0, max: rnd(0.3, 0.8), color: colors[irnd(colors.length)],
      });
    }
  }

  function draw() {
    const ox = Math.floor(cam.x), oy = Math.floor(cam.y);
    const c0 = Math.floor(ox / CELL), r0 = Math.floor(oy / CELL);
    const fx = -(ox % CELL), fy = -(oy % CELL);
    const fa = Sprites.get('floorA'), fb = Sprites.get('floorB');
    for (let r = 0; r <= Math.ceil(H / CELL) + 1; r++) {
      for (let c = 0; c <= Math.ceil(W / CELL) + 1; c++) {
        const gx = wrap(c0 + c, GW), gy = wrap(r0 + r, GH);
        const x = fx + c * CELL, y = fy + r * CELL;
        ctx.drawImage((gx + gy) % 2 ? fa : fb, x, y);
        if (walls.has(key(gx, gy))) {
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.fillRect(x + 2, y + 2, CELL, CELL - 1);
          ctx.drawImage(Sprites.get('wall'), x, y);
        }
      }
    }
    const crate = Sprites.get('crate');
    for (const c of crates) {
      const p = screen(c.x * CELL, c.y * CELL);
      const fall = Math.pow(1 - c.drop, 2) * CELL * 4;
      const bob = c.drop >= 1 ? ((Math.floor(time * 2) + c.x) % 2) * -1 : 0;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(p.x + 3, p.y + 14, 10, 2);
      if (c.tier >= 3 && c.drop >= 1) {
        ctx.globalAlpha = 0.25 + 0.2 * Math.sin(time * 5);
        ctx.fillStyle = RARITY[c.tier];
        ctx.fillRect(p.x + 1, p.y + 1, CELL - 2, CELL - 2);
        ctx.globalAlpha = 1;
      }
      if (c.life < 3 && Math.floor(time * 8) % 2) continue;
      ctx.drawImage(crate, p.x, Math.round(p.y - fall + bob));
    }
    const alive = units.filter((u) => u.alive).map((u) => ({ u, p: pos(u) }));
    alive.sort((a, b) => a.p.y - b.p.y);
    for (const { u, p } of alive) {
      const s = screen(p.x, p.y);
      if (s.x < -CELL || s.y < -CELL || s.x > W || s.y > H) continue;
      const hop = u.t < 1 ? -Math.round(Math.sin(u.t * Math.PI) * 2) : ((Math.floor(time * 2.2) + u.gx) % 2 ? 0 : -1);
      const fade = Math.min(1, (time - u.born) / 0.6);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(s.x + 4, s.y + 14, 8, 2);
      ctx.globalAlpha = fade;
      ctx.drawImage(Sprites.get(u.type, u.side, u.flash > 0 ? 'flash' : ''), s.x, s.y + hop);
      ctx.globalAlpha = 1;
    }
    for (const sh of shots) {
      const a = screen(sh.x0, sh.y0);
      const dx = sh.x1 - sh.x0, dy = sh.y1 - sh.y0;
      const col = sh.side === 'blue' ? '#93c5fd' : '#fca5a5';
      if (sh.sniper) {
        ctx.globalAlpha = 1 - sh.t * 0.6;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.x + 0.5, a.y + 0.5); ctx.lineTo(a.x + dx + 0.5, a.y + dy + 0.5); ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        const t = sh.t;
        const hx = Math.round(a.x + dx * t), hy = Math.round(a.y + dy * t);
        const tx = Math.round(a.x + dx * Math.max(0, t - 0.25)), ty = Math.round(a.y + dy * Math.max(0, t - 0.25));
        ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.fillRect(hx - 1, hy - 1, 2, 2);
      }
    }
    for (const b of booms) {
      const s = screen(b.x, b.y);
      const f = Math.min(2, Math.floor(b.t * 3));
      ctx.drawImage(Sprites.get('boom' + (f + 1)), s.x - CELL, s.y - CELL, CELL * 2, CELL * 2);
    }
    for (const p of sparks) {
      const s = screen(p.x, p.y);
      ctx.globalAlpha = 1 - p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.fillRect(s.x, s.y, 1, 1);
    }
    ctx.globalAlpha = 1;
    // затемнение, чтобы меню читалось поверх
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);
  }

  function loop(now) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (now - last < FRAME_MS) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    update(dt);
    draw();
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (cv) { build(); draw(); } }, 200);
  }

  return {
    init(canvas) {
      cv = canvas;
      ctx = cv.getContext('2d');
      build();
      window.addEventListener('resize', onResize);
    },
    start() {
      if (!cv || running) return;
      running = true;
      cv.classList.add('on');
      last = performance.now();
      raf = requestAnimationFrame(loop);
    },
    stop() {
      if (!cv) return;
      running = false;
      cancelAnimationFrame(raf);
      cv.classList.remove('on');
    },
  };
})();
