// ─── Big Back Blitz — Audio Manager ─────────────────────────────────────────
// Singleton that manages background music and one-shot SFX via the Web Audio
// API.
//
// Design:
//   • Background music: one of 3 synthesized hip-hop beat patterns, chosen
//     randomly at game load, looped seamlessly. Starts on first user gesture
//     to satisfy browser autoplay policy.
//   • Helmet crack SFX: a one-shot impact sound played at the collision
//     moment of the menu intro animation. Independent of the music toggle.
//   • Announcer / gameplay SFX: loaded from audio files in public/sfx/ and
//     played as one-shot AudioBufferSourceNodes routed through sfxGain.
//     The six announcer-voiced events use AI-generated MP3 voice clips from
//     public/sfx/announcer/ (HBCU-stadium-PA-style). Non-voice cues (e.g.
//     coin chime) stay as small synthesized WAVs.
//     Preloaded on first user interaction alongside music start.
//     Per-sound throttling prevents jarring rapid-fire overlaps.
//   • Procedural SFX: synthesized on the fly for short tonal cues (countdown
//     beeps, combo ding, near-miss whoosh, UI clicks, milestone chimes, etc.).
//     All routed through sfxGain so they respect the mute toggle.
//   • Music on/off toggle silences both music and all announcer SFX (both
//     gain nodes are set to 0 when muted).
//   • Music on/off preference is persisted to localStorage.

const MUSIC_PREF_KEY = 'bbb-music-on'
const MUSIC_VOL = 0.28
const SFX_VOL   = 0.75

// ─── Persistence ─────────────────────────────────────────────────────────────
function loadMusicPref(): boolean {
  try { return localStorage.getItem(MUSIC_PREF_KEY) !== 'false' } catch { return true }
}
function saveMusicPref(on: boolean) {
  try { localStorage.setItem(MUSIC_PREF_KEY, on ? 'true' : 'false') } catch {}
}

// ─── Asset paths ─────────────────────────────────────────────────────────────
// The six announcer-voiced events (touchdown, powerup, catch, jumpover, spin,
// boost) are loaded from AI-generated MP3 voice clips in
// `public/sfx/announcer/`. See that folder's README for the provider, voice,
// and regeneration script. `coin` is a non-voice synthesized chime that
// stays as a WAV.
const SFX_FILES = {
  touchdown: 'sfx/announcer/touchdown.mp3',
  coin:      'sfx/coin.wav',
  powerup:   'sfx/announcer/hes-getting-pumped.mp3',
  catch:     'sfx/announcer/catch.mp3',
  jumpover:  'sfx/announcer/he-did-him-dirty.mp3',
  spin:      'sfx/announcer/theres-no-stopping-him.mp3',
  boost:     'sfx/announcer/jets.mp3',
  dontgiveup:'sfx/announcer/dont-give-up.mp3',
} as const
type SfxKey = keyof typeof SFX_FILES

// Recorded engine/turbo loop used by startBoostLoop / stopBoostLoop. Sourced
// from OpenGameArt ("racing car engine sound loops" by BlackCortex, CC0,
// derived from a public-domain pdsounds.org recording) and converted to a
// compact mono Ogg Vorbis loop.
const BOOST_LOOP_FILE = 'sfx/boost_loop.ogg'
const BOOST_LOOP_VOL  = 0.55

// Minimum milliseconds between successive plays of the same sound.
const SFX_MIN_GAP: Record<SfxKey, number> = {
  touchdown: 800,
  coin:      120,
  powerup:   300,
  catch:     600,
  jumpover:  500,
  spin:      450,
  boost:     600,
  dontgiveup:1500,
}

// ─── Drum / bass primitive schedulers ────────────────────────────────────────
function schedKick(ctx: OfflineAudioContext | AudioContext, when: number, vol = 0.9) {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.connect(g); g.connect(ctx.destination)
  osc.frequency.setValueAtTime(160, when)
  osc.frequency.exponentialRampToValueAtTime(0.01, when + 0.45)
  g.gain.setValueAtTime(vol, when)
  g.gain.exponentialRampToValueAtTime(0.01, when + 0.4)
  osc.start(when); osc.stop(when + 0.5)
}

function schedSnare(ctx: OfflineAudioContext | AudioContext, when: number, vol = 0.55) {
  const sr = ctx.sampleRate
  const sz = Math.ceil(sr * 0.14)
  const buf = ctx.createBuffer(1, sz, sr)
  const d = buf.getChannelData(0)
  for (let i = 0; i < sz; i++) d[i] = Math.random() * 2 - 1
  const src = ctx.createBufferSource(); src.buffer = buf
  const g = ctx.createGain()
  g.gain.setValueAtTime(vol, when); g.gain.exponentialRampToValueAtTime(0.01, when + 0.13)
  src.connect(g); g.connect(ctx.destination); src.start(when)

  const osc = ctx.createOscillator()
  const g2 = ctx.createGain()
  osc.frequency.value = 210
  g2.gain.setValueAtTime(vol * 0.45, when); g2.gain.exponentialRampToValueAtTime(0.01, when + 0.08)
  osc.connect(g2); g2.connect(ctx.destination); osc.start(when); osc.stop(when + 0.08)
}

