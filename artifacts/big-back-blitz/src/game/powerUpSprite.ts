// Hydration bottle power-up sprite loader. Preloaded once at startup so the
// canvas draw path is a single `drawImage` call per frame.

const BASE = `${import.meta.env.BASE_URL}sprites/powerups/`

let bottleImg: HTMLImageElement | null = null
let loaded = false
let loadingPromise: Promise<void> | null = null

export function loadPowerUpSprites(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (loadingPromise) return loadingPromise

  const img = new Image()
  img.decoding = 'async'
  loadingPromise = new Promise<void>((resolve) => {
    img.onload = () => { bottleImg = img; loaded = true; resolve() }
    img.onerror = () => {
      // eslint-disable-next-line no-console
      console.warn('hydration bottle preload failed')
      resolve()
    }
    img.src = `${BASE}hydration.png`
  })
  return loadingPromise
}

export function getBottleImage(): HTMLImageElement | null {
  return bottleImg
}
