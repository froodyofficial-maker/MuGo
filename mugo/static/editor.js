/* =====================================================================
   MuGo Studio — cut, trim and slow down parts of a song.
   The timeline is a list of segments covering the original track:
     { start, end, speed, cut }
   Preview plays the original file while skipping cut parts and changing
   playback rate; "Save" renders the result with ffmpeg on the server.
   ===================================================================== */
const Studio = (() => {
  const EPS = 1e-3;
  const COLORS = { cut: '251,113,133', slow: '96,165,250', fast: '251,191,36' };
  let st = null;          // editor state for the mounted song
  let root = null;        // view element
  const pa = new Audio(); // preview audio
  pa.preload = 'auto';
  let raf = 0;

  /* ---------------- mount / unmount ---------------- */
  function mount(viewEl, id, animate) {
    root = viewEl;
    if (!id) { stop(); st = null; return renderPicker(); }
    const song = S.byId[id];
    if (st && st.id === id && root.querySelector('.studio')) return; // keep state on refresh
    if (!song) return (root.innerHTML = `<div class="empty"><div class="bubble">${icon('alert')}</div><h3>Song not found</h3><p><a href="#/editor">Back to Studio</a></p></div>`);
    if (!ready(song)) return (root.innerHTML = `<div class="empty"><div class="bubble">${icon('download')}</div><h3>Still downloading</h3><p>You can edit “${esc(song.title)}” once it has finished downloading.</p></div>`);
    stop();
    st = {
      id, song, dur: song.duration || 0, peaks: null, segs: [], sel: null, hist: [], fut: [],
      zoom: 1, pitch: 'keep', reverb: '', fadeIn: 0, fadeOut: 0, playhead: 0, titleTouched: false, hover: null,
    };
    renderShell();
    load();
  }
  function unmount() { if (st) stop(); hqStop(); }

  function renderPicker() {
    const songs = S.songs.filter(ready);
    root.innerHTML = `
      <div class="hero"><div><h1>Studio<span class="g">.</span></h1>
        <p>Trim intros, cut out parts, or slow down sections — then save it as a new song in your library.</p></div></div>
      ${songs.length ? `<div class="section-head"><h2>Pick a song to edit</h2></div>
        <div class="studio-pick stagger">${songs.map((s, i) => `
          <a class="quick-item" style="--i:${Math.min(i, 24)}" href="#/editor/${s.id}">${artHTML(s)}
            <div class="t">${esc(s.title)}<div class="s-sub">${esc(s.artist || '')} · ${fmt(s.duration)}</div></div>
            <span class="play-btn grad" style="width:38px;height:38px">${icon('scissors')}</span></a>`).join('')}</div>`
      : `<div class="empty"><div class="bubble">${icon('scissors')}</div><h3>No songs yet</h3><p>Add a song first — then come back to edit it.</p></div>`}`;
  }

  function renderShell() {
    const s = st.song;
    root.innerHTML = `
    <div class="studio">
      <div class="st-top">
        ${s.thumb ? `<img src="${thumb(s)}" alt="">` : `<div class="noart">${icon('music')}</div>`}
        <div class="grow"><div class="ch-kicker">Studio</div><div class="st-title">${esc(s.title)}</div><div class="st-sub">${esc(s.artist || '')} · original ${fmt(st.dur)}</div></div>
        <a class="btn" href="#/editor">${icon('music')}<span>Change song</span></a>
      </div>

      <div class="panel">
        <div class="st-tools" style="margin:0 0 12px">
          <button class="play-btn grad" data-s="preview" title="Quick preview (Space)">${icon('play')}</button>
          <div><div style="font-weight:800;font-size:18px;font-variant-numeric:tabular-nums" data-s="clock">0:00.0</div><div class="sel-label" data-s="clockLbl">quick preview · playhead</div></div>
          <button class="btn" data-s="hifi" title="Render the edit with the real studio engine and play it">${icon('sparkles')}<span>Hi-Fi preview</span></button>
          <div style="flex:1"></div>
          <button class="icon-btn" data-s="undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
          <button class="icon-btn" data-s="redo" title="Redo (Ctrl+Shift+Z)">${icon('redo')}</button>
          <span class="sep"></span>
          <button class="icon-btn" data-s="zoomOut" title="Zoom out (-)">${icon('zoomOut')}</button>
          <button class="icon-btn" data-s="zoomIn" title="Zoom in (+)">${icon('zoomIn')}</button>
        </div>
        <div class="wave-wrap" data-s="wrap">
          <div class="wave-ruler" data-s="ruler"></div>
          <div class="wave-inner" data-s="inner"><canvas data-s="canvas"></canvas>
            <div class="wave-loading" data-s="loading"><div style="text-align:center"><div class="mini-bar indet" style="width:160px;margin:0 auto 12px"><div></div></div>Reading waveform…</div></div></div>
        </div>
        <div class="legend">
          <span><i style="background:rgba(${COLORS.cut},.8)"></i>Cut out</span>
          <span><i style="background:rgba(${COLORS.slow},.8)"></i>Slowed down</span>
          <span><i style="background:rgba(${COLORS.fast},.8)"></i>Sped up</span>
          <span style="margin-left:auto">Drag on the waveform to select · click to move the playhead</span>
        </div>

        <div class="st-tools" data-s="seltools">
          <span class="sel-label">Selection</span>
          <input class="time-input" data-s="selA" placeholder="start">
          <span class="sel-label">→</span>
          <input class="time-input" data-s="selB" placeholder="end">
          <span class="sel-label" data-s="selLen"></span>
          <span class="sep"></span>
          <div class="seg-btns" style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn cut" data-s="cut" title="Delete / Backspace">${icon('scissors')}<span>Cut out</span></button>
            <button class="btn keep" data-s="keep" title="K">${icon('crop')}<span>Keep only this</span></button>
            <button class="btn" data-s="playSel">${icon('play')}<span>Play selection</span></button>
            <button class="btn ghost" data-s="resetSel">${icon('refresh')}<span>Reset part</span></button>
          </div>
          <span class="sep"></span>
          <div class="speed-box">${icon('turtle')}<input type="range" min="0.5" max="1.5" step="0.05" value="0.8" data-s="speed"><b data-s="speedVal">0.80×</b>
            <button class="btn primary" data-s="applySpeed" style="height:30px;padding:0 14px"><span data-s="speedLbl">Apply</span></button></div>
        </div>
      </div>

      <div class="st-grid">
        <div class="panel">
          <h4>Edits</h4>
          <div class="seg-list" data-s="segList"></div>
          <div class="kbd-hint"><kbd>Space</kbd> preview · <kbd>Del</kbd> cut selection · <kbd>K</kbd> keep only selection · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Esc</kbd> clear selection · <kbd>+</kbd>/<kbd>−</kbd> zoom</div>
        </div>
        <div class="panel">
          <h4>Export</h4>
          <div class="opt-row"><div><b>New length</b><small>after cuts and speed changes</small></div><div class="result-len" data-s="len">—</div></div>
          <div class="opt-row"><div><b>Speed changes</b><small>Natural: studio time-stretch (Rubber Band), tempo changes, pitch &amp; vocals stay natural · Vinyl: true varispeed like a turntable, pitch drops with the speed (the classic “slowed” sound)</small></div>
            <div class="seg-toggle" data-s="pitch"><button data-v="keep" class="on">Natural</button><button data-v="vinyl">Vinyl</button></div></div>
          <div class="opt-row"><div><b>Reverb</b><small>Convolution reverb, added at render (hear it with Hi-Fi preview)</small></div>
            <div class="seg-toggle" data-s="reverb"><button data-v="" class="on">Off</button><button data-v="room">Room</button><button data-v="hall">Hall</button><button data-v="dreamy">Dreamy</button></div></div>
          <div class="opt-row"><div><b>Fade in / out</b><small>seconds</small></div><div style="display:flex;gap:8px">
            <input class="num-input" type="number" min="0" max="20" step="0.5" value="0" data-s="fadeIn" title="Fade in">
            <input class="num-input" type="number" min="0" max="20" step="0.5" value="0" data-s="fadeOut" title="Fade out"></div></div>
          <label class="field" style="display:block;margin:14px 0 0"><span class="sel-label">Save as</span>
            <input class="input" data-s="title" style="margin-top:6px"></label>
          <div style="display:flex;gap:10px;margin-top:16px">
            <button class="btn ghost" data-s="resetAll">${icon('refresh')}<span>Start over</span></button>
            <button class="btn primary lg" style="flex:1" data-s="save">${icon('sparkles')}<span>Save as new song</span></button>
          </div>
        </div>
      </div>
    </div>`;
    q('title').value = `${st.song.title} (edit)`;
    bind();
  }
  const q = k => root.querySelector(`[data-s="${k}"]`);

  /* ---------------- loading & peaks ---------------- */
  async function load() {
    const my = st;
    pa.src = `/media/audio/${my.id}`;
    try {
      const buf = await (await fetch(`/media/audio/${my.id}`)).arrayBuffer();
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const audioBuf = await new Ctx(1, 1, 44100).decodeAudioData(buf);
      if (st !== my) return;
      my.dur = audioBuf.duration;
      const N = Math.min(16000, Math.max(2000, Math.round(my.dur * 60)));
      const peaks = new Float32Array(N);
      const chans = [];
      for (let c = 0; c < Math.min(2, audioBuf.numberOfChannels); c++) chans.push(audioBuf.getChannelData(c));
      const per = audioBuf.length / N;
      for (let i = 0; i < N; i++) {
        let m = 0; const a = Math.floor(i * per), b = Math.floor((i + 1) * per);
        for (const ch of chans) for (let j = a; j < b; j += 2) { const v = Math.abs(ch[j]); if (v > m) m = v; }
        peaks[i] = m;
      }
      let max = 0; for (const p of peaks) if (p > max) max = p;
      for (let i = 0; i < N; i++) peaks[i] = Math.pow(peaks[i] / (max || 1), 0.8);
      my.peaks = peaks;
      my.segs = [{ start: 0, end: my.dur, speed: 1, cut: false }];
      q('loading').remove();
      update();
    } catch (e) {
      q('loading').innerHTML = `<div style="text-align:center;color:var(--danger)">${icon('alert')}<p>Couldn't read this audio file.<br><small>${esc(e.message)}</small></p></div>`;
    }
  }

  /* ---------------- segment operations ---------------- */
  const snap = () => JSON.stringify(st.segs);
  function commit(before) { st.hist.push(before); if (st.hist.length > 100) st.hist.shift(); st.fut = []; merge(); update(); }
  function split(t) {
    const i = st.segs.findIndex(s => t > s.start + EPS && t < s.end - EPS);
    if (i < 0) return;
    const s = st.segs[i];
    st.segs.splice(i, 1, { ...s, end: t }, { ...s, start: t });
  }
  function apply(a, b, fn) {
    a = Math.max(0, a); b = Math.min(st.dur, b);
    if (b - a < 0.01) return;
    split(a); split(b);
    st.segs.forEach(s => { if (s.start >= a - EPS && s.end <= b + EPS) fn(s); });
  }
  function merge() {
    const out = [];
    for (const s of st.segs) {
      const p = out[out.length - 1];
      if (p && p.cut === s.cut && Math.abs(p.speed - s.speed) < 1e-6) p.end = s.end;
      else out.push({ ...s });
    }
    st.segs = out.filter(s => s.end - s.start > 0.005);
  }
  function op(name) {
    if (!st?.peaks) return;
    const before = snap();
    const sel = st.sel && st.sel.b - st.sel.a > 0.01 ? st.sel : null;
    if (name === 'cut' && sel) { apply(sel.a, sel.b, s => s.cut = true); toast('Cut out ' + fmt(sel.b - sel.a)); }
    else if (name === 'keep' && sel) { apply(0, sel.a, s => s.cut = true); apply(sel.b, st.dur, s => s.cut = true); toast('Trimmed to selection'); }
    else if (name === 'reset' && sel) apply(sel.a, sel.b, s => { s.cut = false; s.speed = 1; });
    else if (name === 'speed') {
      const v = +q('speed').value;
      const [a, b] = sel ? [sel.a, sel.b] : [0, st.dur];
      apply(a, b, s => s.speed = v);
      toast(`${v < 1 ? 'Slowed' : v > 1 ? 'Sped up' : 'Normal speed for'} ${sel ? 'selection' : 'whole song'}${v !== 1 ? ' to ' + v.toFixed(2) + '×' : ''}`);
    }
    else if (name === 'resetAll') st.segs = [{ start: 0, end: st.dur, speed: 1, cut: false }];
    else return;
    if (before !== snap()) commit(before);
  }
  function undo() { if (!st.hist.length) return; st.fut.push(snap()); st.segs = JSON.parse(st.hist.pop()); update(); }
  function redo() { if (!st.fut.length) return; st.hist.push(snap()); st.segs = JSON.parse(st.fut.pop()); update(); }
  const kept = () => st.segs.filter(s => !s.cut);
  const outLen = () => kept().reduce((a, s) => a + (s.end - s.start) / s.speed, 0);
  const segAt = t => st.segs.find(s => t >= s.start - EPS && t < s.end) || st.segs[st.segs.length - 1];

  /* ---------------- UI updates ---------------- */
  function update() {
    if (!st) return;
    draw(); ruler();
    const sel = st.sel;
    const has = !!(sel && sel.b - sel.a > 0.01);
    ['cut', 'keep', 'playSel', 'resetSel'].forEach(k => q(k).disabled = !has);
    if (document.activeElement !== q('selA')) q('selA').value = has ? fmtMs(sel.a) : '';
    if (document.activeElement !== q('selB')) q('selB').value = has ? fmtMs(sel.b) : '';
    q('selLen').textContent = has ? `(${fmtMs(sel.b - sel.a)})` : 'none — speed applies to whole song';
    q('speedLbl').textContent = has ? 'Apply to selection' : 'Apply to whole song';
    q('undo').disabled = !st.hist.length; q('redo').disabled = !st.fut.length;
    q('undo').style.opacity = st.hist.length ? 1 : .35; q('redo').style.opacity = st.fut.length ? 1 : .35;
    const L = outLen();
    q('len').innerHTML = `${fmt(L)}<span style="font-size:14px;color:var(--muted);font-weight:600"> / ${fmt(st.dur)}</span>`;
    // edit list
    const edits = st.segs.filter(s => s.cut || s.speed !== 1);
    q('segList').innerHTML = edits.length ? edits.map(s => {
      const c = s.cut ? COLORS.cut : s.speed < 1 ? COLORS.slow : COLORS.fast;
      const lbl = s.cut ? 'Cut out' : (s.speed < 1 ? 'Slowed' : 'Sped up') + ` · ${s.speed.toFixed(2)}×`;
      return `<div class="seg-row" data-seg="${s.start}|${s.end}"><span class="dot" style="background:rgb(${c})"></span><span class="lbl">${lbl}</span>
        <span style="color:var(--muted)">${fmtMs(s.start)} → ${fmtMs(s.end)}</span><button class="icon-btn" data-undo-seg="${s.start}|${s.end}" title="Reset this part">${icon('close')}</button></div>`;
    }).join('') : `<div style="color:var(--faint);padding:8px 2px;line-height:1.6">No edits yet. Select a part of the waveform, then cut it out, keep only it, or change its speed.</div>`;
    // smart title
    if (!st.titleTouched) {
      const k = kept(); const allSlow = k.length && k.every(s => s.speed < 1), allFast = k.length && k.every(s => s.speed > 1);
      q('title').value = `${st.song.title} (${allSlow ? 'slowed' : allFast ? 'sped up' : 'edit'})`;
    }
  }
  function fmtMs(t) { t = Math.max(0, t); const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; }
  function parseTime(v) {
    v = String(v).trim(); if (!v) return NaN;
    const p = v.split(':').map(Number); if (p.some(isNaN)) return NaN;
    return p.length === 1 ? p[0] : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
  }

  /* ---------------- drawing ---------------- */
  function canvasSize() {
    const wrap = q('wrap'); if (!wrap) return { w: 0, h: 0 }; const w = Math.max(300, wrap.clientWidth * st.zoom);
    q('inner').style.width = w + 'px'; q('ruler').style.width = w + 'px';
    return { w, h: q('inner').clientHeight };
  }
  function draw() {
    if (!st || !st.peaks || !root?.contains(q('canvas'))) return;
    const cv = q('canvas');
    const { w, h } = canvasSize(); const dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
    const X = t => t / st.dur * w;
    // segment backgrounds
    for (const s of st.segs) {
      if (!s.cut && s.speed === 1) continue;
      const c = s.cut ? COLORS.cut : s.speed < 1 ? COLORS.slow : COLORS.fast;
      x.fillStyle = `rgba(${c},${s.cut ? .13 : .16})`; x.fillRect(X(s.start), 0, X(s.end) - X(s.start), h);
      if (s.cut) { // hatching
        x.save(); x.beginPath(); x.rect(X(s.start), 0, X(s.end) - X(s.start), h); x.clip();
        x.strokeStyle = `rgba(${c},.22)`; x.lineWidth = 1;
        for (let k = X(s.start) - h; k < X(s.end); k += 9) { x.beginPath(); x.moveTo(k, h); x.lineTo(k + h, 0); x.stroke(); }
        x.restore();
      }
      x.fillStyle = `rgba(${c},.9)`; x.fillRect(X(s.start), 0, X(s.end) - X(s.start), 3);
      if (!s.cut) { x.font = '700 11px system-ui'; x.fillText(`${s.speed.toFixed(2)}×`, X(s.start) + 6, 17); }
    }
    // waveform
    const bw = 3, gap = 1, n = Math.floor(w / (bw + gap)), P = st.peaks, mid = h / 2;
    const g = x.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#c4b5fd'); g.addColorStop(.5, '#f9a8d4'); g.addColorStop(1, '#fdba74');
    let si = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i / n * P.length), b = Math.max(a + 1, Math.floor((i + 1) / n * P.length));
      let m = 0; for (let j = a; j < b; j++) if (P[j] > m) m = P[j];
      const t = (i + .5) / n * st.dur;
      while (si < st.segs.length - 1 && t >= st.segs[si].end) si++;
      const seg = st.segs[si];
      const bh = Math.max(2, m * (h - 30));
      x.fillStyle = seg.cut ? `rgba(${COLORS.cut},.35)` : t < st.playhead ? g : 'rgba(255,255,255,.55)';
      x.fillRect(i * (bw + gap), mid - bh / 2, bw, bh);
    }
    // selection
    if (st.sel && st.sel.b - st.sel.a > 0.001) {
      const a = X(st.sel.a), b = X(st.sel.b);
      x.fillStyle = 'rgba(255,255,255,.11)'; x.fillRect(a, 0, b - a, h);
      x.fillStyle = '#fff'; x.fillRect(a - 1, 0, 2, h); x.fillRect(b - 1, 0, 2, h);
      for (const px of [a, b]) { x.beginPath(); x.roundRect ? x.roundRect(px - 5, mid - 14, 10, 28, 5) : x.rect(px - 5, mid - 14, 10, 28); x.fill(); }
    }
    // hover line
    if (st.hover != null) { x.fillStyle = 'rgba(255,255,255,.35)'; x.fillRect(X(st.hover), 0, 1, h); }
    // playhead
    const px = X(st.playhead);
    x.shadowColor = 'rgba(244,114,182,.9)'; x.shadowBlur = 12; x.fillStyle = '#fff'; x.fillRect(px - 1, 0, 2, h); x.shadowBlur = 0;
    x.beginPath(); x.moveTo(px - 6, 0); x.lineTo(px + 6, 0); x.lineTo(px, 8); x.fill();
    q('clock').textContent = fmtMs(st.playhead);
  }
  function ruler() {
    if (!q('ruler')) return;
    const { w } = canvasSize(); const pxPerSec = w / st.dur;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300]; const step = steps.find(s => s * pxPerSec > 70) || 600;
    let html = '';
    for (let t = 0; t <= st.dur; t += step) html += `<span style="left:${t * pxPerSec}px">${fmt(t)}</span>`;
    q('ruler').innerHTML = html;
  }

  /* ---------------- Hi-Fi preview (server render, exact final sound) ---------------- */
  const hq = new Audio(); hq.preload = 'auto';
  let hqRaf = 0;
  function hqStop() {
    hq.pause(); cancelAnimationFrame(hqRaf);
    const b = root?.querySelector('[data-s="hifi"]');
    if (b) { b.disabled = false; b.innerHTML = `${icon('sparkles')}<span>Hi-Fi preview</span>`; }
    const l = root?.querySelector('[data-s="clockLbl"]'); if (l) l.textContent = 'quick preview · playhead';
    if (st?.peaks && root?.contains(root.querySelector('[data-s="clock"]'))) draw();
  }
  async function hifi() {
    if (!st?.peaks) return;
    if (!hq.paused) return hqStop();
    stop(); if (!audio.paused) Player.pause();
    const segs = kept().map(s => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3), speed: s.speed }));
    if (!segs.length) return toast('Everything is cut — nothing to play', { error: true });
    const b = q('hifi'); b.disabled = true; b.innerHTML = `<span class="mini-bar indet" style="width:60px"><div></div></span><span>Rendering…</span>`;
    try {
      const r = await api.preview({ source: st.id, segments: segs, pitch: st.pitch, reverb: st.reverb, fadeIn: st.fadeIn, fadeOut: st.fadeOut });
      if (!q('hifi')) return;
      hq.src = r.url; await hq.play();
      b.disabled = false; b.innerHTML = `${icon('stop')}<span>Stop Hi-Fi</span>`;
      q('clockLbl').textContent = 'Hi-Fi preview · final render';
      const tick = () => { if (hq.paused || !q('clock')) return hqStop(); q('clock').textContent = `${fmt(hq.currentTime)} / ${fmt(hq.duration || r.duration)}`; hqRaf = requestAnimationFrame(tick); };
      tick();
    } catch (e) { toast(e.message, { error: true }); hqStop(); }
  }
  hq.addEventListener('ended', hqStop);

  /* ---------------- preview playback ---------------- */
  function startPreview(from, until = null) {
    if (!st?.peaks) return;
    if (!hq.paused) hqStop();
    if (!audio.paused) Player.pause();
    let t = from ?? st.playhead;
    if (t >= st.dur - 0.05) t = 0;
    const s = segAt(t); if (s.cut) { const nx = st.segs.find(x => x.start >= s.end - EPS && !x.cut); if (!nx) return; t = nx.start; }
    st.until = until;
    pa.preservesPitch = pa.mozPreservesPitch = pa.webkitPreservesPitch = st.pitch === 'keep';
    pa.currentTime = t; pa.playbackRate = segAt(t).speed;
    pa.play().catch(() => {});
    setPlayIcon(true);
    cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  }
  function stop() { pa.pause(); cancelAnimationFrame(raf); setPlayIcon(false); }
  function setPlayIcon(on) { const b = root?.querySelector('[data-s="preview"]'); if (b) b.innerHTML = icon(on ? 'pause' : 'play'); }
  function loop() {
    if (!st || pa.paused || !q('wrap')) { setPlayIcon(false); return; }
    let t = pa.currentTime;
    if (st.until != null && t >= st.until) { stop(); st.playhead = st.until; st.until = null; draw(); return; }
    const s = segAt(t);
    if (s.cut) {
      const nx = st.segs.find(x => x.start >= s.end - EPS && !x.cut);
      if (!nx) { stop(); st.playhead = st.dur; draw(); return; }
      pa.currentTime = t = nx.start;
    }
    const sp = segAt(t).speed; if (Math.abs(pa.playbackRate - sp) > 1e-3) pa.playbackRate = sp;
    st.playhead = t;
    draw();
    // keep playhead in view when zoomed
    const wrap = q('wrap'); const X = t / st.dur * q('inner').clientWidth;
    if (st.zoom > 1 && (X < wrap.scrollLeft || X > wrap.scrollLeft + wrap.clientWidth - 40)) wrap.scrollLeft = X - 60;
    raf = requestAnimationFrame(loop);
  }
  pa.addEventListener('ended', () => { stop(); if (st) { st.playhead = 0; draw(); } });

  /* ---------------- events ---------------- */
  function bind() {
    const cv = q('canvas'), wrap = q('wrap');
    const tAt = e => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(st.dur, (e.clientX - r.left) / r.width * st.dur)); };
    const pxPerSec = () => cv.getBoundingClientRect().width / st.dur;
    let drag = null;
    cv.addEventListener('pointerdown', e => {
      if (!st.peaks) return;
      cv.setPointerCapture(e.pointerId);
      const t = tAt(e), tol = 7 / pxPerSec();
      if (st.sel && Math.abs(t - st.sel.a) < tol) drag = { mode: 'a', x: e.clientX };
      else if (st.sel && Math.abs(t - st.sel.b) < tol) drag = { mode: 'b', x: e.clientX };
      else drag = { mode: 'new', anchor: t, x: e.clientX, moved: false };
    });
    cv.addEventListener('pointermove', e => {
      if (!st.peaks) return;
      const t = tAt(e);
      st.hover = t;
      const tol = 7 / pxPerSec();
      cv.style.cursor = st.sel && (Math.abs(t - st.sel.a) < tol || Math.abs(t - st.sel.b) < tol) ? 'ew-resize' : 'crosshair';
      if (drag) {
        if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
        if (drag.mode === 'new' && drag.moved) st.sel = { a: Math.min(drag.anchor, t), b: Math.max(drag.anchor, t) };
        if (drag.mode === 'a') { st.sel.a = Math.min(t, st.sel.b - .05); }
        if (drag.mode === 'b') { st.sel.b = Math.max(t, st.sel.a + .05); }
        update();
      } else draw();
    });
    cv.addEventListener('pointerleave', () => { st.hover = null; draw(); });
    cv.addEventListener('pointerup', e => {
      if (!drag) return;
      if (drag.mode === 'new' && !drag.moved) {
        const t = tAt(e);
        if (st.sel && t >= st.sel.a && t <= st.sel.b) { st.playhead = t; }
        else { st.sel = null; st.playhead = t; }
        if (!pa.paused) startPreview(t);
        update();
      }
      drag = null;
    });
    wrap.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); zoom(e.deltaY < 0 ? 1.25 : 0.8, e);
    }, { passive: false });

    root.querySelector('.studio').addEventListener('click', e => {
      const b = e.target.closest('button[data-s]');
      const k = b?.dataset.s;
      const seg = e.target.closest('[data-undo-seg]');
      if (seg) { const [a, bb] = seg.dataset.undoSeg.split('|').map(Number); const before = snap(); apply(a, bb, s => { s.cut = false; s.speed = 1; }); commit(before); return; }
      const row = e.target.closest('[data-seg]');
      if (row) { const [a, bb] = row.dataset.seg.split('|').map(Number); st.sel = { a, b: bb }; st.playhead = a; update(); return; }
      if (!k) return;
      if (k === 'preview') return pa.paused ? startPreview() : stop();
      if (k === 'hifi') return hifi();
      if (k === 'undo') return undo();
      if (k === 'redo') return redo();
      if (k === 'zoomIn') return zoom(1.5);
      if (k === 'zoomOut') return zoom(1 / 1.5);
      if (k === 'cut') return op('cut');
      if (k === 'keep') return op('keep');
      if (k === 'resetSel') return op('reset');
      if (k === 'applySpeed') return op('speed');
      if (k === 'playSel' && st.sel) return startPreview(st.sel.a, st.sel.b);
      if (k === 'resetAll') return confirmModal('Start over?', 'All cuts and speed changes will be removed.', 'Start over').then(ok => ok && op('resetAll'));
      if (k === 'save') return save();
    });
    q('speed').addEventListener('input', e => {
      const v = +e.target.value; q('speedVal').textContent = v.toFixed(2) + '×';
      const box = e.target.closest('.speed-box'); box.firstElementChild.outerHTML = icon(v < 1 ? 'turtle' : v > 1 ? 'rabbit' : 'disc');
    });
    const selInput = (k) => q(k).addEventListener('change', () => {
      const a = parseTime(q('selA').value), b = parseTime(q('selB').value);
      if (!isNaN(a) && !isNaN(b) && b > a) { st.sel = { a: Math.max(0, a), b: Math.min(st.dur, b) }; update(); }
      else toast('Use times like 1:23.5', { error: true });
    });
    selInput('selA'); selInput('selB');
    q('pitch').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      st.pitch = b.dataset.v; q('pitch').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      pa.preservesPitch = pa.mozPreservesPitch = pa.webkitPreservesPitch = st.pitch === 'keep';
    });
    q('reverb').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      st.reverb = b.dataset.v; q('reverb').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    });
    q('fadeIn').addEventListener('input', e => st.fadeIn = Math.max(0, +e.target.value || 0));
    q('fadeOut').addEventListener('input', e => st.fadeOut = Math.max(0, +e.target.value || 0));
    q('title').addEventListener('input', () => st.titleTouched = true);
    new ResizeObserver(() => { if (st?.peaks && q('wrap')) { draw(); ruler(); } }).observe(wrap);
  }
  function zoom(f, e) {
    if (!st?.peaks) return;
    const wrap = q('wrap');
    const anchorX = e ? e.clientX - wrap.getBoundingClientRect().left : wrap.clientWidth / 2;
    const tAnchor = (wrap.scrollLeft + anchorX) / q('inner').clientWidth * st.dur;
    st.zoom = Math.max(1, Math.min(40, st.zoom * f));
    draw(); ruler();
    wrap.scrollLeft = tAnchor / st.dur * q('inner').clientWidth - anchorX;
  }

  async function save() {
    const segs = kept().map(s => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3), speed: s.speed }));
    if (!segs.length) return toast('Everything is cut — nothing to save', { error: true });
    const btn = q('save'); btn.disabled = true;
    try {
      const song = await api.edit({ source: st.id, segments: segs, pitch: st.pitch, reverb: st.reverb, fadeIn: st.fadeIn, fadeOut: st.fadeOut, title: q('title').value.trim() });
      toast('Rendering your edit…', { img: thumb(st.song), sub: song.title });
      refresh(true);
    } catch (e) { toast(e.message, { error: true }); }
    btn.disabled = false;
  }

  function onKey(e) {
    if (!st?.peaks) return false;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { e.preventDefault(); pa.paused ? startPreview() : stop(); return true; }
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return true; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return true; }
    if ((k === 'delete' || k === 'backspace') && st.sel) { e.preventDefault(); op('cut'); return true; }
    if (k === 'k' && st.sel) { op('keep'); return true; }
    if (k === 'escape') { st.sel = null; update(); return true; }
    if (k === '+' || k === '=') { zoom(1.5); return true; }
    if (k === '-') { zoom(1 / 1.5); return true; }
    if (k === 'arrowleft' || k === 'arrowright') { st.playhead = Math.max(0, Math.min(st.dur, st.playhead + (k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 0.1 : 2))); if (!pa.paused) startPreview(st.playhead); draw(); return true; }
    return false;
  }

  return { mount, unmount, onKey };
})();
