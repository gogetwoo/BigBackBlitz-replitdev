#!/usr/bin/env node
// Generates AI-voiced announcer clips for Big Back Blitz using OpenAI's
// gpt-audio model (via the Replit AI Integrations proxy — env vars are
// provisioned by the `ai-integrations-openai` skill).
//
// Provider: OpenAI Chat Completions w/ audio modality
// Model:    gpt-audio
// Voice:    ash (charismatic, expressive male)
// Style:    energetic HBCU stadium PA announcer (delivered via the user
//           prompt so the same voice can be re-tuned later)
//
// Pipeline:
//   1. gpt-audio synthesizes the spoken line as MP3 (base64)
//   2. ffmpeg trims leading/trailing silence
//   3. ffmpeg loudnorm pass for consistent loudness across clips
//   4. ffmpeg atempo bumps each clip to fit ≤ ~2 s without changing pitch
//   5. Re-encoded as 96 kbps mono 44.1 kHz MP3
//
// Run with:
//   node scripts/generate-announcer-tts.mjs
//
// Outputs MP3 files to artifacts/big-back-blitz/public/sfx/announcer/.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, '../artifacts/big-back-blitz/public/sfx/announcer')

const BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
const KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY
if (!BASE || !KEY) {
  console.error('Missing AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY env vars.')
  process.exit(1)
}

const STYLE =
  `Speak in the voice of an energetic HBCU classic football stadium PA announcer — ` +
  `bold, hyped, charismatic, broadcast-style, slightly gravelly, with rhythmic emphasis. ` +
  `Loud, excited, full-volume hype like Saturday afternoon at the Bayou Classic. ` +
  `Hit the key word HARD. End strong, no trailing softness. Say ONLY the line, nothing else, no preface.`

// `tempo` compresses delivery (without changing pitch) so each clip lands
// at ≤ ~2 s. Tuned per-line by syllable count.
const CLIPS = [
  { file: 'touchdown.mp3',   line: 'TOUCHDOWN!!',                  tempo: 1.15 },
  { file: 'catch.mp3',       line: 'WHAT a catch!',                tempo: 1.00 },
  { file: 'mossed.mp3',      line: 'He got MOSSED!',               tempo: 1.30 },
  { file: 'no-stopping.mp3', line: "There's NO stoppin' him!",     tempo: 1.45 },
  { file: 'jets.mp3',        line: 'Look at the JETS on that one!', tempo: 1.10 },
  { file: 'pumped.mp3',      line: "He's getting PUMPED up!",       tempo: 1.58 },
]

fs.mkdirSync(OUT_DIR, { recursive: true })

const url = `${BASE.replace(/\/$/, '')}/chat/completions`

const TRIM_FILTER =
  'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB:detection=peak,' +
  'areverse,' +
  'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB:detection=peak,' +
  'areverse,' +
  'loudnorm=I=-14:TP=-1.5:LRA=7'

for (const c of CLIPS) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-audio',
      modalities: ['text', 'audio'],
      audio: { voice: 'ash', format: 'mp3' },
      messages: [
        { role: 'user', content: `${STYLE}\n\nLine to say: "${c.line}"` },
      ],
    }),
  })
  if (!resp.ok) {
    console.error(`✗ ${c.file}: ${resp.status} ${await resp.text()}`)
    process.exitCode = 1
    continue
  }
  const json = await resp.json()
  const b64 = json?.choices?.[0]?.message?.audio?.data
  if (!b64) {
    console.error(`✗ ${c.file}: no audio in response`)
    process.exitCode = 1
    continue
  }
  const raw = Buffer.from(b64, 'base64')

  // Write the raw clip to a temp file, then run two ffmpeg passes:
  //   pass 1: trim silence + loudnorm
  //   pass 2: tempo adjust + final encode
  const tmpRaw  = path.join(os.tmpdir(), `bbb-tts-raw-${c.file}`)
  const tmpTrim = path.join(os.tmpdir(), `bbb-tts-trim-${c.file}`)
  const finalOut = path.join(OUT_DIR, c.file)
  fs.writeFileSync(tmpRaw, raw)

  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', tmpRaw,
    '-af', TRIM_FILTER,
    '-codec:a', 'libmp3lame', '-b:a', '96k', '-ar', '44100', '-ac', '1',
    tmpTrim,
  ])
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', tmpTrim,
    '-af', `atempo=${c.tempo}`,
    '-codec:a', 'libmp3lame', '-b:a', '96k', '-ar', '44100', '-ac', '1',
    finalOut,
  ])

  fs.unlinkSync(tmpRaw)
  fs.unlinkSync(tmpTrim)

  const sz = fs.statSync(finalOut).size
  console.log(`  ${c.file}: ${(sz / 1024).toFixed(1)} KB`)
}

console.log('Done. Clips written to public/sfx/announcer/.')
