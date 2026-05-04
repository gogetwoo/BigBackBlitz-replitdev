#!/usr/bin/env node
// Generates synthesized SFX WAV files for Big Back Blitz announcer events.
// Run with: node scripts/generate-sfx.mjs

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, '../artifacts/big-back-blitz/public/sfx')
fs.mkdirSync(OUT_DIR, { recursive: true })

const SR = 44100

function writeWav(filename, samples) {
  const numSamples = samples.length
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)

  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)   // PCM
  buf.writeUInt16LE(1, 22)   // mono
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }

  fs.writeFileSync(path.join(OUT_DIR, filename), buf)
  console.log(`  wrote ${filename} (${(buf.length / 1024).toFixed(1)} KB, ${(numSamples / SR).toFixed(2)}s)`)
}

function mix(arrays) {
  const len = Math.max(...arrays.map(a => a.length))
  const out = new Float32Array(len)
  for (const arr of arrays) {
    for (let i = 0; i < arr.length; i++) out[i] += arr[i]
  }
  return out
}

function normalize(arr, peak = 0.85) {
  let max = 0
  for (const v of arr) max = Math.max(max, Math.abs(v))
  if (max < 0.001) return arr
  const scale = peak / max
  return arr.map(v => v * scale)
}

function envelope(arr, attackSamples, decaySamples) {
  const out = new Float32Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    let env = 1
    if (i < attackSamples) env = i / attackSamples
    const fromEnd = arr.length - i
    if (fromEnd < decaySamples) env *= fromEnd / decaySamples
    out[i] = arr[i] * env
  }
  return out
}

function noise(nSamples) {
  const out = new Float32Array(nSamples)
  for (let i = 0; i < nSamples; i++) out[i] = Math.random() * 2 - 1
  return out
}

function osc(nSamples, freqFn, type = 'sine', vol = 1) {
  const out = new Float32Array(nSamples)
  let phase = 0
  for (let i = 0; i < nSamples; i++) {
    const f = typeof freqFn === 'function' ? freqFn(i / SR) : freqFn
    phase += (2 * Math.PI * f) / SR
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI
    let s = 0
    if (type === 'sine') s = Math.sin(phase)
    else if (type === 'sawtooth') s = (phase / Math.PI) - 1
    else if (type === 'square') s = phase < Math.PI ? 1 : -1
    else if (type === 'triangle') s = phase < Math.PI ? (phase / (Math.PI / 2) - 1) : (3 - phase / (Math.PI / 2))
    out[i] = s * vol
  }
  return out
}

function gain(arr, gainFn) {
  const out = new Float32Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    const g = typeof gainFn === 'function' ? gainFn(i / SR) : gainFn
    out[i] = arr[i] * g
  }
  return out
}

function expGain(arr, startVol, endVol, durSec) {
  const nSamples = Math.min(arr.length, Math.ceil(durSec * SR))
  return gain(arr, (t) => {
    const frac = Math.min(t / durSec, 1)
    return startVol * Math.pow(endVol / startVol, frac)
  })
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const a of arrays) { out.set(a, offset); offset += a.length }
  return out
}

function zeros(nSamples) { return new Float32Array(nSamples) }
function sec(s) { return Math.ceil(s * SR) }

// Low-pass filter (simple single-pole IIR)
function lpf(arr, cutoff) {
  const rc = 1 / (2 * Math.PI * cutoff)
  const dt = 1 / SR
  const alpha = dt / (rc + dt)
  const out = new Float32Array(arr.length)
  let prev = 0
  for (let i = 0; i < arr.length; i++) {
    out[i] = prev + alpha * (arr[i] - prev)
    prev = out[i]
  }
  return out
}

// Band-pass filter (two-pass LP/HP)
function hpf(arr, cutoff) {
  const rc = 1 / (2 * Math.PI * cutoff)
  const dt = 1 / SR
  const alpha = rc / (rc + dt)
  const out = new Float32Array(arr.length)
  let prev = 0; let prevIn = 0
  for (let i = 0; i < arr.length; i++) {
    out[i] = alpha * (prev + arr[i] - prevIn)
    prevIn = arr[i]; prev = out[i]
  }
  return out
}

