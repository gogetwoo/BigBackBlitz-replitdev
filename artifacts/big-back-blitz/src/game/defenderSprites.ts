// Defender sprite loader + animation controller. Mirrors playerSprites.ts:
// frames live under `public/sprites/defender/<variant>/<state>_<index>.png`
// and are preloaded once at startup so the draw path is a single drawImage
// call per frame with zero per-frame allocations.

const BASE = `${import.meta.env.BASE_URL}sprites/defender/`

export type DefenderSpriteState = 'idle' | 'run' | 'tackle'

export const DEFENDER_VARIANTS = [
  'grambling',
  'alcorn',
  'southern',
  'famu',
  'ncat',
  'morehouse',
  'hampton',
  'texassouthern',
  'prairieview',
  'bethunecookman',
] as const
export type DefenderVariant = typeof DEFENDER_VARIANTS[number]

// Human-readable HBCU names per variant, used for in-game labels (tackle
// callout) and the gameover "schools faced" roster. Kept short enough to
// render legibly above a tackler without wrapping.
export const DEFENDER_DISPLAY_NAMES: Record<DefenderVariant, string> = {
  grambling:      'GRAMBLING STATE',
  alcorn:         'ALCORN STATE',
  southern:       'SOUTHERN',
  famu:           'FLORIDA A&M',
  ncat:           'NORTH CAROLINA A&T',
  morehouse:      'MOREHOUSE',
  hampton:        'HAMPTON',
  texassouthern:  'TEXAS SOUTHERN',
  prairieview:    'PRAIRIE VIEW A&M',
  bethunecookman: 'BETHUNE-COOKMAN',
}

// Native canvas size of every sprite (centered pivot at canvas center).
export const DEFENDER_SPRITE_W = 128
export const DEFENDER_SPRITE_H = 192

// How many frames each state has on disk.
const FRAME_COUNTS: Record<DefenderSpriteState, number> = {
  idle: 1,
  run: 3,
  tackle: 7,
}

// `run` loops continuously off the per-defender runCycle phase. `tackle`
// is a one-shot whose total duration drives a clamped frame index.
const TACKLE_DURATION = 1.14   // seconds for the full 7-frame sequence

const frames: Record<DefenderVariant, Record<DefenderSpriteState, HTMLImageElement[]>> =
  Object.fromEntries(
    DEFENDER_VARIANTS.map(v => [v, { idle: [], run: [], tackle: [] }]),
  ) as unknown as Record<DefenderVariant, Record<DefenderSpriteState, HTMLImageElement[]>>

let loaded = false
let loadFailed = false
let loadingPromise: Promise<void> | null = null

const PRELOAD_TIMEOUT_MS = 5000

export function loadDefenderSprites(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (loadingPromise) return loadingPromise

  const all: Promise<void>[] = []
  for (const variant of DEFENDER_VARIANTS) {
    for (const state of Object.keys(FRAME_COUNTS) as DefenderSpriteState[]) {
      const n = FRAME_COUNTS[state]
      const list = frames[variant][state]
      list.length = n
      for (let i = 0; i < n; i++) {
        const img = new Image()
        img.decoding = 'async'
        const p = new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(
            new Error(`failed to load defender ${variant}/${state}_${i}.png`)
          )
        })
        img.src = `${BASE}${variant}/${state}_${i}.png`
        list[i] = img
        all.push(p)
      }
    }
  }

  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (!loaded) {
        loadFailed = true
        // eslint-disable-next-line no-console
        console.warn(`defender sprite preload exceeded ${PRELOAD_TIMEOUT_MS}ms; starting with fallback`)
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
    console.warn('defender sprite preload failed; starting with fallback', err)
  })
  return loadingPromise
}

export function defenderSpritesReady(): boolean { return loaded }
export function defenderSpritesReadyOrFailed(): boolean { return loaded || loadFailed }

export function pickDefenderFrame(
  variant: DefenderVariant,
  state: DefenderSpriteState,
  runCycle: number,
  tackleElapsed: number,
): HTMLImageElement | null {
  const list = frames[variant]?.[state]
  if (!list || list.length === 0) return null

  if (state === 'run') {
    const phase = ((runCycle % 1) + 1) % 1
    const i = Math.floor(phase * list.length) % list.length
    return list[i]
  }
  if (state === 'tackle') {
    const t = Math.max(0, Math.min(1, tackleElapsed / TACKLE_DURATION))
    const idx = Math.min(list.length - 1, Math.floor(t * list.length))
    return list[idx]
  }
  return list[0]
}

export function getTackleDuration(): number { return TACKLE_DURATION }

// Round-robin variant picker so the field shows a mix of HBCU color schemes.
let pickIdx = Math.floor(Math.random() * DEFENDER_VARIANTS.length)
export function pickDefenderVariant(): DefenderVariant {
  const v = DEFENDER_VARIANTS[pickIdx % DEFENDER_VARIANTS.length]
  // Advance by a stride coprime to the variant count (10) so even with
  // multiple defenders spawning in quick succession we cycle through every
  // school instead of biasing toward neighbors.
  pickIdx = (pickIdx + 3) % DEFENDER_VARIANTS.length
  return v
}
