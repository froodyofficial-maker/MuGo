/* =====================================================================
   MuGo Studio — cut, trim and slow down parts of a song.
   The timeline is a list of segments covering the original track:
     { start, end, speed, cut }
   Preview plays the original file while skipping cut parts and changing
   playback rate; "Save" renders the result with ffmpeg on the server.
   ===================================================================== */
const Studio = (() => {
  const EPS = 1e-3;
  const COLORS = { cut: '251,113,133', slow: '96,165,250', fast: '251,191,36', d8: '192,132,252' };
  let st = null;          // editor state for the mounted song
  let root = null;        // view element
  const pa = new Audio(); // preview audio
  pa.preload = 'auto';

  /* Live effects for the quick preview, matching the server render:
     warm EQ → dry + (pre-delay → low-cut → convolution reverb) */
  const REVERBS = { room: [1.4, .018, 7500], hall: [3.2, .035, 6000], dreamy: [5.8, .055, 4500] };
  const fx = {
    ctx: null, irCache: {},
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      try {
        const c = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = c.createMediaElementSource(pa);
        this.low = c.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 95;
        this.mid = c.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 250; this.mid.Q.value = 1;
        this.high = c.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 5500;
        this.dry = c.createGain();
        this.delay = c.createDelay(1); this.hp = c.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 180;
        this.conv = c.createConvolver(); this.conv.normalize = false; this.wet = c.createGain(); this.wet.gain.value = 0;
        src.connect(this.low).connect(this.mid).connect(this.high);
        // 8D stage (same recipe as the server): mono → front/behind/head-shadow paths → per-ear gains
        this.post = c.createGain();
        this.orig = c.createGain(); this.high.connect(this.orig).connect(this.post);
        const mono = c.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
        const lp = f => { const b = c.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = f; return b; };
        const back = lp(3200), back2 = lp(3200), shadow = lp(1300);
        this.high.connect(mono); mono.connect(back).connect(back2); mono.connect(shadow);
        const merger = c.createChannelMerger(2);
        this.ear = [0, 1].map(ch => {
          const g = { front: c.createGain(), back: c.createGain(), shadow: c.createGain() };
          mono.connect(g.front); back2.connect(g.back); shadow.connect(g.shadow);
          Object.values(g).forEach(n => { n.gain.value = 0; n.connect(merger, 0, ch); });
          return g;
        });
        this.e8 = c.createGain(); this.e8.gain.value = 0; merger.connect(this.e8).connect(this.post);
        // 16D: binaural spatial graph (rebuilt when the room / bass settings change)
        this.spIn = c.createGain(); this.high.connect(this.spIn);
        this.spMake = c.createGain(); this.spGate = c.createGain(); this.spGate.gain.value = 0;
        this.spMake.connect(this.spGate).connect(this.post);
        this.rebuildSpatial();
        this.post.connect(this.dry).connect(c.destination);
        this.post.connect(this.delay).connect(this.hp).connect(this.conv).connect(this.wet).connect(c.destination);
        this.en = 0;
        this.update();
      } catch (e) { console.warn('live preview effects unavailable', e); this.ctx = null; }
    },
    /** Same recipe as the server: decorrelated pink-noise tails with an exponential decay, lowpassed. */
    ir(name) {
      if (this.irCache[name]) return this.irCache[name];
      const [tail, , lp] = REVERBS[name], c = this.ctx, sr = c.sampleRate, n = Math.floor(tail * sr);
      const buf = c.createBuffer(2, n, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, y = 0, e = 0;
        const a = Math.exp(-2 * Math.PI * lp / sr);  // one-pole lowpass
        for (let i = 0; i < n; i++) {
          const w = Math.random() * 2 - 1;  // Paul Kellet pink-noise filter
          b0 = .99886 * b0 + w * .0555179; b1 = .99332 * b1 + w * .0750759; b2 = .969 * b2 + w * .153852;
          b3 = .8665 * b3 + w * .3104856; b4 = .55 * b4 + w * .5329522; b5 = -.7616 * b5 - w * .016898;
          const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * .5362; b6 = w * .115926;
          y = (1 - a) * pink + a * y;
          const t = i / n, env = Math.pow(1 - t, 4) * Math.min(1, i / (sr * .012));  // ≈ exp decay + 12 ms attack
          d[i] = y * env; e += d[i] * d[i];
        }
        const k = 1 / Math.sqrt(e || 1); for (let i = 0; i < n; i++) d[i] *= k;  // energy-normalise like the server
      }
      return (this.irCache[name] = buf);
    },
    update() {
      if (!this.ctx || !st) return;
      const warm = st.warm, t = this.ctx.currentTime;
      this.low.gain.setTargetAtTime(warm ? 5 : 0, t, .05);
      this.mid.gain.setTargetAtTime(warm ? 1.5 : 0, t, .05);
      this.high.gain.setTargetAtTime(warm ? -4 : 0, t, .05);
      if (st.reverb && REVERBS[st.reverb] && !(st.eightD !== 'off' && st.sp.engine === 'binaural')) {
        if (this.conv.buffer !== this.ir(st.reverb)) this.conv.buffer = this.ir(st.reverb);
        this.delay.delayTime.value = REVERBS[st.reverb][1];
        const relDb = -16 + 17 * st.reverbAmount;               // same mapping as the server
        this.wet.gain.setTargetAtTime(Math.pow(10, (relDb - fx.cal) / 20), t, .05);
      } else this.wet.gain.setTargetAtTime(0, t, .05);
    },
    cal: 4.6,  // measured: browser wet level at gain 1 vs dry (server uses 6.3)
    rebuildSpatial() {
      if (!this.ctx || !st) return;
      if (this.sp) { try { this.spIn.disconnect(); this.sp.output.disconnect(); } catch {} }
      this.sp = Spatial.build(this.ctx, st.sp);   // live object: path settings apply instantly
      this.spIn.connect(this.sp.input); this.sp.output.connect(this.spMake);
      this.match = Spatial.makeMatcher(this.ctx, this.spIn, this.sp.output, this.spMake);
    },
    /** per-frame 8D motion; `t` is the position in the ORIGINAL song */
    frame(t) {
      if (!this.ctx || !st || !this.ear) return;
      const now = this.ctx.currentTime, set = (p, v) => p.setTargetAtTime(v, now, .015);
      const seg = segAt(t);
      const target = st.eightD === 'all' ? 1 : st.eightD === 'parts' && seg && seg.d8 ? 1 : 0;
      this.en += (target - this.en) * .06;                    // smooth ~0.5 s crossfade, like the render
      const en = this.en < .002 ? 0 : this.en;
      const th = 2 * Math.PI * outTime(t) / st.eightDPeriod;
      const x = .88 * Math.sin(th), fb = (1 + Math.cos(th)) / 2;
      const gains = [Math.cos((x + 1) * Math.PI / 4), Math.sin((x + 1) * Math.PI / 4)];
      const shad = [.75 * Math.max(0, x), .75 * Math.max(0, -x)];
      this.ear.forEach((g, i) => {
        const k = 1.18 * gains[i];
        set(g.front.gain, k * (1 - shad[i]) * fb);
        set(g.back.gain, k * (1 - shad[i]) * (1 - fb));
        set(g.shadow.gain, k * shad[i]);
      });
      if (st.sp.engine === 'binaural') {
        set(this.e8.gain, 0); set(this.spGate.gain, en); set(this.orig.gain, 1 - en);
        if (en > .001) { this.sp.s = st.sp; Spatial.place(this.sp, outTime(t)); this.match(); }
      } else {
        set(this.spGate.gain, 0);
        set(this.e8.gain, .85 * en);
        set(this.orig.gain, 1 - .85 * en);
      }
    },
  };
  /** map an original-song time to the time in the edited output (cuts removed, speed applied) */
  function outTime(t) {
    let o = 0;
    for (const s of st.segs) {
      if (s.start >= t) break;
      if (!s.cut) o += (Math.min(t, s.end) - s.start) / s.speed;
    }
    return o;
  }
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
      zoom: 1, eightD: 'off', eightDPeriod: 8, sp: { ...Spatial.DEFAULTS, room: 'studio', roomAmt: .7, ...store.get('spatial', {}) }, pitch: store.get('studioPitch', 'vinyl'), semitones: 0, warm: false, reverb: '', reverbAmount: .7, fadeIn: 0, fadeOut: 0, playhead: 0, titleTouched: false, hover: null,
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
          <span><i style="background:rgba(${COLORS.d8},.9)"></i>8D audio</span>
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
            <button class="btn d8" data-s="d8" title="Make this part spin around your head (headphones)">${icon('headphones')}<span>8D this part</span></button>
            <button class="btn ghost" data-s="resetSel">${icon('refresh')}<span>Reset part</span></button>
          </div>
          <span class="sep"></span>
          <div class="speed-box">${icon('turtle')}<input type="range" min="0.5" max="1.5" step="0.05" value="0.8" data-s="speed"><b data-s="speedVal">0.80×</b>
            <button class="btn primary" data-s="applySpeed" style="height:30px;padding:0 14px"><span data-s="speedLbl">Apply</span></button></div>
        </div>
      </div>


      <div class="panel sp-panel" data-s="spPanel">
        <div class="sp-head"><div><h4 style="margin:0">3D / 8D audio 🎧</h4><small>Put on headphones. The music moves around you inside a virtual room</small></div>
          <div class="seg-toggle" data-s="eightD"><button data-v="off">Off</button><button data-v="all">Whole song</button><button data-v="parts">Marked parts</button></div></div>
        <div class="sp-body">
          <div class="sp-controls">
            <div class="opt-row"><div><b>Engine</b><small><b>16D</b>: binaural head model and real room reflections, for depth and space · <b>Classic 8D</b>: simple left/right circling</small></div>
              <div class="seg-toggle" data-s="spEngine"><button data-v="binaural">16D · binaural</button><button data-v="classic">Classic 8D</button></div></div>
            <div class="opt-row sp-bin"><div><b>Movement</b><small>The path the music takes around you</small></div>
              <div class="seg-toggle" data-s="spMotion"><button data-v="circle">Circle</button><button data-v="figure8">Figure 8</button><button data-v="pingpong">Ping-pong</button><button data-v="spiral">Spiral</button><button data-v="wander">Wander</button></div></div>
            <div class="opt-row sp-bin"><div><b>Direction</b></div><div class="seg-toggle" data-s="spDir"><button data-v="1">Clockwise</button><button data-v="-1">Counter-clockwise</button></div></div>
            <div class="opt-row"><div><b>Speed</b><small>Seconds for one full lap</small></div><div class="sp-slider"><span class="sel-label">fast</span><input type="range" min="3" max="30" step="0.5" data-s="period" style="width:150px"><span class="sel-label">slow</span><b data-s="periodVal"></b></div></div>
            <div class="opt-row sp-bin"><div><b>Distance</b><small>How far from your head the music plays</small></div><div class="sp-slider"><span class="sel-label">close</span><input type="range" min="0.5" max="4" step="0.1" data-s="spDist" style="width:150px"><span class="sel-label">far</span><b data-s="spDistVal"></b></div></div>
            <div class="opt-row sp-bin"><div><b>Breathing</b><small>Drifts closer and further away</small></div><div class="sp-slider"><span class="sel-label">none</span><input type="range" min="0" max="100" step="5" data-s="spBreath" style="width:150px"><span class="sel-label">lots</span><b data-s="spBreathVal"></b></div></div>
            <div class="opt-row sp-bin"><div><b>Height</b><small>Rises above and dips below your ears</small></div><div class="sp-slider"><span class="sel-label">flat</span><input type="range" min="0" max="100" step="5" data-s="spHeight" style="width:150px"><span class="sel-label">high</span><b data-s="spHeightVal"></b></div></div>
            <div class="opt-row sp-bin"><div><b>Width</b><small>Keeps some of the song's stereo spread</small></div><div class="sp-slider"><span class="sel-label">point</span><input type="range" min="0" max="100" step="5" data-s="spWidth" style="width:150px"><span class="sel-label">wide</span><b data-s="spWidthVal"></b></div></div>
            <div class="opt-row sp-bin"><div><b>Room</b><small>The space you're standing in</small></div>
              <div class="seg-toggle" data-s="spRoom"><button data-v="none">None</button><button data-v="small">Small room</button><button data-v="studio">Empty room</button><button data-v="hall">Big empty hall</button><button data-v="cathedral">Cathedral</button></div></div>
            <div class="opt-row sp-bin"><div><b>Room amount</b><small>Echoes from the walls, floor and ceiling, plus the room's tail</small></div><div class="sp-slider"><span class="sel-label">dry</span><input type="range" min="0" max="100" step="5" data-s="spRoomAmt" style="width:150px"><span class="sel-label">roomy</span><b data-s="spRoomAmtVal"></b></div></div>
            <div class="opt-row sp-bin"><div><b>Keep bass centred</b><small>Bass stays solid in the middle, like pro 16D mixes</small></div><div class="seg-toggle" data-s="spBass"><button data-v="1">On</button><button data-v="0">Off</button></div></div>
          </div>
          <div class="sp-radar"><canvas data-s="radar"></canvas><div class="sel-label">Top view · the dot is the music (bigger = higher) · dashed box = room</div></div>
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
          <div class="opt-row"><div><b>When slowing down</b><small><b>Deeper</b>: like slowing a record, so the pitch and tone drop with the speed (the classic “slowed” sound) · <b>Keep pitch</b>: only the tempo changes (studio time-stretch)</small></div>
            <div class="seg-toggle" data-s="pitch"><button data-v="vinyl">Deeper</button><button data-v="keep">Keep pitch</button></div></div>
          <div class="opt-row"><div><b>Extra depth</b><small>Shift the whole song's pitch down (or up) without changing speed. Hear it with Hi-Fi preview</small></div>
            <div style="display:flex;align-items:center;gap:10px"><input type="range" min="-12" max="6" step="0.5" value="0" data-s="semis" style="width:130px;accent-color:#f472b6"><b data-s="semisVal" style="width:92px;text-align:right;font-variant-numeric:tabular-nums">0 semitones</b></div></div>
          <div class="opt-row"><div><b>Warm, heavy tone</b><small>Boosts the bass and softens the highs for a darker sound</small></div>
            <div class="seg-toggle" data-s="warm"><button data-v="0" class="on">Off</button><button data-v="1">On</button></div></div>
          <div class="opt-row" data-s="reverbRow"><div><b>Reverb</b><small data-s="reverbNote">Convolution reverb, the “slowed + reverb” sound. You hear it in the preview too</small></div>
            <div class="seg-toggle" data-s="reverb"><button data-v="" class="on">Off</button><button data-v="room">Room</button><button data-v="hall">Hall</button><button data-v="dreamy">Dreamy</button></div></div>
          <div class="opt-row" data-s="amountRow" style="opacity:.4;pointer-events:none"><div><b>Reverb amount</b><small>How loud the echo is compared to the song</small></div>
            <div style="display:flex;align-items:center;gap:10px"><input type="range" min="0" max="100" step="5" value="70" data-s="revAmt" style="width:130px;accent-color:#f472b6"><b data-s="revAmtVal" style="width:44px;text-align:right;font-variant-numeric:tabular-nums">70%</b></div></div>
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
      if (p && p.cut === s.cut && !!p.d8 === !!s.d8 && Math.abs(p.speed - s.speed) < 1e-6) p.end = s.end;
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
    else if (name === 'reset' && sel) apply(sel.a, sel.b, s => { s.cut = false; s.speed = 1; s.d8 = false; });
    else if (name === 'd8' && sel) {
      const inSel = st.segs.filter(s => s.end > sel.a + EPS && s.start < sel.b - EPS);
      const turnOn = !inSel.every(s => s.d8);
      apply(sel.a, sel.b, s => s.d8 = turnOn);
      if (turnOn && st.eightD !== 'all') setEightD('parts');
      toast(turnOn ? '8D on for this part 🎧' : '8D removed from this part');
    }
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
    ['cut', 'keep', 'playSel', 'resetSel', 'd8'].forEach(k => q(k).disabled = !has);
    if (document.activeElement !== q('selA')) q('selA').value = has ? fmtMs(sel.a) : '';
    if (document.activeElement !== q('selB')) q('selB').value = has ? fmtMs(sel.b) : '';
    q('selLen').textContent = has ? `(${fmtMs(sel.b - sel.a)})` : 'none — speed applies to whole song';
    q('speedLbl').textContent = has ? 'Apply to selection' : 'Apply to whole song';
    q('undo').disabled = !st.hist.length; q('redo').disabled = !st.fut.length;
    q('undo').style.opacity = st.hist.length ? 1 : .35; q('redo').style.opacity = st.fut.length ? 1 : .35;
    const L = outLen();
    q('len').innerHTML = `${fmt(L)}<span style="font-size:14px;color:var(--muted);font-weight:600"> / ${fmt(st.dur)}</span>`;
    // edit list
    const edits = st.segs.filter(s => s.cut || s.speed !== 1 || s.d8);
    q('segList').innerHTML = edits.length ? edits.map(s => {
      const c = s.cut ? COLORS.cut : s.speed < 1 ? COLORS.slow : s.speed > 1 ? COLORS.fast : COLORS.d8;
      const lbl = s.cut ? 'Cut out' : [s.speed !== 1 ? (s.speed < 1 ? 'Slowed' : 'Sped up') + ` · ${s.speed.toFixed(2)}×` : '', s.d8 ? '8D audio' : ''].filter(Boolean).join(' + ');
      return `<div class="seg-row" data-seg="${s.start}|${s.end}"><span class="dot" style="background:rgb(${c})"></span><span class="lbl">${lbl}</span>
        <span style="color:var(--muted)">${fmtMs(s.start)} → ${fmtMs(s.end)}</span><button class="icon-btn" data-undo-seg="${s.start}|${s.end}" title="Reset this part">${icon('close')}</button></div>`;
    }).join('') : `<div style="color:var(--faint);padding:8px 2px;line-height:1.6">No edits yet. Select a part of the waveform, then cut it out, keep only it, or change its speed.</div>`;
    // smart title
    if (!st.titleTouched) {
      const k = kept(); const allSlow = k.length && k.every(s => s.speed < 1), allFast = k.length && k.every(s => s.speed > 1);
      const tag = st.eightD === 'off' ? '' : st.sp.engine === 'binaural' ? ' · 16D' : ' · 8D';
      q('title').value = `${st.song.title} (${allSlow ? 'slowed' : allFast ? 'sped up' : 'edit'}${tag})`;
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
    // 8D parts: purple band along the bottom with a label
    for (const s of st.segs) {
      if (s.cut || !(s.d8 || st.eightD === 'all')) continue;
      const a = X(s.start), wd = X(s.end) - a;
      x.fillStyle = `rgba(${COLORS.d8},${st.eightD === 'all' || st.eightD === 'parts' ? .12 : .05})`; x.fillRect(a, 0, wd, h);
      x.fillStyle = `rgba(${COLORS.d8},.95)`; x.fillRect(a, h - 4, wd, 4);
      if (wd > 30 && (s.d8 || s === st.segs.find(z => !z.cut))) { x.font = '800 11px system-ui'; x.fillText('8D', a + 6, h - 10); }
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

  /** options for the server render; in 16D mode the server skips 8D + reverb and the browser adds the 3D stage */
  function renderOpts() {
    const on = spatialOn();
    return { source: st.id, pitch: st.pitch, semitones: st.semitones, warm: st.warm,
      reverb: on ? '' : st.reverb, reverbAmount: st.reverbAmount,
      eightD: on ? 'off' : st.eightD, eightDPeriod: st.eightDPeriod, fadeIn: st.fadeIn, fadeOut: st.fadeOut };
  }
  /** full-quality 16D render: server does cuts/speed/tone, then the binaural room is rendered here */
  async function render3D(segs, label) {
    const r = await api.preview({ ...renderOpts(), segments: segs });
    const ab = await (await fetch(r.url)).arrayBuffer();
    const buf = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(ab);
    const parts = partsIntervals();
    const gate = st.eightD === 'all' ? null : t => gateAt(parts, t);
    return Spatial.renderOffline(buf, { ...st.sp }, gate, p => label(`3D ${Math.round(p * 100)}%`));
  }

  /* ---------------- Hi-Fi preview (server render, exact final sound) ---------------- */
  const hq = new Audio(); hq.preload = 'auto';
  let hqRaf = 0, hqBuf = null;   // hqBuf = { ctx, src, t0, dur } when playing a 16D render
  const hqTime = () => hqBuf ? hqBuf.ctx.currentTime - hqBuf.t0 : hq.currentTime;
  const hqPlaying = () => !!hqBuf || !hq.paused;
  function hqStop() {
    hq.pause(); cancelAnimationFrame(hqRaf);
    if (hqBuf) { try { hqBuf.src.stop(); hqBuf.ctx.close(); } catch {} hqBuf = null; }
    const b = root?.querySelector('[data-s="hifi"]');
    if (b) { b.disabled = false; b.innerHTML = `${icon('sparkles')}<span>Hi-Fi preview</span>`; }
    const l = root?.querySelector('[data-s="clockLbl"]'); if (l) l.textContent = 'quick preview · playhead';
    if (st?.peaks && root?.contains(root.querySelector('[data-s="clock"]'))) draw();
  }
  async function hifi() {
    if (!st?.peaks) return;
    if (hqPlaying()) return hqStop();
    stop(); if (!audio.paused) Player.pause();
    const segs = kept().map(s => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3), speed: s.speed, d8: !!s.d8 }));
    if (!segs.length) return toast('Everything is cut — nothing to play', { error: true });
    const b = q('hifi'); b.disabled = true; b.innerHTML = `<span class="mini-bar indet" style="width:60px"><div></div></span><span>Rendering…</span>`;
    try {
      let dur;
      if (spatialOn()) {
        const out = await render3D(segs, txt => { if (q('hifi')) b.innerHTML = `<span class="mini-bar indet" style="width:60px"><div></div></span><span>${txt}</span>`; });
        if (!q('hifi')) return;
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = ctx.createBufferSource(); src.buffer = out; src.connect(ctx.destination);
        hqBuf = { ctx, src, t0: ctx.currentTime + .05 }; src.start(hqBuf.t0); dur = out.duration;
        src.onended = () => { if (hqBuf && hqBuf.src === src) hqStop(); };
      } else {
        const r = await api.preview({ ...renderOpts(), segments: segs });
        if (!q('hifi')) return;
        hq.src = r.url; await hq.play(); dur = r.duration;
      }
      b.disabled = false; b.innerHTML = `${icon('stop')}<span>Stop Hi-Fi</span>`;
      q('clockLbl').textContent = 'Hi-Fi preview · final render';
      const tick = () => {
        if (!hqPlaying() || !q('clock')) return hqStop();
        q('clock').textContent = `${fmt(Math.max(0, hqTime()))} / ${fmt(hq.duration || dur)}`;
        if (spatialOn()) radar('hq');
        hqRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { toast(e.message, { error: true }); hqStop(); }
  }
  hq.addEventListener('ended', hqStop);

  /* ---------------- preview playback ---------------- */
  function startPreview(from, until = null) {
    if (!st?.peaks) return;
    if (hqPlaying()) hqStop();
    if (!audio.paused) Player.pause();
    let t = from ?? st.playhead;
    if (t >= st.dur - 0.05) t = 0;
    const s = segAt(t); if (s.cut) { const nx = st.segs.find(x => x.start >= s.end - EPS && !x.cut); if (!nx) return; t = nx.start; }
    st.until = until;
    pa.preservesPitch = pa.mozPreservesPitch = pa.webkitPreservesPitch = st.pitch === 'keep';
    pa.currentTime = t; pa.playbackRate = segAt(t).speed;
    fx.init();
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
    fx.frame(t);
    radar(true);
    draw();
    // keep playhead in view when zoomed
    const wrap = q('wrap'); const X = t / st.dur * q('inner').clientWidth;
    if (st.zoom > 1 && (X < wrap.scrollLeft || X > wrap.scrollLeft + wrap.clientWidth - 40)) wrap.scrollLeft = X - 60;
    raf = requestAnimationFrame(loop);
  }
  pa.addEventListener('ended', () => { stop(); if (st) { st.playhead = 0; draw(); } });

  const spatialOn = () => st.eightD !== 'off' && st.sp.engine === 'binaural';
  function setEightD(v) {
    st.eightD = v;
    if (v === 'parts' && !st.segs.some(s => s.d8)) toast('Select a part of the waveform, then press “8D this part”');
    syncSpatial();
  }
  /** reflect st.sp / st.eightD in the panel, remember settings, refresh live audio + radar */
  function syncSpatial(structural = false) {
    const sp = st.sp, P = q('spPanel'); if (!P) return;
    const tog = (k, v) => q(k).querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === String(v)));
    tog('eightD', st.eightD); tog('spEngine', sp.engine); tog('spMotion', sp.motion); tog('spDir', sp.dir); tog('spRoom', sp.room); tog('spBass', sp.keepBass ? 1 : 0);
    const val = (k, v, txt) => { const el = q(k); if (document.activeElement !== el) el.value = v; q(k + 'Val').textContent = txt; };
    val('period', sp.period, sp.period + ' s'); val('spDist', sp.distance, sp.distance.toFixed(1) + ' m');
    val('spBreath', Math.round(sp.breath * 100), Math.round(sp.breath * 100) + '%'); val('spHeight', Math.round(sp.height * 100), Math.round(sp.height * 100) + '%');
    val('spWidth', Math.round(sp.width * 100), Math.round(sp.width * 100) + '%'); val('spRoomAmt', Math.round(sp.roomAmt * 100), Math.round(sp.roomAmt * 100) + '%');
    P.classList.toggle('classic', sp.engine === 'classic'); P.classList.toggle('off', st.eightD === 'off');
    q('spRoomAmt').closest('.opt-row').style.opacity = sp.room === 'none' ? .4 : '';
    st.eightDPeriod = sp.period;
    // in 16D mode the room replaces the separate reverb
    const rr = q('reverbRow'), on = spatialOn();
    rr.style.opacity = on ? .4 : ''; rr.style.pointerEvents = on ? 'none' : '';
    q('reverbNote').textContent = on ? 'Turned off while 16D is on: the 3D room provides the space' : 'Convolution reverb, the “slowed + reverb” sound. You hear it in the preview too';
    store.set('spatial', sp);
    if (structural) fx.rebuildSpatial();
    fx.update();
    radar(false);
    draw();
  }
  function radar(live) {
    const cv = q('radar'); if (!cv) return;
    const t = live === 'hq' ? hqTime() : outTime(st.playhead);
    Spatial.drawRadar(cv, st.sp, t, !!live && st.eightD !== 'off');
  }
  /** output-time spans of the parts marked for 8D */
  function partsIntervals() {
    const out = []; let o = 0;
    for (const s of st.segs) {
      if (s.cut) continue;
      const len = (s.end - s.start) / s.speed;
      if (s.d8) { const last = out[out.length - 1]; if (last && Math.abs(last[1] - o) < 1e-3) last[1] = o + len; else out.push([o, o + len]); }
      o += len;
    }
    return out;
  }
  const gateAt = (parts, t) => Math.min(1, parts.reduce((a, [x, y]) => a + Math.min(1, Math.max(0, (t - x) / .6)) * Math.min(1, Math.max(0, (y - t) / .6)), 0));

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
      if (seg) { const [a, bb] = seg.dataset.undoSeg.split('|').map(Number); const before = snap(); apply(a, bb, s => { s.cut = false; s.speed = 1; s.d8 = false; }); commit(before); return; }
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
      if (k === 'd8') return op('d8');
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
      st.pitch = b.dataset.v; store.set('studioPitch', st.pitch); q('pitch').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      pa.preservesPitch = pa.mozPreservesPitch = pa.webkitPreservesPitch = st.pitch === 'keep';
    });
    q('pitch').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === st.pitch));
    q('semis').addEventListener('input', e => {
      st.semitones = +e.target.value;
      q('semisVal').textContent = st.semitones === 0 ? '0 semitones' : `${st.semitones > 0 ? '+' : ''}${st.semitones} semitone${Math.abs(st.semitones) === 1 ? '' : 's'}`;
    });
    q('warm').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      st.warm = b.dataset.v === '1'; q('warm').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      fx.update();
    });
    q('reverb').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      st.reverb = b.dataset.v; q('reverb').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      const row = q('amountRow'); row.style.opacity = st.reverb ? 1 : .4; row.style.pointerEvents = st.reverb ? '' : 'none';
      fx.update();
    });
    q('eightD').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setEightD(b.dataset.v); });
    const pick = (k, fn, structural) => q(k).addEventListener('click', e => { const b = e.target.closest('button'); if (b) { fn(b.dataset.v); syncSpatial(structural); } });
    pick('spEngine', v => st.sp.engine = v, true);
    pick('spMotion', v => st.sp.motion = v);
    pick('spDir', v => st.sp.dir = +v);
    pick('spRoom', v => st.sp.room = v, true);
    pick('spBass', v => st.sp.keepBass = v === '1', true);
    const slide = (k, fn, structural) => {
      q(k).addEventListener('input', e => { fn(+e.target.value); syncSpatial(false); });
      if (structural) q(k).addEventListener('change', () => syncSpatial(true));
    };
    slide('period', v => st.sp.period = v);
    slide('spDist', v => st.sp.distance = v);
    slide('spBreath', v => st.sp.breath = v / 100);
    slide('spHeight', v => st.sp.height = v / 100);
    slide('spWidth', v => st.sp.width = v / 100);
    slide('spRoomAmt', v => st.sp.roomAmt = v / 100, true);
    syncSpatial();
    q('revAmt').addEventListener('input', e => {
      st.reverbAmount = +e.target.value / 100; q('revAmtVal').textContent = e.target.value + '%'; fx.update();
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
    const segs = kept().map(s => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3), speed: s.speed, d8: !!s.d8 }));
    if (!segs.length) return toast('Everything is cut — nothing to save', { error: true });
    const btn = q('save'); btn.disabled = true;
    const label = btn.innerHTML;
    try {
      const title = q('title').value.trim();
      if (spatialOn()) {
        const out = await render3D(segs, txt => { btn.innerHTML = `<span class="mini-bar indet" style="width:60px"><div></div></span><span>Rendering ${txt}</span>`; });
        btn.innerHTML = `<span class="mini-bar indet" style="width:60px"><div></div></span><span>Saving…</span>`;
        const fd = new FormData();
        fd.append('audio', Spatial.encodeWav(out), 'edit.wav'); fd.append('source', st.id); fd.append('title', title);
        const r = await fetch('/api/edit/upload', { method: 'POST', body: fd });
        const song = await r.json(); if (!r.ok) throw new Error(song.error || 'Saving failed');
        toast('Saved to your library 🎧', { img: thumb(st.song), sub: song.title });
      } else {
        const song = await api.edit({ ...renderOpts(), segments: segs, title });
        toast('Rendering your edit…', { img: thumb(st.song), sub: song.title });
      }
      refresh(true);
    } catch (e) { toast(e.message, { error: true }); }
    btn.disabled = false; btn.innerHTML = label;
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