console.log('Generating Big Back Blitz SFX...')

// ── 1. touchdown.wav ────────────────────────────────────────────────────────
// Triumphant three-note horn fanfare + crowd roar swell
{
  const dur = 2.2
  const n = sec(dur)

  // Crowd roar: filtered noise swell
  const crowdNoise = hpf(lpf(noise(n), 2000), 200)
  const crowd = gain(crowdNoise, t => {
    if (t < 0.12) return (t / 0.12) * 0.55
    if (t < 0.9) return 0.55
    return 0.55 * Math.pow(0.01 / 0.55, (t - 0.9) / (dur - 0.9))
  })

  // Three rising sawtooth notes: G4 → C5 → E5
  const hornNotes = [[392, 0, 0.45], [523.25, 0.10, 0.45], [659.25, 0.20, 0.45]]
  const hornParts = hornNotes.map(([hz, start, d]) => {
    const startSample = sec(start)
    const nSamp = sec(d)
    const wave = osc(nSamp, hz, 'sawtooth', 0.55)
    const bright = osc(nSamp, hz * 2, 'square', 0.12)
    const shaped = gain(mix([wave, bright]), t => {
      if (t < 0.02) return t / 0.02
      return Math.pow(0.01 / 1, (t - 0.02) / (d - 0.02))
    })
    const padded = new Float32Array(n)
    const slice = shaped.slice(0, Math.min(shaped.length, n - startSample))
    padded.set(slice, startSample)
    return padded
  })

  // High punctuation: C6 rising in at 0.30s
  const punchStart = sec(0.30)
  const punchDur = sec(0.65)
  const punch = osc(punchDur, 1046.5, 'sawtooth', 0.38)
  const punchShaped = gain(punch, t => {
    if (t < 0.02) return t / 0.02
    return Math.pow(0.01 / 1, (t - 0.02) / 0.63)
  })
  const punchPad = new Float32Array(n)
  punchPad.set(punchShaped.slice(0, Math.min(punchShaped.length, n - punchStart)), punchStart)

  writeWav('touchdown.wav', normalize(mix([crowd, ...hornParts, punchPad])))
}

// ── 2. coin.wav ─────────────────────────────────────────────────────────────
// Classic two-note bell chime: E6 → B6
{
  const dur = 0.35
  const n = sec(dur)
  const notes = [[1318.5, 0], [1975.5, 0.065]]
  const parts = notes.map(([hz, start]) => {
    const s = sec(start)
    const noteN = sec(0.22)
    const wave = osc(noteN, hz, 'sine', 0.38)
    const overtone = osc(noteN, hz * 1.5, 'triangle', 0.14)
    const shaped = expGain(mix([wave, overtone]), 1, 0.001, 0.22)
    const padded = new Float32Array(n)
    padded.set(shaped.slice(0, Math.min(shaped.length, n - s)), s)
    return padded
  })
  writeWav('coin.wav', normalize(mix(parts)))
}

// ── 3. powerup.wav ──────────────────────────────────────────────────────────
// Rising energetic sweep — "He's getting pumped!"
{
  const dur = 0.35
  const n = sec(dur)

  const sweep = osc(n, t => 523.25 * Math.pow(1318.5 / 523.25, t / dur), 'triangle', 0.40)
  const sweep2 = osc(n, t => 1046.5 * Math.pow(2637 / 1046.5, t / dur), 'sine', 0.18)
  // Pump-up accent blip at 0.15s
  const accentStart = sec(0.15)
  const accentN = sec(0.18)
  const accent = osc(accentN, 1760, 'square', 0.22)
  const accentShaped = expGain(accent, 1, 0.001, 0.18)
  const accentPad = new Float32Array(n)
  accentPad.set(accentShaped.slice(0, Math.min(accentShaped.length, n - accentStart)), accentStart)

  const sweepEnv = gain(mix([sweep, sweep2]), t => {
    if (t < 0.015) return t / 0.015
    return Math.pow(0.01 / 1, (t - 0.015) / (dur - 0.015))
  })
  writeWav('powerup.wav', normalize(mix([sweepEnv, accentPad])))
}