function schedHihat(ctx: OfflineAudioContext | AudioContext, when: number, vol = 0.28) {
  const sr = ctx.sampleRate
  const sz = Math.ceil(sr * 0.06)
  const buf = ctx.createBuffer(1, sz, sr)
  const d = buf.getChannelData(0)
  for (let i = 0; i < sz; i++) d[i] = Math.random() * 2 - 1
  const src = ctx.createBufferSource(); src.buffer = buf
  const flt = ctx.createBiquadFilter(); flt.type = 'highpass'; flt.frequency.value = 7500
  const g = ctx.createGain()
  g.gain.setValueAtTime(vol, when); g.gain.exponentialRampToValueAtTime(0.01, when + 0.055)
  src.connect(flt); flt.connect(g); g.connect(ctx.destination); src.start(when)
}

function schedBass(ctx: OfflineAudioContext | AudioContext, when: number, freq: number, vol = 0.45) {
  const osc = ctx.createOscillator()
  osc.type = 'sawtooth'; osc.frequency.value = freq
  const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 480; flt.Q.value = 3
  const g = ctx.createGain()
  g.gain.setValueAtTime(vol, when); g.gain.exponentialRampToValueAtTime(0.01, when + 0.22)
  osc.connect(flt); flt.connect(g); g.connect(ctx.destination)
  osc.start(when); osc.stop(when + 0.25)
}

// ─── Track definitions ───────────────────────────────────────────────────────
interface TrackDef {
  bpm: number
  kick:  number[]
  snare: number[]
  hihat: number[]
  bass:  Array<[step: number, hz: number]>
}

const TRACK_DEFS: TrackDef[] = [
  {
    bpm: 90,
    kick:  [0, 8, 14],
    snare: [4, 12],
    hihat: [0, 2, 4, 6, 8, 10, 12, 14],
    bass:  [[0, 55], [8, 41], [14, 49]],
  },
  {
    bpm: 96,
    kick:  [0, 4, 8, 13],
    snare: [4, 12, 15],
    hihat: [0, 2, 4, 6, 7, 8, 10, 12, 14],
    bass:  [[0, 49], [8, 41], [13, 44]],
  },
  {
    bpm: 84,
    kick:  [0, 6, 8, 11],
    snare: [4, 12],
    hihat: [2, 4, 6, 8, 10, 12, 14, 15],
    bass:  [[0, 41], [8, 55], [12, 49]],
  },
]

async function renderTrack(def: TrackDef): Promise<AudioBuffer> {
  const stepDur = 60 / def.bpm / 4
  const barDur  = stepDur * 16
  const bars    = 2
  const sr      = 44100
  const offCtx  = new OfflineAudioContext(1, Math.ceil(sr * barDur * bars), sr)

  for (let b = 0; b < bars; b++) {
    const start = b * barDur
    for (let s = 0; s < 16; s++) {
      const w = start + s * stepDur
      if (def.kick.includes(s))  schedKick(offCtx, w)
      if (def.snare.includes(s)) schedSnare(offCtx, w)
      if (def.hihat.includes(s)) schedHihat(offCtx, w)
    }
    for (const [s, hz] of def.bass) scheduleBass(offCtx, start + s * stepDur, hz)
  }

  return offCtx.startRendering()
}

// ─── Manager ─────────────────────────────────────────────────────────────────
class AudioManager {
  private ac:        AudioContext | null = null
  private musicGain: GainNode | null = null
  private sfxGain:   GainNode | null = null
  private musicSrc:  AudioBufferSourceNode | null = null
  private musicBuf:  AudioBuffer | null = null
  private musicOn:   boolean
  private started:   boolean = false
  private starting:  boolean = false

  // Decoded audio buffers keyed by SfxKey — populated during preload.
  private sfxBuffers: Partial<Record<SfxKey, AudioBuffer>> = {}
  private sfxLoading: boolean = false
  private sfxLoaded:  boolean = false

  // Active source node + last-play timestamp for each sound key.
  private sfxActive: Partial<Record<SfxKey, { src: AudioBufferSourceNode; playedAt: number }>> = {}

  // Throttle timestamps for rapid-fire procedural SFX (ms).
  private nearMissLastAt  = -Infinity
  private milestoneLastAt = -Infinity
  private comboDingLastAt = -Infinity
  private spinClearLastAt = -Infinity
  private jumpClearLastAt = -Infinity

  // Boost engine loop — recorded sample played through an
  // AudioBufferSourceNode with loop=true and a per-loop gain for fade-in/out.
  private boostLoopBuf:    AudioBuffer | null = null
  private boostLoopLoading: boolean = false
  private boostLoopSrc:    AudioBufferSourceNode | null = null
  private boostLoopGain:   GainNode | null = null

  // ── Crowd noise layer ──────────────────────────────────────────────────
  // Procedural stadium crowd: a 2-second noise buffer played on loop
  // through three gain nodes — ambient murmur (constant), swell
  // (ramps with combo), and peak roar (spikes on big plays).
  private crowdSrc:         AudioBufferSourceNode | null = null
  private crowdGainAmbient: GainNode | null = null
  private crowdGainSwell:   GainNode | null = null
  private crowdGainRoar:    GainNode | null = null
  private crowdBuf:         AudioBuffer | null = null
  private crowdStarted:     boolean = false

