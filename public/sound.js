/* Процедурный звук на Web Audio API — без внешних аудиофайлов. */
const Sound = (() => {
  'use strict';
  let ac = null, master = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem('tlc_muted') === '1'; } catch (e) { /* ignore */ }
  const VOL = 0.5;

  function ensure() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createGain();
      master.gain.value = muted ? 0 : VOL;
      const comp = ac.createDynamicsCompressor();
      master.connect(comp);
      comp.connect(ac.destination);
      const len = ac.sampleRate;
      noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  // ================= МУЗЫКА: маленький секвенсор и две оригинальные чиптюн-темы =================
  // Ноты пишутся по 16 шагов (шестнадцатые) на такт: «A4» — нота, «-» — тянуть, «.» — пауза.
  const NN = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  const midi = (s) => { const m = /^([A-G][#b]?)(-?\d)$/.exec(s); return 12 * (+m[2] + 1) + NN[m[1]]; };
  const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const chord = (s) => s.split(' ').map(midi);
  // мелодия такта -> [{step, len, n}]
  function parseBar(str) {
    const tk = str.trim().split(/\s+/), out = [];
    for (let i = 0; i < tk.length; i++) {
      if (tk[i] === '-' || tk[i] === '.') continue;
      let len = 1;
      while (tk[i + len] === '-') len++;
      out.push({ step: i, len, n: midi(tk[i]) });
    }
    return out;
  }

  const TRACKS = {
    // Меню: «Привал» — спокойно, ля минор. Первый круг — пэд и арпеджио, со второго вступает мелодия.
    menu: {
      bpm: 84, vol: 0.55,
      chords: ['A3 C4 E4', 'F3 A3 C4', 'C4 E4 G4', 'G3 B3 D4', 'A3 C4 E4', 'F3 A3 C4', 'G3 B3 D4', 'E3 G#3 B3'].map(chord),
      bass: ['A2', 'F2', 'C3', 'G2', 'A2', 'F2', 'G2', 'E2'].map(midi),
      lead: [
        'E5 - - - . . A4 - C5 - - - B4 - A4 -', 'C5 - - - - - - - A4 - - - . . . .',
        'G4 - - - C5 - - - E5 - - - D5 - C5 -', 'D5 - - - - - - - B4 - - - . . . .',
        'E5 - - - . . A5 - G5 - - - E5 - C5 -', 'F5 - - - E5 - C5 - A4 - - - . . . .',
        'B4 - - - D5 - - - G5 - - - F5 - D5 -', 'E5 - - - - - - - G#4 - - - B4 - - -',
      ].map(parseBar),
      leadFrom: 1,
      style: 'calm',
    },
    // Бой: «Тактика» — ре минор, 132 удара. Часть A — 8 тактов, часть B — 8 тактов, по кругу.
    battle: {
      bpm: 132, vol: 0.5,
      chords: ['D4 F4 A4', 'Bb3 D4 F4', 'C4 E4 G4', 'A3 C4 E4', 'D4 F4 A4', 'Bb3 D4 F4', 'G3 Bb3 D4', 'A3 C#4 E4',
        'Bb3 D4 F4', 'C4 E4 G4', 'D4 F4 A4', 'D4 F4 A4', 'G3 Bb3 D4', 'A3 C#4 E4', 'D4 F4 A4', 'A3 C#4 E4'].map(chord),
      bass: ['D2', 'Bb1', 'C2', 'A1', 'D2', 'Bb1', 'G1', 'A1', 'Bb1', 'C2', 'D2', 'D2', 'G1', 'A1', 'D2', 'A1'].map(midi),
      lead: [
        'D5 - - . D5 . F5 - A5 - - - G5 - F5 -', 'E5 - D5 - - - - - . . F5 - D5 - Bb4 -',
        'C5 - - . C5 . E5 - G5 - - - A5 - G5 -', 'E5 - - - - - - - . . C5 - D5 - E5 -',
        'F5 - - . F5 . A5 - D6 - - - C6 - A5 -', 'Bb5 - - - A5 - F5 - D5 - - - F5 - - -',
        'G5 - - - F5 - E5 - D5 - - - Bb4 - D5 -', 'C#5 - - - - - - - E5 - - - A4 - - -',
        'D5 - - - - - F5 - - - Bb5 - - - A5 -', 'G5 - - - - - E5 - - - C5 - - - E5 -',
        'F5 - - - - - E5 - D5 - - - A4 - - -', 'D5 - F5 - A5 - D6 - - - - - . . . .',
        'Bb5 - - - A5 - G5 - - - D5 - G5 - - -', 'A5 - - - G5 - F5 - E5 - - - C#5 - - -',
        'D5 - - - E5 - F5 - G5 - A5 - - - F5 -', 'E5 - - - - - - - A5 - - - . . . .',
      ].map(parseBar),
      leadFrom: 0,
      style: 'drive',
    },
  };

  let musOn = true;
  try { musOn = localStorage.getItem('tlc_music') !== '0'; } catch (e) { /* ignore */ }
  let musBus = null, musTimer = null, cur = null, wantTrack = null, intensity = 0;

  function voice(type, f, t, dur, vol, o) {
    o = o || {};
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t);
    if (o.detune) osc.detune.value = o.detune;
    if (o.vib) { // лёгкое вибрато на длинных нотах
      const l = ac.createOscillator(), lg = ac.createGain();
      l.frequency.value = 5.5; lg.gain.value = f * 0.006;
      l.connect(lg); lg.connect(osc.frequency); l.start(t + 0.15); l.stop(t + dur + 0.05);
    }
    const g = ac.createGain();
    const a = o.attack || 0.008, rel = Math.min(o.release || 0.08, dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    g.gain.setValueAtTime(vol * (o.sustain != null ? o.sustain : 0.8), t + Math.max(a, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out = g;
    if (o.lp) { const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = o.lp; g.connect(fl); out = fl; }
    osc.connect(g); out.connect(cur.gain);
    osc.start(t); osc.stop(t + dur + 0.05);
  }
  function hit(t, kind, vol) {
    const g = ac.createGain();
    g.connect(cur.gain);
    if (kind === 'kick') {
      const o = ac.createOscillator();
      o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g); o.start(t); o.stop(t + 0.2);
      return;
    }
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    const fl = ac.createBiquadFilter();
    const dur = kind === 'snare' ? 0.13 : kind === 'ohat' ? 0.12 : 0.035;
    fl.type = kind === 'snare' ? 'bandpass' : 'highpass';
    fl.frequency.value = kind === 'snare' ? 1900 : 7000;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(fl); fl.connect(g); src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
    if (kind === 'snare') { // «тело» малого барабана
      const o = ac.createOscillator(), og = ac.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
      og.gain.setValueAtTime(vol * 0.5, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.connect(og); og.connect(cur.gain); o.start(t); o.stop(t + 0.1);
    }
  }

  // один шаг (шестнадцатая) трека
  function playStep(tr, bar, step, t, loop) {
    const sp = 60 / tr.bpm / 4, b = bar % tr.chords.length;
    const ch = tr.chords[b], root = tr.bass[b];
    if (tr.style === 'calm') {
      if (step === 0) {
        for (const n of ch) { voice('triangle', hz(n), t, sp * 16 + 0.6, 0.03, { attack: 0.9, release: 1.2, lp: 1100 }); voice('sawtooth', hz(n) * 1.003, t, sp * 16 + 0.6, 0.008, { attack: 1.1, release: 1.2, lp: 800 }); }
      }
      if (step === 0 || step === 8) voice('sine', hz(root), t, sp * 7, 0.11, { attack: 0.03, release: 0.4 });
      if (step % 2 === 0) { const arp = [0, 1, 2, 1, 0, 2, 1, 2][step / 2]; voice('square', hz(ch[arp] + 12), t, sp * 1.6, 0.011, { lp: 2200 }); }
      if (step % 4 === 2) hit(t, 'hat', 0.018);
    } else {
      // бас — восьмые с октавными скачками
      const bp = { 0: 0, 2: 0, 4: 12, 6: 0, 8: 0, 10: 0, 12: 12, 14: 7 };
      if (bp[step] != null) voice('square', hz(root + bp[step]), t, sp * 1.7, 0.05, { lp: 700, release: 0.05 });
      if (bp[step] != null) voice('triangle', hz(root + bp[step]), t, sp * 1.7, 0.07, { release: 0.05 });
      // барабаны
      const partB = b >= 8;
      if (step === 0 || step === 6 || step === 8 || (partB && step === 11)) hit(t, 'kick', 0.32);
      if (step === 4 || step === 12) hit(t, 'snare', 0.13);
      if (step === 15 && b % 4 === 3) hit(t, 'snare', 0.08);
      if (step % 2 === 0 || intensity) hit(t, step === 14 ? 'ohat' : 'hat', step % 2 ? 0.02 : 0.035);
      // аккорд-«стабы» на сильных долях и арпеджио во второй части
      if (step === 0 || step === 10) for (const n of ch) voice('sawtooth', hz(n), t, sp * 1.5, 0.012, { lp: 1600 });
      if (partB || intensity) voice('square', hz(ch[step % 3] + 12), t, sp * 0.9, 0.009, { lp: 2600 });
    }
    // мелодия
    if (loop >= tr.leadFrom) for (const nt of tr.lead[b]) {
      if (nt.step !== step) continue;
      const dur = nt.len * sp;
      voice('square', hz(nt.n), t, dur * 0.95, tr.style === 'calm' ? 0.028 : 0.04, { lp: tr.style === 'calm' ? 2400 : 3400, vib: dur > 0.3, sustain: 0.7, release: 0.12 });
      if (intensity && tr.style !== 'calm') voice('triangle', hz(nt.n - 12), t, dur * 0.95, 0.04, { sustain: 0.8 });
    }
  }

  function musTick() {
    if (!ac || ac.state !== 'running' || !cur) return;
    const tr = TRACKS[cur.name], sp = 60 / tr.bpm / 4, total = tr.chords.length * 16;
    if (cur.next < ac.currentTime) cur.next = ac.currentTime + 0.05;
    // в фоновой вкладке таймеры срабатывают раз в секунду — планируем с запасом, чтобы музыка не заикалась
    const ahead = document.hidden ? 1.6 : 0.35;
    while (cur.next < ac.currentTime + ahead) {
      const s = cur.step % total;
      playStep(tr, Math.floor(s / 16), s % 16, cur.next, Math.floor(cur.step / total));
      cur.step++;
      cur.next += sp;
    }
  }
  function fadeOut(c) {
    if (!c) return;
    const t = ac.currentTime;
    c.gain.gain.cancelScheduledValues(t);
    c.gain.gain.setValueAtTime(Math.max(0.0001, c.gain.gain.value), t);
    c.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    setTimeout(() => c.gain.disconnect(), 1200);
  }
  // включить нужный трек (с плавной сменой) или тишину
  function applyMusic() {
    if (!ac) return; // запустится после первого клика (политика автозапуска звука)
    const name = musOn && !muted ? wantTrack : null;
    if (cur && cur.name === name) return;
    if (cur) { fadeOut(cur); cur = null; }
    if (!name) return;
    if (!musBus) { musBus = ac.createGain(); musBus.gain.value = 1; musBus.connect(master); }
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(TRACKS[name].vol, ac.currentTime + 1.2);
    g.connect(musBus);
    cur = { name, gain: g, step: 0, next: ac.currentTime + 0.1 };
    if (!musTimer) musTimer = setInterval(musTick, 90);
    musTick();
  }
  let lastHover = 0;

  function env(g, t, vol, attack, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  function tone(o) {
    if (muted) return;
    const a = ensure();
    if (!a) return;
    const t = a.currentTime + (o.delay || 0);
    const osc = a.createOscillator();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), t + o.dur);
    const g = a.createGain();
    env(g, t, o.vol == null ? 0.2 : o.vol, o.attack || 0.004, o.dur);
    osc.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + o.dur + 0.03);
  }

  function noise(o) {
    if (muted) return;
    const a = ensure();
    if (!a) return;
    const t = a.currentTime + (o.delay || 0);
    const src = a.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const flt = a.createBiquadFilter();
    flt.type = o.filter || 'lowpass';
    flt.frequency.setValueAtTime(o.f || 2000, t);
    if (o.f2) flt.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
    flt.Q.value = o.q || 0.8;
    const g = a.createGain();
    env(g, t, o.vol == null ? 0.2 : o.vol, o.attack || 0.003, o.dur);
    src.connect(flt); flt.connect(g); g.connect(master);
    src.start(t); src.stop(t + o.dur + 0.05);
  }

  const notes = (seq, type, vol, gap) => {
    let t = 0;
    for (const [f, d] of seq) {
      if (f) {
        tone({ type, f, dur: d * 0.95, vol, delay: t });
        tone({ type: 'triangle', f: f / 2, dur: d * 0.95, vol: vol * 0.6, delay: t });
      }
      t += d + (gap || 0);
    }
  };

  const api = {
    unlock() { const a = ensure(); applyMusic(); musTick(); return a; },
    // фоновая музыка: 'menu' | 'battle' | null
    music(name) { wantTrack = name; if (name !== 'battle') intensity = 0; applyMusic(); },
    setIntensity(v) { intensity = v ? 1 : 0; },
    ambientStart() { api.music('menu'); },
    ambientStop() { api.music(null); },
    toggleMusic() {
      musOn = !musOn;
      try { localStorage.setItem('tlc_music', musOn ? '1' : '0'); } catch (e) { /* ignore */ }
      if (musOn) ensure();
      applyMusic();
      return musOn;
    },
    isMusicOn() { return musOn; },
    hover() {
      const n = performance.now();
      if (n - lastHover < 60) return;
      lastHover = n;
      tone({ type: 'square', f: 1760, dur: 0.018, vol: 0.025 });
    },
    click() { tone({ type: 'square', f: 520, f2: 880, dur: 0.05, vol: 0.08 }); },
    join() { [392, 523, 659].forEach((f, i) => tone({ type: 'triangle', f, dur: 0.1, vol: 0.12, delay: i * 0.07 })); },
    leave() { [523, 392, 262].forEach((f, i) => tone({ type: 'triangle', f, dur: 0.1, vol: 0.1, delay: i * 0.07 })); },
    ready() {
      tone({ type: 'square', f: 880, dur: 0.06, vol: 0.1 });
      tone({ type: 'square', f: 1320, dur: 0.12, vol: 0.1, delay: 0.07 });
      noise({ f: 5000, dur: 0.05, vol: 0.06, filter: 'highpass' });
    },
    unready() { tone({ type: 'square', f: 660, f2: 330, dur: 0.1, vol: 0.08 }); },
    count() {
      tone({ type: 'square', f: 440, dur: 0.12, vol: 0.14 });
      tone({ type: 'triangle', f: 220, dur: 0.2, vol: 0.12 });
      noise({ f: 300, f2: 60, dur: 0.25, vol: 0.12 });
    },
    go() {
      notes([[523, 0.07], [659, 0.07], [784, 0.07], [1047, 0.3]], 'square', 0.1, 0.005);
      noise({ f: 2500, f2: 80, dur: 0.6, vol: 0.25 });
      tone({ type: 'sine', f: 110, f2: 40, dur: 0.5, vol: 0.3 });
    },
    select() { tone({ f: 660, f2: 990, dur: 0.06, vol: 0.1 }); },
    step() {
      noise({ f: 1100, dur: 0.045, vol: 0.12, filter: 'bandpass', q: 3 });
      tone({ type: 'triangle', f: 130, f2: 70, dur: 0.05, vol: 0.12 });
    },
    pickup(tier) {
      const t = tier || 0;
      const seq = [523, 659, 784, 1047, 1319, 1568].slice(0, 4 + Math.min(2, t));
      seq.forEach((f, i) => tone({ f: f * (1 + t * 0.06), dur: 0.08, vol: 0.1, delay: i * 0.055 }));
      if (t >= 2) tone({ type: 'triangle', f: 2093, dur: 0.25, vol: 0.06, delay: seq.length * 0.055 });
    },
    legendary(mythic) {
      notes(mythic
        ? [[784, 0.08], [988, 0.08], [1175, 0.08], [1568, 0.08], [1175, 0.08], [1568, 0.08], [2093, 0.4]]
        : [[659, 0.09], [784, 0.09], [988, 0.09], [1319, 0.35]], 'square', 0.08, 0.005);
      noise({ f: 8000, f2: 3000, dur: mythic ? 0.9 : 0.5, vol: 0.05, filter: 'highpass', delay: 0.1 });
    },
    laser() {
      tone({ type: 'sawtooth', f: 1500, f2: 180, dur: 0.18, vol: 0.12 });
      tone({ type: 'square', f: 760, f2: 90, dur: 0.15, vol: 0.05 });
    },
    sniper() {
      tone({ type: 'sawtooth', f: 2400, f2: 110, dur: 0.32, vol: 0.13 });
      noise({ f: 6000, f2: 400, dur: 0.22, vol: 0.12, filter: 'lowpass' });
    },
    shotgun() {
      noise({ f: 3500, f2: 180, dur: 0.38, vol: 0.5 });
      tone({ type: 'square', f: 170, f2: 40, dur: 0.25, vol: 0.22 });
    },
    explosion(big) {
      noise({ f: big ? 2000 : 1300, f2: 50, dur: big ? 0.95 : 0.5, vol: 0.6 });
      tone({ type: 'sine', f: 120, f2: 28, dur: big ? 0.8 : 0.4, vol: 0.5 });
    },
    hit() {
      tone({ type: 'square', f: 240, f2: 70, dur: 0.09, vol: 0.14 });
      noise({ f: 2600, dur: 0.06, vol: 0.12 });
    },
    shield() {
      tone({ type: 'sine', f: 900, f2: 1900, dur: 0.22, vol: 0.15 });
      tone({ type: 'triangle', f: 1300, f2: 600, dur: 0.25, vol: 0.1, delay: 0.06 });
    },
    heal() { [440, 554, 659, 880].forEach((f, i) => tone({ type: 'triangle', f, dur: 0.12, vol: 0.12, delay: i * 0.07 })); },
    jet() {
      noise({ f: 500, f2: 2800, dur: 0.48, vol: 0.28, filter: 'bandpass', q: 1.4 });
      tone({ type: 'sawtooth', f: 90, f2: 220, dur: 0.45, vol: 0.06 });
    },
    crate() {
      tone({ type: 'triangle', f: 300, f2: 620, dur: 0.12, vol: 0.12 });
      tone({ f: 940, dur: 0.05, vol: 0.07, delay: 0.13 });
    },
    mine() {
      tone({ type: 'square', f: 1250, dur: 0.03, vol: 0.09 });
      tone({ type: 'square', f: 820, dur: 0.03, vol: 0.09, delay: 0.08 });
    },
    turn() {
      tone({ type: 'triangle', f: 523, dur: 0.1, vol: 0.13 });
      tone({ type: 'triangle', f: 784, dur: 0.16, vol: 0.13, delay: 0.1 });
    },
    // Звук выстрела по виду снаряда
    shot(kind) {
      switch (kind) {
        case 'sniper': return this.sniper();
        case 'shotgun': return this.shotgun();
        case 'bolt':
          tone({ type: 'sawtooth', f: 900, f2: 140, dur: 0.22, vol: 0.13 });
          tone({ type: 'square', f: 300, f2: 80, dur: 0.2, vol: 0.08 });
          return;
        case 'burst':
          for (let i = 0; i < 3; i++) {
            tone({ type: 'square', f: 520, f2: 160, dur: 0.05, vol: 0.09, delay: i * 0.07 });
            noise({ f: 3000, dur: 0.04, vol: 0.08, delay: i * 0.07 });
          }
          return;
        case 'dart': case 'syringe':
          noise({ f: 5000, f2: 1800, dur: 0.12, vol: 0.12, filter: 'bandpass', q: 2 });
          tone({ type: 'triangle', f: 1400, f2: 900, dur: 0.06, vol: 0.05 });
          return;
        case 'knife':
          noise({ f: 6000, f2: 2500, dur: 0.18, vol: 0.14, filter: 'bandpass', q: 3 });
          tone({ type: 'triangle', f: 2200, f2: 1700, dur: 0.08, vol: 0.05, delay: 0.05 });
          return;
        case 'sword': // свист клинка и звон стали
          noise({ f: 4500, f2: 1200, dur: 0.16, vol: 0.14, filter: 'bandpass', q: 2.5 });
          tone({ type: 'triangle', f: 2600, f2: 2400, dur: 0.18, vol: 0.06, delay: 0.1 });
          tone({ type: 'sine', f: 3900, dur: 0.12, vol: 0.03, delay: 0.1 });
          return;
        case 'bone':
          noise({ f: 1500, f2: 600, dur: 0.15, vol: 0.1, filter: 'bandpass', q: 1.5 });
          tone({ type: 'triangle', f: 320, f2: 160, dur: 0.12, vol: 0.12, delay: 0.12 });
          return;
        case 'punch':
          noise({ f: 900, f2: 120, dur: 0.2, vol: 0.3 });
          tone({ type: 'sine', f: 140, f2: 50, dur: 0.22, vol: 0.3 });
          return;
        case 'shield':
          tone({ type: 'square', f: 1100, f2: 1300, dur: 0.12, vol: 0.06 });
          tone({ type: 'triangle', f: 660, dur: 0.25, vol: 0.08, delay: 0.1 });
          return;
        case 'ice':
          tone({ type: 'sine', f: 2400, f2: 1800, dur: 0.15, vol: 0.06 });
          noise({ f: 6000, f2: 3000, dur: 0.12, vol: 0.08, filter: 'bandpass', q: 3 });
          return;
        case 'frost':
          noise({ f: 2000, f2: 8000, dur: 0.3, vol: 0.1, filter: 'bandpass', q: 2 });
          tone({ type: 'sine', f: 1200, f2: 2600, dur: 0.3, vol: 0.06 });
          return;
        case 'poison':
          noise({ f: 5000, f2: 1800, dur: 0.12, vol: 0.12, filter: 'bandpass', q: 2 });
          tone({ type: 'sine', f: 380, f2: 620, dur: 0.08, vol: 0.05, delay: 0.1 });
          return;
        case 'skull':
          tone({ type: 'sawtooth', f: 260, f2: 130, dur: 0.3, vol: 0.08 });
          tone({ type: 'sine', f: 520, f2: 390, dur: 0.3, vol: 0.05 });
          return;
        case 'claw':
          noise({ f: 2500, f2: 900, dur: 0.15, vol: 0.14, filter: 'bandpass', q: 1.5 });
          tone({ type: 'square', f: 140, f2: 90, dur: 0.12, vol: 0.06 });
          return;
        case 'scan':
          for (let i = 0; i < 2; i++) tone({ type: 'sine', f: 1500 - i * 300, f2: 2200 - i * 300, dur: 0.12, vol: 0.07, delay: i * 0.09 });
          return;
        case 'wave':
          for (let i = 0; i < 3; i++) tone({ type: 'sine', f: 600 + i * 220, f2: 900 + i * 220, dur: 0.1, vol: 0.08, delay: i * 0.08 });
          return;
        default: return this.laser();
      }
    },
    // Заморозка: звон ледяных кристаллов и треск льда (синтез)
    freeze() {
      [2093, 2637, 3136, 2349, 2794].forEach((f, i) => tone({ type: 'sine', f, f2: f * 1.01, dur: 0.35, vol: 0.05, delay: i * 0.045 }));
      tone({ type: 'triangle', f: 1568, f2: 784, dur: 0.5, vol: 0.06, delay: 0.05 });
      for (let i = 0; i < 4; i++) noise({ f: 7000, dur: 0.03, vol: 0.12, filter: 'highpass', delay: 0.18 + i * 0.05 });
      noise({ f: 4000, f2: 9000, dur: 0.4, vol: 0.05, filter: 'bandpass', q: 4, delay: 0.1 });
    },
    thaw() { [1760, 1318, 988].forEach((f, i) => tone({ type: 'sine', f, dur: 0.12, vol: 0.04, delay: i * 0.06 })); },
    raise() {
      tone({ type: 'sawtooth', f: 110, f2: 70, dur: 0.7, vol: 0.12 });
      tone({ type: 'square', f: 233, f2: 196, dur: 0.6, vol: 0.05, delay: 0.1 });
      noise({ f: 400, f2: 150, dur: 0.6, vol: 0.12, filter: 'lowpass' });
    },
    crumble() { noise({ f: 1200, f2: 300, dur: 0.35, vol: 0.12, filter: 'bandpass', q: 1 }); },
    revive() {
      notes([[523, 0.08], [659, 0.08], [784, 0.08], [1047, 0.08], [1319, 0.35]], 'triangle', 0.09, 0.005);
      tone({ type: 'sine', f: 2093, dur: 0.5, vol: 0.04, delay: 0.3 });
    },
    poison() {
      for (let i = 0; i < 3; i++) tone({ type: 'sine', f: 300 + i * 90, f2: 520 + i * 90, dur: 0.07, vol: 0.06, delay: i * 0.06 });
    },
    trumpet() {
      tone({ type: 'sawtooth', f: 180, f2: 330, dur: 0.25, vol: 0.14 });
      tone({ type: 'sawtooth', f: 330, f2: 300, dur: 0.45, vol: 0.14, delay: 0.24 });
      tone({ type: 'square', f: 165, f2: 150, dur: 0.6, vol: 0.06, delay: 0.1 });
    },
    tick() { tone({ type: 'square', f: 1000, dur: 0.03, vol: 0.05 }); },
    error() {
      tone({ type: 'square', f: 150, dur: 0.1, vol: 0.1 });
      tone({ type: 'square', f: 110, dur: 0.14, vol: 0.1, delay: 0.09 });
    },
    victory() {
      notes([[523, 0.12], [659, 0.12], [784, 0.12], [1047, 0.28], [0, 0.06], [784, 0.12], [1047, 0.55]], 'square', 0.09, 0.01);
    },
    defeat() { notes([[392, 0.22], [349, 0.22], [311, 0.22], [262, 0.6]], 'square', 0.08, 0.02); },
    toggleMute() {
      muted = !muted;
      try { localStorage.setItem('tlc_muted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
      if (master) master.gain.value = muted ? 0 : VOL;
      if (!muted) ensure();
      applyMusic();
      return muted;
    },
    isMuted() { return muted; },
  };
  return api;
})();