// ── 4. catch.wav ────────────────────────────────────────────────────────────
// Ascending excited phrase + big C6 flourish + crowd gasp — "What a catch!"
{
  const dur = 0.90
  const n = sec(dur)

  // Three staccato rising notes: C5 → E5 → G5
  const catchNotes = [[523.25, 0], [659.25, 0.09], [783.99, 0.18]]
  const noteParts = catchNotes.map(([hz, start]) => {
    const s = sec(start)
    const noteN = sec(0.28)
    const wave = osc(noteN, hz, 'sawtooth', 0.42)
    const shaped = gain(wave, t => {
      if (t < 0.012) return t / 0.012
      return Math.pow(0.01 / 1, (t - 0.012) / 0.268)
    })
    const padded = new Float32Array(n)
    padded.set(shaped.slice(0, Math.min(shaped.length, n - s)), s)
    return padded
  })

  // Big C6 flourish at 0.27s
  const flourishStart = sec(0.27)
  const flourishN = sec(0.60)
  const flourish = osc(flourishN, 1046.5, 'sawtooth', 0.50)
  const flourishShaped = gain(flourish, t => {
    if (t < 0.03) return t / 0.03
    return Math.pow(0.01 / 1, (t - 0.03) / 0.57)
  })
  const flourishPad = new Float32Array(n)
  flourishPad.set(flourishShaped.slice(0, Math.min(flourishShaped.length, n - flourishStart)), flourishStart)

  // Crowd gasp: filtered noise burst at 0.27s
  const gaspStart = sec(0.27)
  const gaspN = sec(0.45)
  const gaspNoise = lpf(hpf(noise(gaspN), 200), 3000)
  const gaspShaped = gain(gaspNoise, t => {
    if (t < 0.02) return (t / 0.02) * 0.30
    return 0.30 * Math.pow(0.01 / 0.30, (t - 0.02) / 0.43)
  })
  const gaspPad = new Float32Array(n)
  gaspPad.set(gaspShaped.slice(0, Math.min(gaspShaped.length, n - gaspStart)), gaspStart)

  writeWav('catch.wav', normalize(mix([...noteParts, flourishPad, gaspPad])))
}

// ── 5. jumpover.wav ─────────────────────────────────────────────────────────
// Upward noise whoosh + rising pitch sweep + sharp accent stab — "He got Mossed!"
{
  const dur = 0.65
  const n = sec(dur)

  // Whoosh: bandpass-filtered noise sweeping upward
  const whooshN = sec(0.30)
  const whooshNoise = noise(whooshN)
  const whooshFiltered = gain(whooshNoise, t => {
    const frac = t / 0.30
    const centerHz = 200 * Math.pow(4000 / 200, frac)
    const bw = centerHz * 0.6
    return Math.min(1, bw / 500) * 0.55
  })
  const whooshPad = new Float32Array(n)
  whooshPad.set(expGain(whooshFiltered, 0.001, 1, 0.04).slice(0, whooshN))

  // Rising pitch sweep: 330 Hz → 1320 Hz over 0.22s
  const sweepN = sec(0.28)
  const sweepWave = osc(sweepN, t => 330 * Math.pow(1320 / 330, t / 0.22), 'sawtooth', 0.38)
  const sweepShaped = gain(sweepWave, t => {
    if (t < 0.02) return t / 0.02
    return Math.pow(0.01 / 1, (t - 0.02) / 0.26)
  })
  const sweepPad = new Float32Array(n)
  sweepPad.set(sweepShaped.slice(0, Math.min(sweepShaped.length, n)))

  // Sharp accent stab at 0.22s — the "Mossed!" punch
  const stabStart = sec(0.22)
  const stabN = sec(0.40)
  const stab = osc(stabN, 880, 'square', 0.45)
  const stab2 = osc(stabN, 1320, 'sawtooth', 0.28)
  const stabShaped = expGain(mix([stab, stab2]), 1, 0.001, 0.40)
  const stabPad = new Float32Array(n)
  stabPad.set(stabShaped.slice(0, Math.min(stabShaped.length, n - stabStart)), stabStart)

  writeWav('jumpover.wav', normalize(mix([whooshPad, sweepPad, stabPad])))
}