  constructor() {
    this.musicOn = loadMusicPref()
  }

  private getOrCreateCtx(): AudioContext {
    if (!this.ac) {
      this.ac = new AudioContext()
      this.musicGain = this.ac.createGain()
      this.sfxGain   = this.ac.createGain()
      this.musicGain.gain.value = this.musicOn ? MUSIC_VOL : 0
      this.sfxGain.gain.value   = this.musicOn ? SFX_VOL  : 0
      this.musicGain.connect(this.ac.destination)
      this.sfxGain.connect(this.ac.destination)
    }
    return this.ac
  }

  /** Called on any user gesture. Creates context, renders a beat, starts it,
   *  and triggers sample preloading. */
  async startMusic(): Promise<void> {
    if (this.started) return
    if (this.starting) return
    this.starting = true

    try {
      const ac = this.getOrCreateCtx()
      if (ac.state === 'suspended') {
        await ac.resume().catch(() => {})
      }

      if (ac.state !== 'running') {
        this.starting = false
        return
      }

      // Preload SFX samples in parallel with music render (non-blocking).
      this.preloadSfx(ac)
      this.preloadBoostLoop(ac)

      const trackIdx = Math.floor(Math.random() * TRACK_DEFS.length)
      const buf = await renderTrack(TRACK_DEFS[trackIdx])
      this.musicBuf = buf

      if (ac.state !== 'running') {
        this.starting = false
        return
      }

      const src = ac.createBufferSource()
      src.buffer = buf
      src.loop = true
      src.connect(this.musicGain!)
      src.start()
      this.musicSrc = src
      this.started  = true
      this.starting = false
    } catch {
      this.starting = false
    }
  }

  /** Fetch and decode all SFX audio files (announcer MP3s + coin WAV).
   *  Runs concurrently; failures are silently ignored so the game still
   *  works if a file 404s. */
  private preloadSfx(ac: AudioContext): void {
    if (this.sfxLoaded || this.sfxLoading) return
    this.sfxLoading = true
    const base = import.meta.env.BASE_URL ?? '/'
    const entries = Object.entries(SFX_FILES) as [SfxKey, string][]
    Promise.all(
      entries.map(([key, file]) =>
        fetch(`${base}${file}`)
          .then(r => r.arrayBuffer())
          .then(ab => ac.decodeAudioData(ab))
          .then(buf => { this.sfxBuffers[key] = buf })
          .catch(() => { /* non-fatal — event will be silent */ })
      )
    ).finally(() => { this.sfxLoaded = true; this.sfxLoading = false })
  }

  /** Fetch + decode the boost engine loop sample. Non-blocking; a 404 or
   *  decode error simply leaves the buffer null and startBoostLoop becomes a
   *  no-op. */
  private preloadBoostLoop(ac: AudioContext): void {
    if (this.boostLoopBuf || this.boostLoopLoading) return
    this.boostLoopLoading = true
    const base = import.meta.env.BASE_URL ?? '/'
    fetch(`${base}${BOOST_LOOP_FILE}`)
      .then(r => r.arrayBuffer())
      .then(ab => ac.decodeAudioData(ab))
      .then(buf => { this.boostLoopBuf = buf })
      .catch(() => { /* non-fatal — boost loop will simply be silent */ })
      .finally(() => { this.boostLoopLoading = false })
  }

  /** Play a preloaded SFX buffer through sfxGain. Stops any currently playing
   *  instance of the same sound first (cut-off, no stacking). Respects the
   *  per-sound minimum gap to prevent rapid-fire retriggering. */
  private playSfx(key: SfxKey): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const buf = this.sfxBuffers[key]
    if (!buf) return

    const now = performance.now()
    const slot = this.sfxActive[key]
    if (slot && now - slot.playedAt < SFX_MIN_GAP[key]) return

    // Cut off previous instance cleanly.
    if (slot) {
      try { slot.src.stop() } catch { /* already ended */ }
    }

