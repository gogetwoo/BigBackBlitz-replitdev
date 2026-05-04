import { useCallback, useEffect, useRef, useState } from 'react'

export type DisplayMode = 'desktop' | 'mobile'
export type Orientation = 'portrait' | 'landscape'

const STORAGE_KEY = 'bbb-display-mode'

// Heuristics for treating the current viewport as a "phone-sized" canvas.
// We deliberately keep the bands tight so a small desktop window doesn't
// accidentally trigger the on-screen touch controls.
//
//   • Portrait phone:  taller than it is wide AND narrower than 700 px.
//   • Landscape phone: wider than it is tall AND short (≤ 540 px tall).
//                      A laptop window is rarely shorter than ~600 px,
//                      while every common phone in landscape is well
//                      under 500 px tall (iPhone 14 Pro: 393, Pixel 7:
//                      412, etc.). 540 leaves a small safety margin.
function isPhonePortrait(w: number, h: number) {
  return h > w && w < 700
}
function isPhoneLandscape(w: number, h: number) {
  return w > h && h <= 540
}

export function autoDetectMode(): DisplayMode {
  if (typeof window === 'undefined') return 'desktop'
  const w = window.innerWidth
  const h = window.innerHeight
  // Phone-sized viewports — portrait OR landscape — get the mobile UI
  // (canvas-fills-viewport, on-screen touch buttons, scaled HUD). The
  // sub-shape (portrait vs landscape) is then resolved by the layout
  // code via `autoDetectOrientation` so each gets a purpose-built
  // canvas aspect ratio and touch-button arrangement.
  if (isPhonePortrait(w, h) || isPhoneLandscape(w, h)) return 'mobile'
  return 'desktop'
}

export function autoDetectOrientation(): Orientation {
  if (typeof window === 'undefined') return 'landscape'
  return window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait'
}

function loadStored(): DisplayMode | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'desktop' || v === 'mobile') return v
  } catch {
    // ignore
  }
  return null
}

export function useDisplayMode() {
  const [mode, setModeState] = useState<DisplayMode>(() => loadStored() ?? autoDetectMode())
  const [userPicked, setUserPicked] = useState<boolean>(() => loadStored() !== null)
  const [suggested, setSuggested] = useState<DisplayMode>(() => autoDetectMode())
  const [orientation, setOrientation] = useState<Orientation>(() => autoDetectOrientation())
  // Monotonically increments once per "settled" viewport change. This is
  // the single source of truth that downstream layout code (GamePage's
  // recalc effect) listens to so a rotation produces exactly one
  // recalc — even when it also flips `mode`. React batches the
  // `viewportTick` and `mode` updates from the same event handler, so a
  // dependent effect with `[mode, viewportTick]` runs once per settle.
  const [viewportTick, setViewportTick] = useState(0)

  // Track userPicked in a ref so the resize listener (registered once)
  // always reads the latest value without re-subscribing.
  const userPickedRef = useRef(userPicked)
  useEffect(() => { userPickedRef.current = userPicked }, [userPicked])

  const setMode = useCallback((m: DisplayMode) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, m)
    } catch {
      // ignore
    }
    setUserPicked(true)
    setModeState(m)
  }, [])

  // Live orientation / resize handling:
  //   • Always refresh `suggested` and `orientation` so menu hints and
  //     landscape-aware layout stay accurate.
  //   • If the user hasn't explicitly picked a mode, also flip the
  //     active `mode` immediately. This makes a phone rotation during
  //     gameplay re-lay-out the field, HUD, and touch buttons on the
  //     fly instead of waiting for the next run.
  //   • If the user has explicitly picked a mode, leave `mode` alone.
  //
  // Debounced: some mobile browsers fire many `resize` events in rapid
  // succession during a rotation as the viewport animates. We wait until
  // the stream settles (RESIZE_DEBOUNCE_MS of quiet) before sampling the
  // final viewport so a rotation produces a single mode flip.
  useEffect(() => {
    const RESIZE_DEBOUNCE_MS = 180
    let timer: ReturnType<typeof setTimeout> | null = null
    function settle() {
      timer = null
      const next = autoDetectMode()
      const nextOri = autoDetectOrientation()
      setSuggested(next)
      setOrientation((cur) => (cur === nextOri ? cur : nextOri))
      if (!userPickedRef.current) {
        setModeState((cur) => (cur === next ? cur : next))
      }
      // Bump the viewport tick *after* any potential mode change so
      // downstream effects see both updates in a single React batch.
      setViewportTick((t) => t + 1)
    }
    function onResize() {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(settle, RESIZE_DEBOUNCE_MS)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      if (timer !== null) clearTimeout(timer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  return { mode, setMode, userPicked, suggested, orientation, viewportTick }
}