// ── 6. spin.wav ─────────────────────────────────────────────────────────────
// Circular whoosh + tri-tone impact sequence — "There's no stopping him!"
{
  const dur = 0.75
  const n = sec(dur)

  // Spin whoosh: bandpass filter that sweeps up then back down (circular feel)
  const spinN = sec(0.35)
  const spinNoise = noise(spinN)
  const spinFiltered = gain(spinNoise, t => {
    const frac = t / 0.35
    const sweep = frac < 0.5 ? frac * 2 : (1 - frac) * 2
    const center = 800 + sweep * 2400
    return Math.min(1, center / 1500) * 0.50
  })
  const spinEnv = gain(spinFiltered, t => {
    if (t < 0.03) return t / 0.03
    if (t < 0.30) return 1
    return Math.pow(0.01, (t - 0.30) / 0.05)
  })
  const spinPad = new Float32Array(n)
  spinPad.set(spinEnv.slice(0, Math.min(spinEnv.length, n)))

  // Tri-tone impact at 0.22s: F4 A4 E5
  const impactNotes = [[349.23, 0], [440.0, 0.055], [659.25, 0.110]]
  const impactParts = impactNotes.map(([hz, offset]) => {
    const s = sec(0.22 + offset)
    const noteN = sec(0.36)
    const wave = osc(noteN, hz, 'sawtooth', 0.36)
    const shaped = gain(wave, t => {
      if (t < 0.015) return t / 0.015
      return Math.pow(0.01 / 1, (t - 0.015) / 0.345)
    })
    const padded = new Float32Array(n)
    padded.set(shaped.slice(0, Math.min(shaped.length, n - s)), s)
    return padded
  })

  writeWav('spin.wav', normalize(mix([spinPad, ...impactParts])))
}

// ── 7. boost.wav ────────────────────────────────────────────────────────────
// Jet engine ramp-up + bass kick at launch — "Look at the jets on that one!"
{
  const dur = 0.65
  const n = sec(dur)

  // Jet whoosh: high-pass noise building rapidly
  const jetN = sec(0.45)
  const jetNoise = hpf(noise(jetN), 800)
  const jetShaped = gain(jetNoise, t => {
    if (t < 0.06) return (t / 0.06) * 0.60
    if (t < 0.20) return 0.60
    return 0.60 * Math.pow(0.01 / 0.60, (t - 0.20) / 0.25)
  })
  const jetPad = new Float32Array(n)
  jetPad.set(jetShaped.slice(0, Math.min(jetShaped.length, n)))

  // Engine pitch ramp: 110 Hz → 880 Hz (sawtooth)
  const engN = sec(0.38)
  const engine = osc(engN, t => 110 * Math.pow(880 / 110, t / 0.30), 'sawtooth', 0.45)
  const engFiltered = lpf(engine, 1800)
  const engShaped = gain(engFiltered, t => {
    if (t < 0.05) return t / 0.05
    return Math.pow(0.01 / 1, (t - 0.05) / 0.33)
  })
  const engPad = new Float32Array(n)
  engPad.set(engShaped.slice(0, Math.min(engShaped.length, n)))

  // Bass kick at 0.26s
  const kickStart = sec(0.26)
  const kickN = sec(0.35)
  const kick = osc(kickN, t => 180 * Math.pow(40 / 180, t / 0.29), 'sine', 0.70)
  const kickShaped = gain(kick, t => {
    if (t < 0.01) return t / 0.01
    return Math.pow(0.01 / 1, (t - 0.01) / 0.34)
  })
  const kickPad = new Float32Array(n)
  kickPad.set(kickShaped.slice(0, Math.min(kickShaped.length, n - kickStart)), kickStart)

  // High ping at 0.26s: A6
  const pingStart = sec(0.26)
  const pingN = sec(0.26)
  const ping = gain(osc(pingN, 1760, 'sine', 0.30), t => {
    if (t < 0.008) return t / 0.008
    return Math.pow(0.01 / 1, (t - 0.008) / 0.252)
  })
  const pingPad = new Float32Array(n)
  pingPad.set(ping.slice(0, Math.min(ping.length, n - pingStart)), pingStart)

  writeWav('boost.wav', normalize(mix([jetPad, engPad, kickPad, pingPad])))
}

console.log('Done.')