    const src = ac.createBufferSource()
    src.buffer = buf
    src.connect(this.sfxGain!)
    src.start()
    src.onended = () => {
      if (this.sfxActive[key]?.src === src) delete this.sfxActive[key]
    }
    this.sfxActive[key] = { src, playedAt: now }
  }

  /** Toggle music and SFX on/off together; persist preference. */
  setMusicOn(on: boolean) {
    this.musicOn = on
    saveMusicPref(on)
    if (this.ac) {
      const t = this.ac.currentTime
      if (this.musicGain) {
        this.musicGain.gain.cancelScheduledValues(t)
        this.musicGain.gain.setTargetAtTime(on ? MUSIC_VOL : 0, t, 0.08)
      }
      if (this.sfxGain) {
        this.sfxGain.gain.cancelScheduledValues(t)
        this.sfxGain.gain.setTargetAtTime(on ? SFX_VOL : 0, t, 0.08)
      }
    }
  }

  getMusicOn(): boolean {
    return this.musicOn
  }

  isContextRunning(): boolean {
    return this.ac !== null && this.ac.state === 'running'
  }

  // ── Helmet crack (procedural, independent of mute toggle) ───────────────
  private _playCrackNow(ac: AudioContext): void {
    const now = ac.currentTime
    const sr = ac.sampleRate

    const sz = Math.ceil(sr * 0.28)
    const buf = ac.createBuffer(1, sz, sr)
    const d = buf.getChannelData(0)
    const decay = sr * 0.045
    for (let i = 0; i < sz; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / decay)
    const nSrc = ac.createBufferSource(); nSrc.buffer = buf
    const nGain = ac.createGain()
    nGain.gain.setValueAtTime(2.2, now)
    nGain.gain.exponentialRampToValueAtTime(0.01, now + 0.22)
    nSrc.connect(nGain); nGain.connect(this.sfxGain!); nSrc.start(now)

    const osc = ac.createOscillator()
    const oGain = ac.createGain()
    osc.frequency.setValueAtTime(140, now)
    osc.frequency.exponentialRampToValueAtTime(18, now + 0.32)
    oGain.gain.setValueAtTime(1.4, now)
    oGain.gain.exponentialRampToValueAtTime(0.01, now + 0.3)
    osc.connect(oGain); oGain.connect(this.sfxGain!)
    osc.start(now); osc.stop(now + 0.35)

    const sz2 = Math.ceil(sr * 0.18)
    const buf2 = ac.createBuffer(1, sz2, sr)
    const d2 = buf2.getChannelData(0)
    for (let i = 0; i < sz2; i++) d2[i] = Math.random() * 2 - 1
    const rSrc = ac.createBufferSource(); rSrc.buffer = buf2
    const rFlt = ac.createBiquadFilter(); rFlt.type = 'bandpass'; rFlt.frequency.value = 3200; rFlt.Q.value = 6
    const rGain = ac.createGain()
    rGain.gain.setValueAtTime(0.6, now)
    rGain.gain.exponentialRampToValueAtTime(0.01, now + 0.16)
    rSrc.connect(rFlt); rFlt.connect(rGain); rGain.connect(this.sfxGain!); rSrc.start(now)
  }

  playHelmetCrack(): void {
    if (this.ac && this.ac.state === 'running') {
      this._playCrackNow(this.ac)
    }
  }

  // ── Gameplay SFX — all routed through sfxGain (mute-respecting) ─────────

  /** Triumphant announcer touchdown sound + crowd roar bed. */
  playTouchdown(): void { this.playSfx('touchdown') }

  /** Classic coin-pickup chime. */
  playCoinPickup(): void { this.playSfx('coin') }

  /** Rising energetic sweep — power-up pickup. */
  playPowerUp(): void { this.playSfx('powerup') }

  /** Excited ascending fanfare — football catch. */
  playCatch(): void { this.playSfx('catch') }

  /** Upward whoosh + accent stab — jump over a defender. */
  playJumpOver(): void { this.playSfx('jumpover') }

  /** Circular whoosh + tri-tone impact — spin move. */
  playSpin(): void { this.playSfx('spin') }

  /** Jet-engine ramp + bass kick — boost/turbo activation. */
  playBoost(): void { this.playSfx('boost') }

  /** Announcer "don't give up!" — fired when a finished run returns to title. */
  playDontGiveUp(): void { this.playSfx('dontgiveup') }

  // ── Procedural SFX (pre-existing, routed to ac.destination) ────────────

  /** Short impact thud for a tackle/hit. */
  playTackle(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const now = ac.currentTime
    const sr = ac.sampleRate

    const sz = Math.ceil(sr * 0.22)
    const buf = ac.createBuffer(1, sz, sr)
    const d = buf.getChannelData(0)
    const decay = sr * 0.05
    for (let i = 0; i < sz; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / decay)
    const nSrc = ac.createBufferSource(); nSrc.buffer = buf
    const nFlt = ac.createBiquadFilter()
    nFlt.type = 'lowpass'; nFlt.frequency.value = 800; nFlt.Q.value = 1
    const nGain = ac.createGain()
    nGain.gain.setValueAtTime(1.6, now)
    nGain.gain.exponentialRampToValueAtTime(0.01, now + 0.18)
    nSrc.connect(nFlt); nFlt.connect(nGain); nGain.connect(this.sfxGain!)
    nSrc.start(now)

    const osc = ac.createOscillator()
    const oGain = ac.createGain()
    osc.frequency.setValueAtTime(110, now)
    osc.frequency.exponentialRampToValueAtTime(35, now + 0.18)
    oGain.gain.setValueAtTime(1.1, now)
    oGain.gain.exponentialRampToValueAtTime(0.01, now + 0.2)
    osc.connect(oGain); oGain.connect(this.sfxGain!)
    osc.start(now); osc.stop(now + 0.22)
  }

  /** Brief fanfare for clearing a level. */
  playLevelWin(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const now = ac.currentTime
    const notes: Array<[hz: number, dur: number]> = [
      [523.25, 0.14],
      [783.99, 0.14],
      [1046.5, 0.14],
      [1318.5, 0.14],
      [1568.0, 0.55],
    ]
    let t = now
    for (let i = 0; i < notes.length; i++) {
      const [hz, dur] = notes[i]
      const osc = ac.createOscillator()
      osc.type = 'sawtooth'; osc.frequency.value = hz
      const flt = ac.createBiquadFilter()
      flt.type = 'lowpass'; flt.frequency.value = 3200; flt.Q.value = 3
      const g = ac.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.01, t + dur + 0.05)
      osc.connect(flt); flt.connect(g); g.connect(this.sfxGain!)
      osc.start(t); osc.stop(t + dur + 0.1)

      const oscB = ac.createOscillator()
      oscB.type = 'triangle'; oscB.frequency.value = hz / 2
      const gB = ac.createGain()
      gB.gain.setValueAtTime(0.0001, t)
      gB.gain.exponentialRampToValueAtTime(0.25, t + 0.02)
      gB.gain.exponentialRampToValueAtTime(0.01, t + dur + 0.05)
      oscB.connect(gB); gB.connect(this.sfxGain!)
      oscB.start(t); oscB.stop(t + dur + 0.1)

      t += Math.min(dur, 0.13)
    }
  }

  // ── New procedural SFX ──────────────────────────────────────────────────

  /** Sharp rising whistle — plays at kickoff when a play begins. */
  playWhistle(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const now = ac.currentTime

    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1100, now)
    osc.frequency.linearRampToValueAtTime(1900, now + 0.14)
    osc.frequency.linearRampToValueAtTime(1700, now + 0.32)

    const g = ac.createGain()
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(0.48, now + 0.03)
    g.gain.setValueAtTime(0.48, now + 0.22)
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.50)

    osc.connect(g); g.connect(this.sfxGain!)
    osc.start(now); osc.stop(now + 0.55)

    // Slight second harmonic to add body
    const osc2 = ac.createOscillator()
    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(2200, now)
    osc2.frequency.linearRampToValueAtTime(3800, now + 0.14)
    osc2.frequency.linearRampToValueAtTime(3400, now + 0.32)
    const g2 = ac.createGain()
    g2.gain.setValueAtTime(0, now)
    g2.gain.linearRampToValueAtTime(0.14, now + 0.03)
    g2.gain.setValueAtTime(0.14, now + 0.22)
    g2.gain.exponentialRampToValueAtTime(0.01, now + 0.50)
    osc2.connect(g2); g2.connect(this.sfxGain!)
    osc2.start(now); osc2.stop(now + 0.55)
  }

  /** Pre-play countdown beep. step 1=low, 2=medium, 3=high (GO!). */
  playCountdownBeep(step: number): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const now = ac.currentTime

    const freqs = [440, 660, 1046.5]
    const freq = freqs[Math.min(step - 1, 2)]
    const dur  = step === 3 ? 0.22 : 0.13
    const vol  = step === 3 ? 0.45 : 0.32

    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const g = ac.createGain()
    g.gain.setValueAtTime(vol, now)
    g.gain.exponentialRampToValueAtTime(0.01, now + dur)
    osc.connect(g); g.connect(this.sfxGain!)
    osc.start(now); osc.stop(now + dur + 0.04)
  }

  /** Dramatic descending game-over sting — distinct from the tackle thud. */
  playGameOver(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const now = ac.currentTime

    const notes: Array<[hz: number, dur: number]> = [
      [440, 0.14],
      [330, 0.14],
      [220, 0.22],
      [110, 0.60],
    ]
    let t = now + 0.06
    for (const [freq, dur] of notes) {
      const osc = ac.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = freq
      const flt = ac.createBiquadFilter()
      flt.type = 'lowpass'; flt.frequency.value = 1600; flt.Q.value = 1
      const g = ac.createGain()
      g.gain.setValueAtTime(0.28, t)
      g.gain.exponentialRampToValueAtTime(0.01, t + dur)
      osc.connect(flt); flt.connect(g); g.connect(this.sfxGain!)
      osc.start(t); osc.stop(t + dur + 0.05)
      t += dur * 0.85
    }
  }

  /** Rising whoosh + oscillator sweep — plays when a new level starts. */
  playSpeedBump(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const now = ac.currentTime
    const sr = ac.sampleRate

    const sz = Math.ceil(sr * 0.35)
    const buf = ac.createBuffer(1, sz, sr)
    const d = buf.getChannelData(0)
    for (let i = 0; i < sz; i++) d[i] = Math.random() * 2 - 1
    const nSrc = ac.createBufferSource(); nSrc.buffer = buf
    const flt = ac.createBiquadFilter()
    flt.type = 'bandpass'
    flt.frequency.setValueAtTime(350, now)
    flt.frequency.exponentialRampToValueAtTime(4200, now + 0.30)
    flt.Q.value = 3
    const ng = ac.createGain()
    ng.gain.setValueAtTime(0.01, now)
    ng.gain.linearRampToValueAtTime(0.50, now + 0.07)
    ng.gain.exponentialRampToValueAtTime(0.01, now + 0.35)
    nSrc.connect(flt); flt.connect(ng); ng.connect(this.sfxGain!)
    nSrc.start(now)

    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(180, now)
    osc.frequency.exponentialRampToValueAtTime(900, now + 0.28)
    const og = ac.createGain()
    og.gain.setValueAtTime(0.26, now)
    og.gain.exponentialRampToValueAtTime(0.01, now + 0.28)
    osc.connect(og); og.connect(this.sfxGain!)
    osc.start(now); osc.stop(now + 0.32)
  }

  /** Short ding — plays each time the combo multiplier ticks up.
   *  Pitch rises with the tier so higher multipliers sound more exciting.
   *  Throttled so rapid dodges don't pile up. */
  playComboUp(tier: number): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return

    const wallNow = performance.now()
    if (wallNow - this.comboDingLastAt < 160) return
    this.comboDingLastAt = wallNow

    const now = ac.currentTime
    // C major pentatonic mapped over tiers 1–8
    const semitones = [0, 4, 7, 12, 16, 19, 24, 28]
    const semi = semitones[Math.min(Math.floor(tier) - 1, semitones.length - 1)]
    const freq = 660 * Math.pow(2, semi / 12)

    const osc = ac.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, now)
    osc.frequency.linearRampToValueAtTime(freq * 1.05, now + 0.09)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.34, now)
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.24)
    osc.connect(g); g.connect(this.sfxGain!)
    osc.start(now); osc.stop(now + 0.27)
  }

  /** Descending buzz — plays when the combo multiplier resets/drops. */
  playComboBreak(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const now = ac.currentTime

    const osc = ac.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(340, now)
    osc.frequency.exponentialRampToValueAtTime(75, now + 0.28)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.28, now)
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.28)
    osc.connect(g); g.connect(this.sfxGain!)
    osc.start(now); osc.stop(now + 0.32)
  }

  /** Rapid high-pitched warning chirp — plays ~0.5 s before boost expires. */
  playPowerUpExpiring(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const now = ac.currentTime

    for (let i = 0; i < 2; i++) {
      const t = now + i * 0.13
      const osc = ac.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = 1900 + i * 200
      const g = ac.createGain()
      g.gain.setValueAtTime(0.22, t)
      g.gain.exponentialRampToValueAtTime(0.01, t + 0.09)
      osc.connect(g); g.connect(this.sfxGain!)
      osc.start(t); osc.stop(t + 0.11)
    }
  }

  /** Start the recorded engine/turbo loop while boost is active. Plays a
   *  decoded AudioBuffer with native looping (loop=true) for seamless
   *  repetition, with a short fade-in. Safe to call redundantly — returns
   *  immediately if already running, or if the sample hasn't finished
   *  loading yet. */
  startBoostLoop(): void {
    if (this.boostLoopSrc) return
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const buf = this.boostLoopBuf
    if (!buf) {
      // Sample not ready yet (still fetching/decoding). Kick off a load in
      // case startMusic hasn't been called and stay silent for this boost.
      this.preloadBoostLoop(ac)
      return
    }

    const now = ac.currentTime
    const src = ac.createBufferSource()
    src.buffer = buf
    src.loop = true
    // Loop the entire buffer; the sample is authored to loop seamlessly.
    src.loopStart = 0
    src.loopEnd = buf.duration

    const g = ac.createGain()
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(BOOST_LOOP_VOL, now + 0.10)

    src.connect(g); g.connect(this.sfxGain!)
    src.start(now)

    this.boostLoopSrc  = src
    this.boostLoopGain = g
  }

  /** Smoothly fade out and stop the boost engine loop.
   *  Safe to call when not running. */
  stopBoostLoop(): void {
    const ac = this.ac
    if (!this.boostLoopSrc || !ac) return
    const now = ac.currentTime
    const FADE_TC      = 0.07   // setTargetAtTime time-constant
    const FADE_SETTLE  = 0.32   // seconds to wait before hard-stop

    if (this.boostLoopGain) {
      this.boostLoopGain.gain.cancelScheduledValues(now)
      // Anchor the current value so the exponential approach starts from it.
      this.boostLoopGain.gain.setValueAtTime(this.boostLoopGain.gain.value, now)
      this.boostLoopGain.gain.setTargetAtTime(0, now, FADE_TC)
    }

    const capturedSrc = this.boostLoopSrc
    this.boostLoopSrc  = null
    this.boostLoopGain = null

    // Hard-stop after the fade-out has settled.
    setTimeout(() => {
      try { capturedSrc.stop() } catch { /* already stopped */ }
    }, FADE_SETTLE * 1000)
  }

  // ── Crowd noise layer ─────────────────────────────────────────────────

  /** Build a 2-second noise buffer that loops seamlessly as stadium crowd. */
  private buildCrowdBuffer(ac: AudioContext): AudioBuffer {
    const sr = ac.sampleRate
    const len = Math.ceil(sr * 2.0)
    const buf = ac.createBuffer(2, len, sr)
    // Two channels with different random seeds so the stereo image is wide.
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      // Fill with band-limited noise in two passes:
      // 1) dense broadband chatter (many voices = white-ish noise)
      // 2) low-frequency swell (crowd breathing as a unit)
      const seed = ch === 0 ? 1664525 : 22695477
      let s = seed
      const lrng = () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff * 2 - 1 }
      for (let i = 0; i < len; i++) d[i] = lrng()
      // Smooth with a simple 3-tap moving average to tilt noise pink-ward.
      for (let i = 1; i < len - 1; i++) {
        d[i] = (d[i - 1] * 0.25 + d[i] * 0.5 + d[i + 1] * 0.25)
      }
    }
    return buf
  }

  /** Start the procedural crowd layer. Safe to call multiple times — no-ops
   *  if already running or if the AudioContext isn't ready. */
  startCrowd(): void {
    if (this.crowdStarted) return
    const ac = this.ac
    if (!ac || ac.state !== 'running') return

    const buf = this.buildCrowdBuffer(ac)
    this.crowdBuf = buf

    // Three gain nodes in parallel for ambient / swell / roar layers.
    const ambient = ac.createGain()
    const swell   = ac.createGain()
    const roar    = ac.createGain()
    ambient.gain.value = this.musicOn ? 0.038 : 0
    swell.gain.value   = 0
    roar.gain.value    = 0

    // Bandpass filter shapes each layer: ambient is mid-high chatter,
    // swell is low-mid rumble, roar is a wide full-range burst.
    const bpAmbient = ac.createBiquadFilter()
    bpAmbient.type = 'bandpass'; bpAmbient.frequency.value = 2200; bpAmbient.Q.value = 0.8

    const bpSwell = ac.createBiquadFilter()
    bpSwell.type = 'bandpass'; bpSwell.frequency.value = 600; bpSwell.Q.value = 0.6

    const bpRoar = ac.createBiquadFilter()
    bpRoar.type = 'lowshelf'; bpRoar.frequency.value = 800; bpRoar.gain.value = 6

    // One noise source feeds all three parallel paths.
    const src = ac.createBufferSource()
    src.buffer = buf
    src.loop = true
    src.loopStart = 0
    src.loopEnd = buf.duration

    src.connect(bpAmbient); bpAmbient.connect(ambient); ambient.connect(this.sfxGain!)
    src.connect(bpSwell);   bpSwell.connect(swell);     swell.connect(this.sfxGain!)
    src.connect(bpRoar);    bpRoar.connect(roar);       roar.connect(this.sfxGain!)

    src.start()
    this.crowdSrc         = src
    this.crowdGainAmbient = ambient
    this.crowdGainSwell   = swell
    this.crowdGainRoar    = roar
    this.crowdStarted     = true
  }

  /** Stop and clean up the crowd layer. */
  stopCrowd(): void {
    if (!this.crowdSrc) return
    try { this.crowdSrc.stop() } catch { /* already ended */ }
    this.crowdSrc = null
    this.crowdGainAmbient = null
    this.crowdGainSwell   = null
    this.crowdGainRoar    = null
    this.crowdStarted     = false
  }

  /** Drive crowd intensity from gameplay state. Call once per game tick.
   *  `excitement` 0..1 (combo-based ramp), `roar` 0..1 (spike on big plays). */
  setCrowdIntensity(excitement: number, roar: number): void {
    if (!this.ac || this.ac.state !== 'running') return
    if (!this.crowdStarted) this.startCrowd()
    const now = this.ac.currentTime
    const vol = this.musicOn ? 1 : 0

    if (this.crowdGainAmbient) {
      const target = 0.038 * vol
      this.crowdGainAmbient.gain.setTargetAtTime(target, now, 0.3)
    }
    if (this.crowdGainSwell) {
      // Excitement ramps the swell: 0 at multiplier 1×, full at 8×.
      const target = excitement * 0.055 * vol
      this.crowdGainSwell.gain.setTargetAtTime(target, now, 0.25)
    }
    if (this.crowdGainRoar) {
      // Roar spikes then decays quickly.
      const target = roar * 0.11 * vol
      if (roar > 0.5) {
        this.crowdGainRoar.gain.cancelScheduledValues(now)
        this.crowdGainRoar.gain.setValueAtTime(target, now)
        this.crowdGainRoar.gain.setTargetAtTime(0, now + 0.15, 0.55)
      } else {
        this.crowdGainRoar.gain.setTargetAtTime(target, now, 0.6)
      }
    }
  }

  /** Whoosh/deflation sound — plays the moment boost expires. */
  playBoostEnd(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const now = ac.currentTime

    const osc = ac.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(300, now)
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.42)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.34, now)
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.40)
    osc.connect(g); g.connect(this.sfxGain!)
    osc.start(now); osc.stop(now + 0.46)

    // Add a brief noise burst to accent the deflation
    const sr = ac.sampleRate
    const sz = Math.ceil(sr * 0.15)
    const buf = ac.createBuffer(1, sz, sr)
    const d = buf.getChannelData(0)
    for (let i = 0; i < sz; i++) d[i] = Math.random() * 2 - 1
    const nSrc = ac.createBufferSource(); nSrc.buffer = buf
    const nFlt = ac.createBiquadFilter()
    nFlt.type = 'highpass'; nFlt.frequency.value = 2000
    const ng = ac.createGain()
    ng.gain.setValueAtTime(0.22, now)
    ng.gain.exponentialRampToValueAtTime(0.01, now + 0.15)
    nSrc.connect(nFlt); nFlt.connect(ng); ng.connect(this.sfxGain!)
    nSrc.start(now)
  }

  /** Quick air-rush whoosh — plays when a defender passes very close without
   *  contact. Throttled to 400 ms so rapid near-misses don't stack. */
  playNearMiss(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return

    const wallNow = performance.now()
    if (wallNow - this.nearMissLastAt < 400) return
    this.nearMissLastAt = wallNow

    const now = ac.currentTime
    const sr = ac.sampleRate
    const sz = Math.ceil(sr * 0.20)
    const buf = ac.createBuffer(1, sz, sr)
    const d = buf.getChannelData(0)
    for (let i = 0; i < sz; i++) d[i] = Math.random() * 2 - 1

    const nSrc = ac.createBufferSource(); nSrc.buffer = buf
    const flt = ac.createBiquadFilter()
    flt.type = 'bandpass'
    flt.frequency.setValueAtTime(900, now)
    flt.frequency.exponentialRampToValueAtTime(3200, now + 0.14)
    flt.Q.value = 4
    const g = ac.createGain()
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.20)
    nSrc.connect(flt); flt.connect(g); g.connect(this.sfxGain!)
    nSrc.start(now)
  }

  /** Short click — plays on start, pause, unpause, and restart buttons. */
  playUIClick(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return
    const now = ac.currentTime

    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 820
    const g = ac.createGain()
    g.gain.setValueAtTime(0.18, now)
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.07)
    osc.connect(g); g.connect(this.sfxGain!)
    osc.start(now); osc.stop(now + 0.09)
  }

  /** Short percussive "whomp" accent — plays on the frame a defender is
   *  cleared by the spin radius sweep. Throttled to 90 ms. */
  playSpinClear(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return

    const wallNow = performance.now()
    if (wallNow - this.spinClearLastAt < 90) return
    this.spinClearLastAt = wallNow

    const now = ac.currentTime
    const sr = ac.sampleRate

    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(220, now)
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.16)
    const og = ac.createGain()
    og.gain.setValueAtTime(0.55, now)
    og.gain.exponentialRampToValueAtTime(0.01, now + 0.18)
    osc.connect(og); og.connect(this.sfxGain!)
    osc.start(now); osc.stop(now + 0.20)

    const sz = Math.ceil(sr * 0.10)
    const buf = ac.createBuffer(1, sz, sr)
    const d = buf.getChannelData(0)
    const decay = sr * 0.025
    for (let i = 0; i < sz; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / decay)
    const nSrc = ac.createBufferSource(); nSrc.buffer = buf
    const flt = ac.createBiquadFilter()
    flt.type = 'bandpass'; flt.frequency.value = 2400; flt.Q.value = 3
    const ng = ac.createGain()
    ng.gain.setValueAtTime(0.32, now)
    ng.gain.exponentialRampToValueAtTime(0.01, now + 0.10)
    nSrc.connect(flt); flt.connect(ng); ng.connect(this.sfxGain!)
    nSrc.start(now)
  }

  /** Short doppler-style "whoosh" — plays when a defender passes under
   *  the player during the jump window. Throttled to 90 ms. */
  playJumpClear(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return

    const wallNow = performance.now()
    if (wallNow - this.jumpClearLastAt < 90) return
    this.jumpClearLastAt = wallNow

    const now = ac.currentTime
    const sr = ac.sampleRate

    const sz = Math.ceil(sr * 0.18)
    const buf = ac.createBuffer(1, sz, sr)
    const d = buf.getChannelData(0)
    for (let i = 0; i < sz; i++) d[i] = Math.random() * 2 - 1
    const nSrc = ac.createBufferSource(); nSrc.buffer = buf
    const flt = ac.createBiquadFilter()
    flt.type = 'bandpass'
    flt.frequency.setValueAtTime(2600, now)
    flt.frequency.exponentialRampToValueAtTime(420, now + 0.16)
    flt.Q.value = 4
    const ng = ac.createGain()
    ng.gain.setValueAtTime(0.36, now)
    ng.gain.exponentialRampToValueAtTime(0.01, now + 0.18)
    nSrc.connect(flt); flt.connect(ng); ng.connect(this.sfxGain!)
    nSrc.start(now)

    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(150, now)
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.14)
    const og = ac.createGain()
    og.gain.setValueAtTime(0.32, now)
    og.gain.exponentialRampToValueAtTime(0.01, now + 0.16)
    osc.connect(og); og.connect(this.sfxGain!)
    osc.start(now); osc.stop(now + 0.18)
  }

  /** Three-note ascending chime — plays at yardage milestones.
   *  Throttled to 600 ms so back-to-back milestones don't overlap. */
  playMilestoneChime(): void {
    const ac = this.ac
    if (!ac || ac.state !== 'running') return

    const wallNow = performance.now()
    if (wallNow - this.milestoneLastAt < 600) return
    this.milestoneLastAt = wallNow

    const now = ac.currentTime
    const notes = [523.25, 659.25, 783.99]  // C5 E5 G5

    for (let i = 0; i < notes.length; i++) {
      const t = now + i * 0.09
      const osc = ac.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = notes[i]
      const g = ac.createGain()
      g.gain.setValueAtTime(0.26, t)
      g.gain.exponentialRampToValueAtTime(0.01, t + 0.28)
      osc.connect(g); g.connect(this.sfxGain!)
      osc.start(t); osc.stop(t + 0.30)
    }
  }
}

function scheduleBass(ctx: OfflineAudioContext | AudioContext, when: number, hz: number) {
  schedBass(ctx, when, hz)
}

export const audioManager = new AudioManager()
