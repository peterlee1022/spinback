// Procedural vinyl crackle: a looped buffer of soft hiss with random pops.
export function createCrackle() {
  let ctx = null;
  let gain = null;
  let last = -1;
  let scratchGain = null;
  let scratchFilter = null;
  let lastScratch = -1;

  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const sr = ctx.sampleRate;
    const len = sr * 6;
    const buf = ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);

    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp += (Math.random() * 2 - 1 - lp) * 0.08;
      data[i] = lp * 0.05;
    }
    for (let k = 0; k < 190; k++) {
      const at = (Math.random() * len) | 0;
      const amp = Math.pow(Math.random(), 3) * 0.7 + 0.03;
      const dur = 20 + Math.random() * 160;
      for (let j = 0; j < dur * 6 && at + j < len; j++) data[at + j] += (Math.random() * 2 - 1) * amp * Math.exp(-j / dur);
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 7000;
    gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(hp).connect(lpf).connect(gain).connect(ctx.destination);
    src.start();

    // scratch: band-passed noise that rises in pitch and volume with hand speed
    const nbuf = ctx.createBuffer(1, sr, sr);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < sr; i++) nd[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = nbuf;
    noise.loop = true;
    scratchFilter = ctx.createBiquadFilter();
    scratchFilter.type = 'bandpass';
    scratchFilter.Q.value = 1.4;
    scratchFilter.frequency.value = 400;
    scratchGain = ctx.createGain();
    scratchGain.gain.value = 0;
    noise.connect(scratchFilter).connect(scratchGain).connect(ctx.destination);
    noise.start();
  }

  return {
    wake() {
      if (!ctx) init();
      else if (ctx.state === 'suspended') ctx.resume();
    },
    setScratch(speed) {
      if (!scratchGain) return;
      const v = Math.min(1, speed / 5);
      if (Math.abs(v - lastScratch) < 0.01) return;
      lastScratch = v;
      scratchFilter.frequency.setTargetAtTime(300 + v * 2600, ctx.currentTime, 0.02);
      scratchGain.gain.setTargetAtTime(v * 0.35, ctx.currentTime, 0.03);
    },
    setLevel(v) {
      if (!gain || Math.abs(v - last) < 0.01) return;
      last = v;
      gain.gain.setTargetAtTime(v, ctx.currentTime, 0.12);
    },
  };
}
