# Announcer voice clips

Six short hype-announcer clips played on big in-game events. Voiced as an
**energetic HBCU stadium PA announcer** — bold, charismatic, broadcast-style.

| File              | Line                            | Trigger (AudioManager method) |
| ----------------- | ------------------------------- | ----------------------------- |
| `touchdown.mp3`   | "TOUCHDOWN!!"                   | `playTouchdown()`             |
| `catch.mp3`       | "WHAT a catch!"                 | `playCatch()`                 |
| `mossed.mp3`      | "He got MOSSED!"                | `playJumpOver()`              |
| `no-stopping.mp3` | "There's NO stoppin' him!"      | `playSpin()`                  |
| `jets.mp3`        | "Look at the JETS on that one!" | `playBoost()`                 |
| `pumped.mp3`      | "He's getting PUMPED up!"       | `playPowerUp()`               |

All clips are mono 44.1 kHz MP3, ≤ ~2 s, ≤ ~25 KB, loudness-matched at
about −14 LUFS / −1.5 dBTP.

## How they were generated

Provider: **OpenAI** Chat Completions API with the audio modality
(via the Replit AI Integrations proxy — no local API key required).

- Model: `gpt-audio`
- Voice: `ash` (charismatic, expressive male)
- Output format: `mp3`
- Style is delivered via the user prompt (see `STYLE` in the script) so the
  same voice can be re-tuned later without changing the model.

Post-processing (ffmpeg):
1. Trim leading/trailing silence (`silenceremove`)
2. `loudnorm` to a consistent target loudness
3. `atempo` per-line to compress delivery so every clip fits ≤ ~2 s
4. Re-encode as 96 kbps mono 44.1 kHz MP3

## Regenerating

```bash
node scripts/generate-announcer-tts.mjs
```

The script reads `AI_INTEGRATIONS_OPENAI_BASE_URL` and
`AI_INTEGRATIONS_OPENAI_API_KEY` from the environment (auto-provisioned by
the `ai-integrations-openai` skill) and writes the six MP3s into this
directory, overwriting the existing files.

If you want to tweak the delivery, edit the `STYLE` prompt or the per-clip
`tempo` values in `scripts/generate-announcer-tts.mjs`.
