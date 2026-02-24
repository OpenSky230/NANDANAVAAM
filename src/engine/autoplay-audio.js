// Lightweight WebAudio sound bed for tour/autoplay mode.
// No external audio assets (keeps repo self-contained + avoids autoplay/copyright issues).

function clamp01(x){
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function getAudioContextCtor(){
  return window.AudioContext || window.webkitAudioContext || null;
}

function createCtx(){
  const AC = getAudioContextCtor();
  if (!AC) return null;
  try { return new AC(); } catch { return null; }
}

function mtof(midi){
  const m = Number(midi);
  if (!Number.isFinite(m)) return 440;
  return 440 * Math.pow(2, (m - 69) / 12);
}

function createImpulseResponse(ctx, seconds = 1.6, decay = 2.4){
  try{
    const sr = ctx.sampleRate;
    const length = Math.max(1, Math.floor(sr * Math.max(0.2, seconds)));
    const buf = ctx.createBuffer(2, length, sr);
    for (let ch = 0; ch < 2; ch++){
      const data = buf.getChannelData(ch);
      for (let i = 0; i < length; i++){
        const t = i / Math.max(1, length - 1);
        const env = Math.pow(1 - t, decay);
        data[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
  }catch{ return null; }
}

export function createAutoplayAudio({
  enabled = true,
  ambientVolume = 0.18,
  transitionVolume = 0.22,
} = {}){
  let _enabled = Boolean(enabled);
  let ctx = null;
  let master = null;
  let ambient = null; // { gain, stopAt, nodes: [...] }
  let disposed = false;

  function ensure(){
    if (disposed) return null;
    if (ctx && master) return ctx;
    ctx = createCtx();
    if (!ctx) return null;
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    return ctx;
  }

  async function resume(){
    try{
      const c = ensure();
      if (!c) return false;
      if (c.state === 'suspended') { try { await c.resume(); } catch {} }
      return true;
    }catch{ return false; }
  }

  function startAmbient(){
    if (!_enabled) return;
    const c = ensure();
    if (!c || !master) return;
    if (ambient) return; // already running

    // Calm music bed: stable pad + very soft slow arpeggio (no tremolo / vibration).
    const t0 = c.currentTime;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.connect(master);

    const mixLP = c.createBiquadFilter();
    mixLP.type = 'lowpass';
    mixLP.frequency.setValueAtTime(1050, t0);
    mixLP.Q.setValueAtTime(0.55, t0);
    mixLP.connect(out);

    const wet = c.createGain();
    wet.gain.setValueAtTime(0.22, t0);
    const dry = c.createGain();
    dry.gain.setValueAtTime(0.78, t0);
    dry.connect(mixLP);

    const conv = c.createConvolver();
    const ir = createImpulseResponse(c, 1.7, 2.2);
    if (ir) conv.buffer = ir;
    wet.connect(conv);
    conv.connect(mixLP);

    // Gentle filter drift (NOT amplitude modulation).
    const lfo = c.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(0.03, t0);
    const lfoGain = c.createGain();
    lfoGain.gain.setValueAtTime(90, t0); // Hz swing
    lfo.connect(lfoGain).connect(mixLP.frequency);

    // Pad layer
    const freqs = [110, 146.83, 196]; // A2, D3, G3 (calm / open)
    const nodes = [];
    for (let i = 0; i < freqs.length; i++){
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freqs[i], t0);
      try { o.detune.setValueAtTime((i - 1) * 1.2, t0); } catch {} // tiny, avoids beating/vibration
      const g = c.createGain();
      g.gain.setValueAtTime(0.19, t0);
      o.connect(g).connect(dry);
      o.connect(g).connect(wet);
      nodes.push({ o, g });
    }

    // Arpeggio scheduler
    const bpm = 52;
    const beat = 60 / bpm;
    const scheduleAhead = 0.25; // seconds
    const tickMs = 50;
    let nextNoteTime = t0 + 0.05;
    let step = 0;
    const chords = [
      [48, 52, 55, 59], // Cmaj7
      [45, 48, 52, 55], // Am7
      [41, 45, 48, 52], // Fmaj7
      [43, 47, 50, 55], // G6
    ];
    const pattern = [0, 2, 1, 3, 2, 1, 0, 2];

    const playPluck = (time, freq, gain, dur) => {
      try{
        const o = c.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(freq, time);
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(1200, time);
        f.frequency.exponentialRampToValueAtTime(700, time + Math.max(0.08, dur * 0.9));
        f.Q.setValueAtTime(0.35, time);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), time + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, time + Math.max(0.35, dur * 1.2));
        o.connect(f).connect(g);
        g.connect(dry);
        g.connect(wet);
        o.start(time);
        o.stop(time + Math.max(0.12, dur + 0.05));
        setTimeout(() => { try { g.disconnect(); f.disconnect(); } catch {} }, 1200);
      }catch{}
    };

    const playBass = (time, freq, gain, dur) => {
      try{
        const o = c.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(freq, time);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), time + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, time + Math.max(0.45, dur));
        o.connect(g);
        g.connect(dry);
        g.connect(wet);
        o.start(time);
        o.stop(time + Math.max(0.25, dur + 0.05));
        setTimeout(() => { try { g.disconnect(); } catch {} }, 1200);
      }catch{}
    };

    const scheduler = setInterval(() => {
      try{
        if (!ambient || disposed) return;
        const cur = c.currentTime;
        while (nextNoteTime < cur + scheduleAhead){
          const chordIdx = Math.floor((step / 4)) % chords.length; // chord per 4 beats
          const chord = chords[chordIdx];
          const beatInChord = step % 4;
          if (beatInChord === 0){
            const root = chord[0] - 24;
            playBass(nextNoteTime, mtof(root), 0.035, beat * 1.9);
          }
          if ((step % 2) === 0) {
            const pat = pattern[step % pattern.length];
            const noteMidi = chord[pat % chord.length] + 12;
            playPluck(nextNoteTime, mtof(noteMidi), 0.032, beat * 1.0);
          }
          nextNoteTime += beat;
          step += 1;
        }
      }catch{}
    }, tickMs);

    // Fade in.
    const vol = clamp01(ambientVolume);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + 1.2);

    try { lfo.start(t0); } catch {}
    for (const n of nodes){ try { n.o.start(t0); } catch {} }

    ambient = { out, mixLP, lfo, lfoGain, nodes, scheduler, stopAt: 0, wet, dry, conv };
    void resume();
  }

  function stopAmbient(){
    if (!ambient || !ctx) return;
    try{
      const c = ctx;
      const t0 = c.currentTime;
      const stopAt = t0 + 0.9;
      ambient.stopAt = stopAt;

      try { ambient.out?.gain?.cancelScheduledValues?.(t0); } catch {}
      try { ambient.out?.gain?.setValueAtTime?.(Math.max(0.0001, ambient.out.gain.value || 0.0001), t0); } catch {}
      try { ambient.out?.gain?.exponentialRampToValueAtTime?.(0.0001, stopAt); } catch {}

      const cleanup = () => {
        if (!ambient) return;
        try { clearInterval(ambient.scheduler); } catch {}
        for (const n of ambient.nodes || []){ try { n.o?.stop?.(); } catch {} }
        try { ambient.lfo?.stop?.(); } catch {}
        try { ambient.out?.disconnect?.(); } catch {}
        try { ambient.mixLP?.disconnect?.(); } catch {}
        try { ambient.lfoGain?.disconnect?.(); } catch {}
        try { ambient.wet?.disconnect?.(); } catch {}
        try { ambient.dry?.disconnect?.(); } catch {}
        try { ambient.conv?.disconnect?.(); } catch {}
        ambient = null;
      };
      setTimeout(cleanup, 1100);
    }catch{
      try { ambient = null; } catch {}
    }
  }

  function playTransition(){
    if (!_enabled) return;
    const c = ensure();
    if (!c || !master) return;

    const t0 = c.currentTime;
    const vol = clamp01(transitionVolume);

    // Soft "whoosh" designed to be non-intrusive.
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol * 0.7), t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
    g.connect(master);

    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(950, t0);
    f.frequency.exponentialRampToValueAtTime(420, t0 + 0.22);
    f.Q.setValueAtTime(0.35, t0);
    f.connect(g);

    // Noise burst
    let noiseSrc = null;
    try{
      const dur = 0.22;
      const frames = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, frames, c.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < frames; i++){
        // quick fade-in/out noise shape
        const x = i / Math.max(1, frames - 1);
        const env = x < 0.18 ? (x / 0.18) : (x > 0.82 ? (1 - x) / 0.18 : 1);
        ch[i] = (Math.random() * 2 - 1) * env;
      }
      noiseSrc = c.createBufferSource();
      noiseSrc.buffer = buf;
      noiseSrc.connect(f);
      noiseSrc.start(t0);
      noiseSrc.stop(t0 + dur);
    }catch{}
    setTimeout(() => { try { g.disconnect(); f.disconnect(); } catch {} }, 500);
    void resume();
  }

  function setEnabled(next){
    _enabled = Boolean(next);
    if (!_enabled) stopAmbient();
  }

  function dispose(){
    disposed = true;
    try { stopAmbient(); } catch {}
    try { master?.disconnect?.(); } catch {}
    try { ctx?.close?.(); } catch {}
    ctx = null; master = null;
  }

  return {
    startAmbient,
    stopAmbient,
    playTransition,
    resume,
    setEnabled,
    dispose,
    isEnabled: () => _enabled,
  };
}
