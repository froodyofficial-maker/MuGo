/* =====================================================================
   MuGo — 16D spatial audio engine (binaural)

   Places the music at a moving point around the listener inside a virtual
   room, the way "16D" / binaural tracks are made:
     • HRTF panning (the browser's measured human-head model): real
       interaural time differences, high-frequency head shadow,
       front/back and height cues — not just left/right volume.
     • First-order room reflections (image-source method): each of the 6
       walls/floor/ceiling sends a delayed, darker copy from its own
       direction, which is what gives distance and "being in a room".
     • A diffuse late reverb tail sized to the room.
     • Bass kept centred (below 120 Hz) so the low end stays solid.
   The same graph runs live (preview) and offline (final render), so the
   preview sounds exactly like the saved file.
   Coordinates: listener at origin, facing −Z, +X right, +Y up (metres).
   ===================================================================== */
const Spatial = (() => {
  const C = 343;  // speed of sound m/s

  const ROOMS = {
    none:      null,
    small:     { label: 'Small room',     w: 4.5, h: 2.6, d: 4,  refl: .62, damp: 9500, tail: .7,  pre: .010, tailGain: .55 },
    studio:    { label: 'Empty studio',   w: 7,   h: 3.4, d: 6,  refl: .68, damp: 8500, tail: 1.3, pre: .018, tailGain: .7 },
    hall:      { label: 'Big empty hall', w: 18,  h: 8,   d: 24, refl: .74, damp: 7200, tail: 2.9, pre: .038, tailGain: .9 },
    cathedral: { label: 'Cathedral',      w: 30,  h: 18,  d: 45, refl: .8,  damp: 6000, tail: 5.6, pre: .065, tailGain: 1.05 },
  };
  const EAR_H = 1.2;  // ears are 1.2 m above the floor
  /* The room adds energy above the bass split, so after loudness matching the bass would sit
     lower. Measured shortfall (dB) at room amount 0 / 35 / 70 / 100 %, given back to the bass. */
  const ROOM_BASS = { small: [0, 1.1, 2.5, 3.5], studio: [0, .9, 2.5, 3.5], hall: [0, 1, 2.9, 4.7], cathedral: [0, 1.4, 3.9, 6.1] };
  function roomBassDb(room, amt) {
    const t = ROOM_BASS[room]; if (!t) return 0;
    const xs = [0, .35, .7, 1], a = Math.max(0, Math.min(1, amt));
    for (let i = 1; i < 4; i++) if (a <= xs[i]) return t[i - 1] + (t[i] - t[i - 1]) * (a - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return t[3];
  }
  /* The head model, averaged over all directions, darkens everything above 1 kHz by 4–8 dB
     (measured). Pro binaural tools undo that "diffuse-field" colouring so the music keeps its
     tone; this EQ was fitted to the measurement (residual within about ±1 dB). */
  const HRTF_EQ = [['peaking', 180, -1.6, .8], ['highshelf', 1200, 4, 0], ['peaking', 5800, -1.2, 1.4], ['peaking', 8400, 5.4, 2.2], ['highshelf', 12000, 1.6, 0]];
  /* The HRTF panner delays its output (≈301 samples in Chromium). Everything that bypasses it
     (centred bass, original mix) is delayed by the same amount so nothing smears or cancels. */
  let LATENCY = 301;
  const latencyReady = (async () => {
    try {
      const sr = 44100, c = new OfflineAudioContext(2, 4096, sr), b = c.createBuffer(1, 4096, sr);
      b.getChannelData(0)[64] = 1;
      const src = c.createBufferSource(); src.buffer = b;
      const p = c.createPanner(); p.panningModel = 'HRTF'; p.positionZ.value = -1;
      src.connect(p).connect(c.destination); src.start();
      const L = (await c.startRendering()).getChannelData(0);
      let pk = 0, pi = 64; for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > pk) { pk = Math.abs(L[i]); pi = i; }
      if (pi - 64 >= 0 && pi - 64 < 2048) LATENCY = pi - 64;
    } catch {}
    return LATENCY;
  })();

  const DEFAULTS = {
    engine: 'binaural', motion: 'circle', dir: 1, period: 8, distance: 1.6, breath: .3,
    height: .2, width: .35, room: 'studio', roomAmt: .6, keepBass: true,
  };

  /* ---------------- motion paths ---------------- */
  function position(s, t) {
    const TAU = Math.PI * 2, per = Math.max(2, s.period);
    const th = s.dir * TAU * t / per;
    let az = th, dist = s.distance, y = 0;
    if (s.motion === 'pingpong') az = (Math.PI / 2) * Math.sin(th);                       // left ↔ right through the front
    else if (s.motion === 'figure8') { az = th; dist *= .55 + .45 * Math.abs(Math.cos(th)); } // pinches at the sides
    else if (s.motion === 'wander') { az = th + 1.3 * Math.sin(.37 * th + 1) + .6 * Math.sin(.71 * th); dist *= 1 + .35 * Math.sin(.23 * th + 2); }
    // distance "breathing" (comes closer, moves away)
    dist *= 1 + s.breath * .45 * Math.sin(TAU * t / (per * 1.37) + .5);
    // vertical movement
    const hAmt = s.motion === 'spiral' ? Math.max(.6, s.height) : s.height;
    y = hAmt * 1.3 * Math.sin(TAU * t / (per * (s.motion === 'spiral' ? 2.2 : 1.618)) + .3);
    dist = Math.max(.45, dist);
    let x = dist * Math.sin(az), z = -dist * Math.cos(az);
    const r = ROOMS[s.room];
    if (r) {  // stay inside the room
      x = clamp(x, -r.w / 2 + .3, r.w / 2 - .3); z = clamp(z, -r.d / 2 + .3, r.d / 2 - .3);
      y = clamp(y, -EAR_H + .3, r.h - EAR_H - .3);
    }
    return [x, y, z];
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /** first-order image sources for the 6 surfaces */
  function images(r, [x, y, z]) {
    const ceil = r.h - EAR_H;
    return [
      [r.w - x, y, z], [-r.w - x, y, z],                 // right / left wall
      [x, -2 * EAR_H - y, z], [x, 2 * ceil - y, z],       // floor / ceiling
      [x, y, -r.d - z], [x, y, r.d - z],                  // front / back wall
    ];
  }
  const len = p => Math.hypot(p[0], p[1], p[2]);
  /** sideways offset of the L/R "speakers" around the moving point (stereo width) */
  function spread(p, s, side) {
    const d = Math.max(.3, Math.hypot(p[0], p[2])), az = Math.atan2(p[0], -p[2]) + side * (.35 + s.width * .9);
    return [d * Math.sin(az), p[1], -d * Math.cos(az)];
  }

  /* ---------------- room tail ---------------- */
  const irCache = new Map();
  function tailIR(ctx, r) {
    const key = ctx.sampleRate + ':' + r.tail + ':' + r.damp + ':' + (ctx instanceof OfflineAudioContext ? 'o' : 'l');
    if (irCache.has(key) && irCache.get(key).ctx === ctx) return irCache.get(key).buf;
    const sr = ctx.sampleRate, n = Math.floor(r.tail * sr), buf = ctx.createBuffer(2, n, sr);
    const a = Math.exp(-2 * Math.PI * r.damp / sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let y = 0, e = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        // denser over time, darker over time (high frequencies die first, like real rooms)
        y = (1 - a) * (Math.random() * 2 - 1) + a * y;
        d[i] = y * Math.exp(-6.9 * t / r.tail) * Math.min(1, i / (sr * .02));
        e += d[i] * d[i];
      }
      const k = 1 / Math.sqrt(e || 1); for (let i = 0; i < n; i++) d[i] *= k;
    }
    irCache.set(key, { ctx, buf });
    return buf;
  }

  /* ---------------- the graph ---------------- */
  function panner(ctx) {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    p.refDistance = 1; p.rolloffFactor = 1; p.maxDistance = 1000;
    return p;
  }
  /**
   * Build the spatial graph. `input` receives the stereo music, `output` emits binaural stereo.
   * Call `place(t, when, mode)` to move things (mode 'live' = smoothed, or use `automate()` offline).
   */
  function build(ctx, s) {
    const g = { ctx, s, input: ctx.createGain(), output: ctx.createGain() };
    // NB: for Web Audio lowpass/highpass, Q is a resonance in dB. A Butterworth (flat) response is
    // −3.0103 dB, not 0.707. Two of them in a row = a Linkwitz-Riley crossover that sums flat.
    const bq = (type, f, q = -3.0103) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    let hi = g.input;
    if (s.keepBass) {  // Linkwitz-Riley style split: bass stays centred, the rest moves
      const l1 = bq('lowpass', 120), l2 = bq('lowpass', 120), h1 = bq('highpass', 120), h2 = bq('highpass', 120);
      g.input.connect(l1).connect(l2);
      const bassMono = ctx.createGain(); bassMono.channelCount = 1; bassMono.channelCountMode = 'explicit';
      const align = ctx.createDelay(1); align.delayTime.value = LATENCY / ctx.sampleRate;  // line up with the head model
      g.bassGain = ctx.createGain(); g.bassGain.gain.value = 1 / Math.max(1, s.distance)    // same distance law as the moving part
        * Math.pow(10, roomBassDb(s.room, s.roomAmt) / 20);                                // and the room's extra energy
      l2.connect(bassMono).connect(align).connect(g.bassGain).connect(g.output);
      g.input.connect(h1).connect(h2); hi = h2;
    }
    const mkMono = () => { const m = ctx.createGain(); m.channelCount = 1; m.channelCountMode = 'explicit'; m.channelInterpretation = 'speakers'; return m; };
    const dryMono = mkMono(); hi.connect(dryMono);           // feeds the room tail (not head-modelled)
    let eq = hi;                                              // tone correction for everything that goes through the head model
    for (const [type, f, gain, q] of HRTF_EQ) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.gain.value = gain; if (q) b.Q.value = q; eq.connect(b); eq = b; }
    const split = ctx.createChannelSplitter(2); eq.connect(split);
    const mono = mkMono(); eq.connect(mono);
    // direct sound, mid/side: the shared middle of the mix is ONE source (so it isn't summed twice and
    // comb-filtered), the stereo difference rides on two spread sources with opposite polarity (width)
    const midP = panner(ctx); mono.connect(midP).connect(g.output);
    const side = ctx.createGain(); side.channelCount = 1; side.channelCountMode = 'explicit';
    const sl = ctx.createGain(), sr = ctx.createGain(); sl.gain.value = .5; sr.gain.value = -.5;
    split.connect(sl, 0); split.connect(sr, 1); sl.connect(side); sr.connect(side);
    g.direct = [midP];
    g.sides = [1, -1].map(sign => {
      const p = panner(ctx), gn = ctx.createGain(); gn.gain.value = sign * Math.min(1, s.width * 1.6);
      side.connect(gn).connect(p).connect(g.output);
      return p;
    });
    g.room = ROOMS[s.room];
    g.refl = [];
    if (g.room) {
      const amt = s.roomAmt;
      for (let k = 0; k < 6; k++) {
        const dl = ctx.createDelay(1), lp = bq('lowpass', g.room.damp * (k === 2 ? .7 : 1)), gain = ctx.createGain(), p = panner(ctx);
        // the floor bounce (k = 2) arrives only ~4 ms late and would notch the low-mids (~130 Hz); treat the floor as rugged
        gain.gain.value = g.room.refl * Math.sqrt(amt) * 1.15 * (k === 2 ? .45 : 1);
        mono.connect(dl).connect(lp).connect(gain).connect(p).connect(g.output);
        g.refl.push({ dl, p });
      }
      const pre = ctx.createDelay(1), hp = bq('highpass', 120), conv = ctx.createConvolver(), tg = ctx.createGain();
      pre.delayTime.value = g.room.pre + .015 + LATENCY / ctx.sampleRate;
      conv.normalize = false; conv.buffer = tailIR(ctx, g.room);
      tg.gain.value = g.room.tailGain * amt * .62;
      dryMono.connect(pre).connect(hp).connect(conv).connect(tg).connect(g.output);
    }
    return g;
  }
  /** positions of every source at output time t */
  /** Echo delays averaged over a lap. Keeping them fixed (instead of following the moving
      source) avoids a pitch warble / chorus on the reflections; directions still move. */
  function echoDelays(g) {
    const s = g.s, key = [s.motion, s.period, s.distance, s.breath, s.height, s.room].join();
    if (g._delKey === key) return g._delays;
    const N = 48, sum = new Array(6).fill(0);
    for (let i = 0; i < N; i++) {
      const p = position(s, i / N * s.period * 2.2), dd = len(p);
      images(g.room, p).forEach((im, k) => sum[k] += Math.min(.95, Math.max(0, (len(im) - dd) / C)));
    }
    g._delKey = key; g._delays = sum.map(v => v / N);
    return g._delays;
  }
  function frameAt(g, t) {
    const s = g.s, p = position(s, t);
    const out = { direct: [p], sides: [spread(p, s, -1), spread(p, s, 1)], refl: [], delays: [] };
    if (g.room) { out.refl = images(g.room, p); out.delays = echoDelays(g); }
    return out;
  }
  /** live: glide everything to the position for time t */
  function place(g, t) {
    const now = g.ctx.currentTime, f = frameAt(g, t), set = (prm, v) => prm.setTargetAtTime(v, now, .03);
    const pos = (pn, [x, y, z]) => { set(pn.positionX, x); set(pn.positionY, y); set(pn.positionZ, z); };
    g.direct.forEach((pn, i) => pos(pn, f.direct[i]));
    g.sides.forEach((pn, i) => pos(pn, f.sides[i]));
    g.refl.forEach((r, i) => { pos(r.p, f.refl[i]); set(r.dl.delayTime, f.delays[i]); });
  }
  /** offline: write the whole motion as automation curves (100 points per second) */
  function automate(g, dur) {
    const N = Math.max(2, Math.ceil(dur * 100)), frames = [];
    for (let i = 0; i < N; i++) frames.push(frameAt(g, i / 100));
    const curve = (prm, fn) => { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = fn(frames[i]); prm.setValueCurveAtTime(a, 0, (N - 1) / 100 || .01); };
    g.direct.forEach((pn, k) => { ['positionX', 'positionY', 'positionZ'].forEach((ax, j) => curve(pn[ax], f => f.direct[k][j])); });
    g.sides.forEach((pn, k) => { ['positionX', 'positionY', 'positionZ'].forEach((ax, j) => curve(pn[ax], f => f.sides[k][j])); });
    g.refl.forEach((r, k) => {
      ['positionX', 'positionY', 'positionZ'].forEach((ax, j) => curve(r.p[ax], f => f.refl[k][j]));
      curve(r.dl.delayTime, f => f.delays[k]);
    });
  }

  /* ---------------- offline render ---------------- */
  /**
   * Spatialise `buf` (AudioBuffer). `gate(t)` → 0..1 says how much of the effect to use at output time t
   * (for "marked parts"). Loudness is matched to the original and peaks kept below 0 dBFS.
   */
  async function renderOffline(buf, s, gate, onProgress) {
    await latencyReady;
    const sr = buf.sampleRate, n = buf.length, dur = n / sr;
    const tailPad = (ROOMS[s.room]?.tail || 0) + .1;
    const ctx = new OfflineAudioContext(2, n + Math.floor(tailPad * sr), sr);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = build(ctx, s);
    src.connect(g.input); g.output.connect(ctx.destination);
    automate(g, dur + tailPad);
    src.start();
    const steps = 20;
    for (let i = 1; i < steps; i++) {
      const at = (dur + tailPad) * i / steps;
      ctx.suspend(at).then(() => { onProgress?.(i / steps); ctx.resume(); });
    }
    const wet = await ctx.startRendering();
    onProgress?.(1);
    const lat = LATENCY;  // the effect comes out this many samples late; read it early so it lines up
    // loudness-match the effect to the original, mix by gate, then keep peaks under 0 dBFS
    const rms = (ab, len) => { let e = 0, c = 0; for (let ch = 0; ch < 2; ch++) { const d = ab.getChannelData(Math.min(ch, ab.numberOfChannels - 1)); for (let i = 0; i < len; i += 4) { e += d[i] * d[i]; c++; } } return Math.sqrt(e / Math.max(1, c)); };
    const k = rms(buf, n) / Math.max(1e-9, rms(wet, n + LATENCY));
    const out = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: sr });
    let peak = 0;
    for (let ch = 0; ch < 2; ch++) {
      const o = out.getChannelData(ch), w = wet.getChannelData(ch), d = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      for (let i = 0; i < n; i++) {
        const gt = gate ? gate(i / sr) : 1;
        const v = gt * k * (w[i + lat] || 0) + (1 - gt) * d[i];
        o[i] = v; const a = Math.abs(v); if (a > peak) peak = a;
      }
    }
    if (peak > .97) { const sc = .97 / peak; for (let ch = 0; ch < 2; ch++) { const o = out.getChannelData(ch); for (let i = 0; i < n; i++) o[i] *= sc; } }
    return out;
  }

  /** 32-bit float WAV for upload (lossless — the only lossy step left is the final encode) */
  function encodeWav(ab) {
    const ch = 2, sr = ab.sampleRate, n = ab.length, bytes = 44 + n * ch * 4;
    const dv = new DataView(new ArrayBuffer(bytes));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, ch, true); dv.setUint32(24, sr, true);   // format 3 = IEEE float
    dv.setUint32(28, sr * ch * 4, true); dv.setUint16(32, ch * 4, true); dv.setUint16(34, 32, true); str(36, 'data'); dv.setUint32(40, n * ch * 4, true);
    const L = ab.getChannelData(0), R = ab.getChannelData(1);
    let o = 44;
    for (let i = 0; i < n; i++) { dv.setFloat32(o, L[i], true); dv.setFloat32(o + 4, R[i], true); o += 8; }
    return new Blob([dv], { type: 'audio/wav' });
  }

  /* ---------------- live loudness matcher (preview) ---------------- */
  function makeMatcher(ctx, dryNode, wetNode, makeup) {
    const a = ctx.createAnalyser(), b = ctx.createAnalyser(); a.fftSize = b.fftSize = 2048;
    dryNode.connect(a); wetNode.connect(b);
    const da = new Float32Array(2048), db = new Float32Array(2048);
    let ratio = 1.6;
    return () => {
      a.getFloatTimeDomainData(da); b.getFloatTimeDomainData(db);
      let x = 0, y = 0; for (let i = 0; i < 2048; i++) { x += da[i] * da[i]; y += db[i] * db[i]; }
      if (x > 1e-7 && y > 1e-9) { const r = Math.sqrt(x / y) * makeup.gain.value; ratio += (Math.min(6, Math.max(.3, r)) - ratio) * .02; }
      makeup.gain.setTargetAtTime(ratio, ctx.currentTime, .2);
    };
  }

  /* ---------------- radar (top-down view) ---------------- */
  function drawRadar(cv, s, t, on) {
    const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
    const r = ROOMS[s.room];
    const extent = Math.max(s.distance * 1.7, r ? Math.max(r.w, r.d) / 2 : 0, 2.2);
    const sc = Math.min(W, H) / 2 / extent * .92, cx = W / 2, cy = H / 2;
    const P = ([px, , pz]) => [cx + px * sc, cy + pz * sc];
    // rings
    x.strokeStyle = 'rgba(255,255,255,.07)'; x.lineWidth = 1;
    for (let m = 1; m <= extent; m++) { x.beginPath(); x.arc(cx, cy, m * sc, 0, Math.PI * 2); x.stroke(); }
    if (r) { x.strokeStyle = 'rgba(192,132,252,.45)'; x.setLineDash([5, 5]); x.strokeRect(cx - r.w / 2 * sc, cy - r.d / 2 * sc, r.w * sc, r.d * sc); x.setLineDash([]); }
    // path (next lap and a bit)
    x.beginPath();
    for (let i = 0; i <= 160; i++) { const [px, py] = P(position(s, t + i / 160 * s.period * 1.3)); i ? x.lineTo(px, py) : x.moveTo(px, py); }
    const grad = x.createLinearGradient(0, 0, W, H); grad.addColorStop(0, 'rgba(192,132,252,.7)'); grad.addColorStop(1, 'rgba(244,114,182,.7)');
    x.strokeStyle = grad; x.lineWidth = 1.6; x.stroke();
    // head (nose points to the front)
    x.fillStyle = '#e9e6f5'; x.beginPath(); x.arc(cx, cy, 9, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.moveTo(cx - 4, cy - 8); x.lineTo(cx, cy - 15); x.lineTo(cx + 4, cy - 8); x.fill();
    x.fillStyle = '#b9b4cc'; x.fillRect(cx - 12, cy - 3, 3, 7); x.fillRect(cx + 9, cy - 3, 3, 7);
    // current position; size = height
    const p = position(s, t), [px, py] = P(p), size = 7 + p[1] * 3;
    x.shadowColor = on ? 'rgba(244,114,182,.9)' : 'transparent'; x.shadowBlur = 16;
    x.fillStyle = on ? '#f472b6' : 'rgba(244,114,182,.5)';
    x.beginPath(); x.arc(px, py, Math.max(3, size), 0, Math.PI * 2); x.fill(); x.shadowBlur = 0;
    x.fillStyle = 'rgba(255,255,255,.4)'; x.font = '700 10px system-ui'; x.textAlign = 'center';
    x.fillText('FRONT', cx, 12); x.fillText('BACK', cx, H - 5);
  }

  return { ROOMS, DEFAULTS, position, build, place, renderOffline, encodeWav, makeMatcher, drawRadar, get latency() { return LATENCY; } };
})();
