/* =====================================================================
   MuGo — Tape mode
   Songs become 3D cassettes on a shelf. Picking one flies it into a
   cassette deck (door opens, tape spins in, door clunks shut, PLAY key
   goes down) and then the song starts. Entirely optional (sidebar toggle).
   ===================================================================== */
const Tapes = (() => {
  const qs = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pref = (k, d) => { try { return JSON.parse(localStorage.getItem('mugo.' + k)) ?? d; } catch { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem('mugo.' + k, JSON.stringify(v)); } catch {} };

  let on = pref('tapeMode', false);

  /* ---------------- looks ---------------- */
  const SHELLS = [
    { shell: 'rgba(28,27,34,.95)', edge: '#1b1a21' },            // smoke black
    { shell: 'rgba(206,213,228,.40)', edge: 'rgba(170,178,196,.75)' }, // clear
    { shell: 'rgba(238,235,228,.97)', edge: '#d4d0c5' },          // white
    { shell: 'rgba(214,40,74,.82)', edge: '#9c1c37' },            // red
    { shell: 'rgba(37,99,235,.80)', edge: '#1e3a8a' },            // blue
    { shell: 'rgba(30,180,150,.78)', edge: '#11705f' },           // mint
    { shell: 'rgba(245,165,30,.85)', edge: '#b06a0a' },           // amber
    { shell: 'rgba(139,72,220,.82)', edge: '#5b21b6' },           // purple
  ];
  const STRIPES = [['#f472b6', '#a78bfa'], ['#fb923c', '#facc15'], ['#22d3ee', '#3b82f6'], ['#4ade80', '#14b8a6'], ['#f43f5e', '#fb923c'], ['#a78bfa', '#22d3ee']];
  function hash(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function styleFor(s) {
    const h = hash(s.parent || s.id), sh = SHELLS[h % SHELLS.length], st = STRIPES[(h >> 8) % STRIPES.length];
    return `--shell:${sh.shell};--shell-edge:${sh.edge};--label-accent:${st[0]};--label-accent2:${st[1]}`;
  }

  /* ---------------- the cassette model ---------------- */
  function screws(seed) {
    return [1, 2, 3, 4, 5].map(i => `<span class="screw s${i}" style="--sr:${(seed * (i + 3) * 37) % 180}deg"></span>`).join('');
  }
  function modelHTML(s, { pack = 0 } = {}) {
    const h = hash(s.id);
    const art = s.thumb ? `<img src="${thumb(s)}" alt="" loading="lazy" draggable="false">` : `<div class="noart">${icon('music')}</div>`;
    const mins = Math.max(30, Math.ceil((s.duration || 0) / 60 / 15) * 15 * 2);
    const left = .55 + .45 * (1 - pack), right = .55 + .45 * pack;
    return `<div class="tape-model">
      <div class="tf tf-back">${screws(h)}</div>
      <div class="tf tf-top"></div><div class="tf tf-bottom"></div><div class="tf tf-left"></div><div class="tf tf-right"></div>
      <div class="tf tf-front">
        <div class="t-label">
          <div class="t-art">${art}</div>
          <div class="t-strip"><span class="t-side">A</span><span class="t-title">${esc(s.title)}</span><span class="t-type">C-${mins}</span></div>
          <div class="t-window"><div class="t-band"></div>
            <div class="reel l"><div class="pack" style="--pack:${left}"></div><div class="hub"></div></div>
            <div class="reel r"><div class="pack" style="--pack:${right}"></div><div class="hub"></div></div></div>
        </div>
        <div class="t-bottom"><i></i><i></i><i></i><i></i><b></b></div>
        ${screws(h)}
      </div>
    </div>`;
  }
  function tapeHTML(s, opts = {}) {
    return `<div class="tape" style="${styleFor(s)}${opts.scale ? `;--s:${opts.scale}` : ''}">${modelHTML(s, opts)}${opts.noShadow ? '' : '<div class="tape-shadow"></div>'}
      ${!ready(s) ? `<div class="tape-progress">${s.status === 'error' ? 'Failed' : statusText(s)}</div>` : ''}</div>`;
  }
  function cell(s, i) {
    const r = ready(s);
    return `<div class="tape-cell ${r ? '' : 'busy'}" style="--i:${Math.min(i, 24)}" data-id="${s.id}" ${r ? 'draggable="true"' : ''} title="${esc(s.title)}">
      ${tapeHTML(s)}
      <div class="tape-meta"><b>${esc(s.title)}</b><span>${esc(s.artist || 'Unknown artist')}${s.duration ? ' · ' + fmt(s.duration) : ''}</span></div></div>`;
  }
  const shelf = (songs, opts = {}) => `<div class="tape-shelf" data-list ${opts.playlist ? `data-playlist="${opts.playlist}"` : ''}>${songs.map(cell).join('')}</div>`;
  const row = songs => `<div class="tape-row">${songs.map(cell).join('')}</div>`;

  /* mouse-follow tilt on the shelf */
  document.addEventListener('pointermove', e => {
    const c = e.target.closest?.('.tape-cell'); if (!c) return;
    const m = qs('.tape-model', c), r = c.querySelector('.tape').getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - .5, dy = (e.clientY - r.top) / r.height - .5;
    m.style.setProperty('--rx', `${8 - dy * 34}deg`);
    m.style.setProperty('--ry', `${-6 + dx * 46}deg`);
    m.style.setProperty('--rz', `${dx * -4}deg`);
  }, { passive: true });
  document.addEventListener('pointerout', e => {
    const c = e.target.closest?.('.tape-cell'); if (!c || c.contains(e.relatedTarget)) return;
    const m = qs('.tape-model', c); ['--rx', '--ry', '--rz'].forEach(p => m.style.removeProperty(p));
  });

  /* ---------------- sound effects (synthesised, no files) ---------------- */
  let sctx;
  function sfx(kind) {
    try {
      sctx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (sctx.state === 'suspended') sctx.resume();
      const t = sctx.currentTime, out = sctx.createGain(); out.gain.value = .32; out.connect(sctx.destination);
      const noise = dur => { const b = sctx.createBuffer(1, Math.ceil(sctx.sampleRate * dur), sctx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const n = sctx.createBufferSource(); n.buffer = b; return n; };
      const env = (node, a, d, peak = 1) => { const g = sctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(.001, t + a + d); node.connect(g); g.connect(out); return g; };
      if (kind === 'clunk') {
        const n = noise(.2), f = sctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; n.connect(f); env(f, .002, .14, 1.2); n.start(t);
        const o = sctx.createOscillator(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(55, t + .15); env(o, .002, .18, .9); o.start(t); o.stop(t + .25);
      } else if (kind === 'click') {
        const n = noise(.05), f = sctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 2; n.connect(f); env(f, .001, .035, 1.4); n.start(t);
      } else if (kind === 'whirr') {
        const n = noise(1.3), f = sctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 6;
        f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(1400, t + 1.1);
        n.connect(f); env(f, .25, 1, .18); n.start(t);
      }
    } catch {}
  }

  /* ---------------- the deck ---------------- */
  let stage = null, deckSong = null, busy = false, running = [];
  const vuSVG = side => `<svg viewBox="0 0 100 60" preserveAspectRatio="none">
      <path d="M14 46 A40 40 0 0 1 86 46" fill="none" stroke="#3a2c18" stroke-width="1.2"/>
      <path d="M70 26 A40 40 0 0 1 86 46" fill="none" stroke="#c0352b" stroke-width="3"/>
      ${Array.from({ length: 11 }, (_, i) => { const a = (-58 + i * 11.6) * Math.PI / 180, x1 = 50 + Math.sin(a) * 40, y1 = 56 - Math.cos(a) * 40, x2 = 50 + Math.sin(a) * (i % 2 ? 36 : 33), y2 = 56 - Math.cos(a) * (i % 2 ? 36 : 33); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${i > 7 ? '#c0352b' : '#3a2c18'}" stroke-width="1"/>`; }).join('')}
      <text x="12" y="20" font-size="7" font-weight="800" fill="#3a2c18">-20</text><text x="80" y="20" font-size="7" font-weight="800" fill="#c0352b">+3</text></svg>
      <div class="vu-needle"></div><div class="vu-label">VU · ${side}</div>`;
  const speaker = () => `<div class="spk"><div class="spk-grill"><div class="spk-cone"></div></div><div class="spk-brand">MUGO</div></div>`;

  function buildStage() {
    stage = document.createElement('div');
    stage.className = 'deck-stage';
    stage.innerHTML = `
      <button class="icon-btn np-close" data-dk="close" title="Close (Esc)">${icon('chevronDown')}</button>
      <div class="deck-floor"></div>
      <div class="deck-wrap"><div class="deck-model">
        <div class="deck-handle"></div><div class="deck-top"></div>
        <div class="deck-body">
          ${speaker()}
          <div class="deck-center">
            <div class="deck-display">
              <div class="vu" data-vu="l">${vuSVG('L')}</div>
              <div class="vfd"><div class="vfd-marquee"><span>INSERT TAPE</span></div>
                <div class="vfd-row"><span class="vfd-time">--:--</span><div class="vfd-bars">${'<i></i>'.repeat(14)}</div></div></div>
              <div class="vu" data-vu="r">${vuSVG('R')}</div>
            </div>
            <div class="deck-bay"><div class="bay-slot"></div><div class="deck-door"></div></div>
            <div class="deck-keys">
              <button class="dkey rec" data-dk="rec" title="REC — open this song in the Studio">${icon('disc')}</button>
              <button class="dkey" data-dk="rew" title="Previous">${icon('rew')}</button>
              <button class="dkey" data-dk="play" title="Play / pause">${icon('play')}</button>
              <button class="dkey" data-dk="ffwd" title="Next">${icon('ffwd')}</button>
              <button class="dkey" data-dk="stop" title="Stop">${icon('stop')}</button>
              <button class="dkey" data-dk="eject" title="Eject">${icon('eject')}</button>
            </div>
          </div>
          ${speaker()}
        </div>
        <div class="deck-brand">MuGo<small>STEREO CASSETTE DECK</small></div>
        <div class="deck-leds"><span class="led on"></span>POWER<span class="led play"></span>PLAY</div>
      </div></div>
      <div class="deck-hint">Space play / pause · ← → seek · Shift+← → previous / next · Esc close</div>`;
    document.body.appendChild(stage);
    stage.addEventListener('click', e => {
      const k = e.target.closest('[data-dk]')?.dataset.dk;
      if (busy && !k) { running.forEach(a => { try { a.finish(); } catch {} }); return; }  // click to skip
      if (!k) return;
      if (k !== 'close') press(k);
      if (k === 'close') close();
      if (k === 'play') Player.toggle();
      if (k === 'rew') Player.prev();
      if (k === 'ffwd') Player.next();
      if (k === 'stop') { Player.pause(); audio.currentTime = 0; }
      if (k === 'eject') eject();
      if (k === 'rec' && Player.current) { const id = Player.current; close(); location.hash = '#/editor/' + id; }
    });
    sync();
  }
  const anim = (el, kf, opts) => { const a = el.animate(kf, opts); running.push(a); a.finished.finally(() => running = running.filter(x => x !== a)).catch(() => {}); return a.finished.catch(() => {}); };
  function press(k) {
    const b = qs(`[data-dk="${k}"]`, stage); if (!b) return;
    b.classList.add('down'); sfx('click'); setTimeout(() => b.classList.remove('down'), 170);
  }
  async function enterStage() {
    if (stage) return false;
    buildStage();
    if (!reduced()) {
      anim(stage, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
      await anim(qs('.deck-wrap', stage), [
        { transform: 'translateY(55vh) rotateX(40deg) scale(.8)', opacity: 0 },
        { transform: 'translateY(-2%) rotateX(-4deg) scale(1.01)', opacity: 1, offset: .75 },
        { transform: 'none', opacity: 1 }], { duration: 750, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    return true;
  }
  function setBay(s, pack = 0) {
    const slot = qs('.bay-slot', stage);
    if (!s) { slot.innerHTML = ''; deckSong = null; return; }
    const r = slot.getBoundingClientRect();
    slot.innerHTML = tapeHTML(s, { scale: (r.width || 260) / 260, noShadow: true, pack });
    deckSong = s.id;
    qs('.vfd-marquee span', stage).textContent = `♪ ${s.title}${s.artist ? ' — ' + s.artist : ''}   ♪ ${s.title}`;
  }
  const bayTape = () => qs('.bay-slot .tape', stage);
  function visibleRect(el) {
    if (!el) return null;
    const t = el.querySelector?.('.tape') || el;
    const r = t.getBoundingClientRect();
    if (r.width < 10 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
    return r;
  }

  /** Fly the tape for song `id` from `srcEl` into the deck, then call onPlay(). */
  async function insert(srcEl, id, onPlay) {
    const s = S.byId[id];
    if (!s) return onPlay();
    if (busy) { running.forEach(a => a.finish?.()); return onPlay(); }
    if (reduced()) { await enterStage(); setBay(s); onPlay(); return; }
    busy = true;
    const src = visibleRect(srcEl);          // measure before the stage covers it
    try {
      await enterStage();
      const model = qs('.deck-model', stage);
      // eject whatever is in there
      if (bayTape()) {
        press('eject'); model.classList.add('open'); await wait(220);
        await anim(bayTape(), [{ transform: 'none', opacity: 1 }, { transform: 'translateY(-140%) rotateX(-20deg)', opacity: 0 }], { duration: 420, easing: 'cubic-bezier(.5,0,.75,0)' });
        setBay(null);
      } else {
        model.classList.add('open'); sfx('click'); await wait(380);
      }
      // the flying tape
      const slot = qs('.bay-slot', stage).getBoundingClientRect();
      const S0 = slot.width / 260;
      const fly = document.createElement('div');
      fly.innerHTML = tapeHTML(s, { scale: S0, noShadow: true });
      const t = fly.firstElementChild; t.classList.add('flying');
      Object.assign(t.style, { left: slot.left + 'px', top: slot.top + 'px', width: slot.width + 'px', height: slot.height + 'px', transformOrigin: '0 0' });
      stage.appendChild(t);
      const m = qs('.tape-model', t);
      const from = src || { left: innerWidth / 2 - slot.width * .35, top: innerHeight + 40, width: slot.width * .7, height: slot.height * .7 };
      const k0 = from.width / slot.width;
      const dx0 = from.left - slot.left, dy0 = from.top - slot.top;
      const midX = dx0 * .3, midY = -Math.min(slot.top - 20, slot.height * 1.35);
      sfx('whirr');
      const dur = 1500;
      const pathA = anim(t, [
        { transform: `translate(${dx0}px, ${dy0}px) scale(${k0})`, easing: 'cubic-bezier(.3,.0,.2,1)' },
        { transform: `translate(${midX}px, ${midY}px) scale(1.18)`, offset: .48, easing: 'cubic-bezier(.4,0,.2,1)' },
        { transform: `translate(0px, ${-slot.height * .9}px) scale(1.02)`, offset: .78, easing: 'cubic-bezier(.6,0,.9,.6)' },
        { transform: 'translate(0, 0) scale(1)' }], { duration: dur, fill: 'forwards' });
      const spin = anim(m, [
        { transform: `scale(${S0}) rotateX(12deg) rotateY(-20deg)` },
        { transform: `scale(${S0}) translateZ(160px) rotateX(-28deg) rotateY(-210deg) rotateZ(-10deg)`, offset: .48 },
        { transform: `scale(${S0}) translateZ(40px) rotateX(-16deg) rotateY(-360deg) rotateZ(0deg)`, offset: .78 },
        { transform: `scale(${S0}) rotateX(0deg) rotateY(-360deg)` }], { duration: dur, fill: 'forwards', easing: 'ease-in-out' });
      await Promise.all([pathA, spin]);
      setBay(s); t.remove();
      // door shuts, deck jolts, PLAY goes down
      model.classList.remove('open');
      await wait(260); sfx('clunk');
      anim(qs('.deck-wrap', stage), [{ transform: 'none' }, { transform: 'translateY(7px) rotateX(1.5deg)' }, { transform: 'translateY(-2px)' }, { transform: 'none' }], { duration: 300, easing: 'ease-out' });
      await wait(320);
      press('play');
      await wait(140);
    } catch (e) { console.warn(e); }
    busy = false;
    onPlay();
  }

  /** Track changed while the deck is open (next/prev/auto-advance): quick swap. */
  async function trackChanged(id) {
    if (!stage || busy || !id || deckSong === id) return;
    const s = S.byId[id]; if (!s) return;
    if (reduced()) return setBay(s);
    busy = true;
    const model = qs('.deck-model', stage);
    model.classList.add('open'); sfx('click');
    if (bayTape()) await anim(bayTape(), [{ transform: 'none', opacity: 1 }, { transform: 'translateY(-140%)', opacity: 0 }], { duration: 300, easing: 'ease-in' });
    setBay(s);
    await anim(bayTape(), [{ transform: 'translateY(-140%) rotateX(-15deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.3,1.3,.5,1)' });
    model.classList.remove('open'); await wait(220); sfx('clunk');
    busy = false;
  }

  async function openDeck() {
    if (!Player.current) { toast('Pick a tape to play first'); return; }
    const fresh = await enterStage();
    if (deckSong !== Player.current) setBay(S.byId[Player.current]);
    if (fresh) sync();
  }
  async function eject() {
    if (!stage) return;
    Player.pause();
    const model = qs('.deck-model', stage);
    model.classList.add('open'); await wait(200);
    if (bayTape()) await anim(bayTape(), [{ transform: 'none' }, { transform: 'translateY(-60%) rotateX(-12deg)' }], { duration: 380, easing: 'cubic-bezier(.3,1.5,.5,1)', fill: 'forwards' });
    await wait(450);
    close();
  }
  function close() {
    if (!stage) return;
    const st = stage; stage = null; deckSong = null; busy = false;
    st.classList.add('leaving');
    setTimeout(() => st.remove(), 450);
  }

  function sync() {
    if (!stage) return;
    const playing = !audio.paused;
    qs('.led.play', stage).classList.toggle('on', playing);
    qs('[data-dk="play"]', stage).innerHTML = icon(playing ? 'pause' : 'play');
  }

  /* per-frame: reels, tape packs, VU needles, speakers, display */
  let rotL = 0, rotR = 0, last = performance.now(), vuL = 0, vuR = 0;
  function frame(t, d, playing) {
    if (!stage) return;
    const now = performance.now(), dt = Math.min(.1, (now - last) / 1000); last = now;
    const p = d ? Math.min(1, t / d) : 0;
    const packL = .55 + .45 * (1 - p), packR = .55 + .45 * p;
    if (playing) { rotL -= dt * 260 / packL; rotR -= dt * 260 / packR; }
    const tape = bayTape();
    if (tape) {
      const [l, r] = qa('.reel', tape);
      l.style.setProperty('--rot', rotL + 'deg'); r.style.setProperty('--rot', rotR + 'deg');
      qs('.pack', l).style.setProperty('--pack', packL); qs('.pack', r).style.setProperty('--pack', packR);
    }
    let level = 0, bass = 0; const bars = qa('.vfd-bars i', stage);
    if (analyser && freq && playing) {
      analyser.getByteFrequencyData(freq);
      let sum = 0; for (let i = 0; i < freq.length; i++) sum += freq[i] * freq[i];
      level = Math.sqrt(sum / freq.length) / 255;
      for (let i = 0; i < 6; i++) bass += freq[i] / 255 / 6;
      bars.forEach((b, i) => { const v = freq[Math.floor(Math.pow(i / bars.length, 1.5) * freq.length * .7)] / 255; b.style.height = Math.max(2, v * 22) + 'px'; });
    } else bars.forEach(b => b.style.height = '2px');
    const ball = (cur, target) => cur + (target - cur) * (target > cur ? .35 : .08);  // VU ballistics
    vuL = ball(vuL, Math.min(1, level * 1.5 * (0.96 + Math.random() * .08)));
    vuR = ball(vuR, Math.min(1, level * 1.5 * (0.96 + Math.random() * .08)));
    qs('[data-vu="l"] .vu-needle', stage).style.setProperty('--needle', (-52 + vuL * 104) + 'deg');
    qs('[data-vu="r"] .vu-needle', stage).style.setProperty('--needle', (-52 + vuR * 104) + 'deg');
    qa('.spk-cone', stage).forEach(c => c.style.setProperty('--pump', 1 + bass * bass * .09));
    qs('.vfd-time', stage).textContent = d ? fmt(t) : '--:--';
  }

  function setOn(v) {
    on = !!v; setPref('tapeMode', on);
    if (!on) close();
  }

  return {
    get on() { return on; }, setOn, shelf, row, tapeHTML, insert, trackChanged, openDeck, close, sync, frame,
    isOpen: () => !!stage,
  };
})();
