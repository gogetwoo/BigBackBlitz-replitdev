// Player sprite loader + animation controller for the Alcorn State #82
// top-view sprite set. Frames live under `public/sprites/player/` and are
// preloaded once at startup so the draw path is a single `drawImage` call
// per frame with zero per-frame allocations.

const BASE = `${import.meta.env.BASE_URL}sprites/player/`
const SPRINT_SHEET = `${BASE}sprint_sheet.png`

export type PlayerSpriteState =
  | 'idle'
  | 'run'
  | 'sprint'
  | 'jump'
  | 'lane_left'
  | 'lane_right'
  | 'dodge'
  | 'catch'
  | 'celebration'
  | 'stumble'

// Native canvas size of every sprite (centered pivot at canvas center).
export const SPRITE_W = 128
export const SPRITE_H = 192

// How many frames each state has on disk.
const FRAME_COUNTS: Record<PlayerSpriteState, number> = {
  idle: 2,
  run: 2,
  sprint: 10,
  jump: 3,
  lane_left: 2,
  lane_right: 2,
  dodge: 4,
  catch: 2,
  celebration: 3,
  stumble: 2,
}

// Looping animations advance forever and wrap around.
// Looping states pick frames using a per-state cycle rate (in cycles/sec).
const LOOP_STATES = new Set<PlayerSpriteState>(['idle', 'run', 'sprint'])

// Elapsed-time-based loops (animate even when runCycle is frozen).
// Period is seconds-per-frame.
const ELAPSED_LOOP_PERIOD: Partial<Record<PlayerSpriteState, number>> = {
  idle: 0.72,
  celebration: 0.42,   // loop the 3-frame celebration during touchdown
}

// One-shot animations play through once at a fixed total duration (sec).
const ONESHOT_DURATION: Partial<Record<PlayerSpriteState, number>> = {
  jump: 0.66,
  dodge: 0.48,
  catch: 0.54,
  celebration: 1.68,
  stumble: 0.42,
  lane_left: 0.22,
  lane_right: 0.22,
}

const frames: Record<PlayerSpriteState, HTMLImageElement[]> = {
  idle: [], run: [], sprint: [], jump: [],
  lane_left: [], lane_right: [], dodge: [], catch: [],
  celebration: [], stumble: [],
}

let loaded = false
let loadFailed = false   // set true if preload errored or timed out
let loadingPromise: Promise<void> | null = null

// Hard cap on how long we'll block gameplay waiting for sprites. Beyond
// this the game is allowed to start with whatever frames did load (or the
// fallback placeholder dot for any that didn't).
const PRELOAD_TIMEOUT_MS = 5000

function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.decoding = 'async'
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`failed to load ${src}`))
    img.src = src
  })
}

async function sliceSprintSheetIntoFrames(): Promise<void> {
  const sheet = await loadImage(SPRINT_SHEET)
  const cols = 5
  const rows = 2
  const total = FRAME_COUNTS.sprint
  const cellW = Math.floor(sheet.naturalWidth / cols)
  const cellH = Math.floor(sheet.naturalHeight / rows)
  if (cellW <= 0 || cellH <= 0) {
    throw new Error('invalid sprint sheet dimensions')
  }

  const out: HTMLImageElement[] = new Array(total)
  for (let i = 0; i < total; i++) {
    const sx = (i % cols) * cellW
    const sy = Math.floor(i / cols) * cellH

    const canvas = document.createElement('canvas')
    canvas.width = SPRITE_W
    canvas.height = SPRITE_H
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('failed to create sprint frame canvas context')

    if (typeof createImageBitmap === 'function') {
      let bitmap: ImageBitmap | null = null
      try {
        bitmap = await createImageBitmap(sheet, sx, sy, cellW, cellH)
        ctx.drawImage(bitmap, 0, 0, SPRITE_W, SPRITE_H)
      } finally {
        bitmap?.close()
      }
    } else {
      ctx.drawImage(sheet, sx, sy, cellW, cellH, 0, 0, SPRITE_W, SPRITE_H)
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b)
        else reject(new Error('failed to encode sprint frame'))
      }, 'image/png')
    })
    const url = URL.createObjectURL(blob)
    try {
      out[i] = await loadImage(url)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  frames.sprint = out
}

export function loadPlayerSprites(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (loadingPromise) return loadingPromise

  const all: Promise<void>[] = []
  for (const state of Object.keys(FRAME_COUNTS) as PlayerSpriteState[]) {
    if (state === 'sprint') continue
    const n = FRAME_COUNTS[state]
    frames[state] = new Array(n)
    for (let i = 0; i < n; i++) {
      const img = new Image()
      img.decoding = 'async'
      const p = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error(`failed to load ${state}_${i}.png`))
      })
      img.src = `${BASE}${state}_${i}.png`
      frames[state][i] = img
      all.push(p)
    }
  }
  all.push(sliceSprintSheetIntoFrames())

  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (!loaded) {
        loadFailed = true
        // eslint-disable-next-line no-console
        console.warn(`player sprite preload exceeded ${PRELOAD_TIMEOUT_MS}ms; starting with fallback`)
      }
      resolve()
    }, PRELOAD_TIMEOUT_MS)
  })

  loadingPromise = Promise.race([
    Promise.all(all).then(() => { loaded = true }),
    timeout,
  ]).catch((err) => {
    loadFailed = true
    // eslint-disable-next-line no-console
    console.warn('player sprite preload failed; starting with fallback', err)
  })
  return loadingPromise
}

export function spritesReady(): boolean { return loaded }

// True once preloading has either completed or failed/timed out.
// Gameplay should gate the initial menu→play transition on this rather
// than spritesReady() so a transient asset failure can't lock the game.
export function spritesReadyOrFailed(): boolean { return loaded || loadFailed }

// ─── Animation controller ──────────────────────────────────────────────────
//
// `runCycle` is a 0..1 normalized phase shared with the rest of the game
// (foot-plant timing). Looping run/sprint animations use it to pick the
// current frame so foot-plants stay synced regardless of frame rate.
//
// `elapsed` is the seconds spent in the current sprite state. Idle uses it
// (so it animates even when runCycle is frozen, e.g. menu/touchdown/gameover).
// One-shots use it too — they clamp to their final frame when complete; the
// caller decides when to switch back to a looping state.
//
// Returns the HTMLImageElement directly (or null) — no per-frame object
// allocation on the hot draw path.

export function pickFrame(
  state: PlayerSpriteState,
  runCycle: number,
  elapsed: number,
): HTMLImageElement | null {
  const list = frames[state]
  if (!list || list.length === 0) return null

  // Elapsed-time loops (idle, celebration): animate regardless of game phase.
  const loopPeriod = ELAPSED_LOOP_PERIOD[state]
  if (loopPeriod !== undefined) {
    const i = Math.floor(elapsed / loopPeriod) % list.length
    return list[i < 0 ? i + list.length : i]
  }
  if (LOOP_STATES.has(state)) {
    const i = Math.floor((((runCycle % 1) + 1) % 1) * list.length) % list.length
    return list[i]
  }
  const dur = ONESHOT_DURATION[state] ?? 0.4
  const t = Math.max(0, Math.min(1, elapsed / dur))
  const idx = Math.min(list.length - 1, Math.floor(t * list.length))
  return list[idx]
}

export function getOneShotDuration(state: PlayerSpriteState): number {
  return ONESHOT_DURATION[state] ?? 0.4
}
