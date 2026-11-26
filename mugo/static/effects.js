/* =====================================================================
   MuGo — Studio effects rack (live preview side)

   Mirrors the server's effects (mugo/server.py → fx_lines) closely enough
   to preview them live while editing. The saved file is always rendered by
   the server, so these are tuned to sound alike, not to be bit-exact.
   Chain:  [pre]  vocals → EQ → drive → bitcrush → radio → lo-fi → chorus →
                  flanger → phaser → vibrato → tremolo → echo → width
           (3D / 8D and reverb sit between pre and post in the Studio)
           [post] punch (compressor) → auto level → volume
   ===================================================================== */
const Effects = (() => {
  const DEFAULTS = {
    eq: [0, 0, 0, 0, 0], vocals: 0, width: 1, drive: 0, crush: 0, radio: 0, lofi: 0,
    chorus: 0, flanger: 0, phaser: 0, trem: 0, tremRate: 5, vib: 0, vibRate: 5,
    echo: 0, echoTime: 350, echoFb: .35, punch: 0, gain: 0, loud: 'off',
  };
  const fresh = () => JSON.parse(JSON.stringify(DEFAULTS));
  const EQ_BANDS = [['lowshelf', 60, 0, 'Sub bass', '60 Hz'], ['peaking', 250, 1, 'Low mids', '250 Hz'], ['peaking', 1000, 1, 'Mids', '1 kHz'],
                    ['peaking', 3500, 1.1, 'Presence', '3.5 kHz'], ['highshelf', 10000, 0, 'Air', '10 kHz']];

  /** one-click looks; `speed` applies to the whole song, other keys are Studio settings */
  const PRESETS = [
    { id: 'nightcore', label: 'Nightcore', icon: 'rabbit', speed: 1.25, pitch: 'vinyl', fx: { eq: [1, 0, 0, 1, 2], punch: .3 } },
    { id: 'slowed', label: 'Slowed + reverb', icon: 'turtle', speed: .8, pitch: 'vinyl', reverb: 'hall', reverbAmount: .7, fx: { eq: [2, 0, 0, -1, -1] } },
    { id: 'bass', label: 'Bass boosted', icon: 'volume', fx: { eq: [9, 2, 0, 0, 1], punch: .4, drive: .15, loud: 'loud' } },
    { id: 'lofi', label: 'Lo-fi', icon: 'disc', warm: true, fx: { lofi: .6, crush: .15, eq: [1, 0, 0, -2, -4], width: .8 } },
    { id: 'vapor', label: 'Vaporwave', icon: 'sparkles', speed: .75, pitch: 'vinyl', reverb: 'dreamy', reverbAmount: .6, fx: { chorus: .5, eq: [0, 1, 0, -2, -3] } },
    { id: 'karaoke', label: 'Karaoke', icon: 'music', fx: { vocals: 1 } },
    { id: 'radio', label: 'Old radio', icon: 'wave', fx: { radio: 1, crush: .1, lofi: .2 } },
    { id: 'concert', label: 'Concert hall', icon: 'library', reverb: 'hall', reverbAmount: .6, fx: { width: 1.3, punch: .2 } },
    { id: 'echo', label: 'Echo chamber', icon: 'refresh', fx: { echo: .55, echoTime: 380, echoFb: .45, width: 1.2 } },
    { id: '16d', label: '16D', icon: 'headphones', eightD: 'all' },
  ];

  /* auto gain, same table as the server (measured on real music at 0 / 50 / 100 %) */
  const MAKEUP = { vocals: [0, 1.4, -1.1], drive: [0, .5, 3.8], radio: [0, 4.2, 3.2], lofi: [0, 4, 5.8], chorus: [0, -.6, -2.2],
                   flanger: [0, 3.2, 5.2], phaser: [0, .7, -.2], trem: [0, 2, 3.8], echo: [0, -.6, -2.2], punch: [0, 9.5, 17.9] };
  const makeup = (k, a) => { const [x, y, z] = MAKEUP[k]; return a <= .5 ? x + (y - x) * a * 2 : y + (z - y) * (a - .5) * 2; };
  const dbGain = db => Math.pow(10, db / 20);

  /* bit crusher as a tiny AudioWorklet (sample-and-hold + quantise) */
  const CRUSH = `class C extends AudioWorkletProcessor{
    static get parameterDescriptors(){return[{name:'bits',defaultValue:16},{name:'step',defaultValue:1}]}
    constructor(){super();this.h=[0,0];this.c=[0,0]}
    process(i,o,p){const a=i[0],b=o[0];if(!a||!a.length)return true;
      const q=Math.pow(2,p.bits[0]-1),st=Math.max(1,p.step[0]);
      for(let ch=0;ch<b.length;ch++){const x=a[ch]||a[0],y=b[ch];let c=this.c[ch];
        for(let n=0;n<y.length;n++){if(c<=0){this.h[ch]=Math.round(x[n]*q)/q;c+=st}c--;y[n]=this.h[ch]}this.c[ch]=c}
      return true}}
    registerProcessor('mugo-crush',C)`;
  const workletReady = new WeakMap();

  function build(ctx) {
    const set = (prm, v) => prm.setTargetAtTime(v, ctx.currentTime, .03);
    const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const BQ = (type, f, q, gain = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; b.gain.value = gain; return b; };
    const LP = f => BQ('lowpass', f, -3.0103), HP = f => BQ('highpass', f, -3.0103);
    const lfo = (hz, depth, target) => { const o = ctx.createOscillator(), g = G(depth); o.frequency.value = hz; o.connect(g).connect(target); o.start(); return { o, g }; };
    const shaper = drive => { const ws = ctx.createWaveShaper(), n = 2048, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(x * drive); } ws.curve = c; ws.oversample = '4x'; return ws; };
    /** a stage with a dry path and a wet path mixed at its output */
    const stage = () => { const s = { in: G(), out: G(), dry: G(1), wet: G(0) }; s.in.connect(s.dry).connect(s.out); s.wet.connect(s.out); return s; };
    const st = {};

    // vocals (karaoke): keep the sides and the bass, drop the centre
    st.voc = stage();
    {
      const sp = ctx.createChannelSplitter(2), l = G(.5), r = G(-.5), side = G(); side.channelCount = 1; side.channelCountMode = 'explicit';
      st.voc.in.connect(sp); sp.connect(l, 0); sp.connect(r, 1); l.connect(side); r.connect(side);
      const mono = G(); mono.channelCount = 1; mono.channelCountMode = 'explicit'; st.voc.in.connect(mono);
      const low = LP(150), low2 = LP(150); mono.connect(low).connect(low2);
      const m = ctx.createChannelMerger(2), inv = G(-1);
      side.connect(m, 0, 0); side.connect(inv).connect(m, 0, 1); low2.connect(m, 0, 0); low2.connect(m, 0, 1);
      m.connect(st.voc.wet);
    }
    // EQ
    st.eq = EQ_BANDS.map(([t, f, q]) => BQ(t, f, q || null, 0));
    // drive
    st.drv = stage(); { const pre = G(), sh = shaper(1), post = G(); st.drv.in.connect(pre).connect(sh).connect(post).connect(st.drv.wet); st.drv.pre = pre; st.drv.post = post; }
    // bitcrush (worklet, loads asynchronously)
    st.cr = stage();
    (async () => {
      try {
        if (!workletReady.has(ctx)) workletReady.set(ctx, ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CRUSH], { type: 'text/javascript' }))));
        await workletReady.get(ctx);
        st.cr.node = new AudioWorkletNode(ctx, 'mugo-crush', { outputChannelCount: [2] });
        st.cr.in.connect(st.cr.node).connect(st.cr.wet);
        g.update(g.fx);
      } catch (e) { console.warn('bitcrush preview unavailable', e); }
    })();
    // radio / telephone band
    st.rad = stage(); { const a = HP(420), b = HP(420), c = LP(3300), d = LP(3300), up = G(dbGain(8)), sh = shaper(1), dn = G(dbGain(-2));
      st.rad.in.connect(a).connect(b).connect(c).connect(d).connect(up).connect(sh).connect(dn).connect(st.rad.wet); }
    // lo-fi tape: filters + wobble + crackle
    st.lofi = stage(); {
      const hp = BQ('highpass', 40, -3.0103), lp = BQ('lowpass', 14000, -3.0103), dl = ctx.createDelay(.1); dl.delayTime.value = .006;
      st.lofi.in.connect(hp).connect(lp).connect(dl).connect(st.lofi.wet);
      st.lofi.hp = hp; st.lofi.lp = lp; st.lofi.wow = lfo(.7, 0, dl.delayTime);
      st.lofi.crackle = G(0); st.lofi.crackle.connect(st.lofi.out);
      const n = ctx.sampleRate * 4, buf = ctx.createBuffer(2, n, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = Math.random() > .99964 ? (Math.random() - .5) * 2 : 0; }
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const chp = BQ('highpass', 900, -3.0103), clp = BQ('lowpass', 7000, -3.0103);
      src.connect(chp).connect(clp).connect(st.lofi.crackle); src.start();
    }
    // chorus: three slowly moving delays
    st.cho = stage(); st.cho.taps = [[.042, .002, .25], [.055, .0023, .4], [.067, .0018, .31]].map(([d, dep, hz]) => {
      const dl = ctx.createDelay(.2); dl.delayTime.value = d; lfo(hz, dep, dl.delayTime); const g = G(0);
      st.cho.in.connect(dl).connect(g).connect(st.cho.wet); return g; });
    // flanger: a very short moving delay with feedback
    st.fla = stage(); { const dl = ctx.createDelay(.05), fb = G(0); dl.delayTime.value = .003; st.fla.lfo = lfo(.35, 0, dl.delayTime);
      st.fla.in.connect(dl); dl.connect(fb).connect(dl); dl.connect(st.fla.wet); st.fla.fb = fb; st.fla.dl = dl; }
    // phaser: four moving all-pass filters
    st.pha = stage(); { let node = st.pha.in; const ctl = G(1); const o = ctx.createOscillator(); o.frequency.value = .45; const dep = G(600); o.connect(dep).connect(ctl); o.start();
      for (let i = 0; i < 4; i++) { const ap = BQ('allpass', 800, .7); ctl.connect(ap.frequency); node.connect(ap); node = ap; } node.connect(st.pha.wet); }
    // vibrato: moving delay, replaces the signal
    st.vib = stage(); { const dl = ctx.createDelay(.1); dl.delayTime.value = .008; st.vib.lfo = lfo(5, 0, dl.delayTime); st.vib.in.connect(dl).connect(st.vib.wet); }
    // tremolo: volume wobble
    st.trem = { in: G(), out: G() }; { const tg = G(1); st.trem.in.connect(tg).connect(st.trem.out); st.trem.tg = tg; st.trem.lfo = lfo(5, 0, tg.gain); }
    // echo with feedback
    st.echo = stage(); { const dl = ctx.createDelay(2), fb = G(.35); dl.delayTime.value = .35; st.echo.in.connect(dl); dl.connect(fb).connect(dl); dl.connect(st.echo.wet); st.echo.dl = dl; st.echo.fb = fb; }
    // stereo width (mid/side)
    st.wid = { in: G(), out: G() }; { const sp = ctx.createChannelSplitter(2), m = ctx.createChannelMerger(2);
      st.wid.ll = G(1); st.wid.lr = G(0); st.wid.rl = G(0); st.wid.rr = G(1);
      st.wid.in.connect(sp); sp.connect(st.wid.ll, 0); sp.connect(st.wid.rl, 0); sp.connect(st.wid.lr, 1); sp.connect(st.wid.rr, 1);
      st.wid.ll.connect(m, 0, 0); st.wid.lr.connect(m, 0, 0); st.wid.rl.connect(m, 0, 1); st.wid.rr.connect(m, 0, 1); m.connect(st.wid.out); }
    // make-up gains after each stage (same table as the server)
    const mk = {}; ['vocals', 'drive', 'radio', 'lofi', 'chorus', 'flanger', 'phaser', 'trem', 'echo'].forEach(k => mk[k] = G(1));

    // wire the pre chain
    const pre = { input: G(), output: G() };
    let node = pre.input;
    const add = (inN, outN) => { node.connect(inN); node = outN; };
    add(st.voc.in, st.voc.out); add(mk.vocals, mk.vocals);
    st.eq.forEach(b => add(b, b));
    add(st.drv.in, st.drv.out); add(mk.drive, mk.drive);
    add(st.cr.in, st.cr.out);
    add(st.rad.in, st.rad.out); add(mk.radio, mk.radio);
    add(st.lofi.in, st.lofi.out); add(mk.lofi, mk.lofi);
    add(st.cho.in, st.cho.out); add(mk.chorus, mk.chorus);
    add(st.fla.in, st.fla.out); add(mk.flanger, mk.flanger);
    add(st.pha.in, st.pha.out); add(mk.phaser, mk.phaser);
    add(st.vib.in, st.vib.out);
    add(st.trem.in, st.trem.out); add(mk.trem, mk.trem);
    add(st.echo.in, st.echo.out); add(mk.echo, mk.echo);
    add(st.wid.in, st.wid.out);
    node.connect(pre.output);

    // post: compressor → auto level (matches the original, like the saved file) → volume
    const post = { input: G(), output: G() };
    const comp = ctx.createDynamicsCompressor(); comp.knee.value = 4; comp.attack.value = .008; comp.release.value = .14;
    const compMk = G(1), level = G(1), vol = G(1);
    post.input.connect(comp).connect(compMk).connect(level).connect(vol).connect(post.output);

    const g = {
      pre, post, fx: fresh(),
      update(fx) {
        g.fx = fx;
        const a = (stg, wet, dry = 1 - wet) => { set(stg.wet.gain, wet); set(stg.dry.gain, dry); };
        a(st.voc, fx.vocals * 1.4, 1 - fx.vocals); set(mk.vocals.gain, dbGain(makeup('vocals', fx.vocals)));
        st.eq.forEach((b, i) => set(b.gain, fx.eq[i] || 0));
        const d = fx.drive, preDb = 2 + 22 * d;
        set(st.drv.pre.gain, dbGain(preDb)); set(st.drv.post.gain, dbGain(-preDb * .62));
        a(st.drv, d > .01 ? Math.min(1, .35 + d) : 0, d > .01 ? Math.max(0, .65 - d) : 1); set(mk.drive.gain, dbGain(makeup('drive', d)));
        const c = fx.crush;
        if (st.cr.node) { set(st.cr.node.parameters.get('bits'), 16 - 12 * c); set(st.cr.node.parameters.get('step'), 1 + 9 * c); }
        a(st.cr, st.cr.node && c > .01 ? Math.min(1, .3 + .7 * c) : 0);
        a(st.rad, fx.radio); set(mk.radio.gain, dbGain(makeup('radio', fx.radio)));
        const l = fx.lofi;
        set(st.lofi.hp.frequency, 40 + 160 * l); set(st.lofi.lp.frequency, 14000 - 10000 * l);
        set(st.lofi.wow.g.gain, l > .01 ? .0004 + .0026 * l : 0); set(st.lofi.crackle.gain, .5 * l);
        a(st.lofi, l > .01 ? 1 : 0, l > .01 ? 0 : 1); set(mk.lofi.gain, dbGain(makeup('lofi', l)));
        const ch = fx.chorus; st.cho.taps.forEach((tg, i) => set(tg.gain, [.45, .4, .35][i] * ch)); a(st.cho, ch > .01 ? .9 : 0, ch > .01 ? .72 : 1);
        set(mk.chorus.gain, dbGain(makeup('chorus', ch)));
        const f = fx.flanger; set(st.fla.lfo.g.gain, (1 + 4 * f) / 2000); set(st.fla.fb.gain, (20 + 40 * f) / 100 * (f > .01 ? 1 : 0));
        a(st.fla, f > .01 ? (40 + 50 * f) / 100 : 0, 1); set(mk.flanger.gain, dbGain(makeup('flanger', f)));
        a(st.pha, fx.phaser * .8); set(mk.phaser.gain, dbGain(makeup('phaser', fx.phaser)));
        st.vib.lfo.o.frequency.value = fx.vibRate; set(st.vib.lfo.g.gain, fx.vib > .01 ? (.05 + .6 * fx.vib) * .006 : 0); a(st.vib, fx.vib > .01 ? 1 : 0);
        const td = .9 * fx.trem; st.trem.lfo.o.frequency.value = fx.tremRate; set(st.trem.tg.gain, 1 - td / 2); set(st.trem.lfo.g.gain, td / 2);
        set(mk.trem.gain, dbGain(makeup('trem', fx.trem)));
        set(st.echo.dl.delayTime, fx.echoTime / 1000); set(st.echo.fb.gain, fx.echoFb); a(st.echo, fx.echo * .8, 1); set(mk.echo.gain, dbGain(makeup('echo', fx.echo)));
        const w = fx.width, aa = .5 + .5 * w, bb = .5 - .5 * w;
        set(st.wid.ll.gain, aa); set(st.wid.rr.gain, aa); set(st.wid.lr.gain, bb); set(st.wid.rl.gain, bb);
        const p = fx.punch;
        set(comp.threshold, p > .01 ? -10 - 20 * p : 0); set(comp.ratio, p > .01 ? 2 + 4 * p : 1); set(compMk.gain, dbGain(makeup('punch', p)));
        set(vol.gain, dbGain(fx.gain));
      },
      level,   // the Studio's auto-level matcher drives this
    };
    g.update(g.fx);
    return g;
  }

  return { DEFAULTS, fresh, PRESETS, EQ_BANDS, build };
})();
