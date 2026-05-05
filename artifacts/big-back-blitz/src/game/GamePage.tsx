import { useCallback, useRef, useEffect, useState, useSyncExternalStore } from 'react'
import {
  loadPlayerSprites, pickFrame, spritesReady, spritesReadyOrFailed,
  getOneShotDuration,
  SPRITE_W, SPRITE_H, type PlayerSpriteState,
} from './playerSprites'
import { loadPowerUpSprites, getBottleImage } from './powerUpSprite'
import {
  loadBoards,
  saveBoards,
  loadLevelBests,
  saveLevelBests,
  type LevelBests,
  insertEntry,
  insertEntryByTd,
  qualifiesForBoard,
  qualifiesForTdBoard,
  buildThresholds,
  buildTdThresholds,
  isValidInitials,
  sanitizeInitials,
  LEADERBOARD_MAX,
  INITIALS_LEN,
  BOARD_MODE_STORAGE_KEY,
  type BoardMode,
  type LeaderboardEntry,
  type ThresholdMarker,
  type TdThresholdMarker,
} from './leaderboard'
import {
  loadDefenderSprites, defenderSpritesReady, pickDefenderFrame,
  getTackleDuration,
  DEFENDER_SPRITE_W, DEFENDER_SPRITE_H,
  DEFENDER_DISPLAY_NAMES, DEFENDER_VARIANTS,
  type DefenderVariant,
} from './defenderSprites'
import { useDisplayMode, type DisplayMode } from '../hooks/use-display-mode'
import { audioManager } from './audioManager'

// On-screen draw size of the player sprite. Tuned so the sprite visually
// occupies roughly the same footprint as the previous primitive drawing.
const PLAYER_DRAW_W = 88
const PLAYER_DRAW_H = PLAYER_DRAW_W * (SPRITE_H / SPRITE_W)   // = 132

// On-screen draw size of defender sprites. Same aspect ratio as the player
// (sprites share native dimensions) so depth scaling and sort order match.
const DEFENDER_DRAW_W = 84
const DEFENDER_DRAW_H = DEFENDER_DRAW_W * (DEFENDER_SPRITE_H / DEFENDER_SPRITE_W)

// ─── Screen ────────────────────────────────────────────────────────────────
// These are MUTABLE because the layout swaps between desktop (landscape) and
// mobile (portrait) modes. `applyDisplayMode` reassigns them; all rendering
// and game-logic code reads the current values directly.
let GW = 1280
let GH = 720

// ─── Field layout ──────────────────────────────────────────────────────────
let FL = 110          // field left X (sideline)
let FR = 1170         // field right X
let FW = FR - FL      // field width = 1060

// 5 lanes
const NLANES = 5
let LANE_XS: number[] = [214, 426, 640, 854, 1066]

// Player sits near the bottom of the field view
let PLAYER_Y = 570

// Spawn defenders above screen
const DEF_SPAWN_SCREEN_Y = -160

// Desktop "feel" anchor — distance a defender travels from spawn to the
// player on the 720-tall desktop canvas. Used to derive SCREEN_SCALE in
// `applyDisplayMode` so taller mobile portraits don't read as slower.
const DESKTOP_JOURNEY = 570 - DEF_SPAWN_SCREEN_Y   // 730 px

// Vertical-pacing scale: how much taller the current canvas's defender
// journey is vs. desktop. 1.0 on desktop; ~1.5–2.0 on mobile portraits.
// `applyDisplayMode` resets it; all px/s rates and px/yard distances that
// govern vertical pacing are multiplied by this so a defender spawned
// off-screen reaches the player in the same number of seconds on every
// layout, and a touchdown still takes ~19 s of base-speed running.
let SCREEN_SCALE = 1

// Active mode (mirrored from React state). Used by drawing code that wants
// to render mode-specific labels (e.g. "TAP TO PLAY" vs "PRESS ANY KEY").
let CURRENT_MODE: DisplayMode = 'desktop'

// Top safe-area inset in canvas units. On notched mobile devices the
// canvas fills the viewport (including the notch), so the top HUD needs
// to avoid that zone. Set by `applyDisplayMode` from CSS env() pixel
// values supplied by the React layer. (Bottom inset is handled in CSS
// for the on-screen controls; the canvas has no bottom HUD on mobile.)
let SAFE_TOP = 0

// True when the current layout is the phone-landscape variant of mobile
// mode (short, wide canvas with stacked corner touch buttons). Read by
// HUD-drawing code so it can shift the speed panel out of the play area
// instead of stacking it under the score panel like the portrait HUD.
let IS_LANDSCAPE_MOBILE = false

// Recompute layout for the chosen mode. In mobile portrait the canvas's
// internal aspect ratio is matched to the device viewport so it can fill
// the screen without letterbox bars; height is clamped to a sensible range
// so a landscape rotation doesn't squash gameplay.
//
// `safeTopCss` is the top safe-area inset in CSS pixels (typically from
// `env(safe-area-inset-top)`). It is only applied in mobile mode and is
// converted from CSS pixels to canvas-internal units using the canvas
// scale factor (canvas height / viewport height).
export function applyDisplayMode(
  mode: DisplayMode,
  viewW: number,
  viewH: number,
  safeTopCss: number = 0,
) {
  CURRENT_MODE = mode
  if (mode === 'mobile') {
    // Distinguish portrait phone vs landscape phone. Both are "mobile"
    // (canvas-fills-viewport, on-screen touch buttons), but each gets a
    // purpose-built canvas aspect ratio:
    //   • Portrait:  fix internal width  (GW = 720), grow height with
    //                viewport ratio. Tall, narrow play column.
    //   • Landscape: fix internal height (GH = 720), grow width with
    //                viewport ratio. Short, wide play strip; lanes
    //                spread further apart and the player is held away
    //                from the bottom edge so the corner touch buttons
    //                don't sit on top of the sprite.
    const isLandscape = viewW > viewH
    IS_LANDSCAPE_MOBILE = isLandscape
    if (isLandscape) {
      GH = 720
      const ratio = viewH > 0 ? viewW / viewH : 16 / 9
      GW = Math.round(GH * Math.max(ratio, 1.0))
      // Clamp to keep aspect ratios sane on extreme devices (foldables,
      // ultra-wide phones, browser dev-tools quirks).
      GW = Math.max(1100, Math.min(GW, 2400))
      FL = 80
      FR = GW - 80
      FW = FR - FL
      LANE_XS = Array.from({ length: NLANES }, (_, i) =>
        Math.round(FL + (FW * (2 * i + 1)) / (2 * NLANES))
      )
      // Higher up than portrait (0.74 vs 0.78) — the corner touch
      // buttons + their stacked action buttons cover the bottom ~25 %
      // of the viewport in landscape, so the player needs to sit above
      // that zone.
      PLAYER_Y = Math.round(GH * 0.74)

      // Aspect matches viewport, so canvas height ≈ viewport height
      // (object-fit: contain). Scale CSS-pixel inset into canvas units.
      const scale = viewH > 0 ? GH / viewH : 1
      SAFE_TOP = Math.round(safeTopCss * scale)
    } else {
      GW = 720
      const ratio = viewW > 0 ? viewH / viewW : 16 / 9
      GH = Math.round(GW * Math.max(ratio, 1.0))
      GH = Math.max(1100, Math.min(GH, 2200))
      FL = 30
      FR = GW - 30
      FW = FR - FL
      LANE_XS = Array.from({ length: NLANES }, (_, i) =>
        Math.round(FL + (FW * (2 * i + 1)) / (2 * NLANES))
      )
      PLAYER_Y = Math.round(GH * 0.78)

      // Convert CSS-pixel inset → canvas units. The canvas display height
      // equals the viewport height (object-fit: contain on a matched ratio),
      // so scale = GH / viewH.
      const scale = viewH > 0 ? GH / viewH : 1
      SAFE_TOP = Math.round(safeTopCss * scale)
    }
  } else {
    GW = 1280
    GH = 720
    FL = 110
    FR = 1170
    FW = FR - FL
    LANE_XS = [214, 426, 640, 854, 1066]
    PLAYER_Y = 570
    SAFE_TOP = 0
    IS_LANDSCAPE_MOBILE = false
  }

  // Recompute the vertical-pacing scale and all px/s and px/yard rates
  // that depend on it. With this in place a defender spawned off-screen
  // reaches the player in roughly the same number of seconds on every
  // layout, yard lines pass at the same cadence, and a touchdown still
  // takes ~19 s at base speed regardless of how tall the canvas is.
  SCREEN_SCALE = (PLAYER_Y - DEF_SPAWN_SCREEN_Y) / DESKTOP_JOURNEY
  PIXELS_PER_YARD = BASE_PIXELS_PER_YARD * SCREEN_SCALE
  YARD_LINE_GAP   = PIXELS_PER_YARD * 5
  PIXELS_PER_TD   = YARDS_TO_TD * PIXELS_PER_YARD
  BASE_SCROLL     = BASE_SCROLL_BASE  * SCREEN_SCALE
  MAX_SCROLL      = MAX_SCROLL_BASE   * SCREEN_SCALE
  SCROLL_STEP     = SCROLL_STEP_BASE  * SCREEN_SCALE
  DEF_BASE_SPD    = DEF_BASE_SPD_BASE * SCREEN_SCALE
  DEF_LVL_SPD     = DEF_LVL_SPD_BASE  * SCREEN_SCALE

  CROWD_L = buildCrowdL()
  CROWD_R = buildCrowdR()
}

// Snapshot of the layout-dependent module state — captured BEFORE
// `applyDisplayMode` is called so `remapEntitiesForLayout` can map
// entity positions from the old coordinate space into the new one.
interface LayoutSnapshot {
  GW: number; GH: number
  FL: number; FR: number
  PLAYER_Y: number
  PIXELS_PER_YARD: number
}

function snapshotLayout(): LayoutSnapshot {
  return { GW, GH, FL, FR, PLAYER_Y, PIXELS_PER_YARD }
}

// Remap all live entity positions and the world offset from the old
// layout into the new one. Called by the React layer right after
// `applyDisplayMode` so a mid-run orientation flip doesn't strand
// defenders/collectibles off-screen, off-lane, or out of pace.
//
// Strategy:
//   • Player → snap to the active lane's new X.
//   • worldOffset → scale by new/old PIXELS_PER_YARD so virtual yards
//     traveled (and yard-line cadence) are preserved.
//   • Defenders / collectibles X → linearly remap from old field strip
//     (FL..FR) into the new one, then for collectibles snap to the
//     nearest new lane.
//   • Defenders / collectibles screenY → remap by their progress along
//     the spawn → player journey so "time until reaching the player"
//     is preserved on the new canvas height.
//   • Particles / float texts → scaled proportionally so the celebration
//     visuals don't suddenly cluster in a corner after a flip.
function remapEntitiesForLayout(g: GS, old: LayoutSnapshot) {
  // Bail if the snapshot is identical to the current layout.
  if (old.GW === GW && old.GH === GH && old.FL === FL && old.FR === FR &&
      old.PLAYER_Y === PLAYER_Y && old.PIXELS_PER_YARD === PIXELS_PER_YARD) {
    return
  }

  const oldFW = Math.max(1, old.FR - old.FL)
  const newFW = FR - FL
  const oldJourney = Math.max(1, old.PLAYER_Y - DEF_SPAWN_SCREEN_Y)
  const newJourney = PLAYER_Y - DEF_SPAWN_SCREEN_Y

  // Player snap to active lane in the new layout.
  g.playerX = LANE_XS[clamp(g.playerLane, 0, NLANES - 1)]
  g.targetLane = clamp(g.targetLane, 0, NLANES - 1)

  // Preserve virtual yards traveled across the px/yard scale change.
  if (old.PIXELS_PER_YARD > 0) {
    g.worldOffset = g.worldOffset * (PIXELS_PER_YARD / old.PIXELS_PER_YARD)
  }

  for (const d of g.defs) {
    if (!d.active) continue
    const px = (d.x - old.FL) / oldFW
    d.x = clamp(FL + px * newFW, FL + 24, FR - 24)
    const progress = (d.screenY - DEF_SPAWN_SCREEN_Y) / oldJourney
    d.screenY = DEF_SPAWN_SCREEN_Y + progress * newJourney
  }

  for (const c of g.cols) {
    if (!c.active) continue
    const px = (c.x - old.FL) / oldFW
    const nx = clamp(FL + px * newFW, FL + 24, FR - 24)
    // Snap pickups to the nearest lane so they don't end up stranded
    // between lanes after a remap.
    let bestLane = 0, bestD = Infinity
    for (let i = 0; i < NLANES; i++) {
      const dd = Math.abs(LANE_XS[i] - nx)
      if (dd < bestD) { bestD = dd; bestLane = i }
    }
    c.x = LANE_XS[bestLane]
    const progress = (c.screenY - DEF_SPAWN_SCREEN_Y) / oldJourney
    c.screenY = DEF_SPAWN_SCREEN_Y + progress * newJourney
  }

  const sx = newFW / oldFW
  const sy = newJourney / oldJourney
  for (const p of g.particles) {
    if (p.life <= 0) continue
    p.x = FL + (p.x - old.FL) * sx
    p.y = p.y * sy
  }
  for (const f of g.floatTexts) {
    if (f.life <= 0) continue
    f.x = FL + (f.x - old.FL) * sx
    f.y = f.y * sy
  }
}

// ─── Scroll / world ────────────────────────────────────────────────────────
// Scale: 60 visual pixels = 1 virtual football yard on desktop. On taller
// mobile portraits these px-per-yard distances are scaled up by
// SCREEN_SCALE (see `applyDisplayMode`) so the vertical cadence of yard
// lines and touchdowns matches desktop's "feel" instead of feeling slow.
// Visual yard lines are drawn every 5 yards (300 px apart on desktop).
// One touchdown = 100 yards = 6000 px on desktop (~19 s at base speed).
const BASE_PIXELS_PER_YARD = 60
const YARDS_TO_TD          = 100
let   PIXELS_PER_YARD = BASE_PIXELS_PER_YARD
let   PIXELS_PER_TD   = YARDS_TO_TD * PIXELS_PER_YARD
let   YARD_LINE_GAP   = PIXELS_PER_YARD * 5

// ─── Speeds (px/s) ─────────────────────────────────────────────────────────
// Vertical-world speeds are stored as desktop "base" constants and the
// live values (without the `_BASE` suffix) are recomputed by
// `applyDisplayMode` so a 2× taller canvas scrolls 2× faster in px/s and
// therefore feels equally fast. Horizontal speeds (lane change, defender
// tracking) intentionally stay constant — the mobile field is narrower,
// so the existing px/s already feels snappy enough.
const BASE_SCROLL_BASE    = 310
// Top-end px/s the field can scroll. Set so that with SCROLL_STEP=38 the
// cap is reached around level 18 ((950-310)/38 ≈ 16.8 → L18). Pushing past
// ~950 px/s starts to feel unfair on reaction time, so beyond the cap we
// keep ramping defender speed + spawn cadence instead of raw scroll.
const MAX_SCROLL_BASE     = 950
// Speed added per completed level (replaces continuous time-based ramp).
// Level 1 = BASE_SCROLL, Level 2 = BASE_SCROLL + SCROLL_STEP, etc.,
// capped at MAX_SCROLL. Smaller step (vs the previous 45) stretches the
// progression so levels 1–18 each feel meaningfully faster than the last
// instead of plateauing at level 12–13.
const SCROLL_STEP_BASE    = 38
const DEF_BASE_SPD_BASE   = 35
// Defender speed added per completed level (not per total touchdown).
// Continues to scale past the scroll-speed cap so high levels still
// escalate even after raw scroll plateaus.
const DEF_LVL_SPD_BASE    = 14
let   BASE_SCROLL  = BASE_SCROLL_BASE
let   MAX_SCROLL   = MAX_SCROLL_BASE
let   SCROLL_STEP  = SCROLL_STEP_BASE
let   DEF_BASE_SPD = DEF_BASE_SPD_BASE
let   DEF_LVL_SPD  = DEF_LVL_SPD_BASE
const LANE_CHG_SPD  = 1380   // px/s X transition (horizontal — not scaled)
const DEF_TRACK_SPD = 320    // defender horizontal tracking speed (not scaled)

// ── Run cadence curve ────────────────────────────────────────────────────
// Stride frequency (cycles/sec) as a function of normalized speed in
// [0, 1]. Three distinct phases (jog, mid, sprint) instead of a straight
// linear ramp: a real runner doesn't visibly thrash their legs much
// faster as they pick up pace at low speeds, but stride frequency really
// jumps near top speed. Smoothstep eases the jog→mid range; a quadratic
// ease-in steepens the mid→sprint range so the last stretch of speed
// visibly cranks the cadence.
const RUN_FREQ_JOG    = 3.2
const RUN_FREQ_MID    = 4.6
const RUN_FREQ_SPRINT = 8.4
const RUN_MID_BREAK   = 0.55
function runCadenceForSpeedFactor(t: number): number {
  const s = Math.max(0, Math.min(1, t))
  if (s <= RUN_MID_BREAK) {
    const u = s / RUN_MID_BREAK
    const eased = u * u * (3 - 2 * u) // smoothstep
    return RUN_FREQ_JOG + eased * (RUN_FREQ_MID - RUN_FREQ_JOG)
  }
  const u = (s - RUN_MID_BREAK) / (1 - RUN_MID_BREAK)
  const eased = u * u // quadratic ease-in
  return RUN_FREQ_MID + eased * (RUN_FREQ_SPRINT - RUN_FREQ_MID)
}

// ─── Player dimensions ─────────────────────────────────────────────────────
const HIT_R     = 21         // collision radius (running)

// ─── Mechanics ─────────────────────────────────────────────────────────────
const SPIN_DUR        = 0.40
const SPIN_RADIUS     = 110
const BOOST_DUR       = 1.6
// Jump = brief vertical hop with full invulnerability for the duration.
// Matched to the sprite one-shot length so the air-time visually maps to
// the animation cycle.
const JUMP_DUR        = 0.55

// ─── Spawn intervals ───────────────────────────────────────────────────────
const SPAWN_DEF_MIN   = 1.5
const SPAWN_DEF_MAX   = 2.8
const SPAWN_COL_INT   = 0.75

// ─── Power-ups (hydration bottles) ─────────────────────────────────────────
// Bottles are STORED in an inventory. Each of the three moves (Jump, Spin,
// Turbo) requires at least 1 power-up to activate. A power-up is consumed
// only when the move actually counters a defender:
//   Jump  → defender passes under during the hop window
//   Spin  → at least one defender cleared in the spin radius
//   Turbo → player contacts (plows through) a defender while boosting
const POWER_UP_MAX = 5

// Duration of the "NEW HIGH SCORE!" banner that fires both in-run (when the
// live score passes someone on the leaderboard) and on the game-over screen
// (when the run qualifies for a top-10 slot). Long enough to read at speed
// without lingering on the screen and obscuring play.
const NHS_ANIM_DUR = 1.6

// ─── Touchdown celebration ────────────────────────────────────────────────
// Total length of the touchdown phase. The first TD_FREEZE_DUR seconds
// completely pause field scrolling so the celebration sprite (1.4s loop)
// can breathe, then the field eases back into motion for the remainder.
const TD_DUR          = 2.4
const TD_FREEZE_DUR   = 1.5
// Period between periodic confetti bursts around the player during the
// freeze window. Spawns a small ring of stars/squares centered on the
// player so the celebration sprite is wreathed in particles.
const TD_BURST_PERIOD = 0.32

// ─── Pools ─────────────────────────────────────────────────────────────────
const MAX_DEF = 16
const MAX_COL = 24
const MAX_PAR = 280
const MAX_FTX = 18

// ─── Colors ────────────────────────────────────────────────────────────────
const C_PURPLE  = '#4B0082'
const C_GOLD    = '#FFD700'
const C_LTPURP  = '#7B2FBE'
const C_SKIN    = '#D4956A'
const C_DEFBLUE = '#1A3A8A'
const C_DEFRED  = '#CC2200'
const C_WHITE   = '#FFFFFF'
const C_FIELD1  = '#2D6B1A'
const C_FIELD2  = '#255814'
const C_ENDZONE = '#4B0082'

// ─── Leaderboard board-mode ───────────────────────────────────────────────────
// Which view is currently displayed on the leaderboard panel ("points" or
// "touchdowns"). Stored as a module-level var so canvas drawing functions
// can read it without being threaded through every call chain. Mirrored
// from React state via `setBoardModeModule`. Persisted to localStorage.
let CURRENT_BOARD_MODE: BoardMode = (() => {
  try {
    const v = typeof window !== 'undefined'
      ? window.localStorage.getItem(BOARD_MODE_STORAGE_KEY)
      : null
    return v === 'touchdowns' ? 'touchdowns' : 'points'
  } catch { return 'points' }
})()

// Canvas-coordinate hit rects for the two leaderboard tabs. Updated every
// frame by drawLeaderboardPanel so the pointer-down handler can detect
// clicks without needing layout knowledge in React.
let TAB_POINTS_RECT  = { x: 0, y: 0, w: 0, h: 0 }
let TAB_TD_RECT      = { x: 0, y: 0, w: 0, h: 0 }
// ─── SFX edge-detection state ────────────────────────────────────────────────
// Module-level variables used to detect state transitions inside update()
// so one-shot SFX fire on the first frame of each event, not every frame.
let _sfxPrevBoostActive  = false
let _sfxPrevBoostTimer   = 0
let _sfxLastMilestoneGrp = -1   // floor(yards/25) — updated each playing frame

// ─── Menu intro animation state ──────────────────────────────────────────────
// Tracks the absolute `time` (seconds) when the menu animation started.
// -1 = not yet started. Reset each time the menu phase is first drawn.
let menuAnimStartTime = -1
// Guards so the helmet-crack SFX fires only once per menu visit.
let helmetCrackPlayed = false
// Set when the animation reaches the impact frame but the AudioContext
// wasn't running yet (browser autoplay policy). The animation restarts
// from the top as soon as audio becomes available so the crack SFX
// fires in-sync with the helmet collision on the next pass.
let helmetCrackMissed = false

// ─── Menu impact particle system ─────────────────────────────────────────────
interface MenuParticle {
  x: number; y: number
  vx: number; vy: number
  life: number        // 0–1, counts down to 0 (dead)
  maxLife: number     // duration in seconds
  size: number
  color: string
  type: 'shard' | 'spark'
}
let menuParticles: MenuParticle[] = []
let menuParticleLastT = -1   // last absolute time — used for delta computation
let menuImpactFired  = false // whether the particle burst has been spawned this run
// Tracks the phase observed on the previous draw call so we can detect a
// transition INTO 'menu' (e.g. from 'gameover' or 'versus') and replay the
// helmet-clash intro sequence from the very beginning. Initialised to 'menu'
// so the very first draw uses the existing < 0 first-load handler instead
// of double-resetting.
let menuLastObservedPhase: Phase = 'menu'

// Index into MENU_OPPONENT_HELMETS for the left-side helmet.
// Starts at -1 so the first advance (on first menu load) lands on index 0.
let menuOpponentIdx = -1

// ─── HBCU schools / level rotation ────────────────────────────────────────
// The player's school (Alcorn) plus a fixed rotation of opponent schools.
// Each level pits Alcorn against one opponent — every defender on the
// field uses that opponent's color variant for the duration of the level.
// Cleared on the 10th touchdown of the level; the rotation loops once
// every school has been beaten so play can continue indefinitely.
type OpponentSchool = Exclude<DefenderVariant, 'alcorn'>

interface SchoolMeta {
  variant: DefenderVariant
  display: string     // short label used on versus card / WINS banner
  primary: string     // dominant brand color
  secondary: string   // accent / secondary color
}

const ALCORN_META: SchoolMeta = {
  variant: 'alcorn',
  display: 'ALCORN',
  primary: '#4B0082',   // Alcorn purple (matches C_PURPLE)
  secondary: '#FFD700', // Alcorn gold   (matches C_GOLD)
}

const SCHOOL_META: Record<OpponentSchool, SchoolMeta> = {
  grambling:      { variant: 'grambling',      display: 'GRAMBLING',       primary: '#000000', secondary: '#FFD700' },
  southern:       { variant: 'southern',       display: 'SOUTHERN',        primary: '#003F87', secondary: '#FDB913' },
  famu:           { variant: 'famu',           display: 'FAMU',            primary: '#FF7F00', secondary: '#006633' },
  ncat:           { variant: 'ncat',           display: 'NC A&T',          primary: '#003366', secondary: '#FDB913' },
  morehouse:      { variant: 'morehouse',      display: 'MOREHOUSE',       primary: '#7B0033', secondary: '#FFFFFF' },
  hampton:        { variant: 'hampton',        display: 'HAMPTON',         primary: '#003366', secondary: '#FFFFFF' },
  texassouthern:  { variant: 'texassouthern',  display: 'TEXAS SOUTHERN',  primary: '#660066', secondary: '#A89D6F' },
  prairieview:    { variant: 'prairieview',    display: 'PRAIRIE VIEW',    primary: '#4B2D83', secondary: '#FDB913' },
  bethunecookman: { variant: 'bethunecookman', display: 'BETHUNE-COOKMAN', primary: '#8B0000', secondary: '#FFD700' },
}

// Fixed rotation order — Alcorn faces these schools in sequence and the
// list loops once cleared. (Order chosen to mirror the example in the
// task spec, which shows ALCORN vs SOUTHERN on level 1.)
const OPPONENT_ROTATION: OpponentSchool[] = [
  'southern',
  'grambling',
  'famu',
  'ncat',
  'morehouse',
  'hampton',
  'texassouthern',
  'prairieview',
  'bethunecookman',
]

function getOpponent(level: number): OpponentSchool {
  const idx = ((level - 1) % OPPONENT_ROTATION.length + OPPONENT_ROTATION.length)
            % OPPONENT_ROTATION.length
  return OPPONENT_ROTATION[idx]
}

// Touchdowns required to clear a level.
const LEVEL_TD_GOAL = 10

// Length of the "ALCORN vs OPPONENT" intro overlay (seconds). Tuned to
// match the touchdown celebration in feel — long enough to read the
// matchup, short enough to keep run pacing snappy.
const VERSUS_DUR = 2.4

// Length of the "ALCORN WINS!" beat that plays after clearing a level.
// Held for 5 seconds so players have time to enjoy the win screen before
// the next level's versus intro begins.
const LEVEL_WIN_DUR = 5

// ─── Types ─────────────────────────────────────────────────────────────────
type DefType    = 'safety' | 'linebacker' | 'corner'
type DefPattern = 'straight' | 'track' | 'diagonal_l' | 'diagonal_r' | 'pincer'
type ColType    = 'coin' | 'football' | 'star'
type Phase      = 'menu' | 'playing' | 'paused' | 'gameover' | 'touchdown'
                | 'versus' | 'levelwin'

interface Defender {
  active: boolean
  x: number; screenY: number
  type: DefType; pattern: DefPattern
  speed: number; vx: number
  dodged: boolean
  runCycle: number
  flashTimer: number   // red flash when near player
  variant: DefenderVariant
  tackling: boolean        // true once this defender has tackled the player
  tackleElapsed: number    // seconds spent in the tackle one-shot
  hitFlashStart: number    // performance.now() ms at tackle impact (0 = inactive)
}

interface Collectible {
  active: boolean; collected: boolean
  x: number; screenY: number
  type: ColType; bobPhase: number
}

interface Particle {
  x: number; y: number
  vx: number; vy: number
  color: string; size: number
  life: number; maxLife: number
  shape: 'circle' | 'rect'
  rot: number; rotV: number
}

interface FloatText {
  x: number; y: number
  text: string; color: string
  size: number; life: number; maxLife: number
}

interface GS {
  phase: Phase
  score: number; yards: number; touchdowns: number
  // ── Levels (HBCU rivalry rotation) ────────────────────────────────────
  // 1-based level counter and per-level touchdown progress. `opponent` is
  // the HBCU school whose color variant every defender on the field uses
  // for the current level. `versusTimer` counts down the LEVEL N intro
  // card; `levelWinTimer` counts down the "ALCORN WINS!" beat that plays
  // when the player clears the 10-TD goal for the level.
  level: number
  levelTouchdowns: number
  opponent: OpponentSchool
  versusTimer: number
  levelWinTimer: number
  // Score the player had when the current level began. Used to compute
  // the per-level point total shown on the level-win overlay (and to
  // diff against the persisted per-level best to award "NEW BEST!").
  levelStartScore: number
  // Per-level best scores keyed by level number, persisted in
  // localStorage. Mutated when the player beats their previous best
  // for the level being cleared.
  levelBests: LevelBests
  // Snapshot of the level-win celebration: the per-level points the
  // player just earned, the best for that level (post-update), and a
  // flag set when this run beat the previous best.
  levelWinScore: number
  levelWinBest: number
  levelWinIsNewBest: boolean
  // Brief countdown (>0 for ~1s after a new level begins) used to flash a
  // "SPEED UP!" callout and pulse the MPH gauge so the player feels the
  // per-level speed step. Purely cosmetic — no gameplay effect.
  speedBumpTimer: number
  // Brief countdown (>0 for ~0.9s after the level-clearing TD lands) used
  // to flash a celebratory burst over the HUD progress bar at the moment
  // it fills to 100 %. Purely cosmetic — no gameplay effect.
  levelGoalFlash: number
  speed: number; playTime: number
  combo: number; multiplier: number; highScore: number
  // player
  playerX: number; playerLane: number; targetLane: number
  leanAngle: number
  spinning: boolean; spinTimer: number; spinRotation: number
  boosting: boolean; boostTimer: number
  // Wall-clock timestamp (performance.now ms) when the player was tackled.
  // Drives a brief white hit-flash overlay on the player sprite that mirrors
  // the defender's hit-flash. 0 = inactive.
  playerHitFlashStart: number
  // Stored hydration-bottle power-ups. A power-up is required to activate
  // any of the three moves (Jump / Spin / Turbo) and is consumed only when
  // the move successfully counters a defender.
  powerUps: number
  // True if a defender was "under" the player during this jump window —
  // used to defer power-up deduction until the jump ends.
  jumpHitThisJump: boolean
  // True once turbo has consumed a power-up in the current activation so
  // only 1 deduction fires per boost, even on multi-defender contact.
  turboHitThisActivation: boolean
  // True once spin has consumed a power-up in the current activation so
  // only 1 deduction fires per spin, even if defenders enter the radius
  // across multiple update ticks.
  spinHitThisActivation: boolean
  // Brief pulse timer (>0 for a moment after picking up a bottle) used to
  // play a grow-in animation on the inventory chip. No mechanical effect.
  hydrationTimer: number
  // ── Leaderboard / NEW HIGH SCORE state ────────────────────────────────
  // Snapshot of the top-10 boards taken at the start of this run so the
  // game-over panel and in-run threshold animations stay stable even if
  // the player saves a new entry afterwards.
  lbSnapshot:   LeaderboardEntry[]   // points board (sorted by score)
  tdSnapshot:   LeaderboardEntry[]   // touchdowns board (sorted by TDs)
  // Remaining ascending-by-score thresholds that haven't been crossed yet
  // this run; popped from the front as g.score grows past each entry's
  // score. When popped we trigger a "NEW HIGH SCORE!" animation.
  lbThresholds: ThresholdMarker[]
  // Animation timer for the in-run "passed someone!" banner. Counts down.
  nhsAnim: number
  // Best rank achieved so far this run (1..10) — used by both the in-run
  // banner and the game-over panel. 0 means no thresholds passed yet.
  nhsRank: number
  // Initials of the entry just passed (for the "PASSED XYZ" subtitle).
  nhsKnocked: string
  // Same idea as lbThresholds/nhsAnim, but for the TOUCHDOWNS board: pops
  // a "🏈 TD RECORD!" banner each time the player's run TD total breaks
  // past a top-10 TD entry. Independent of the points-based banner so the
  // two can fire simultaneously without clobbering each other.
  tdThresholds: TdThresholdMarker[]
  tdNhsAnim:    number
  tdNhsRank:    number
  tdNhsKnocked: string
  // Game-over initials-entry flow. `entryActive` is true on the gameover
  // screen when the run's score qualifies for the top 10 and we haven't
  // submitted yet. `entryInitials` is the live 0..3-char string typed in
  // by the player, mirrored from React state into gsRef so the canvas can
  // render the slots in the leaderboard list. `entrySubmitted` flips true
  // once the player confirms, unlocking "press any key to play again".
  // `entryRank` is the rank the entry will land at on the POINTS board (1..10).
  // `tdEntryRank` is the rank on the TOUCHDOWNS board (0 if doesn't qualify).
  entryActive: boolean
  entryInitials: string
  entrySubmitted: boolean
  entryRank: number
  tdEntryRank: number
  runCycle: number
  // Smoothed run-cycle frequency (cycles/sec). Lerps toward the
  // speed-derived target so jog→sprint transitions across level steps
  // ramp organically instead of snapping. See run-cycle block in tick().
  runFreqSmoothed: number
  // sprite animation
  spriteState: PlayerSpriteState
  spriteOneShotElapsed: number
  catchTimer: number       // > 0 while a "catch" one-shot is playing
  stumbleTimer: number     // > 0 while a near-miss stumble plays
  jumpTimer: number        // > 0 while in the air after a JUMP (also grants invuln)
  // world
  worldOffset: number
  tdTimer: number     // touchdown celebration countdown (counts down from TD_DUR)
  tdBurstIn: number   // timer until next confetti burst around player during TD
  // Set of HBCU defender variants the player has encountered this run
  // (added on dodge or tackle). Surfaced on the gameover overlay as a
  // small "SCHOOLS FACED" roster so the per-defender variant assignment
  // is meaningful to the player.
  schoolsSeen: Set<DefenderVariant>
  // spawn
  nextDefIn: number; nextColIn: number
  // pools
  defs: Defender[]; cols: Collectible[]
  particles: Particle[]; floatTexts: FloatText[]
  // effects
  shakeAmp: number; shakeDur: number; shakeX: number; shakeY: number
  screenFlash: number; screenFlashColor: string
  // input
  keys: {
    left: boolean; right: boolean; up: boolean; down: boolean
    spin: boolean; turbo: boolean
  }
}

// ─── Init ──────────────────────────────────────────────────────────────────
function mkDefender(): Defender {
  return { active:false, x:0, screenY:0, type:'safety', pattern:'straight',
           speed:0, vx:0, dodged:false, runCycle:0, flashTimer:0,
           variant:'grambling', tackling:false, tackleElapsed:0,
           hitFlashStart:0 }
}
function mkCollectible(): Collectible {
  return { active:false, collected:false, x:0, screenY:0, type:'coin', bobPhase:0 }
}
function mkParticle(): Particle {
  return { x:0,y:0,vx:0,vy:0,color:'#fff',size:4,life:0,maxLife:1,shape:'circle',rot:0,rotV:0 }
}
function mkFloatText(): FloatText {
  return { x:0,y:0,text:'',color:'#fff',size:24,life:0,maxLife:1 }
}

function initState(hs = 0): GS {
  const { points: lbSnapshot, tds: tdSnapshot } = loadBoards()
  const startLevel = 1
  return {
    phase: 'menu', score: 0, yards: 0, touchdowns: 0,
    level: startLevel,
    levelTouchdowns: 0,
    opponent: getOpponent(startLevel),
    versusTimer: 0,
    levelWinTimer: 0,
    levelStartScore: 0,
    levelBests: loadLevelBests(),
    levelWinScore: 0,
    levelWinBest: 0,
    levelWinIsNewBest: false,
    speedBumpTimer: 0,
    levelGoalFlash: 0,
    speed: BASE_SCROLL, playTime: 0,
    combo: 0, multiplier: 1, highScore: hs,
    playerX: LANE_XS[2], playerLane: 2, targetLane: 2,
    leanAngle: 0,
    spinning: false, spinTimer: 0, spinRotation: 0,
    boosting: false, boostTimer: 0,
    playerHitFlashStart: 0,
    powerUps: 0, jumpHitThisJump: false, turboHitThisActivation: false, spinHitThisActivation: false,
    hydrationTimer: 0,
    lbSnapshot,
    tdSnapshot,
    lbThresholds: buildThresholds(lbSnapshot),
    nhsAnim: 0, nhsRank: 0, nhsKnocked: '',
    tdThresholds: buildTdThresholds(tdSnapshot),
    tdNhsAnim: 0, tdNhsRank: 0, tdNhsKnocked: '',
    entryActive: false, entryInitials: '', entrySubmitted: false, entryRank: 0, tdEntryRank: 0,
    runCycle: 0,
    // Initialised to the jog cadence (RUN_FREQ_MIN) so the very first
    // frame doesn't lerp up from 0.
    runFreqSmoothed: 4,
    spriteState: 'idle', spriteOneShotElapsed: 0,
    catchTimer: 0, stumbleTimer: 0,
    jumpTimer: 0,
    worldOffset: 0, tdTimer: 0, tdBurstIn: 0,
    schoolsSeen: new Set<DefenderVariant>(),
    nextDefIn: 3.5, nextColIn: 1.0,
    defs: Array.from({ length: MAX_DEF }, mkDefender),
    cols: Array.from({ length: MAX_COL }, mkCollectible),
    particles: Array.from({ length: MAX_PAR }, mkParticle),
    floatTexts: Array.from({ length: MAX_FTX }, mkFloatText),
    shakeAmp: 0, shakeDur: 0, shakeX: 0, shakeY: 0,
    screenFlash: 0, screenFlashColor: '#fff',
    keys: { left:false, right:false, up:false, down:false, spin:false, turbo:false },
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function rng(min: number, max: number) { return min + Math.random() * (max - min) }
function rngInt(min: number, max: number) { return Math.floor(rng(min, max + 1)) }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }

function addParticle(g: GS, cfg: Partial<Particle> & { x:number; y:number; color:string }) {
  const slot = g.particles.find(p => p.life <= 0)
  if (!slot) return
  Object.assign(slot, { vx:0, vy:0, size:5, life:0.6, maxLife:0.6, shape:'circle', rot:0, rotV:0 }, cfg)
}

function addFloat(g: GS, x: number, y: number, text: string, color: string, size = 28) {
  const slot = g.floatTexts.find(f => f.life <= 0)
  if (!slot) return
  slot.x = x; slot.y = y; slot.text = text; slot.color = color
  slot.size = size; slot.life = slot.maxLife = 1.0
}

function burst(g: GS, x: number, y: number, color: string, n: number, speed = 180) {
  for (let i = 0; i < n; i++) {
    const a = rng(0, Math.PI * 2)
    const s = rng(speed * 0.4, speed)
    addParticle(g, { x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s, color,
                     size: rng(4,9), life: rng(0.4,0.9), maxLife:0.9,
                     shape: Math.random() > 0.5 ? 'rect' : 'circle',
                     rot: rng(0,Math.PI*2), rotV: rng(-6,6) })
  }
}

// Touchdown-flavoured burst: longer-lived confetti/star particles with an
// upward bias so they arc above the celebrating player before falling.
function tdStarBurst(g: GS, x: number, y: number, n: number) {
  const colors = [C_GOLD, '#fff7aa', '#ffe066', C_WHITE, '#ff9adb', '#7B2FBE']
  for (let i = 0; i < n; i++) {
    const a = rng(-Math.PI, 0) * (Math.random() < 0.7 ? 1 : -1)
    const s = rng(140, 320)
    addParticle(g, {
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s - rng(40, 120),
      color: colors[Math.floor(Math.random() * colors.length)],
      size: rng(5, 11),
      life: rng(0.8, 1.4), maxLife: 1.4,
      shape: Math.random() > 0.4 ? 'rect' : 'circle',
      rot: rng(0, Math.PI * 2), rotV: rng(-7, 7),
    })
  }
}

function shake(g: GS, amp: number, dur: number) {
  g.shakeAmp = amp; g.shakeDur = dur
}

// ─── Spawn ──────────────────────────────────────────────────────────────────
const DEF_PATTERNS: DefPattern[] = ['straight', 'track', 'diagonal_l', 'diagonal_r']

function spawnDefender(g: GS) {
  const slot = g.defs.find(d => !d.active)
  if (!slot) return
  const types: DefType[] = ['safety','linebacker','corner']
  const tIdx = Math.random() < 0.5 ? 0 : Math.random() < 0.6 ? 2 : 1
  const type = types[tIdx]
  const lane = rngInt(0, NLANES - 1)
  const patternPool: DefPattern[] = g.touchdowns >= 2
    ? DEF_PATTERNS
    : ['straight', 'track']
  const pattern = patternPool[Math.floor(Math.random() * patternPool.length)]
  const speedMult = type === 'linebacker' ? 0.72 : type === 'corner' ? 1.15 : 1.0
  // Key off current level (0-indexed) so defender speed steps up only
  // when a new level begins, not continuously with every touchdown.
  const lvl = g.level - 1

  slot.active  = true
  slot.x       = LANE_XS[lane]
  slot.screenY = DEF_SPAWN_SCREEN_Y
  slot.type    = type
  slot.pattern = pattern
  slot.speed   = (DEF_BASE_SPD + lvl * DEF_LVL_SPD) * speedMult
  slot.vx      = pattern === 'diagonal_l' ? -rng(60,130) : pattern === 'diagonal_r' ? rng(60,130) : 0
  slot.dodged  = false
  slot.runCycle = Math.random()
  slot.flashTimer = 0
  // Lock every defender on the field to the current level's opponent
  // school so the matchup reads visually as a single rivalry. The
  // shared `pickDefenderVariant()` cycler is unused now that levels
  // dictate the variant directly.
  slot.variant = g.opponent
  slot.tackling = false
  slot.tackleElapsed = 0
  slot.hitFlashStart = 0
}

function spawnCollectible(g: GS) {
  const slot = g.cols.find(c => !c.active)
  if (!slot) return
  const r = Math.random()
  const type: ColType = r < 0.12 ? 'star' : r < 0.32 ? 'football' : 'coin'
  const screenY = DEF_SPAWN_SCREEN_Y + rng(-80, 80)

  // Snap to one of the 5 lanes. Prefer a lane that isn't already occupied by
  // a defender at a similar y, so players don't have to take a hit to grab
  // the pickup. If every lane has a defender nearby, fall back to any lane.
  const Y_OVERLAP = 120          // px window that counts as "same row"
  const LANE_BAND = 60           // x distance to count a defender as in-lane
  const free: number[] = []
  for (let i = 0; i < NLANES; i++) {
    const laneX = LANE_XS[i]
    let occupied = false
    for (const d of g.defs) {
      if (!d.active) continue
      if (Math.abs(d.x - laneX) < LANE_BAND &&
          Math.abs(d.screenY - screenY) < Y_OVERLAP) {
        occupied = true
        break
      }
    }
    if (!occupied) {
      for (const c of g.cols) {
        if (!c.active || c === slot) continue
        if (Math.abs(c.x - laneX) < LANE_BAND &&
            Math.abs(c.screenY - screenY) < Y_OVERLAP) {
          occupied = true
          break
        }
      }
    }
    if (!occupied) free.push(i)
  }
  const pool = free.length > 0
    ? free
    : Array.from({ length: NLANES }, (_, i) => i)
  const lane = pool[Math.floor(Math.random() * pool.length)]

  slot.active    = true
  slot.collected = false
  slot.x         = LANE_XS[lane]
  slot.screenY   = screenY
  slot.type      = type
  slot.bobPhase  = rng(0, Math.PI * 2)
}

// ─── Input (edge) ───────────────────────────────────────────────────────────
let prevKeys = { left:false, right:false, up:false, down:false, spin:false, turbo:false }

// Per-source held state. Each input device writes into its own object,
// then `mergeHeld` ORs them into `g.keys` so multiple sources (keyboard
// + gamepad, etc.) can drive the player in the same session without
// clobbering each other. Touch swipes / touch buttons mutate game state
// directly (lane / action timers) and don't participate in `g.keys`, so
// they don't need their own slot here.
const kbHeld = { left:false, right:false, up:false, down:false, spin:false, turbo:false }
const gpHeld = { left:false, right:false, up:false, down:false, spin:false, turbo:false }

// Tracks whether a gamepad is currently connected. Mirrored from the
// gamepad useEffect's poll loop so the canvas-level menu / game-over
// overlays can decide whether to surface the controller-bindings panel.
let GAMEPAD_CONNECTED = false

// Index of the currently active controller (the one driving the player).
// Mirrored from the gamepad polling effect so module-level helpers like
// `triggerRumble` can locate the same pad without re-running discovery.
let ACTIVE_GAMEPAD_INDEX: number | null = null

// Fire a haptic rumble on the active controller, if it supports
// `vibrationActuator` (Chromium-family browsers + most modern pads).
// Silently no-ops when no controller is connected, the controller has
// no actuator, or the call throws — keyboard / touch players see no
// effect and never an error. Also bails while paused so a delayed
// effect can't fire after the player taps pause.
function triggerRumble(g: GS, duration: number, strong: number, weak: number) {
  if (g.phase === 'paused') return
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return
  try {
    const pads = navigator.getGamepads()
    if (!pads) return
    const pad = (ACTIVE_GAMEPAD_INDEX !== null ? pads[ACTIVE_GAMEPAD_INDEX] : null)
      ?? pads.find(p => p && p.connected) ?? null
    if (!pad) return
    // `vibrationActuator` is non-standard but widely supported. Cast
    // through `unknown` to avoid lib.dom.d.ts churn across TS versions.
    const actuator = (pad as unknown as {
      vibrationActuator?: {
        playEffect?: (
          type: string,
          opts: { duration: number; strongMagnitude: number; weakMagnitude: number; startDelay?: number },
        ) => Promise<unknown>
      }
    }).vibrationActuator
    if (!actuator || typeof actuator.playEffect !== 'function') return
    const p = actuator.playEffect('dual-rumble', {
      duration,
      strongMagnitude: strong,
      weakMagnitude: weak,
      startDelay: 0,
    })
    if (p && typeof (p as Promise<unknown>).catch === 'function') {
      (p as Promise<unknown>).catch(() => { /* ignore */ })
    }
  } catch {
    /* swallow — haptics are a nice-to-have */
  }
}
// Fire a short tactile pulse via the Vibration API (mobile devices).
// Mirrors the gamepad `triggerRumble` for phones: pairs with audio cues
// like near-miss and combo dings so they still feel tangible when the
// player has sound muted. Only runs in mobile mode to avoid spurious
// desktop calls (some Chrome builds expose `navigator.vibrate` on
// desktop but no-op or warn). Wrapped in try/catch because the spec
// allows the UA to throw or return false at any time.
function triggerVibration(pattern: number | number[]) {
  if (CURRENT_MODE !== 'mobile') return
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate(pattern)
  } catch {
    /* swallow — haptics are a nice-to-have */
  }
}
function mergeHeld(g: GS) {
  const k = g.keys
  k.left  = kbHeld.left  || gpHeld.left
  k.right = kbHeld.right || gpHeld.right
  k.up    = kbHeld.up    || gpHeld.up
  k.spin  = kbHeld.spin  || gpHeld.spin
  k.turbo = kbHeld.turbo || gpHeld.turbo
}
function clearAllHeld(g: GS) {
  kbHeld.left = kbHeld.right = kbHeld.up = false
  kbHeld.spin = kbHeld.turbo = false
  gpHeld.left = gpHeld.right = gpHeld.up = false
  gpHeld.spin = gpHeld.turbo = false
  mergeHeld(g)
}

// ─── Update ────────────────────────────────────────────────────────────────
function update(g: GS, dt: number) {
  const cdt = Math.min(dt, 0.05)

  // Sprite-state machine runs every frame regardless of phase, so menu
  // idles, touchdown celebrations, and game-over stumbles all
  // animate correctly.
  updateSpriteState(g, cdt)

  // Decay shake + screen flash every frame regardless of phase. Touchdown
  // re-triggers shake mid-celebration, and the game-over screen flash
  // also needs to fade — both depend on this running during their phases,
  // not only when 'playing'.
  if (g.shakeDur > 0) {
    g.shakeDur  -= cdt
    const a      = g.shakeAmp * (g.shakeDur > 0 ? 1 : 0)
    g.shakeX     = rng(-a, a)
    g.shakeY     = rng(-a, a)
  } else { g.shakeX = 0; g.shakeY = 0 }
  if (g.screenFlash > 0) g.screenFlash -= cdt * 2.5
  if (g.speedBumpTimer > 0) g.speedBumpTimer = Math.max(0, g.speedBumpTimer - cdt)
  if (g.levelGoalFlash > 0) g.levelGoalFlash = Math.max(0, g.levelGoalFlash - cdt)

  if (g.phase === 'touchdown') {
    const prevTimer = g.tdTimer
    g.tdTimer -= cdt
    const elapsed     = TD_DUR - g.tdTimer
    const prevElapsed = TD_DUR - prevTimer

    // Freeze field scrolling for the first ~1.5s so the celebration sprite
    // (and the score popup) can breathe, then ease the field back into a
    // slow drift so the cut to 'playing' isn't a jarring jolt.
    if (elapsed >= TD_FREEZE_DUR) {
      const t = clamp(
        (elapsed - TD_FREEZE_DUR) / Math.max(0.01, TD_DUR - TD_FREEZE_DUR),
        0, 1,
      )
      g.worldOffset += BASE_SCROLL * 0.35 * t * cdt
    }

    // Follow-up shakes: a softer secondary thump while the celebration plays
    // so the camera keeps a rhythm rather than going dead still after the
    // initial trigger shake decays.
    if (prevElapsed < 0.45 && elapsed >= 0.45) shake(g, 7, 0.22)
    if (prevElapsed < 0.95 && elapsed >= 0.95) shake(g, 4, 0.18)

    // Confetti drifting in from above the field — kept from the original
    // celebration so the whole field feels alive, not just the player.
    if (Math.random() < 0.7) {
      const colors = [C_GOLD, C_WHITE, C_PURPLE, '#ff4444', '#44ff88', '#ffe066']
      addParticle(g, {
        x: rng(FL, FR), y: rng(60, 380),
        vx: rng(-70, 70), vy: rng(80, 260),
        color: colors[Math.floor(Math.random() * colors.length)],
        size: rng(6, 14), life: rng(0.9, 2.1), maxLife: 2.1,
        shape: 'rect', rot: rng(0, Math.PI*2), rotV: rng(-4, 4),
      })
    }

    // Periodic confetti / star bursts centered on the player — only during
    // the freeze window so the celebration feels concentrated around the
    // sprite, then fades as the field starts moving again.
    g.tdBurstIn -= cdt
    if (g.tdBurstIn <= 0 && elapsed < TD_FREEZE_DUR) {
      g.tdBurstIn = TD_BURST_PERIOD
      tdStarBurst(g, g.playerX, PLAYER_Y - 10, 14)
    }

    updateParticles(g, cdt)
    updateFloatTexts(g, cdt)
    if (g.tdTimer <= 0) {
      // Remove all active defenders/collectibles after touchdown so the
      // field is clean before either resuming play or rolling into the
      // ALCORN-WINS beat that gates the next level.
      for (const d of g.defs) d.active = false
      for (const c of g.cols) c.active = false
      if (g.levelTouchdowns >= LEVEL_TD_GOAL) {
        // Level cleared — kick off the level-win celebration. Same
        // visual energy as a touchdown (gold burst + shake + confetti
        // + score-popup typography) but with an ALCORN-WINS! headline.
        //
        // Snapshot the per-level point total (score gained since the
        // level began) and check it against the persisted best for
        // this level. If the player beat the previous best, update
        // the in-memory map + localStorage and flag the overlay so
        // it can show a "NEW BEST!" badge.
        const earned   = Math.max(0, g.score - g.levelStartScore)
        const prevBest = g.levelBests[g.level] ?? 0
        const isNew    = earned > prevBest
        if (isNew) {
          g.levelBests = { ...g.levelBests, [g.level]: earned }
          saveLevelBests(g.levelBests)
        }
        g.levelWinScore     = earned
        g.levelWinBest      = isNew ? earned : prevBest
        g.levelWinIsNewBest = isNew
        g.phase = 'levelwin'
        g.levelWinTimer = LEVEL_WIN_DUR
        g.tdBurstIn = 0
        shake(g, 16, 0.5)
        g.screenFlash = 0.7
        g.screenFlashColor = 'rgba(255,215,0,0.45)'
        burst(g, g.playerX, PLAYER_Y, C_GOLD, 36, 320)
        burst(g, g.playerX, PLAYER_Y, C_WHITE, 18, 220)
        tdStarBurst(g, g.playerX, PLAYER_Y - 20, 28)
        addFloat(g, GW/2, GH/2 + 40, `LEVEL ${g.level} CLEARED!`, C_WHITE, 44)
        triggerRumble(g, 500, 0.85, 0.95)
        audioManager.playLevelWin()
      } else {
        g.phase = 'playing'
      }
    }
    return
  }

  if (g.phase === 'levelwin') {
    // Mirror the touchdown freeze + ease-back camera + periodic confetti
    // so the level-win beat reads as a victory celebration of comparable
    // length / energy. Once the timer expires, advance to the next
    // opponent and re-enter the LEVEL N versus card.
    const prevTimer = g.levelWinTimer
    g.levelWinTimer -= cdt
    const elapsed     = LEVEL_WIN_DUR - g.levelWinTimer
    const prevElapsed = LEVEL_WIN_DUR - prevTimer

    if (elapsed >= TD_FREEZE_DUR) {
      const t = clamp(
        (elapsed - TD_FREEZE_DUR) / Math.max(0.01, LEVEL_WIN_DUR - TD_FREEZE_DUR),
        0, 1,
      )
      g.worldOffset += BASE_SCROLL * 0.35 * t * cdt
    }
    if (prevElapsed < 0.45 && elapsed >= 0.45) shake(g, 7, 0.22)
    if (prevElapsed < 0.95 && elapsed >= 0.95) shake(g, 4, 0.18)

    if (Math.random() < 0.7) {
      const colors = [C_GOLD, C_WHITE, C_PURPLE, '#ff4444', '#44ff88', '#ffe066']
      addParticle(g, {
        x: rng(FL, FR), y: rng(60, 380),
        vx: rng(-70, 70), vy: rng(80, 260),
        color: colors[Math.floor(Math.random() * colors.length)],
        size: rng(6, 14), life: rng(0.9, 2.1), maxLife: 2.1,
        shape: 'rect', rot: rng(0, Math.PI*2), rotV: rng(-4, 4),
      })
    }

    g.tdBurstIn -= cdt
    if (g.tdBurstIn <= 0 && elapsed < TD_FREEZE_DUR) {
      g.tdBurstIn = TD_BURST_PERIOD
      tdStarBurst(g, g.playerX, PLAYER_Y - 10, 14)
    }

    updateParticles(g, cdt)
    updateFloatTexts(g, cdt)
    if (g.levelWinTimer <= 0) {
      // Roll the rotation forward (loops once we hit the end of the
      // opponent list) and re-enter the versus intro phase.
      g.level += 1
      g.levelTouchdowns = 0
      // Re-baseline the per-level scoring window: any points earned
      // from here until the next levelwin count toward the *new* level.
      g.levelStartScore = g.score
      g.opponent = getOpponent(g.level)
      g.phase = 'versus'
      g.versusTimer = VERSUS_DUR
      // Trigger a brief "SPEED UP!" flash + MPH-gauge pulse so the per-level
      // speed step (BASE_SCROLL + level*SCROLL_STEP) reads as intentional.
      // Cap at MAX_SCROLL — no point flashing if we're already maxed out.
      const prevSpd = Math.min(BASE_SCROLL + (g.level - 2) * SCROLL_STEP, MAX_SCROLL)
      const newSpd  = Math.min(BASE_SCROLL + (g.level - 1) * SCROLL_STEP, MAX_SCROLL)
      if (newSpd > prevSpd + 0.5) {
        g.speedBumpTimer = 1.0
        // Snap g.speed forward now (gameplay only re-derives this in
        // 'playing'), so the pulsing MPH gauge reads the *new* value
        // throughout the versus card, not the previous level's speed.
        g.speed = newSpd
        addFloat(g, GW / 2, GH / 2 - 20, 'SPEED UP!', '#ffcc00', 40)
        audioManager.playSpeedBump()
      }
    }
    return
  }

  if (g.phase === 'versus') {
    // Hold scrolling and gameplay in place while the LEVEL N intro
    // card animates. Particles + float texts still update so any
    // residual celebration confetti drifts off naturally.
    const prevVT = g.versusTimer
    g.versusTimer -= cdt

    // Countdown beeps during the versus intro card (versusTimer counts
    // down from VERSUS_DUR = 2.4 s). Three beeps at ~0.4, ~1.1, ~1.8 s
    // elapsed, with the final beep at a higher pitch to signal "GO!".
    if (prevVT > 2.0 && g.versusTimer <= 2.0) audioManager.playCountdownBeep(1)
    if (prevVT > 1.3 && g.versusTimer <= 1.3) audioManager.playCountdownBeep(2)
    if (prevVT > 0.6 && g.versusTimer <= 0.6) audioManager.playCountdownBeep(3)

    updateParticles(g, cdt)
    updateFloatTexts(g, cdt)
    if (g.versusTimer <= 0) {
      g.phase = 'playing'
      // Reset spawn timers so the new level eases in instead of
      // dumping a queued defender on top of the player at t=0.
      g.nextDefIn = Math.max(g.nextDefIn, 1.6)
      g.nextColIn = Math.max(g.nextColIn, 0.6)
      // Kickoff whistle fires the moment play begins.
      audioManager.playWhistle()
      // Reset milestone tracker so yard-line chimes start fresh each run.
      _sfxLastMilestoneGrp = Math.floor(g.yards / 25)
    }
    return
  }

  if (g.phase !== 'playing') return

  // ── Time + speed ──────────────────────────────────────────────────────
  g.playTime  += cdt
  const boost  = g.boosting ? 1.55 : 1.0
  // Speed is constant within a level and steps up only when the level
  // advances (g.level increments in the levelwin handler). Turbo boost
  // multiplies on top of this fixed per-level base.
  g.speed      = Math.min(BASE_SCROLL + (g.level - 1) * SCROLL_STEP, MAX_SCROLL) * boost
  g.worldOffset += g.speed * cdt
  g.yards      = g.worldOffset / PIXELS_PER_YARD     // virtual yards

  // ── Run cycle ──────────────────────────────────────────────────────────
  // Cadence ramps with speed across three distinct phases: jog at low
  // speeds, a mid-speed stride, and a noticeably sharper sprint cadence
  // near top speed. The curve is gentle in the jog→mid range (a real
  // runner doesn't visibly thrash their legs much faster as they pick up
  // pace) and steepens in the mid→sprint range where stride frequency
  // really jumps. Boost layers an extra bump on top without making slow
  // levels look frantic.
  const baseSpeed       = Math.min(BASE_SCROLL + (g.level - 1) * SCROLL_STEP, MAX_SCROLL)
  const speedFactor     = Math.max(0, Math.min(1, (baseSpeed - BASE_SCROLL) / (MAX_SCROLL - BASE_SCROLL)))
  const targetRunFreq   = runCadenceForSpeedFactor(speedFactor) + (g.boosting ? 2.4 : 0)
  // Exponential smoothing toward the target cadence. Rate 6 ⇒ ~95% of
  // the way there in ~0.5 s, so the level-up speed step eases in as a
  // gradual jog→sprint instead of snapping. Frame-rate independent via
  // the (1 - exp(-cdt*rate)) form.
  const RUN_FREQ_LERP_RATE = 6
  g.runFreqSmoothed += (targetRunFreq - g.runFreqSmoothed) * (1 - Math.exp(-cdt * RUN_FREQ_LERP_RATE))
  g.runCycle = (g.runCycle + cdt * g.runFreqSmoothed) % 1

  // ── Edge-triggered input ───────────────────────────────────────────────
  const jL  = g.keys.left  && !prevKeys.left
  const jR  = g.keys.right && !prevKeys.right
  const jU  = g.keys.up    && !prevKeys.up      // JUMP
  const jSp = g.keys.spin  && !prevKeys.spin    // SPIN dodge (X / Shift)
  const jTu = g.keys.turbo && !prevKeys.turbo   // TURBO burst (C)
  prevKeys = { ...g.keys }

  if (jL && g.targetLane > 0) g.targetLane--
  if (jR && g.targetLane < NLANES - 1) g.targetLane++

  // Jump — brief invulnerable hop (clears low defenders). Requires at
  // least 1 power-up. Power-up is deducted only if a defender was under
  // the player during the hop (deduction happens when jump ends).
  if (jU && g.jumpTimer <= 0 && !g.spinning) {
    if (g.powerUps > 0) {
      g.jumpTimer = JUMP_DUR
      g.jumpHitThisJump = false
      burst(g, g.playerX, PLAYER_Y + 22, '#cccccc', 8, 120)
      burst(g, g.playerX, PLAYER_Y + 22, C_WHITE, 4, 80)
    } else {
      // Empty cue — no power-ups available
      g.screenFlash = Math.max(g.screenFlash, 0.12)
      g.screenFlashColor = 'rgba(255,80,80,0.25)'
      addFloat(g, g.playerX, PLAYER_Y - 50, 'NEED POWER-UP!', '#ff6666', 22)
    }
  }

  // Spin move (X / Shift). Requires at least 1 power-up. Power-up is
  // deducted only if at least one defender is cleared by the spin.
  if (jSp && !g.spinning && g.jumpTimer <= 0) {
    if (g.powerUps > 0) {
      g.spinning = true; g.spinTimer = 0; g.spinRotation = 0
      burst(g, g.playerX, PLAYER_Y, C_GOLD, 16, 220)
      burst(g, g.playerX, PLAYER_Y, C_WHITE, 8, 160)
      g.screenFlash = 0.18
      g.screenFlashColor = 'rgba(255, 255, 255, 0.45)'
    } else {
      // Empty cue
      g.screenFlash = Math.max(g.screenFlash, 0.12)
      g.screenFlashColor = 'rgba(255,80,80,0.25)'
      addFloat(g, g.playerX, PLAYER_Y - 50, 'NEED POWER-UP!', '#ff6666', 22)
    }
  }

  // Turbo burst (C). Requires at least 1 power-up. Cannot activate while
  // jumping or spinning (move exclusivity). Power-up is deducted only on
  // the first defender contact during this boost activation.
  if (jTu && !g.boosting && g.jumpTimer <= 0 && !g.spinning) {
    if (g.powerUps > 0) {
      g.boosting = true
      g.boostTimer = BOOST_DUR
      g.turboHitThisActivation = false
      burst(g, g.playerX, PLAYER_Y + 20, C_GOLD, 12, 180)
      addFloat(g, g.playerX, PLAYER_Y - 60, 'TURBO!', C_GOLD, 32)
      audioManager.playBoost()
    } else {
      // Empty cue
      g.screenFlash = Math.max(g.screenFlash, 0.12)
      g.screenFlashColor = 'rgba(255,80,80,0.25)'
      addFloat(g, g.playerX, PLAYER_Y - 60, 'NEED POWER-UP!', '#ff6666', 22)
    }
  }

  // ── Timers ─────────────────────────────────────────────────────────────
  if (g.spinning) {
    g.spinTimer += cdt
    g.spinRotation = (g.spinTimer / SPIN_DUR) * Math.PI * 2
    if (g.spinTimer >= SPIN_DUR) {
      g.spinning = false; g.spinTimer = 0; g.spinRotation = 0; g.spinHitThisActivation = false
    }
  }

  if (g.boosting) {
    // Power-up expiring cue — fires the first frame boostTimer crosses below
    // 0.5 s. We save _sfxPrevBoostTimer BEFORE decrement so the comparison
    // is "last frame's pre-decrement value > 0.5, this frame's pre-decrement
    // value <= 0.5", which reliably triggers exactly once.
    if (_sfxPrevBoostTimer > 0.5 && g.boostTimer <= 0.5) {
      audioManager.playPowerUpExpiring()
    }
    _sfxPrevBoostTimer = g.boostTimer        // save pre-decrement for next frame
    g.boostTimer -= cdt
    if (g.boostTimer <= 0) {
      g.boosting = false; g.boostTimer = 0; g.turboHitThisActivation = false
    }
  } else {
    _sfxPrevBoostTimer = 0                   // reset so next boost start is clean
  }

  // ── Boost loop SFX edge detection ──────────────────────────────────────
  // Start the engine loop on the first frame boost becomes active; stop it
  // (with a whoosh) on the first frame it ends. Runs outside the boostTimer
  // block above so we catch the transition reliably even when cdt > boostTimer.
  if (g.boosting && !_sfxPrevBoostActive) {
    audioManager.startBoostLoop()
  } else if (!g.boosting && _sfxPrevBoostActive) {
    audioManager.stopBoostLoop()
    audioManager.playBoostEnd()
  }
  _sfxPrevBoostActive = g.boosting
  if (g.hydrationTimer > 0) {
    g.hydrationTimer = Math.max(0, g.hydrationTimer - cdt)
  }
  if (g.nhsAnim > 0) {
    g.nhsAnim = Math.max(0, g.nhsAnim - cdt)
  }
  if (g.tdNhsAnim > 0) {
    g.tdNhsAnim = Math.max(0, g.tdNhsAnim - cdt)
  }
  // Drain leaderboard thresholds while the live score has caught up to or
  // passed the next-cheapest entry on the snapshot. Each pop fires the
  // "NEW HIGH SCORE!" banner + a celebratory float so multiple crossings
  // in quick succession still feel rewarding.
  while (g.lbThresholds.length > 0 && g.score >= g.lbThresholds[0].score) {
    const t = g.lbThresholds.shift()!
    g.nhsAnim = NHS_ANIM_DUR
    g.nhsRank = t.rankAchieved
    g.nhsKnocked = t.initials
    addFloat(g, g.playerX, PLAYER_Y - 80, `RANK #${t.rankAchieved}!`, '#ffe066', 32)
    burst(g, g.playerX, PLAYER_Y - 30, '#ffe066', 14, 200)
    burst(g, g.playerX, PLAYER_Y - 30, C_GOLD, 8, 160)
    g.screenFlash = Math.max(g.screenFlash, 0.22)
    g.screenFlashColor = 'rgba(255, 215, 0, 0.42)'
  }

  // Jump deferred deduction. The jump timer itself decays in updateSpriteState
  // so the sprite plays through; here we handle the deferred power-up
  // deduction (if a defender was cleared during the hop).
  const jumpWasActive = g.jumpTimer > 0
  if (jumpWasActive && g.jumpTimer - cdt <= 0) {
    if (g.jumpHitThisJump) {
      g.powerUps = Math.max(0, g.powerUps - 1)
      g.jumpHitThisJump = false
    }
  }

  // ── Player X interpolation ─────────────────────────────────────────────
  const tgtX   = LANE_XS[g.targetLane]
  const dx     = tgtX - g.playerX
  const step   = LANE_CHG_SPD * cdt
  if (Math.abs(dx) <= step) {
    g.playerX    = tgtX
    g.playerLane = g.targetLane
  } else {
    g.playerX += Math.sign(dx) * step
  }

  // Lean
  const leanTarget = clamp(-dx / 180, -1, 1) * 0.32
  g.leanAngle += (leanTarget - g.leanAngle) * Math.min(1, cdt * 10)

  // Grass trail when boosting
  if (g.boosting && Math.random() < 0.5) {
    addParticle(g, {
      x: g.playerX + rng(-16, 16),
      y: PLAYER_Y + rng(20, 34),
      vx: rng(-30, 30), vy: rng(40, 130),
      color: '#6dbf3a', size: rng(3, 7), life: 0.4, maxLife: 0.4,
    })
  }

  // ── Spawn ──────────────────────────────────────────────────────────────
  g.nextDefIn -= cdt
  if (g.nextDefIn <= 0) {
    spawnDefender(g)
    // Two-phase tightening of defender cadence:
    //  • Pre-cap: shrink intervals as raw scroll speed climbs (1.0 → 0.5×).
    //  • Post-cap: each additional level past the scroll-speed cap shaves
    //    another 3% off the interval, floored at 0.32×, so high levels
    //    (18+) keep getting denser even though px/s is locked at MAX.
    const capLevel = Math.ceil((MAX_SCROLL - BASE_SCROLL) / SCROLL_STEP) + 1
    const preCap   = Math.min(1, (g.level - 1) / Math.max(1, capLevel - 1))
    const overflow = Math.max(0, g.level - capLevel)
    const sf = Math.max(0.32, 1 - preCap * 0.5 - overflow * 0.03)
    g.nextDefIn = rng(SPAWN_DEF_MIN, SPAWN_DEF_MAX) * sf
  }
  g.nextColIn -= cdt
  if (g.nextColIn <= 0) {
    spawnCollectible(g)
    g.nextColIn = SPAWN_COL_INT * rng(0.7, 1.3)
  }

  // ── Move defenders ─────────────────────────────────────────────────────
  // Defender run cadence mirrors the player's ramp: a calm jog at low
  // speeds and a full sprint at max speed. Each defender's effective
  // velocity (field scroll + their own charge speed) drives the cycle so
  // faster pursuers visibly churn their legs harder.
  for (const d of g.defs) {
    if (!d.active) continue
    // Tackling defenders freeze in place playing the one-shot tackle
    // animation; they don't keep charging or drifting in X.
    if (d.tackling) {
      d.tackleElapsed += cdt
      continue
    }
    const defSpeed = g.speed + d.speed
    const defSpeedFactor = Math.max(0, Math.min(1, (defSpeed - BASE_SCROLL) / (MAX_SCROLL - BASE_SCROLL)))
    const defRunFreq = runCadenceForSpeedFactor(defSpeedFactor)
    d.runCycle = (d.runCycle + cdt * defRunFreq) % 1
    // Defenders ride the field scroll AND charge with their own speed
    d.screenY += defSpeed * cdt

    if (d.pattern === 'track') {
      const trackDx = g.playerX - d.x
      d.x += Math.sign(trackDx) * Math.min(Math.abs(trackDx), DEF_TRACK_SPD * cdt)
    } else {
      d.x += d.vx * cdt
    }
    d.x = clamp(d.x, FL + 24, FR - 24)

    // Near-player flash
    if (d.screenY > PLAYER_Y - 200) {
      d.flashTimer += cdt * 5
    }

    if (d.screenY > GH + 80) d.active = false

    // Score dodge when passes player
    if (!d.dodged && d.screenY > PLAYER_Y + 80) {
      d.dodged   = true
      g.schoolsSeen.add(d.variant)
      const pts  = Math.round(50 * g.multiplier)
      g.score   += pts
      g.combo++
      if (g.combo % 3 === 0) {
        g.multiplier = Math.min(8, g.multiplier + 0.5)
        audioManager.playComboUp(g.multiplier)
        // Tiny tactile tick on the combo ding. Intensity scales with
        // multiplier (capped) by repeating short 15ms pulses so higher
        // combos feel snappier without ever being long enough to annoy.
        const ticks = Math.min(4, Math.max(1, Math.round(g.multiplier)))
        const comboPattern: number[] = []
        for (let i = 0; i < ticks; i++) {
          if (i > 0) comboPattern.push(20)
          comboPattern.push(15)
        }
        triggerVibration(comboPattern)
        addFloat(g, d.x, PLAYER_Y - 50, `x${g.multiplier.toFixed(1)} MULTIPLIER!`, C_GOLD, 26)
      } else {
        addFloat(g, d.x, PLAYER_Y - 30, `+${pts}`, C_WHITE, 24)
      }
    }
  }

  // ── Move collectibles ──────────────────────────────────────────────────
  for (const c of g.cols) {
    if (!c.active || c.collected) continue
    c.screenY += g.speed * cdt
    c.bobPhase += cdt * 3
    if (c.screenY > GH + 60) c.active = false
  }

  // ── Collision: defenders ───────────────────────────────────────────────
  // Jumping = invulnerable (player is in the air, defenders pass under).
  //   During the jump we track if any defender would have hit — for the
  //   deferred power-up deduction on landing.
  // Spinning = handled below (clears defenders, consumes 1 power-up).
  // Turbo (boosting) = plow-through on contact — handled below.
  if (!g.spinning && g.jumpTimer <= 0 && !g.boosting) {
    for (const d of g.defs) {
      if (!d.active || d.dodged) continue
      const ex = d.type === 'linebacker' ? HIT_R * 1.6 : HIT_R * 1.2
      const ey = d.type === 'linebacker' ? HIT_R * 1.6 : HIT_R * 1.1
      const dx2 = g.playerX - d.x
      const dy2 = PLAYER_Y - d.screenY
      // Near-miss → brief STUMBLE animation (defender close in front).
      if (
        !d.dodged &&
        d.screenY < PLAYER_Y &&
        d.screenY > PLAYER_Y - 90 &&
        Math.abs(dx2) < (ex + HIT_R) * 1.5 &&
        Math.abs(dx2) > (ex + HIT_R)   // not actually colliding
      ) {
        if (g.stumbleTimer === 0) {
          audioManager.playNearMiss()
          // Short 30ms buzz pairs with the audio cue so phone players
          // still feel near-misses even when muted.
          triggerVibration(30)
        }
        g.stumbleTimer = Math.max(g.stumbleTimer, 0.18)
      }
      if (Math.abs(dx2) < ex + HIT_R && Math.abs(dy2) < ey + HIT_R) {
        // TACKLED
        g.phase = 'gameover'
        g.schoolsSeen.add(d.variant)
        // Float the tackler's HBCU name above the collision point so the
        // player learns who just brought them down. Sized small enough for
        // the longer school names ("BETHUNE-COOKMAN") to fit on screen.
        addFloat(
          g, g.playerX, PLAYER_Y - 70,
          DEFENDER_DISPLAY_NAMES[d.variant],
          C_GOLD, 22,
        )
        if (g.score > g.highScore) g.highScore = g.score
        // If the run qualifies for EITHER top-10 board, open initials entry.
        // We use snapshots taken at the start of the run so a post-game save
        // can't change the qualification check mid-screen.
        // Ranks are provisional (computed against snapshots) and confirmed on submit.
        const qualPoints = qualifiesForBoard(g.score, g.lbSnapshot)
        // Pass score so tie-breaking by score is handled correctly.
        const qualTds    = qualifiesForTdBoard(g.touchdowns, g.tdSnapshot, g.score)
        if (qualPoints || qualTds) {
          g.entryActive = true
          g.entrySubmitted = false
          g.entryInitials = ''
          // Provisional points rank.
          if (qualPoints) {
            let provRank = g.lbSnapshot.length + 1
            for (let i = 0; i < g.lbSnapshot.length; i++) {
              if (g.score > g.lbSnapshot[i].score) { provRank = i + 1; break }
            }
            g.entryRank = Math.min(provRank, LEADERBOARD_MAX)
            // Final celebratory banner on the game-over screen.
            g.nhsAnim = NHS_ANIM_DUR
            g.nhsRank = g.entryRank
          } else {
            g.entryRank = 0
          }
          // Provisional TD rank — uses full comparator: TDs then score.
          if (qualTds) {
            let provTdRank = g.tdSnapshot.length + 1
            for (let i = 0; i < g.tdSnapshot.length; i++) {
              const snap = g.tdSnapshot[i]
              if (g.touchdowns > snap.touchdowns ||
                  (g.touchdowns === snap.touchdowns && g.score > snap.score)) {
                provTdRank = i + 1; break
              }
            }
            g.tdEntryRank = Math.min(provTdRank, LEADERBOARD_MAX)
          } else {
            g.tdEntryRank = 0
          }
        }
        shake(g, 22, 0.55)
        g.screenFlash = 0.5; g.screenFlashColor = 'rgba(200,0,0,0.55)'
        burst(g, g.playerX, PLAYER_Y, '#ff4444', 22, 260)
        burst(g, g.playerX, PLAYER_Y, C_GOLD, 10, 180)
        // Short, heavy rumble on the tackle.
        triggerRumble(g, 280, 1.0, 0.7)
        // 200ms long buzz on phones — separate from the gamepad rumble
        // above so a player on a touch device still gets a tactile
        // "you got tackled" jolt.
        triggerVibration(200)
        audioManager.playTackle()
        audioManager.playGameOver()
        // If the player had a combo multiplier built up, the tackle breaks it.
        if (g.multiplier > 1) audioManager.playComboBreak()
        // Stop the boost engine loop if it was running so it doesn't
        // bleed into the game-over screen. Also stop crowd noise.
        audioManager.stopBoostLoop()
        audioManager.stopCrowd()
        _sfxPrevBoostActive = false
        // Trigger the tackling defender's tackle animation. Snap it onto
        // the player's position so the 7-frame sequence reads as the
        // tackler driving the ball carrier down right where they met.
        d.tackling = true
        d.tackleElapsed = 0
        d.x = g.playerX
        d.screenY = PLAYER_Y
        // Brief white hit-flash on the defender sprite (~5 frames @ 60fps)
        // to sell the impact of contact. We stamp a wall-clock timestamp so
        // the flash duration is independent of the update loop — important
        // because the tackle transitions phase to 'gameover' which short-
        // circuits update(), and tackling defenders also skip per-defender
        // decay logic in the update loop.
        d.hitFlashStart = performance.now()
        // Mirror the defender's hit-flash on the player sprite so the
        // collision reads as a true two-body impact. Same wall-clock
        // approach: the gameover phase short-circuits update(), so a
        // timestamp-driven flash is independent of update ticks.
        g.playerHitFlashStart = performance.now()
        return
      }
    }
  } else if (g.jumpTimer > 0) {
    // During the jump window mark if a defender would have collided so we
    // can deduct a power-up on landing (jumpHitThisJump).
    for (const d of g.defs) {
      if (!d.active || d.dodged) continue
      const ex = d.type === 'linebacker' ? HIT_R * 1.6 : HIT_R * 1.2
      const ey = d.type === 'linebacker' ? HIT_R * 1.6 : HIT_R * 1.1
      const dx2 = g.playerX - d.x
      const dy2 = PLAYER_Y - d.screenY
      if (Math.abs(dx2) < ex + HIT_R && Math.abs(dy2) < ey + HIT_R) {
        g.jumpHitThisJump = true
        // Mark dodged so the defender doesn't trigger a tackle when the
        // jump ends and the hitbox returns to ground level.
        d.dodged = true
        const pts = Math.round(60 * g.multiplier)
        g.score += pts
        burst(g, d.x, d.screenY, '#cccccc', 10, 160)
        addFloat(g, d.x, d.screenY, `OVER! +${pts}`, C_WHITE, 24)
        g.schoolsSeen.add(d.variant)
        audioManager.playJumpOver()
        // Per-clear accent on the frame the defender passes under the
        // player. Throttled inside the manager so multi-defender jump
        // clears don't stack jarringly.
        audioManager.playJumpClear()
      }
    }
  } else if (g.boosting) {
    // Turbo plow-through — contact while boosting knocks out the defender,
    // scores, shows "TRUCK STICK!" and consumes 1 power-up (once per
    // activation via turboHitThisActivation).
    for (const d of g.defs) {
      if (!d.active || d.dodged) continue
      const ex = d.type === 'linebacker' ? HIT_R * 1.8 : HIT_R * 1.4
      const ey = d.type === 'linebacker' ? HIT_R * 1.8 : HIT_R * 1.4
      const dx2 = g.playerX - d.x
      const dy2 = PLAYER_Y - d.screenY
      if (Math.abs(dx2) < ex + HIT_R && Math.abs(dy2) < ey + HIT_R) {
        // Knock out the defender (mirrors spin-clear semantics).
        d.active = false
        d.dodged = true
        const pts = Math.round(120 * g.multiplier)
        g.score += pts
        burst(g, d.x, d.screenY, C_GOLD, 18, 240)
        burst(g, d.x, d.screenY, '#ff8800', 10, 180)
        addFloat(g, d.x, d.screenY - 30, 'TRUCK STICK!', '#ff8800', 32)
        addFloat(g, d.x, d.screenY + 20, `+${pts}`, C_GOLD, 24)
        shake(g, 10, 0.25)
        triggerRumble(g, 200, 0.75, 0.5)
        g.screenFlash = Math.max(g.screenFlash, 0.20)
        g.screenFlashColor = 'rgba(255, 140, 0, 0.35)'
        g.schoolsSeen.add(d.variant)
        // Consume exactly 1 power-up per boost activation (first contact).
        if (!g.turboHitThisActivation && g.powerUps > 0) {
          g.powerUps--
          g.turboHitThisActivation = true
        }
      }
    }
  } else if (g.spinning) {
    // Spin knocks out nearby defenders; deduct exactly 1 power-up once
    // per activation (first successful clear) via spinHitThisActivation.
    for (const d of g.defs) {
      if (!d.active) continue
      const dx2 = g.playerX - d.x
      const dy2 = PLAYER_Y - d.screenY
      if (Math.sqrt(dx2*dx2 + dy2*dy2) < SPIN_RADIUS) {
        d.active = false
        const pts = Math.round(80 * g.multiplier)
        g.score += pts
        burst(g, d.x, d.screenY, C_GOLD, 14, 200)
        burst(g, d.x, d.screenY, C_WHITE, 8, 150)
        addFloat(g, d.x, d.screenY, `SPIN! +${pts}`, C_GOLD, 28)
        triggerRumble(g, 140, 0.45, 0.65)
        audioManager.playSpin()
        // Per-clear accent on the frame this defender is swept by the
        // spin radius. Throttled inside the manager so simultaneous
        // multi-defender clears don't stack jarringly.
        audioManager.playSpinClear()
        // Deduct exactly 1 power-up for the whole spin (first clear only).
        if (!g.spinHitThisActivation && g.powerUps > 0) {
          g.powerUps--
          g.spinHitThisActivation = true
        }
      }
    }
  }

  // ── Collision: collectibles ────────────────────────────────────────────
  for (const c of g.cols) {
    if (!c.active || c.collected) continue
    const dx2 = g.playerX - c.x
    const dy2 = PLAYER_Y - c.screenY
    if (Math.abs(dx2) < 34 && Math.abs(dy2) < 34) {
      c.collected = true
      let pts = 0; let label = ''; let col = C_GOLD
      if (c.type === 'coin') {
        pts = Math.round(10 * g.multiplier); label = `+${pts}`; col = C_GOLD
        audioManager.playCoinPickup()
      } else if (c.type === 'football') {
        pts = Math.round(25 * g.multiplier); label = `TD CATCH! +${pts}`; col = '#ff9900'
        // Trigger one-shot CATCH animation
        g.catchTimer = getOneShotDuration('catch')
        audioManager.playCatch()
      } else {
        // Hydration bottle — STORED in inventory. Each of the three moves
        // requires a bottle to activate. Pickup gives a multiplier bump.
        pts = Math.round(50 * g.multiplier); label = `⭐ +${pts}`; col = '#ffe066'
        g.multiplier = Math.min(8, g.multiplier + 1)
        audioManager.playComboUp(g.multiplier)
        if (g.powerUps < POWER_UP_MAX) {
          g.powerUps++
          g.hydrationTimer = 0.9    // brief grow-in pulse on the inventory chip
          addFloat(g, c.x, c.screenY - 30, '+1 POWER UP', '#c266ff', 28)
          audioManager.playPowerUp()
        } else {
          // Inventory full — award a score bonus instead.
          const bonus = Math.round(200 * g.multiplier)
          g.score += bonus
          addFloat(g, c.x, c.screenY - 30, `BONUS +${bonus}`, '#ffe066', 28)
        }
      }
      g.score += pts
      burst(g, c.x, c.screenY, col, 12, 180)
      addFloat(g, c.x, c.screenY - 20, label, col)
    }
  }

  // ── Touchdown check (every 100 yards / PIXELS_PER_TD) ─────────────────
  const curTD = Math.floor(g.worldOffset / PIXELS_PER_TD)
  if (curTD > g.touchdowns) {
    g.touchdowns = curTD
    // Per-level counter — gates level completion. The lifetime
    // `g.touchdowns` keeps tracking the run total for leaderboard /
    // gameover stats; this counter resets to 0 each level.
    g.levelTouchdowns += 1
    if (g.levelTouchdowns >= LEVEL_TD_GOAL) {
      // Fire the HUD progress-bar fill flash at the moment it tops out.
      // Lingers ~0.9s — long enough to read against the levelwin overlay
      // that follows ~TD_DUR seconds later.
      g.levelGoalFlash = 0.9
    }
    const bonus = 500 * g.touchdowns
    g.score += bonus
    g.phase     = 'touchdown'
    g.tdTimer   = TD_DUR
    g.tdBurstIn = 0     // fire the first centered burst on the next update tick
    g.multiplier = Math.min(8, g.multiplier + 0.5)
    shake(g, 16, 0.5)
    g.screenFlash = 0.7; g.screenFlashColor = 'rgba(255,215,0,0.45)'
    // Big initial concentric blast: tight gold core, wider white ring,
    // plus a high-arc star burst so the celebration registers instantly.
    burst(g, g.playerX, PLAYER_Y, C_GOLD, 36, 320)
    burst(g, g.playerX, PLAYER_Y, C_WHITE, 18, 220)
    tdStarBurst(g, g.playerX, PLAYER_Y - 20, 28)
    addFloat(g, GW/2, GH/2 - 60, `TOUCHDOWN!`, C_GOLD, 96)
    addFloat(g, GW/2, GH/2 + 40, `+${bonus} PTS`, C_WHITE, 48)
    // Longer celebratory rumble at the start of the touchdown phase.
    triggerRumble(g, 500, 0.85, 0.95)
    audioManager.playTouchdown()
    // Drain TD thresholds: each entry the player's run TD count strictly
    // beats fires a "🏈 TD RECORD!" banner via tdNhsAnim. Mirrors the
    // points-board nhsAnim drain but keyed on touchdowns instead of score.
    while (g.tdThresholds.length > 0 && g.touchdowns > g.tdThresholds[0].touchdowns) {
      const t = g.tdThresholds.shift()!
      g.tdNhsAnim    = NHS_ANIM_DUR
      g.tdNhsRank    = t.rankAchieved
      g.tdNhsKnocked = t.initials
      addFloat(g, g.playerX, PLAYER_Y - 120, `TD RANK #${t.rankAchieved}!`, '#ffd28a', 32)
      burst(g, g.playerX, PLAYER_Y - 30, '#ffd28a', 12, 200)
    }
  }

  // ── Add score from running ─────────────────────────────────────────────
  // Divide by SCREEN_SCALE so score-per-second from raw running stays
  // comparable across desktop and mobile (mobile's px/s is scaled up; we
  // want score to track virtual yards/s, not raw pixels/s).
  g.score += Math.round(g.speed * cdt * 0.1 * g.multiplier / SCREEN_SCALE)

  // ── Effects ────────────────────────────────────────────────────────────
  // Shake / screen-flash decay was hoisted to run for every phase (above),
  // so the touchdown follow-up shakes animate correctly mid-celebration.

  // ── Yardage milestone chimes ────────────────────────────────────────────
  // Fire a short chime every 25 virtual yards (skipping the first 5 yards
  // so it doesn't fire at run-start, and skipping touchdown moments since
  // those already have a big audio event). Throttling inside playMilestoneChime
  // prevents overlaps from back-to-back milestone crossings.
  const curMilestoneGrp = Math.floor(g.yards / 25)
  if (curMilestoneGrp > _sfxLastMilestoneGrp && g.yards > 5 && g.phase !== 'touchdown') {
    audioManager.playMilestoneChime()
  }
  _sfxLastMilestoneGrp = curMilestoneGrp

  // ── Crowd intensity ─────────────────────────────────────────────────────
  // Drive excitement from the combo multiplier (0 at x1, full at x8) and
  // spike roar on touchdown / big-play screen-flash moments.
  if (audioManager.isContextRunning()) {
    const excitement = Math.max(0, (g.multiplier - 1) / 7)
    const roar = g.screenFlash > 0.6 ? g.screenFlash : 0
    audioManager.setCrowdIntensity(excitement, roar)
  }

  updateParticles(g, cdt)
  updateFloatTexts(g, cdt)
}

// ─── Sprite state machine ─────────────────────────────────────────────────
//
// Resolves the current player game state to a sprite animation state.
// One-shot states (jump, catch, stumble, dodge, celebration) latch
// for their full duration via per-state timers so the animation plays
// through cleanly even if the underlying input flips back.
//
// Mapping (game state → sprite state):
//   menu                       → idle
//   touchdown                  → celebration  (long one-shot)
//   gameover                   → stumble      (the tackle: player stumbles/falls)
//   spinning                   → dodge        (juke move)
//   catchTimer > 0             → catch        (after grabbing a football)
//   jumpTimer  > 0             → jump         (player jumped — invuln hop)
//   stumbleTimer > 0           → stumble      (near-miss recovery)
//   lane change in progress    → lane_left / lane_right
//   boosting                   → sprint       (turbo plow-through active)
//   default                    → run
function updateSpriteState(g: GS, dt: number) {
  // Decay one-shot timers
  if (g.catchTimer   > 0) g.catchTimer   = Math.max(0, g.catchTimer   - dt)
  if (g.stumbleTimer > 0) g.stumbleTimer = Math.max(0, g.stumbleTimer - dt)
  if (g.jumpTimer    > 0) g.jumpTimer    = Math.max(0, g.jumpTimer    - dt)

  let next: PlayerSpriteState
  if (g.phase === 'menu' || g.phase === 'paused' || g.phase === 'versus') {
    next = 'idle'
  } else if (g.phase === 'gameover') {
    // Tackle = stumble/fall. Hold the pose after the animation finishes.
    next = 'stumble'
  } else if (g.phase === 'touchdown' || g.phase === 'levelwin') {
    next = 'celebration'
  } else if (g.spinning) {
    next = 'dodge'
  } else if (g.catchTimer > 0) {
    next = 'catch'
  } else if (g.jumpTimer > 0) {
    next = 'jump'
  } else if (g.stumbleTimer > 0) {
    next = 'stumble'
  } else {
    // Lane change transient — show side-step sprite while in motion.
    const tgtX = LANE_XS[g.targetLane]
    const dx   = tgtX - g.playerX
    if (Math.abs(dx) > 6) {
      next = dx < 0 ? 'lane_left' : 'lane_right'
    } else if (g.boosting) {
      next = 'sprint'
    } else {
      next = 'run'
    }
  }

  if (next !== g.spriteState) {
    g.spriteState = next
    g.spriteOneShotElapsed = 0
  } else {
    g.spriteOneShotElapsed += dt
  }
}

function updateParticles(g: GS, dt: number) {
  for (const p of g.particles) {
    if (p.life <= 0) continue
    p.x  += p.vx * dt
    p.y  += p.vy * dt
    p.vy += 280 * dt  // gravity
    p.rot += p.rotV * dt
    p.life -= dt
  }
}

function updateFloatTexts(g: GS, dt: number) {
  for (const f of g.floatTexts) {
    if (f.life <= 0) continue
    f.y    -= 88 * dt
    f.life -= dt
  }
}

// ─── Drawing helpers ────────────────────────────────────────────────────────
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// ─── Background (sidelines + crowd) ─────────────────────────────────────────
// Fan records are pre-baked once per layout. `applyDisplayMode` rebuilds them
// when the player switches between desktop and mobile modes. Each fan stores
// enough data for a human-shaped procedural silhouette (head + torso + arms)
// plus a random phase offset so staggered animation costs zero per-frame alloc.
interface Fan {
  x: number      // center-x of the fan figure
  y: number      // top-y of the fan figure
  w: number      // body width (7–17 px)
  h: number      // total figure height (14–26 px)
  jersey: string // jersey / torso fill color
  skin: string   // head skin tone
  phase: number  // 0–2π random offset for sin-based bob & arm wave
}

// Alcorn State palette for the home (left) sideline.
const ALCORN_JERSEYS = ['#4B0082','#6B22AA','#FFD700','#fff','#9933CC','#3B0060']

// Aggregate HBCU palette for the visitor (right) sideline — primary jersey /
// accent colors representative of each school the player faces. Alcorn is
// excluded here because they are the home team.
const HBCU_JERSEYS = [
  '#000000','#C9A227',  // Grambling State  — black / gold
  '#00338D','#C9A227',  // Southern         — blue / gold
  '#FF6600','#006747',  // FAMU             — orange / green
  '#003087','#C9A227',  // NC A&T           — blue / gold
  '#6D1945','#ffffff',  // Morehouse        — maroon / white
  '#003087','#B6B8BA',  // Hampton          — blue / silver
  '#5C1A1A','#888888',  // Texas Southern   — maroon / gray
  '#4B1C82','#C9A227',  // Prairie View     — purple / gold
  '#7B0D1E','#C9A227',  // Bethune-Cookman  — maroon / gold
]

// A small range of skin tones so the stands read as a human crowd.
const SKIN_TONES = ['#FDBCB4','#E8A87C','#C68642','#8D5524','#5C3317']

function buildCrowd(seed: number, areaX: number, areaW: number, jerseys: string[]): Fan[] {
  let s = seed
  const n = () => { s=(s*1664525+1013904223)&0x7fffffff; return s/0x7fffffff }
  const count = Math.max(40, Math.round(areaW * GH * 0.005))
  return Array.from({length: count}, () => ({
    x:      areaX + n() * areaW,
    y:      n() * GH,
    w:      7  + n() * 10,
    h:      14 + n() * 12,
    jersey: jerseys[Math.floor(n() * jerseys.length)],
    skin:   SKIN_TONES[Math.floor(n() * SKIN_TONES.length)],
    phase:  n() * Math.PI * 2,
  }))
}

function buildCrowdL(): Fan[] { return buildCrowd(42, 0,  FL,      ALCORN_JERSEYS) }
function buildCrowdR(): Fan[] { return buildCrowd(77, FR, GW - FR, HBCU_JERSEYS)  }

let CROWD_L: Fan[] = buildCrowdL()
let CROWD_R: Fan[] = buildCrowdR()

// Draw a single human-shaped fan silhouette. `bobY` is a vertical pixel offset
// for the bob animation (0 when frozen). `armUp` switches between raised-arm
// and relaxed-arm pose. Kept small and path-free (fillRect + arc) for speed.
function drawFan(ctx: CanvasRenderingContext2D, fan: Fan, bobY: number, armUp: boolean) {
  const headR  = Math.max(2, fan.w * 0.38)
  const bodyH  = fan.h * 0.55
  const cx     = fan.x
  const headCY = fan.y + bobY + headR
  const bodyT  = headCY + headR * 0.8

  // Torso
  ctx.fillStyle = fan.jersey
  ctx.fillRect(cx - fan.w * 0.45, bodyT, fan.w * 0.9, bodyH)

  // Head
  ctx.fillStyle = fan.skin
  ctx.beginPath()
  ctx.arc(cx, headCY, headR, 0, Math.PI * 2)
  ctx.fill()

  // Arms — only drawn when the fan is wide enough to read at this scale
  if (fan.w >= 9) {
    const armY  = bodyT + bodyH * 0.25
    const reach = fan.w * 0.55
    ctx.strokeStyle = fan.jersey
    ctx.lineWidth   = Math.max(1, fan.w * 0.18)
    ctx.beginPath()
    if (armUp) {
      ctx.moveTo(cx - fan.w * 0.45, armY)
      ctx.lineTo(cx - fan.w * 0.45 - reach * 0.55, armY - reach)
      ctx.moveTo(cx + fan.w * 0.45, armY)
      ctx.lineTo(cx + fan.w * 0.45 + reach * 0.55, armY - reach)
    } else {
      ctx.moveTo(cx - fan.w * 0.45, armY)
      ctx.lineTo(cx - fan.w * 0.45 - reach * 0.55, armY + reach * 0.4)
      ctx.moveTo(cx + fan.w * 0.45, armY)
      ctx.lineTo(cx + fan.w * 0.45 + reach * 0.55, armY + reach * 0.4)
    }
    ctx.stroke()
  }
}

// `active` — true during gameplay phases; freezes animation on pause/gameover.
function drawSidelines(ctx: CanvasRenderingContext2D, time: number, active: boolean) {
  // ── Night-sky backdrop ────────────────────────────────────────────────────
  const skyGrd = ctx.createLinearGradient(0, 0, 0, GH)
  skyGrd.addColorStop(0,   '#03010a')
  skyGrd.addColorStop(0.4, '#0a0520')
  skyGrd.addColorStop(1,   '#140b2e')
  ctx.fillStyle = skyGrd
  ctx.fillRect(0, 0, GW, GH)

  // ── Star-field ────────────────────────────────────────────────────────────
  ctx.save()
  for (let i = 0; i < 80; i++) {
    const sx = ((i * 137.508 + 11) % 1) * GW
    const sy = ((i * 97.3 + 7)    % 1) * (GH * 0.55)
    const sr = 0.5 + ((i * 53) % 10) * 0.12
    const twinkle = 0.6 + 0.4 * Math.sin(time * 1.2 + i * 0.9)
    ctx.globalAlpha = 0.35 * twinkle
    ctx.fillStyle = '#ffffff'
    ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2); ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.restore()

  // ── Floodlight halos ──────────────────────────────────────────────────────
  const floodAlpha = 0.13 + 0.04 * Math.sin(time * 0.7)
  const towers = [
    { x: FL * 0.15,         y: GH * 0.08 },
    { x: FL * 0.75,         y: GH * 0.04 },
    { x: FR + (GW-FR)*0.25, y: GH * 0.04 },
    { x: FR + (GW-FR)*0.85, y: GH * 0.08 },
  ]
  for (const t of towers) {
    const halo = ctx.createRadialGradient(t.x, t.y, 2, t.x, t.y, 160)
    halo.addColorStop(0,   `rgba(255,252,210,${floodAlpha * 3.5})`)
    halo.addColorStop(0.3, `rgba(255,245,180,${floodAlpha})`)
    halo.addColorStop(1,   'rgba(0,0,0,0)')
    ctx.fillStyle = halo
    ctx.fillRect(t.x - 160, t.y - 20, 320, 220)
    ctx.save()
    ctx.globalAlpha = 0.65 + 0.3 * Math.sin(time * 1.1 + t.x)
    ctx.fillStyle = '#fffde8'
    ctx.beginPath(); ctx.arc(t.x, t.y, 3, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }

  // ── Left sideline ─────────────────────────────────────────────────────────
  const lgrd = ctx.createLinearGradient(0, 0, FL, 0)
  lgrd.addColorStop(0,   '#08031a')
  lgrd.addColorStop(0.6, '#150830')
  lgrd.addColorStop(1,   '#1f0e3c')
  ctx.fillStyle = lgrd
  ctx.fillRect(0, 0, FL, GH)
  ctx.save()
  ctx.beginPath(); ctx.rect(0, 0, FL, GH); ctx.clip()
  ctx.globalAlpha = 0.82
  for (const d of CROWD_L) {
    const bobY  = active ? Math.sin(time * 4.5 + d.phase) * 3 : 0
    const armUp = active && Math.sin(time * 3.0 + d.phase) > 0.3
    drawFan(ctx, d, bobY, armUp)
  }
  ctx.restore()

  // ── Right sideline ────────────────────────────────────────────────────────
  const rgrd = ctx.createLinearGradient(FR, 0, GW, 0)
  rgrd.addColorStop(0,   '#110616')
  rgrd.addColorStop(0.4, '#0c0415')
  rgrd.addColorStop(1,   '#050108')
  ctx.fillStyle = rgrd
  ctx.fillRect(FR, 0, GW - FR, GH)
  ctx.save()
  ctx.beginPath(); ctx.rect(FR, 0, GW - FR, GH); ctx.clip()
  ctx.globalAlpha = 0.82
  for (const d of CROWD_R) {
    const bobY  = active ? Math.sin(time * 4.5 + d.phase) * 3 : 0
    const armUp = active && Math.sin(time * 3.0 + d.phase) > 0.3
    drawFan(ctx, d, bobY, armUp)
  }
  ctx.restore()
  ctx.globalAlpha = 1

  // ── Sideline-edge field glow ──────────────────────────────────────────────
  const edgeW = Math.min(FL, 28)
  const leftEdge = ctx.createLinearGradient(FL - edgeW, 0, FL, 0)
  leftEdge.addColorStop(0, 'rgba(0,0,0,0)')
  leftEdge.addColorStop(1, 'rgba(160,220,140,0.07)')
  ctx.fillStyle = leftEdge
  ctx.fillRect(FL - edgeW, 0, edgeW, GH)
  const rightEdge = ctx.createLinearGradient(FR, 0, FR + edgeW, 0)
  rightEdge.addColorStop(0, 'rgba(160,220,140,0.07)')
  rightEdge.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = rightEdge
  ctx.fillRect(FR, 0, edgeW, GH)

  // ── Top scoreboard glow strip ─────────────────────────────────────────────
  const scoreboardGrd = ctx.createLinearGradient(0, 0, 0, 30)
  scoreboardGrd.addColorStop(0, 'rgba(75,0,130,0.18)')
  scoreboardGrd.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = scoreboardGrd
  ctx.fillRect(0, 0, GW, 30)

  // ── Sideline labels ───────────────────────────────────────────────────────
  if (FL >= 80) {
    ctx.save()
    ctx.translate(FL / 2, GH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.shadowColor = C_GOLD; ctx.shadowBlur = 8
    ctx.fillStyle = C_GOLD; ctx.font = 'bold 14px Impact'; ctx.textAlign = 'center'
    ctx.fillText('ALCORN STATE', 0, 0)
    ctx.shadowBlur = 0
    ctx.restore()

    ctx.save()
    ctx.translate(FR + (GW - FR) / 2, GH / 2)
    ctx.rotate(Math.PI / 2)
    ctx.shadowColor = '#C9A227'; ctx.shadowBlur = 8
    ctx.fillStyle = '#C9A227'; ctx.font = 'bold 14px Impact'; ctx.textAlign = 'center'
    ctx.fillText('VISITORS', 0, 0)
    ctx.shadowBlur = 0
    ctx.restore()
  }
}

// ─── Field surface + markings ────────────────────────────────────────────────
function drawField(ctx: CanvasRenderingContext2D, worldOffset: number, touchdowns: number) {
  // Alternating mowing-stripe pattern. Anchored to absolute world Y positions
  // and projected with the SAME formula as yard lines: screenY = PLAYER_Y +
  // worldOffset - W. This guarantees stripes scroll DOWN at the same rate the
  // yard lines do, so the field reads as one continuous moving surface.
  const stripeH = YARD_LINE_GAP / 2     // 150 px (= 2.5 virtual yards)
  ctx.save()
  ctx.beginPath()
  ctx.rect(FL, 0, FW, GH)
  ctx.clip()
  {
    const wAtTop    = worldOffset + PLAYER_Y
    const wAtBottom = worldOffset + PLAYER_Y - GH
    const firstW    = Math.floor(wAtBottom / stripeH) * stripeH - stripeH
    const lastW     = Math.ceil(wAtTop    / stripeH) * stripeH + stripeH
    let idx         = Math.floor(firstW / stripeH)
    for (let W = firstW; W <= lastW; W += stripeH, idx++) {
      const sy = PLAYER_Y + worldOffset - W
      ctx.fillStyle = idx % 2 === 0 ? C_FIELD1 : C_FIELD2
      // Each stripe is drawn between W and W - stripeH (above it in world);
      // its top edge in screen space is therefore sy - stripeH.
      ctx.fillRect(FL, sy - stripeH, FW, stripeH + 1)   // +1 px to seal seams
    }
  }

  // Floodlight cones from tower positions (established in drawSidelines)
  const floodCones = [
    { ox: FL + FW * 0.18, spread: FW * 0.55 },
    { ox: FL + FW * 0.82, spread: FW * 0.55 },
  ]
  for (const fc of floodCones) {
    const coneGrd = ctx.createRadialGradient(fc.ox, 0, 0, fc.ox, GH * 0.5, fc.spread)
    coneGrd.addColorStop(0,   'rgba(255,250,220,0.11)')
    coneGrd.addColorStop(0.5, 'rgba(255,240,180,0.05)')
    coneGrd.addColorStop(1,   'rgba(0,0,0,0)')
    ctx.fillStyle = coneGrd
    ctx.fillRect(FL, 0, FW, GH)
  }
  // Field ambient — subtle blue-tinted ambient from the open sky
  const fgrd = ctx.createRadialGradient(GW/2, GH * 0.4, 0, GW/2, GH * 0.4, GH * 0.7)
  fgrd.addColorStop(0, 'rgba(200,220,255,0.06)')
  fgrd.addColorStop(1, 'rgba(0,0,0,0.04)')
  ctx.fillStyle = fgrd
  ctx.fillRect(FL, 0, FW, GH)
  // Near-edge vignette — darkens the field near the viewer (bottom) for depth
  const vigGrd = ctx.createLinearGradient(0, GH * 0.7, 0, GH)
  vigGrd.addColorStop(0, 'rgba(0,0,0,0)')
  vigGrd.addColorStop(1, 'rgba(0,0,0,0.18)')
  ctx.fillStyle = vigGrd
  ctx.fillRect(FL, GH * 0.7, FW, GH * 0.3)

  // Yard lines — drawn at absolute world Y positions and projected onto screen.
  // A yard line at world Y = W appears at: screenY = PLAYER_Y + worldOffset - W.
  // As worldOffset grows (player runs upfield), screenY grows → lines visually
  // scroll DOWN past the player, which is how the field looks when running UP.
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth   = 2

  const wAtTop    = worldOffset + PLAYER_Y                                          // W when sy = 0
  const wAtBottom = worldOffset + PLAYER_Y - GH                                     // W when sy = GH
  const firstW    = Math.floor(wAtBottom / YARD_LINE_GAP) * YARD_LINE_GAP - YARD_LINE_GAP
  const lastW     = Math.ceil(wAtTop    / YARD_LINE_GAP) * YARD_LINE_GAP + YARD_LINE_GAP

  for (let W = firstW; W <= lastW; W += YARD_LINE_GAP) {
    const sy = PLAYER_Y + worldOffset - W
    if (sy < -20 || sy > GH + 20) continue

    // Main yard line
    ctx.beginPath()
    ctx.moveTo(FL, sy)
    ctx.lineTo(FR, sy)
    ctx.stroke()

    // Hash marks at 1/3 and 2/3 of field, with a mid-spacing tick
    const h1 = FL + FW * 0.33
    const h2 = FL + FW * 0.67
    ctx.lineWidth = 1.5
    for (const hx of [h1, h2]) {
      ctx.beginPath(); ctx.moveTo(hx - 14, sy); ctx.lineTo(hx + 14, sy); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(hx - 8, sy + YARD_LINE_GAP/2); ctx.lineTo(hx + 8, sy + YARD_LINE_GAP/2); ctx.stroke()
    }
    ctx.lineWidth = 2

    // Yard number for this line. Each "drive" is YARDS_TO_TD long and resets
    // after each touchdown (so 10, 20, 30, … 90, then end-zone, then 10 again).
    const yardsAtLine = Math.round(W / PIXELS_PER_YARD)
    const driveYards  = ((yardsAtLine % YARDS_TO_TD) + YARDS_TO_TD) % YARDS_TO_TD
    if (driveYards % 10 === 0 && driveYards > 0) {
      const label = String(driveYards)
      ctx.fillStyle = 'rgba(255,255,255,0.78)'
      ctx.font      = 'bold 22px Impact'
      ctx.textAlign = 'left'
      ctx.fillText(label, FL + 14, sy - 6)
      ctx.textAlign = 'right'
      ctx.fillText(label, FR - 14, sy - 6)
    }
  }

  // Sideline boundary lines
  ctx.strokeStyle = C_WHITE; ctx.lineWidth = 3
  ctx.beginPath(); ctx.moveTo(FL, 0); ctx.lineTo(FL, GH); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(FR, 0); ctx.lineTo(FR, GH); ctx.stroke()

  // Lane guide dots (very subtle)
  ctx.globalAlpha = 0.06
  ctx.fillStyle = C_WHITE
  for (const lx of LANE_XS) {
    for (let gy = 0; gy < GH; gy += 40) {
      ctx.beginPath(); ctx.arc(lx, gy, 2, 0, Math.PI*2); ctx.fill()
    }
  }
  ctx.globalAlpha = 1
  ctx.lineWidth = 1
  ctx.restore()

  // ── End zones ──────────────────────────────────────────────────────────
  // The 5 yards immediately *past* each touchdown line are styled as a
  // proper end zone: purple/white checkerboard floor with big block-style
  // "ALCORN" lettering centered in the band. Anchored in world coordinates
  // so the whole thing scrolls down past the player along with the field
  // stripes and yard lines.
  //
  // Geometry recap (same projection as yard lines):
  //   screenY = PLAYER_Y + worldOffset - W
  //   larger W ⇒ smaller screenY (higher on screen / further upfield)
  // For touchdown index k, the goal line sits at world W = (k+1)*PIXELS_PER_TD.
  // The end zone occupies world W ∈ [goalW, goalW + EZ_DEPTH] — i.e. the
  // 5 yards beyond the goal line. On screen that band extends UPWARD from
  // goalSY by ezH pixels (smaller screenY = further upfield).
  //
  // We iterate over a small range of k around the player so both the next-
  // up end zone and the just-crossed one (during the touchdown freeze)
  // remain rendered without popping.
  const tdsCovered  = Math.floor(worldOffset / PIXELS_PER_TD)
  const EZ_DEPTH_YD = 5
  const cellSize    = PIXELS_PER_YARD                  // 1-yard checker squares
  const ezH         = EZ_DEPTH_YD * PIXELS_PER_YARD
  for (let k = Math.max(-1, tdsCovered - 1); k <= tdsCovered + 2; k++) {
    const goalW   = (k + 1) * PIXELS_PER_TD
    const goalSY  = PLAYER_Y + worldOffset - goalW
    const ezTopSY = goalSY - ezH                        // top of EZ band (5 yds past goal line)
    const ezBotSY = goalSY                              // bottom of EZ band (= goal line)
    if (ezBotSY < -8 || ezTopSY > GH + 8) continue

    ctx.save()
    ctx.beginPath(); ctx.rect(FL, 0, FW, GH); ctx.clip()

    // Checker floor — 5 rows × ⌈FW / cellSize⌉ cols. Row 0 is the row
    // directly under the goal line, row EZ_DEPTH_YD-1 is the bottom-most
    // (the row the player enters first when approaching).
    const cols = Math.ceil(FW / cellSize) + 1
    for (let row = 0; row < EZ_DEPTH_YD; row++) {
      const cellTopSY = ezTopSY + row * cellSize
      // Cull rows outside the viewport for cheap fill cost.
      if (cellTopSY > GH || cellTopSY + cellSize < 0) continue
      for (let col = 0; col < cols; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? C_PURPLE : C_WHITE
        ctx.fillRect(FL + col * cellSize, cellTopSY, cellSize + 1, cellSize + 1)
      }
    }

    // Subtle inner shadow at the very back (top) of the end zone so the
    // band reads as a distinct area against the bright field stripes.
    const shade = ctx.createLinearGradient(0, ezTopSY, 0, ezTopSY + 24)
    shade.addColorStop(0, 'rgba(0,0,0,0.28)')
    shade.addColorStop(1, 'rgba(0,0,0,0.0)')
    ctx.fillStyle = shade
    ctx.fillRect(FL, ezTopSY, FW, 24)

    // Gold goal line (bottom edge of the end zone band — the scoring line).
    ctx.strokeStyle = C_GOLD
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.moveTo(FL, goalSY)
    ctx.lineTo(FR, goalSY)
    ctx.stroke()

    // White back-of-endzone line (top edge of the end zone band — the back
    // wall). Mirrors the goal line on the opposite side of the band so the
    // end zone is visually closed off.
    ctx.strokeStyle = C_WHITE
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(FL, ezTopSY)
    ctx.lineTo(FR, ezTopSY)
    ctx.stroke()

    // "ALCORN" — block-style lettering centered in the band, anchored in
    // world coords so it scrolls with the floor.
    const textW  = goalW + (EZ_DEPTH_YD / 2) * cellSize  // mid-band (2.5 yds past goal line)
    const textSY = PLAYER_Y + worldOffset - textW
    if (textSY > -ezH && textSY < GH + ezH) {
      // Size the type to fill ~55% of the band height; clamp on small mobile
      // viewports so it never overflows the field width.
      let fsize = Math.round(ezH * 0.55)
      // Loose width budget — leave 12% padding inside the field.
      const widthBudget = FW * 0.88
      ctx.save()
      ctx.translate(GW / 2, textSY)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const letters = 'ALCORN'
      const tracking = () => fsize * 0.10
      const measure = () => {
        ctx.font = `900 ${fsize}px Impact, "Arial Black", sans-serif`
        const widths = letters.split('').map(c => ctx.measureText(c).width)
        const total = widths.reduce((a, b) => a + b, 0) + tracking() * (letters.length - 1)
        return { widths, total }
      }
      let m = measure()
      // Shrink to fit if the field is narrow (mobile portrait).
      while (m.total > widthBudget && fsize > 18) {
        fsize -= 2
        m = measure()
      }
      // Per-letter draw with stacked outlines for the block effect:
      //   1) thick black outline (heavy shadow / depth)
      //   2) gold mid-stroke (HBCU accent)
      //   3) vertical white→gold gradient fill
      ctx.lineJoin = 'round'
      let cursor = -m.total / 2
      for (let i = 0; i < letters.length; i++) {
        const w  = m.widths[i]
        const cx = cursor + w / 2
        // Drop shadow underneath the letter for a stamped-on-turf feel.
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.55)'
        ctx.shadowBlur = fsize * 0.18
        ctx.shadowOffsetY = fsize * 0.06
        // Outer black stroke.
        ctx.lineWidth = fsize * 0.22
        ctx.strokeStyle = '#000000'
        ctx.strokeText(letters[i], cx, 0)
        ctx.restore()
        // Inner gold stroke on top of the black outline.
        ctx.lineWidth = fsize * 0.10
        ctx.strokeStyle = C_GOLD
        ctx.strokeText(letters[i], cx, 0)
        // Letter fill: bright at the top, settling to gold at the bottom.
        const grad = ctx.createLinearGradient(0, -fsize * 0.55, 0, fsize * 0.55)
        grad.addColorStop(0,    '#ffffff')
        grad.addColorStop(0.55, '#fff2b8')
        grad.addColorStop(1,    C_GOLD)
        ctx.fillStyle = grad
        ctx.fillText(letters[i], cx, 0)
        cursor += w + tracking()
      }
      ctx.restore()
    }

    ctx.restore()
  }
}

// ─── Player sprite render ────────────────────────────────────────────────────
//
// Single drawImage of the current animation frame, plus on-top overlays
// (boost speed lines, spin glow, lean rotation). All transforms are applied
// to the canvas — no per-frame allocations on the hot path.
function drawPlayerSprite(
  ctx: CanvasRenderingContext2D,
  g: GS,
) {
  const cx = Math.round(g.playerX)

  // Vertical hop while jumping. Half-sine curve over the jump duration so
  // the sprite peaks at mid-animation and lands as the timer expires. Pure
  // visual — collision is gated on jumpTimer > 0, not the offset.
  let hopOffset = 0
  if (g.jumpTimer > 0) {
    const t = 1 - g.jumpTimer / JUMP_DUR
    hopOffset = -Math.sin(t * Math.PI) * 28
  }
  const cy = Math.round(PLAYER_Y + hopOffset)

  // Soft shadow so the sprite reads on the field. Anchored at PLAYER_Y so
  // it stays on the ground while the sprite hops into the air; shadow
  // shrinks as the player rises for a sense of altitude.
  const shadowScale = g.jumpTimer > 0
    ? 1 - Math.min(0.55, Math.abs(hopOffset) / 32)
    : 1
  ctx.fillStyle = `rgba(0,0,0,${0.32 * (0.5 + shadowScale * 0.5)})`
  ctx.beginPath()
  ctx.ellipse(
    cx + 4, PLAYER_Y + 30,
    PLAYER_DRAW_W * 0.32 * shadowScale,
    PLAYER_DRAW_W * 0.13 * shadowScale,
    0, 0, Math.PI * 2,
  )
  ctx.fill()

  if (!spritesReady()) {
    // Sprites haven't finished loading: fall back to a small pulsing dot so
    // there's no visible flash of a missing player. Loading is sub-second on
    // local network, so this branch is essentially never seen by players.
    ctx.fillStyle = C_PURPLE
    ctx.beginPath(); ctx.arc(cx, cy, 14, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = C_GOLD; ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(cx, cy, 14, 0, Math.PI * 2); ctx.stroke()
    return
  }

  const img = pickFrame(g.spriteState, g.runCycle, g.spriteOneShotElapsed)
  if (!img) return

  ctx.save()
  ctx.translate(cx, cy)
  // Lane-change lean. Spinning rotates fully through 360° during the move.
  if (g.spinning) {
    ctx.rotate(g.spinRotation)
  } else {
    ctx.rotate(g.leanAngle)
  }
  // Center the sprite on the pivot. Round coordinates for crisp pixels.
  const dx = -Math.round(PLAYER_DRAW_W / 2)
  const dy = -Math.round(PLAYER_DRAW_H / 2)
  ctx.drawImage(img, dx, dy, PLAYER_DRAW_W, PLAYER_DRAW_H)

  // Brief white impact flash on tackle contact — mirrors the defender's
  // hit-flash (~5 frames @ 60fps) so the collision reads as a two-body
  // impact. Stamped with source-atop so it only tints the sprite pixels
  // (not the shadow/background). Wall-clock driven so it persists into
  // the gameover phase even though update() short-circuits there.
  if (g.playerHitFlashStart > 0) {
    const PLAYER_HIT_FLASH_MS = 83
    const hitFlashAmt = Math.max(
      0,
      1 - (performance.now() - g.playerHitFlashStart) / PLAYER_HIT_FLASH_MS,
    )
    if (hitFlashAmt > 0) {
      ctx.globalCompositeOperation = 'source-atop'
      ctx.globalAlpha = Math.min(0.9, hitFlashAmt * 0.9)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(dx, dy, PLAYER_DRAW_W, PLAYER_DRAW_H)
    }
  }
  ctx.restore()

  // Boost speed lines (gold)
  if (g.boosting) {
    ctx.save()
    ctx.translate(cx, cy)
    ctx.strokeStyle = 'rgba(255,215,0,0.55)'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    for (let i = 0; i < 6; i++) {
      const sx  = rng(-PLAYER_DRAW_W * 0.35, PLAYER_DRAW_W * 0.35)
      const len = rng(20, 45)
      ctx.beginPath()
      ctx.moveTo(sx, PLAYER_DRAW_H * 0.32)
      ctx.lineTo(sx + rng(-4, 4), PLAYER_DRAW_H * 0.32 + len)
      ctx.stroke()
    }
    ctx.restore()
  }

  // Spin glow ring tinted gold to match the new palette
  if (g.spinning) {
    const t = g.spinTimer / SPIN_DUR
    ctx.save()
    ctx.globalAlpha = (1 - t) * 0.45
    ctx.fillStyle = C_GOLD
    ctx.beginPath()
    ctx.arc(cx, cy, PLAYER_DRAW_W * 0.55, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

// ─── Defender sprite render ──────────────────────────────────────────────────
//
// Mirrors drawPlayerSprite: a single drawImage of the current PNG frame from
// the defender's variant set, with the existing transforms (depth scaling
// pre-applied by the caller, hit-flash tint via a tinted overlay).
function drawDefenderSprite(
  ctx: CanvasRenderingContext2D,
  d: Defender,
  flashAmt: number,
  hitFlashAmt: number,
) {
  const cx = Math.round(d.x)
  const cy = Math.round(d.screenY)

  // Depth-perspective scaling — defenders far up field (near DEF_SPAWN_SCREEN_Y)
  // appear smaller; defenders near the player (PLAYER_Y) appear full size.
  const journey   = Math.max(1, PLAYER_Y - DEF_SPAWN_SCREEN_Y)
  const depthT    = Math.max(0, Math.min(1, (cy - DEF_SPAWN_SCREEN_Y) / journey))
  const depthScale = 0.52 + depthT * 0.48
  const dw = Math.round(DEFENDER_DRAW_W * depthScale)
  const dh = Math.round(DEFENDER_DRAW_H * depthScale)

  // Dual-ellipse shadow: primary soft blob + narrow contact shadow, both
  // scale with depthT so far defenders cast fainter, tighter shadows.
  const shadowOpacity = 0.18 + depthT * 0.28
  ctx.fillStyle = `rgba(0,0,0,${shadowOpacity.toFixed(2)})`
  ctx.beginPath()
  ctx.ellipse(
    cx + 3, cy + dh * 0.30,
    dw * 0.38, dw * 0.14,
    0, 0, Math.PI * 2,
  )
  ctx.fill()
  // Contact shadow (tighter, darker)
  ctx.fillStyle = `rgba(0,0,0,${(shadowOpacity * 0.6).toFixed(2)})`
  ctx.beginPath()
  ctx.ellipse(
    cx + 1, cy + dh * 0.32,
    dw * 0.22, dw * 0.07,
    0, 0, Math.PI * 2,
  )
  ctx.fill()

  if (!defenderSpritesReady()) {
    ctx.fillStyle = '#1A3A8A'
    ctx.beginPath(); ctx.arc(cx, cy, 14 * depthScale, 0, Math.PI * 2); ctx.fill()
    return
  }

  const state = d.tackling ? 'tackle' : 'run'
  const img = pickDefenderFrame(d.variant, state, d.runCycle, d.tackleElapsed)
  if (!img) return

  const dx = -Math.round(dw / 2)
  const dy = -Math.round(dh / 2)

  ctx.save()
  ctx.translate(cx, cy)

  // Depth fog: far defenders get a dark overlay to simulate atmospheric perspective
  // Apply it below the sprite (globalCompositeOperation default) as a pre-tint.
  const fogAmt = (1 - depthT) * 0.38
  if (fogAmt > 0.02) {
    ctx.globalAlpha = fogAmt
    ctx.fillStyle = '#101820'
    ctx.fillRect(dx - 2, dy - 2, dw + 4, dh + 4)
    ctx.globalAlpha = 1
  }

  ctx.drawImage(img, dx, dy, dw, dh)

  // Hit-flash tint
  if (flashAmt > 0) {
    ctx.globalCompositeOperation = 'source-atop'
    ctx.globalAlpha = Math.min(0.55, flashAmt * 0.55)
    ctx.fillStyle = '#ff2222'
    ctx.fillRect(dx, dy, dw, dh)
  }
  // White impact flash on tackle contact
  if (hitFlashAmt > 0) {
    ctx.globalCompositeOperation = 'source-atop'
    ctx.globalAlpha = Math.min(0.9, hitFlashAmt * 0.9)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(dx, dy, dw, dh)
  }
  ctx.restore()
}

// (legacy `drawFootballPlayer` defender renderer + `lerpColor` helper +
//  PLAYER_W/H constants removed; defenders now use sprite PNGs via
//  drawDefenderSprite, see above.)

// ─── Collectibles ─────────────────────────────────────────────────────────────
function drawCollectible(ctx: CanvasRenderingContext2D, c: Collectible, time: number) {
  const bob = Math.sin(c.bobPhase + time * 2.5) * 5
  const cy  = c.screenY + bob

  if (c.type === 'coin') {
    const spin = Math.cos(time * 4 + c.bobPhase)
    const hw   = Math.max(1, 16 * Math.abs(spin))
    // Glow
    ctx.shadowColor = C_GOLD; ctx.shadowBlur = 14
    const grd = ctx.createRadialGradient(c.x, cy, 0, c.x, cy, 16)
    grd.addColorStop(0, '#fff7aa')
    grd.addColorStop(0.5, C_GOLD)
    grd.addColorStop(1, '#aa7700')
    ctx.fillStyle = grd
    ctx.beginPath(); ctx.ellipse(c.x, cy, hw, 16, 0, 0, Math.PI*2); ctx.fill()
    if (Math.abs(spin) > 0.3) {
      ctx.fillStyle = 'rgba(255,255,180,0.7)'
      ctx.font = 'bold 12px Impact'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('$', c.x, cy)
      ctx.textBaseline = 'alphabetic'
    }
    ctx.shadowBlur = 0

  } else if (c.type === 'football') {
    ctx.shadowColor = '#ff8800'; ctx.shadowBlur = 18
    // Outer glow ring
    ctx.strokeStyle = 'rgba(255,140,0,0.35)'; ctx.lineWidth = 8
    ctx.beginPath(); ctx.arc(c.x, cy, 22, 0, Math.PI*2); ctx.stroke()
    // Football
    const fw = 18, fh = 12
    ctx.fillStyle = '#7c3a10'
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.ellipse(c.x, cy, fw, fh, 0, 0, Math.PI*2); ctx.fill(); ctx.stroke()
    ctx.strokeStyle = C_WHITE; ctx.lineWidth = 1.2
    ctx.beginPath(); ctx.moveTo(c.x-fw+2,cy); ctx.bezierCurveTo(c.x-8,cy-fh*1.2,c.x+8,cy-fh*1.2,c.x+fw-2,cy); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(c.x-fw+2,cy); ctx.bezierCurveTo(c.x-8,cy+fh*1.2,c.x+8,cy+fh*1.2,c.x+fw-2,cy); ctx.stroke()
    for (let l=-4;l<=4;l+=4){ ctx.beginPath();ctx.moveTo(c.x+l,cy-fh*0.8);ctx.lineTo(c.x+l,cy+fh*0.8);ctx.stroke() }
    ctx.shadowBlur = 0; ctx.lineWidth = 1

  } else {
    // Hydration bottle power-up — image with electric purple/cyan glow.
    ctx.save()
    const img = getBottleImage()
    const pulse = 1 + Math.sin(time * 5 + c.bobPhase) * 0.12
    const flicker = 0.75 + Math.sin(time * 17 + c.bobPhase * 3) * 0.15
                          + Math.sin(time * 41 + c.bobPhase) * 0.10

    // Outer purple halo (radial gradient under the bottle).
    const haloR = 34 * pulse
    const halo = ctx.createRadialGradient(c.x, cy, 0, c.x, cy, haloR)
    halo.addColorStop(0,    `rgba(200, 120, 255, ${0.55 * flicker})`)
    halo.addColorStop(0.45, `rgba(150,  60, 240, ${0.35 * flicker})`)
    halo.addColorStop(1,    'rgba(80, 0, 160, 0)')
    ctx.fillStyle = halo
    ctx.beginPath(); ctx.arc(c.x, cy, haloR, 0, Math.PI * 2); ctx.fill()

    // Cyan inner spark glow for that "electric" feel.
    const sparkR = 22 * pulse
    const spark = ctx.createRadialGradient(c.x, cy, 0, c.x, cy, sparkR)
    spark.addColorStop(0, `rgba(220, 245, 255, ${0.45 * flicker})`)
    spark.addColorStop(1, 'rgba(120, 220, 255, 0)')
    ctx.fillStyle = spark
    ctx.beginPath(); ctx.arc(c.x, cy, sparkR, 0, Math.PI * 2); ctx.fill()

    // Bottle image (with subtle bob-tied tilt) or fallback if not yet loaded.
    const bw = 44, bh = 66
    const tilt = Math.sin(time * 1.6 + c.bobPhase) * 0.10
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.save()
      ctx.translate(c.x, cy)
      ctx.rotate(tilt)
      ctx.shadowColor = '#c266ff'
      ctx.shadowBlur = 18 * flicker
      ctx.drawImage(img, -bw / 2, -bh / 2, bw, bh)
      ctx.restore()
      ctx.shadowBlur = 0
    } else {
      // Fallback: a glowing purple capsule until the image finishes loading.
      ctx.fillStyle = '#a040ff'
      ctx.beginPath(); ctx.ellipse(c.x, cy, bw * 0.35, bh * 0.45, 0, 0, Math.PI * 2); ctx.fill()
    }

    // Flickering electric arcs around the bottle.
    const arcCount = 3
    ctx.lineCap = 'round'
    for (let i = 0; i < arcCount; i++) {
      const seed = c.bobPhase * 7 + i * 2.13
      const phase = time * (8 + i * 3) + seed
      // Trigger each arc only when its sine wave is near a peak — gives a
      // flickering, irregular feel rather than continuous lightning.
      const trigger = Math.sin(phase)
      if (trigger < 0.55) continue
      const intensity = (trigger - 0.55) / 0.45   // 0..1
      const startA = phase * 1.7
      const endA   = startA + Math.PI * (0.35 + 0.5 * Math.sin(phase * 0.7))
      const r1 = 18 + Math.sin(phase * 2) * 4
      const r2 = 26 + Math.sin(phase * 1.3 + 1) * 5
      const x1 = c.x + Math.cos(startA) * r1
      const y1 = cy  + Math.sin(startA) * r1
      const x2 = c.x + Math.cos(endA)   * r2
      const y2 = cy  + Math.sin(endA)   * r2
      // Jagged midpoint for the lightning kink.
      const mx = (x1 + x2) / 2 + Math.cos(phase * 3.3) * 6
      const my = (y1 + y2) / 2 + Math.sin(phase * 4.1) * 6
      ctx.strokeStyle = `rgba(220, 240, 255, ${0.85 * intensity})`
      ctx.shadowColor = '#9a4dff'
      ctx.shadowBlur = 10
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x1, y1); ctx.lineTo(mx, my); ctx.lineTo(x2, y2)
      ctx.stroke()
    }
    ctx.shadowBlur = 0
    ctx.lineWidth = 1
    ctx.restore()
  }
}

// ─── Particles ────────────────────────────────────────────────────────────────
// ── Speed Visual Effects ──────────────────────────────────────────────────────
// Renders boost ghost afterimages, directional speed lines, and a chromatic
// aberration edge flash at high screenFlash. Inserted in the render pipeline
// just after drawPlayerSprite so it composites on top of the player but under
// HUD elements.
function drawSpeedEffects(ctx: CanvasRenderingContext2D, g: GS, time: number) {
  const px = Math.round(g.playerX)
  const py = PLAYER_Y

  // ── Boost ghost afterimage ──────────────────────────────────────────
  // Three translucent ellipses trailing behind the player when boosting.
  // Gold when boost-active, purple when spin-active, white otherwise (speed).
  const isBoost = g.boostLoop > 0
  const isSpin  = (g as any).spinActive > 0   // spinActive may not exist, safe cast
  const hasEffect = isBoost || isSpin || g.screenFlash > 0.08
  if (hasEffect && (isBoost || isSpin)) {
    const ghostColor = isBoost
      ? 'rgba(255,200,0,'
      : 'rgba(160,60,255,'
    for (let i = 0; i < 3; i++) {
      const trailY = py + 18 + i * 14
      const alpha  = (0.22 - i * 0.06) * (isBoost ? 1 : 0.75)
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.fillStyle = ghostColor + '1)'
      ctx.beginPath()
      ctx.ellipse(px, trailY, 18 - i * 3, 9 - i * 2, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }

  // ── Directional speed lines ─────────────────────────────────────────
  // Upward streaks that intensify with speed. Color: gold=boost, purple=spin,
  // white=general speed. Length and count scale with screenFlash / boost state.
  const lineIntensity = isBoost ? 1.0 : (isSpin ? 0.75 : Math.min(g.screenFlash * 1.5, 0.5))
  if (lineIntensity > 0.05) {
    const lineCount  = Math.round(6 + lineIntensity * 10)
    const lineColor  = isBoost ? '#FFD700' : isSpin ? '#B44CFF' : '#FFFFFF'
    const maxLength  = 40 + lineIntensity * 60
    ctx.save()
    ctx.globalAlpha = lineIntensity * 0.55
    ctx.strokeStyle = lineColor
    for (let i = 0; i < lineCount; i++) {
      // Deterministic but varied per-frame via time offset
      const phase   = (i / lineCount) * Math.PI * 2 + time * (2 + i * 0.3)
      const lx      = px + Math.sin(phase) * 38 + Math.cos(phase * 0.5) * 22
      const ly      = py - 10 - Math.abs(Math.sin(phase * 1.3)) * 30
      const len     = maxLength * (0.4 + 0.6 * Math.abs(Math.sin(phase * 0.7)))
      const alpha01 = 0.3 + 0.7 * Math.abs(Math.sin(phase * 1.1))
      ctx.globalAlpha = lineIntensity * alpha01 * 0.5
      ctx.lineWidth   = 1 + lineIntensity * 1.5
      ctx.beginPath()
      ctx.moveTo(lx, ly)
      ctx.lineTo(lx + Math.sin(phase * 0.2) * 4, ly - len)
      ctx.stroke()
    }
    ctx.restore()
  }

  // ── Chromatic aberration edge flash ─────────────────────────────────
  // At high screenFlash (impacts, touchdowns) paint thin R/G/B offset
  // strips around the player to simulate camera shake / impact bloom.
  if (g.screenFlash > 0.55) {
    const ca = (g.screenFlash - 0.55) / 0.45   // 0–1 above threshold
    const offset = Math.round(ca * 5)
    ctx.save()
    ctx.globalAlpha = ca * 0.45
    // Red channel shift left
    ctx.fillStyle = 'rgba(255,0,0,1)'
    ctx.beginPath()
    ctx.ellipse(px - offset, py - 5, 26, 12, 0, 0, Math.PI * 2)
    ctx.fill()
    // Cyan channel shift right
    ctx.fillStyle = 'rgba(0,255,255,1)'
    ctx.beginPath()
    ctx.ellipse(px + offset, py - 5, 26, 12, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, g: GS) {
  for (const p of g.particles) {
    if (p.life <= 0) continue
    const a = Math.max(0, p.life / p.maxLife)
    ctx.globalAlpha = a * a
    ctx.fillStyle   = p.color
    if (p.shape === 'rect') {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot)
      ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size)
      ctx.restore()
    } else {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * a, 0, Math.PI*2); ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

// ─── Float texts ──────────────────────────────────────────────────────────────
function drawFloatTexts(ctx: CanvasRenderingContext2D, g: GS) {
  for (const f of g.floatTexts) {
    if (f.life <= 0) continue
    const t   = f.life / f.maxLife
    const a   = t < 0.25 ? t / 0.25 : 1
    const sc  = 0.8 + t * 0.2
    ctx.globalAlpha = a
    ctx.save()
    ctx.translate(f.x, f.y)
    ctx.scale(sc, sc)
    ctx.font      = `bold ${f.size}px Impact, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillText(f.text, 2, 2)
    ctx.fillStyle = f.color
    ctx.shadowColor = f.color; ctx.shadowBlur = 10
    ctx.fillText(f.text, 0, 0)
    ctx.shadowBlur = 0
    ctx.restore()
  }
  ctx.globalAlpha = 1
}

// ─── HUD ─────────────────────────────────────────────────────────────────────
function drawHUD(ctx: CanvasRenderingContext2D, g: GS, time: number) {
  if (g.phase === 'gameover' || g.phase === 'menu') return

  // Mobile: shift top HUD elements down past the notch / status bar.
  // The pause button sits at the top-right (HTML overlay) and reserves
  // room there; ensure the canvas Speed panel doesn't crash into it.
  const topY = 12 + SAFE_TOP
  const isMobile = CURRENT_MODE === 'mobile'

  // ── Score + yards + level (top left) ────────────────────────────
  // Panel grew taller to host a dedicated "LEVEL N — X / 10 TDs" line
  // beneath the existing yards/TD line. The level line is tinted with
  // the current opponent's primary color so the matchup reads in the
  // HUD throughout the level.
  const oppMeta = SCHOOL_META[g.opponent]
  // Score panel — pop scale + gold glow on screenFlash (TD, collect, milestone)
  const scorePop   = g.screenFlash > 0.1 ? 1 + (g.screenFlash - 0.1) * 0.12 : 1
  const scoreGlow  = g.screenFlash > 0.3 ? Math.min((g.screenFlash - 0.3) / 0.4, 1) : 0
  ctx.save()
  ctx.translate(12 + 120, topY + 60)
  ctx.scale(scorePop, scorePop)
  ctx.translate(-(12 + 120), -(topY + 60))
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  roundRect(ctx, 12, topY, 240, 120, 10); ctx.fill()
  ctx.fillStyle = C_GOLD
  ctx.font = 'bold 40px Impact'; ctx.textAlign = 'left'
  if (scoreGlow > 0) { ctx.shadowColor = C_GOLD; ctx.shadowBlur = 18 * scoreGlow }
  ctx.fillText(g.score.toLocaleString(), 24, topY + 42)
  ctx.shadowBlur = 0
  ctx.restore()
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.font = '17px Impact'
  ctx.fillText(`${Math.floor(g.yards)} YDS  ·  TD: ${g.touchdowns}`, 24, topY + 66)
  // Level / per-level TD progress.
  ctx.fillStyle = oppMeta.secondary
  ctx.font = 'bold 16px Impact'
  ctx.fillText(
    `LEVEL ${g.level} — ${g.levelTouchdowns} / ${LEVEL_TD_GOAL} TDs`,
    24, topY + 90,
  )
  // Progress bar beneath the level line — fills toward the LEVEL_TD_GOAL
  // and uses the opponent's accent color so it matches the per-level theme.
  // Pulses/glows as the bar enters its last 20 % so the player feels the
  // run closing in on the level goal, then bursts into a brief gold/accent
  // flash the moment it fills (driven by g.levelGoalFlash).
  {
    const barX = 24, barY = topY + 100, barW = 216, barH = 8
    const prog = clamp(g.levelTouchdowns / LEVEL_TD_GOAL, 0, 1)
    // Pulse ramp: 0 below 80 % full, eases to 1 as the bar hits 100 %.
    const pulseRamp = clamp((prog - 0.8) / 0.2, 0, 1)
    // Sin-wave heartbeat — speeds up slightly as the bar fills.
    const pulse = pulseRamp > 0
      ? (0.55 + 0.45 * Math.sin(time * (10 + pulseRamp * 6)))
      : 0
    // Fill-flash remaining-time fraction (1 on trigger → 0 at end).
    const flash01 = g.levelGoalFlash > 0
      ? clamp(g.levelGoalFlash / 0.9, 0, 1)
      : 0
    // Linear decay envelope (1 → 0): peaks immediately on the trigger
    // frame so the burst hits in-sync with the final TD landing, then
    // fades out over the lifetime of g.levelGoalFlash.
    const flashPop = flash01

    ctx.save()
    // Track
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    roundRect(ctx, barX, barY, barW, barH, 4); ctx.fill()
    // Filled portion — glow scales with pulse + flash.
    if (prog > 0) {
      const glowAlpha = pulse * 0.85 + flashPop * 0.9
      if (glowAlpha > 0) {
        ctx.shadowColor = oppMeta.secondary
        ctx.shadowBlur = 10 + pulse * 14 + flashPop * 22
      }
      ctx.fillStyle = oppMeta.secondary
      roundRect(ctx, barX, barY, Math.max(barH, barW * prog), barH, 4); ctx.fill()
      ctx.shadowBlur = 0
    }
    // Outline — subtle gold tint as the bar nears full so the pulse reads
    // even on bright accent colors.
    if (pulse > 0 || flashPop > 0) {
      ctx.strokeStyle = `rgba(255,215,0,${0.35 * pulse + 0.7 * flashPop})`
      ctx.lineWidth = 1.5
      roundRect(ctx, barX - 1, barY - 1, barW + 2, barH + 2, 5); ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'
    ctx.lineWidth = 1
    roundRect(ctx, barX, barY, barW, barH, 4); ctx.stroke()

    // Fill-flash burst: bright accent overlay + expanding gold ring + a
    // small "GOAL!" tag above the bar. Respects opponent accent color.
    if (flashPop > 0) {
      // Bright overlay across the full bar
      ctx.globalAlpha = flashPop * 0.85
      ctx.fillStyle = '#FFFFFF'
      roundRect(ctx, barX, barY, barW, barH, 4); ctx.fill()
      ctx.globalAlpha = 1
      // Expanding accent halo around the bar
      const grow = (1 - flash01) * 14   // 0 → 14 px outward
      ctx.globalAlpha = flashPop * 0.55
      ctx.strokeStyle = oppMeta.secondary
      ctx.lineWidth = 2
      roundRect(
        ctx,
        barX - grow, barY - grow,
        barW + grow * 2, barH + grow * 2,
        4 + grow,
      )
      ctx.stroke()
      ctx.globalAlpha = 1
      // "GOAL!" tag pops above the bar — uses the accent color with a gold
      // glow so it reads against any background.
      ctx.save()
      ctx.globalAlpha = flashPop
      ctx.translate(barX + barW / 2, barY - 6)
      ctx.scale(1 + flashPop * 0.25, 1 + flashPop * 0.25)
      ctx.textAlign = 'center'
      ctx.shadowColor = '#FFD700'
      ctx.shadowBlur = 14
      ctx.fillStyle = oppMeta.secondary
      ctx.font = 'bold 14px Impact'
      ctx.fillText('GOAL!', 0, 0)
      ctx.shadowBlur = 0
      ctx.restore()
      ctx.textAlign = 'left'
    }
    ctx.restore()
  }

  // ── In-run "NEW HIGH SCORE!" banner (top center, just under HUD) ──
  // Fires while g.nhsAnim > 0 — set when the live score crosses an entry
  // on the snapshotted leaderboard. Pops in, holds, then fades out.
  if (g.nhsAnim > 0) {
    const t01 = clamp(1 - g.nhsAnim / NHS_ANIM_DUR, 0, 1)
    const intro = clamp(t01 / 0.18, 0, 1)
    const outro = clamp(g.nhsAnim / 0.45, 0, 1)
    const alpha = Math.min(intro, outro)
    const popScale = 1 + (1 - intro) * 0.35 + Math.sin(time * 18) * 0.04
    const cy = topY + 126
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(GW / 2, cy)
    ctx.scale(popScale, popScale)
    ctx.textAlign = 'center'
    // Outer glow
    ctx.shadowColor = '#FFD700'
    ctx.shadowBlur = 26
    ctx.fillStyle = '#FFD700'
    ctx.font = 'bold 38px Impact'
    ctx.fillText('★ NEW HIGH SCORE! ★', 0, 0)
    ctx.shadowBlur = 0
    // Subtitle: which rank you just hit + who you passed.
    ctx.fillStyle = '#fff7c2'
    ctx.font = 'bold 18px Impact'
    const sub = g.nhsKnocked
      ? `RANK #${g.nhsRank}  ·  PASSED ${g.nhsKnocked}`
      : `RANK #${g.nhsRank}`
    ctx.fillText(sub, 0, 22)
    ctx.restore()
    ctx.globalAlpha = 1
    ctx.textAlign = 'left'
  }

  // ── In-run "🏈 TD RECORD!" banner (just below the NHS banner) ──
  // Fires while g.tdNhsAnim > 0 — set when a touchdown pushes the player's
  // run TD count past a top-10 entry on the snapshotted TD board. Drawn as
  // a separate banner so it can coexist with the points-based banner on
  // the same frame.
  if (g.tdNhsAnim > 0) {
    const t01    = clamp(1 - g.tdNhsAnim / NHS_ANIM_DUR, 0, 1)
    const intro  = clamp(t01 / 0.18, 0, 1)
    const outro  = clamp(g.tdNhsAnim / 0.45, 0, 1)
    const alpha  = Math.min(intro, outro)
    const popScale = 1 + (1 - intro) * 0.35 + Math.sin(time * 18) * 0.04
    // Offset below the NHS banner so they stack rather than overlap when
    // both are active at once.
    const cy = topY + 126 + (g.nhsAnim > 0 ? 70 : 0)
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(GW / 2, cy)
    ctx.scale(popScale, popScale)
    ctx.textAlign = 'center'
    ctx.shadowColor = '#ff9b3a'
    ctx.shadowBlur = 26
    ctx.fillStyle = '#ffb347'
    ctx.font = 'bold 36px Impact'
    ctx.fillText('🏈 TD RECORD! 🏈', 0, 0)
    ctx.shadowBlur = 0
    ctx.fillStyle = '#ffe2b8'
    ctx.font = 'bold 18px Impact'
    const sub = g.tdNhsKnocked
      ? `TD RANK #${g.tdNhsRank}  ·  PASSED ${g.tdNhsKnocked}`
      : `TD RANK #${g.tdNhsRank}`
    ctx.fillText(sub, 0, 22)
    ctx.restore()
    ctx.globalAlpha = 1
    ctx.textAlign = 'left'
  }

  // ── Combo Meter (top center) — tiered fire-glow display ───────────
  // Tier thresholds: tier0=×1, tier1=×2, tier2=×4, tier3=×7+
  // Each tier changes the fill color and adds progressively wilder glow.
  if (g.multiplier > 1) {
    const mult = g.multiplier
    const tier = mult >= 7 ? 3 : mult >= 4 ? 2 : mult >= 2 ? 1 : 0
    const tierColors  = ['#FFD700', '#FF8C00', '#FF4500', '#FF1400']
    const tierGlows   = [C_GOLD,    '#FF8C00', '#FF4500', '#FF1400']
    const tierBlurs   = [12, 18, 26, 38]
    const tierLabels  = ['COMBO', 'COMBO', 'ON FIRE', 'UNSTOPPABLE']
    const barMaxMult  = [2, 4, 7, 12]   // upper end of each tier's fill bar
    const barMinMult  = [1, 2, 4, 7]
    const fillPct = tier < 3
      ? Math.min((mult - barMinMult[tier]) / (barMaxMult[tier] - barMinMult[tier]), 1)
      : Math.min((mult - 7) / 5, 1)
    const pulse = 1 + Math.sin(time * (8 + tier * 3)) * (0.03 + tier * 0.015)
    const comboW = isMobile ? 150 : 180
    const comboH = isMobile ? 54 : 64

    ctx.save()
    ctx.translate(GW / 2, topY + (isMobile ? 30 : 34))
    ctx.scale(pulse, pulse)
    ctx.globalAlpha = 0.92

    // Panel background
    ctx.fillStyle = 'rgba(0,0,0,0.62)'
    roundRect(ctx, -comboW/2, -comboH/2, comboW, comboH, 10)
    ctx.fill()

    // Panel border — glows with tier color
    ctx.strokeStyle = tierColors[tier]
    ctx.lineWidth = 2
    ctx.shadowColor = tierGlows[tier]
    ctx.shadowBlur = tierBlurs[tier] * 0.5
    roundRect(ctx, -comboW/2, -comboH/2, comboW, comboH, 10)
    ctx.stroke()
    ctx.shadowBlur = 0

    // Fill progress bar (bottom strip)
    const barH = 7
    const barY = comboH/2 - barH - 4
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    roundRect(ctx, -comboW/2 + 6, barY, comboW - 12, barH, 3)
    ctx.fill()
    if (fillPct > 0) {
      const barGrd = ctx.createLinearGradient(-comboW/2 + 6, 0, comboW/2 - 6, 0)
      barGrd.addColorStop(0, tierColors[tier])
      barGrd.addColorStop(1, tierGlows[tier])
      ctx.fillStyle = barGrd
      ctx.shadowColor = tierGlows[tier]
      ctx.shadowBlur = 8
      roundRect(ctx, -comboW/2 + 6, barY, Math.max(6, (comboW - 12) * fillPct), barH, 3)
      ctx.fill()
      ctx.shadowBlur = 0
    }

    // Fire sparks at tier >= 1
    if (tier >= 1) {
      const sparkCount = 4 + tier * 3
      for (let i = 0; i < sparkCount; i++) {
        const sp = (i / sparkCount) * Math.PI * 2 + time * (3 + tier)
        const sx = Math.sin(sp) * (comboW * 0.44)
        const sy = -comboH * 0.4 + Math.cos(sp * 1.3) * 4
        const sr = 1.5 + Math.abs(Math.sin(sp * 2.1)) * (tier * 1.2)
        ctx.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(sp))
        ctx.fillStyle = tierColors[tier]
        ctx.shadowColor = tierGlows[tier]
        ctx.shadowBlur = 6
        ctx.beginPath()
        ctx.arc(sx, sy, sr, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }
    }

    // ×N.N COMBO label
    ctx.globalAlpha = 0.95
    ctx.textAlign = 'center'
    ctx.fillStyle = tierColors[tier]
    ctx.shadowColor = tierGlows[tier]
    ctx.shadowBlur = tierBlurs[tier]
    ctx.font = `bold ${isMobile ? 22 : 26}px Impact`
    ctx.fillText(`×${mult.toFixed(1)} ${tierLabels[tier]}`, 0, isMobile ? 8 : 10)
    ctx.shadowBlur = 0

    ctx.restore()
    ctx.globalAlpha = 1
  }

  // ── Power-up inventory chip (top center, below multiplier) ──────
  // Persistent while the player is holding any bottles. Shows the bottle
  // icon, a "x N" counter, and a small "SPIN / TURBO" hint so players know
  // how to spend them. A brief grow-pulse plays when a new bottle is
  // collected (driven by the short `hydrationTimer`).
  //
  // On mobile we keep the chip on screen at all times — even when empty —
  // so touch players can tell at a glance whether they have ammo for the
  // JUMP / SPIN / TURBO buttons. When empty the chip renders in a dim
  // greyscale so it clearly reads as "unavailable".
  const showPowerChip = g.powerUps > 0 || isMobile
  if (showPowerChip) {
    const isEmpty = g.powerUps <= 0
    // Mobile shrinks the chip to fit small screens better; desktop keeps
    // its existing size.
    const chipW = isMobile ? 132 : 168
    const chipH = isMobile ? 36 : 44
    const cx = GW / 2
    const cy = topY + (g.multiplier > 1 ? 60 : 16) + chipH / 2

    // Pickup pulse: scale briefly bumps to ~1.18 then settles to 1.0.
    // Skip the pulse / flicker when empty — a dim chip should sit still.
    const pulse = !isEmpty && g.hydrationTimer > 0
      ? 1 + 0.18 * clamp(g.hydrationTimer / 0.9, 0, 1)
      : 1
    const flicker = isEmpty ? 0 : 0.78 + Math.sin(time * 14) * 0.18

    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(pulse, pulse)
    if (isEmpty) ctx.globalAlpha = 0.55

    // Background pill — dark with a purple edge glow (greyed when empty).
    ctx.fillStyle = isEmpty ? 'rgba(18, 18, 22, 0.7)' : 'rgba(20, 6, 40, 0.78)'
    roundRect(ctx, -chipW / 2, -chipH / 2, chipW, chipH, 12); ctx.fill()
    ctx.strokeStyle = isEmpty
      ? 'rgba(140, 140, 150, 0.45)'
      : `rgba(180, 120, 255, ${0.45 + 0.25 * flicker})`
    ctx.lineWidth = 1.5
    roundRect(ctx, -chipW / 2, -chipH / 2, chipW, chipH, 12); ctx.stroke()

    // Bottle icon (left side).
    const iconCx = -chipW / 2 + (isMobile ? 20 : 24)
    const iconCy = 0
    const iconW = isMobile ? 20 : 24
    const iconH = isMobile ? 30 : 36
    if (!isEmpty) {
      const halo = ctx.createRadialGradient(iconCx, iconCy, 0, iconCx, iconCy, 24)
      halo.addColorStop(0, `rgba(200, 120, 255, ${0.55 * flicker})`)
      halo.addColorStop(1, 'rgba(80, 0, 160, 0)')
      ctx.fillStyle = halo
      ctx.beginPath(); ctx.arc(iconCx, iconCy, 24, 0, Math.PI * 2); ctx.fill()
    }

    const img = getBottleImage()
    if (img && img.complete && img.naturalWidth > 0) {
      if (isEmpty) {
        // Render the bottle desaturated when empty: draw it once, then
        // overlay a grey tint via source-atop so it loses its color.
        ctx.drawImage(img, iconCx - iconW / 2, iconCy - iconH / 2, iconW, iconH)
        ctx.save()
        ctx.globalCompositeOperation = 'source-atop'
        ctx.fillStyle = 'rgba(120, 120, 130, 0.85)'
        ctx.fillRect(iconCx - iconW / 2, iconCy - iconH / 2, iconW, iconH)
        ctx.restore()
      } else {
        ctx.shadowColor = '#c266ff'
        ctx.shadowBlur = 8 * flicker
        ctx.drawImage(img, iconCx - iconW / 2, iconCy - iconH / 2, iconW, iconH)
        ctx.shadowBlur = 0
      }
    } else {
      ctx.fillStyle = isEmpty ? '#666670' : '#a040ff'
      ctx.beginPath()
      ctx.ellipse(iconCx, iconCy, iconW * 0.4, iconH * 0.45, 0, 0, Math.PI * 2)
      ctx.fill()
    }

    // Counter "x N" — big purple-glow number (grey when empty).
    if (!isEmpty) {
      ctx.shadowColor = '#9a4dff'
      ctx.shadowBlur = 10 * flicker
    }
    ctx.fillStyle = isEmpty ? '#9a9aa3' : '#e9d6ff'
    ctx.font = isMobile ? 'bold 22px Impact' : 'bold 26px Impact'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(`× ${g.powerUps}`, iconCx + (isMobile ? 14 : 18), 1)
    ctx.shadowBlur = 0

    // Small hint text on the right side.
    if (isMobile) {
      // Compact single-line hint to fit the smaller mobile chip.
      ctx.fillStyle = isEmpty ? 'rgba(180,180,190,0.6)' : 'rgba(220, 240, 255, 0.78)'
      ctx.font = 'bold 9px Impact'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(isEmpty ? 'NEED BOTTLE' : 'SPIN / TURBO', chipW / 2 - 8, 0)
    } else {
      ctx.fillStyle = 'rgba(220, 240, 255, 0.78)'
      ctx.font = 'bold 9px Impact'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText('SPIN / TURBO', chipW / 2 - 10, -8)
      ctx.fillStyle = 'rgba(180, 220, 255, 0.55)'
      ctx.font = '9px Impact'
      ctx.fillText('when empty', chipW / 2 - 10, 6)
    }

    // Reset baseline so subsequent HUD draws aren't affected.
    ctx.textBaseline = 'alphabetic'
    ctx.restore()
  }

  // ── Speed (top right) ───────────────────────────────────────────
  // Placement varies by layout:
  //   • Desktop:        top-right corner.
  //   • Portrait mobile: stacked below the score panel on the left
  //                      (the pause button occupies the top-right).
  //   • Landscape mobile: top-right but inset from the pause button —
  //                       there's plenty of horizontal room so we don't
  //                       want to crowd the score panel on the left.
  const speedX = isMobile
    ? IS_LANDSCAPE_MOBILE ? GW - 188 - 64 : 12
    : GW - 200
  const speedY = isMobile
    ? IS_LANDSCAPE_MOBILE ? topY : topY + 96
    : topY
  // Pulse the entire gauge (scale + golden glow) for ~1s after a level
  // begins, so the per-level speed step is impossible to miss.
  const bumpT  = clamp(g.speedBumpTimer, 0, 1)        // 1 → just-bumped, 0 → idle
  const bumpScale = 1 + 0.12 * bumpT
  const bumpGlow  = 18 * bumpT
  // Pulse 3× over the 1s window for a noticeable "throb".
  const bumpFlick = bumpT > 0 ? 0.6 + 0.4 * Math.abs(Math.sin(bumpT * Math.PI * 3)) : 1
  ctx.save()
  if (bumpT > 0) {
    const cx = speedX + 94, cy = speedY + 38
    ctx.translate(cx, cy)
    ctx.scale(bumpScale, bumpScale)
    ctx.translate(-cx, -cy)
    ctx.shadowColor = '#ffcc00'
    ctx.shadowBlur  = bumpGlow * bumpFlick
  }
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  roundRect(ctx, speedX, speedY, 188, 76, 10); ctx.fill()
  if (bumpT > 0) {
    // Bright gold border ring during the pulse.
    ctx.strokeStyle = `rgba(255, 204, 0, ${0.55 + 0.4 * bumpFlick})`
    ctx.lineWidth = 2
    roundRect(ctx, speedX, speedY, 188, 76, 10); ctx.stroke()
  }
  ctx.shadowBlur = 0
  ctx.fillStyle = bumpT > 0 ? '#ffe066' : 'rgba(255,255,255,0.7)'
  ctx.font = '14px Impact'; ctx.textAlign = 'right'
  ctx.fillText(bumpT > 0 ? 'SPEED UP!' : 'SPEED', speedX + 184, speedY + 20)
  const spd = Math.min((g.speed - BASE_SCROLL) / (MAX_SCROLL - BASE_SCROLL), 1)
  ctx.fillStyle = 'rgba(255,255,255,0.18)'
  roundRect(ctx, speedX + 6, speedY + 26, 170, 14, 4); ctx.fill()
  // Speed-bar fill: gold while boosting (turbo) OR pulsing on a level
  // bump, otherwise the usual green→amber→red speed gradient.
  ctx.fillStyle = (g.boosting || bumpT > 0)
    ? '#ffcc00'
    : spd > 0.8 ? '#ff4444' : spd > 0.5 ? '#ffaa00' : '#44ee88'
  roundRect(ctx, speedX + 6, speedY + 26, Math.max(8, 170 * spd), 14, 4); ctx.fill()
  if (bumpT > 0) {
    ctx.shadowColor = '#ffcc00'
    ctx.shadowBlur  = 12 * bumpFlick
  }
  ctx.fillStyle = bumpT > 0 ? '#fff7c2' : 'rgba(255,255,255,0.8)'
  ctx.font = bumpT > 0 ? 'bold 15px Impact' : '13px Impact'
  // Normalize MPH by SCREEN_SCALE so the readout matches between desktop
  // and mobile (raw px/s is scaled up on tall portraits, but the player's
  // yards/s — which is what the dial really represents — is the same).
  ctx.fillText(`${Math.round(g.speed / 10 / SCREEN_SCALE)} MPH`, speedX + 184, speedY + 60)
  ctx.shadowBlur = 0
  ctx.restore()

  // ── Opponent badge (just under the Speed panel) ─────────────────
  // Small "VS <SCHOOL>" label tinted with the current opponent's primary
  // color so the player can connect the defenders on screen to the team
  // they're facing this level. Sits flush under the Speed panel on every
  // layout (desktop / portrait / landscape mobile) since the Speed panel's
  // own placement already accounts for safe-areas and the pause button.
  {
    const oppName = DEFENDER_DISPLAY_NAMES[oppMeta.variant]
    const badgeX = speedX
    const badgeY = speedY + 76 + 6
    const badgeW = 188
    const badgeH = 26
    ctx.save()
    // Filled pill in the school's primary color, with a thin accent stroke.
    ctx.fillStyle = oppMeta.primary
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 8); ctx.fill()
    ctx.strokeStyle = oppMeta.secondary
    ctx.lineWidth = 1.5
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 8); ctx.stroke()
    // "VS" in the accent color, school name in white for contrast.
    // Auto-shrink the name font if the longest school names (e.g.
    // "NORTH CAROLINA A&T") would otherwise overflow the badge width.
    ctx.textBaseline = 'middle'
    const cy = badgeY + badgeH / 2
    const innerPad = 10
    const maxNameWidth = badgeW - innerPad * 2
    ctx.font = 'bold 12px Impact'
    const vsW = ctx.measureText('VS ').width
    let nameSize = 15
    ctx.font = `bold ${nameSize}px Impact`
    while (ctx.measureText(oppName).width + vsW > maxNameWidth && nameSize > 10) {
      nameSize -= 1
      ctx.font = `bold ${nameSize}px Impact`
    }
    const nameW = ctx.measureText(oppName).width
    const totalW = vsW + nameW
    const startX = badgeX + (badgeW - totalW) / 2
    ctx.font = 'bold 12px Impact'
    ctx.fillStyle = oppMeta.secondary
    ctx.textAlign = 'left'
    ctx.fillText('VS ', startX, cy + 1)
    ctx.font = `bold ${nameSize}px Impact`
    ctx.fillStyle = '#FFFFFF'
    ctx.fillText(oppName, startX + vsW, cy + 1)
    ctx.textBaseline = 'alphabetic'
    ctx.restore()
  }

  // ── Move hints (desktop only — touch buttons show this on mobile) ──
  if (CURRENT_MODE !== 'mobile') {
    const hasAmmo = g.powerUps > 0
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    roundRect(ctx, 12, GH - 68, 200, 56, 10); ctx.fill()
    ctx.textAlign = 'center'
    ctx.fillStyle = hasAmmo ? C_GOLD : 'rgba(255,215,0,0.35)'
    ctx.font = 'bold 11px Impact'
    ctx.fillText('MOVES (need power-up)', 112, GH - 52)
    ctx.fillStyle = hasAmmo ? C_WHITE : 'rgba(255,255,255,0.35)'
    ctx.font = '10px Impact'
    ctx.fillText('JUMP [↑]  SPIN [X]  TURBO [C]', 112, GH - 32)
    ctx.fillStyle = hasAmmo ? '#c266ff' : 'rgba(194,102,255,0.35)'
    ctx.font = '10px Impact'
    ctx.fillText(`${g.powerUps} / ${POWER_UP_MAX} power-up${g.powerUps !== 1 ? 's' : ''}`, 112, GH - 16)
  }

  ctx.lineWidth = 1; ctx.textAlign = 'left'
}

// ─── Overlays ─────────────────────────────────────────────────────────────────
//
// "ALCORN vs OPPONENT" intro card. Tinted with the opponent's primary
// color so each level reads as a distinct rivalry. Scaled by an intro
// pop-in / outro fade so the card animates in, holds, then dismisses.
// Helper: smoothstep easing
function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}
// Helper: bounce-overshoot easing for badge pop
function bounceIn(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  if (c < 0.72) return 2.2 * c * c
  if (c < 0.9)  return 2.2 * c * c - 0.7 * (c - 0.72) * (c - 0.72) * 15
  return 1 + (c - 1) * (c - 1) * 6 * (c - 0.7)
}

function drawVersusCard(
  ctx: CanvasRenderingContext2D,
  g: GS,
  time: number,
) {
  const opp = SCHOOL_META[g.opponent]
  const elapsed = VERSUS_DUR - g.versusTimer
  // Smooth intro/outro easing
  const rawIn  = elapsed / 0.42
  const rawOut = g.versusTimer / 0.30
  const popIn  = smoothstep(Math.min(rawIn, 1))
  const popOut = smoothstep(Math.min(rawOut, 1))
  const alpha  = Math.min(popIn, popOut)
  const isMobile = CURRENT_MODE === 'mobile'

  if (alpha < 0.01) return

  // ── Cinematic dark backdrop ─────────────────────────────────────────
  ctx.save()
  ctx.globalAlpha = 0.88 * alpha
  ctx.fillStyle = '#04010f'
  ctx.fillRect(0, 0, GW, GH)
  ctx.globalAlpha = alpha

  // Diagonal color panels slide in from sides
  const panelSlide = smoothstep(Math.min(elapsed / 0.55, 1))
  // Left panel (Alcorn primary) slides in from left
  const leftX = -GW * 0.5 * (1 - panelSlide)
  ctx.save()
  ctx.globalAlpha = alpha * 0.62
  ctx.fillStyle = ALCORN_META.primary
  ctx.beginPath()
  ctx.moveTo(leftX, 0)
  ctx.lineTo(leftX + GW * 0.5 + 60, 0)
  ctx.lineTo(leftX + GW * 0.5 - 20, GH)
  ctx.lineTo(leftX, GH)
  ctx.closePath()
  ctx.fill()
  // Right panel (opponent primary) slides in from right
  const rightX = GW * 0.5 * (1 - panelSlide)
  ctx.fillStyle = opp.primary
  ctx.beginPath()
  ctx.moveTo(GW + rightX, 0)
  ctx.lineTo(GW * 0.5 + 20 + rightX, 0)
  ctx.lineTo(GW * 0.5 - 60 + rightX, GH)
  ctx.lineTo(GW + rightX, GH)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  // Center vignette overlay
  ctx.save()
  ctx.globalAlpha = alpha * 0.45
  const vigGrd = ctx.createRadialGradient(GW/2, GH/2, 0, GW/2, GH/2, GW * 0.7)
  vigGrd.addColorStop(0, 'rgba(0,0,0,0)')
  vigGrd.addColorStop(1, 'rgba(0,0,0,0.85)')
  ctx.fillStyle = vigGrd
  ctx.fillRect(0, 0, GW, GH)
  ctx.restore()

  // Scanlines for cinematic texture
  ctx.save()
  ctx.globalAlpha = alpha * 0.06
  ctx.fillStyle = '#000000'
  for (let sy = 0; sy < GH; sy += 4) {
    ctx.fillRect(0, sy, GW, 2)
  }
  ctx.restore()

  // ── Animated glowing gradient border ───────────────────────────────
  ctx.save()
  ctx.globalAlpha = alpha * (0.7 + 0.3 * Math.sin(time * 5))
  const borderGrd = ctx.createLinearGradient(0, 0, GW, GH)
  const tShift = (time * 0.3) % 1
  borderGrd.addColorStop(Math.max(0, tShift - 0.01), ALCORN_META.secondary)
  borderGrd.addColorStop(tShift,                       C_GOLD)
  borderGrd.addColorStop(Math.min(1, tShift + 0.01), opp.secondary)
  ctx.strokeStyle = borderGrd
  ctx.lineWidth = 4
  ctx.strokeRect(4, 4, GW - 8, GH - 8)
  ctx.restore()

  // ── Card ────────────────────────────────────────────────────────────
  ctx.save()
  ctx.translate(GW / 2, GH / 2)
  const breathe    = 1 + Math.sin(time * 3.5) * 0.012
  const cardScale  = smoothstep(Math.min(elapsed / 0.38, 1)) * breathe
  ctx.scale(cardScale, cardScale)
  ctx.globalAlpha = alpha

  const cardW = isMobile ? Math.min(GW - 36, 560) : 840
  const cardH = isMobile ? 230 : 290

  // Card shadow
  ctx.save()
  ctx.shadowColor = '#000'
  ctx.shadowBlur  = 60
  ctx.fillStyle = 'rgba(0,0,0,0.7)'
  roundRect(ctx, -cardW/2 + 8, -cardH/2 + 8, cardW, cardH, 20)
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.restore()

  // Card body
  ctx.fillStyle = 'rgba(6, 3, 22, 0.90)'
  roundRect(ctx, -cardW/2, -cardH/2, cardW, cardH, 18)
  ctx.fill()

  // Animated gradient border on card
  ctx.lineWidth = 3.5
  const t2 = (time * 0.5) % 1
  const cardBorderGrd = ctx.createLinearGradient(-cardW/2, 0, cardW/2, 0)
  cardBorderGrd.addColorStop(0,   ALCORN_META.secondary)
  cardBorderGrd.addColorStop(0.3 + t2 * 0.4, C_GOLD)
  cardBorderGrd.addColorStop(1,   opp.secondary)
  ctx.strokeStyle = cardBorderGrd
  ctx.shadowColor = C_GOLD
  ctx.shadowBlur = 12 + 8 * Math.sin(time * 4)
  roundRect(ctx, -cardW/2, -cardH/2, cardW, cardH, 18)
  ctx.stroke()
  ctx.shadowBlur = 0

  // ── Helmet fly-in ───────────────────────────────────────────────────
  const helmetFly  = smoothstep(Math.min((elapsed - 0.08) / 0.45, 1))
  const teamSize   = isMobile ? 34 : 50
  const helmetR    = isMobile ? 40 : 58
  const helmetX    = cardW/2 - helmetR - 10
  const textX      = cardW/4 - 38

  // Left half color fill (Alcorn)
  ctx.save()
  ctx.globalAlpha = alpha * 0.82
  ctx.fillStyle = ALCORN_META.primary
  ctx.fillRect(-cardW/2 + 8, -cardH/2 + 8, cardW/2 - 68, cardH - 16)
  ctx.restore()

  // Right half color fill (opponent)
  ctx.save()
  ctx.globalAlpha = alpha * 0.82
  ctx.fillStyle = opp.primary
  ctx.fillRect(60, -cardH/2 + 8, cardW/2 - 68, cardH - 16)
  ctx.restore()

  // Alcorn helmet slides in from left
  const alcHX = -helmetX - (1 - helmetFly) * cardW * 0.6
  {
    const alcImg = getMenuHelmetImage(MENU_ALCORN_HELMET.src)
    const helmetY = 0
    ctx.save()
    ctx.shadowColor = ALCORN_META.secondary
    ctx.shadowBlur  = 22 + 12 * Math.sin(time * 4)
    if (alcImg) drawHelmetImage(ctx, alcHX, helmetY, helmetR, alcImg, false)
    else drawHelmet(ctx, alcHX, helmetY, helmetR,
                    ALCORN_META.primary, ALCORN_META.secondary, '82')
    ctx.shadowBlur = 0
    ctx.restore()
  }

  // Opponent helmet slides in from right
  const oppHX = helmetX + (1 - helmetFly) * cardW * 0.6
  {
    const oppSrc = OPPONENT_HELMET_SRC[g.opponent]
    const oppImg = oppSrc ? getMenuHelmetImage(oppSrc) : undefined
    const helmetY = 0
    ctx.save()
    ctx.shadowColor = opp.secondary
    ctx.shadowBlur  = 22 + 12 * Math.sin(time * 4 + 1.2)
    if (oppImg) drawHelmetImage(ctx, oppHX, helmetY, helmetR, oppImg, true)
    else drawHelmet(ctx, oppHX, helmetY, helmetR,
                    opp.primary, opp.secondary, '1')
    ctx.shadowBlur = 0
    ctx.restore()
  }

  // ── Team name labels ────────────────────────────────────────────────
  ctx.textAlign = 'center'
  const labelMax = cardW/2 - helmetR * 2 - 60

  let alcFontSize = teamSize
  ctx.font = `bold ${alcFontSize}px Impact`
  while (ctx.measureText(ALCORN_META.display).width > labelMax && alcFontSize > 18) {
    alcFontSize -= 2
    ctx.font = `bold ${alcFontSize}px Impact`
  }
  ctx.fillStyle = ALCORN_META.secondary
  ctx.shadowColor = ALCORN_META.secondary
  ctx.shadowBlur = 16
  ctx.fillText(ALCORN_META.display, -textX, isMobile ? 42 : 60)
  ctx.shadowBlur = 0
  ctx.fillStyle = C_WHITE
  ctx.font = isMobile ? 'bold 14px Impact' : 'bold 17px Impact'
  ctx.fillText('HOME', -textX, isMobile ? -82 : -106)

  let oppFontSize = teamSize
  ctx.font = `bold ${oppFontSize}px Impact`
  while (ctx.measureText(opp.display).width > labelMax && oppFontSize > 18) {
    oppFontSize -= 2
    ctx.font = `bold ${oppFontSize}px Impact`
  }
  ctx.fillStyle = opp.secondary
  ctx.shadowColor = opp.secondary
  ctx.shadowBlur = 16
  ctx.fillText(opp.display, textX, isMobile ? 42 : 60)
  ctx.shadowBlur = 0
  ctx.fillStyle = C_WHITE
  ctx.font = isMobile ? 'bold 14px Impact' : 'bold 17px Impact'
  ctx.fillText('AWAY', textX, isMobile ? -82 : -106)

  // ── VS badge bounce-in with overshoot ──────────────────────────────
  const vsFly  = bounceIn(Math.min((elapsed - 0.14) / 0.50, 1))
  const vsR    = isMobile ? 40 : 54
  ctx.save()
  ctx.scale(vsFly, vsFly)
  ctx.fillStyle = C_GOLD
  ctx.shadowColor = C_GOLD
  ctx.shadowBlur = 28 + 14 * Math.sin(time * 6)
  ctx.beginPath(); ctx.arc(0, 0, vsR, 0, Math.PI * 2); ctx.fill()
  ctx.shadowBlur = 0
  ctx.fillStyle = '#000'
  ctx.font = `bold ${isMobile ? 36 : 50}px Impact`
  ctx.fillText('VS', 0, isMobile ? 14 : 18)
  ctx.restore()

  // ── LEVEL N kicker (fades in after card appears) ────────────────────
  const levelFade = smoothstep(Math.min((elapsed - 0.20) / 0.30, 1))
  ctx.save()
  ctx.globalAlpha = alpha * levelFade
  ctx.font = `bold ${isMobile ? 36 : 52}px Impact`
  ctx.fillStyle = C_GOLD
  ctx.shadowColor = C_GOLD
  ctx.shadowBlur = 26
  ctx.fillText(`LEVEL ${g.level}`, 0, isMobile ? -(cardH/2) - 26 : -(cardH/2) - 36)
  ctx.shadowBlur = 0
  ctx.restore()

  // ── Subtitle fade-in ────────────────────────────────────────────────
  const subtitleFade = smoothstep(Math.min((elapsed - 0.28) / 0.30, 1))
  ctx.save()
  ctx.globalAlpha = alpha * subtitleFade
  ctx.fillStyle = 'rgba(255,255,255,0.88)'
  ctx.font = isMobile ? 'bold 15px Impact' : 'bold 20px Impact'
  ctx.fillText(
    `FIRST TO ${LEVEL_TD_GOAL} TOUCHDOWNS WINS`,
    0, cardH/2 + (isMobile ? 30 : 44),
  )
  ctx.restore()

  ctx.restore()   // card transform
  ctx.restore()   // backdrop
  ctx.globalAlpha = 1
  ctx.textAlign = 'left'
}

// "ALCORN WINS!" beat overlay — fires when the player clears 10 TDs in
// a level. Mirrors the touchdown overlay's typography (gold/white/gold
// gradient, big Impact, drop shadow) so the cadence reads as a normal
// touchdown celebration with swapped copy.
function drawAlcornWins(
  ctx: CanvasRenderingContext2D,
  g: GS,
  time: number,
) {
  const elapsed   = LEVEL_WIN_DUR - g.levelWinTimer
  const freezeT   = clamp(elapsed / TD_FREEZE_DUR, 0, 1)
  const popIn     = clamp(elapsed / 0.22, 0, 1)
  const settle    = clamp((elapsed - TD_FREEZE_DUR) / 0.5, 0, 1)
  const baseScale = 0.55 + popIn * 0.55 - settle * 0.18
  const pulse     = 1 + Math.sin(time * (freezeT < 1 ? 9 : 5)) * 0.07
  const scale     = baseScale * pulse

  ctx.save(); ctx.translate(GW/2, GH/2 - 90); ctx.scale(scale, scale)
  ctx.textAlign = 'center'
  ctx.font = 'bold 120px Impact'
  ctx.strokeStyle = '#000'; ctx.lineWidth = 8
  ctx.strokeText('ALCORN WINS!', 0, 0)
  const grd = ctx.createLinearGradient(-360, -90, 360, 10)
  grd.addColorStop(0, ALCORN_META.secondary)
  grd.addColorStop(0.5, '#fff')
  grd.addColorStop(1, ALCORN_META.primary)
  ctx.fillStyle = grd
  ctx.shadowColor = C_GOLD; ctx.shadowBlur = 36
  ctx.fillText('ALCORN WINS!', 0, 0)
  ctx.shadowBlur = 0
  ctx.restore()

  // ── Stat readout ─────────────────────────────────────────────────────
  // Eases in just after the headline pops so the eye lands on the win
  // first, then the supporting stats. Shows the points earned this
  // level, the persisted per-level best, and a pulsing "NEW BEST!"
  // badge when the player beat their previous record.
  const statT = clamp((elapsed - 0.45) / 0.4, 0, 1)
  if (statT > 0) {
    ctx.save()
    ctx.globalAlpha = statT
    ctx.textAlign = 'center'

    // Line 1: per-level points + best
    ctx.font = 'bold 30px Impact'
    ctx.strokeStyle = '#000'; ctx.lineWidth = 5
    const statLine =
      `LEVEL SCORE: ${g.levelWinScore.toLocaleString()}  ·  BEST: ${g.levelWinBest.toLocaleString()}`
    ctx.strokeText(statLine, GW / 2, GH / 2 + 6)
    ctx.fillStyle = '#fff'
    ctx.fillText(statLine, GW / 2, GH / 2 + 6)

    // Line 2: NEW BEST! badge — only when this run beat the prior best.
    if (g.levelWinIsNewBest) {
      const badgePulse = 1 + Math.sin(time * 7) * 0.06
      ctx.save()
      ctx.translate(GW / 2, GH / 2 + 56)
      ctx.scale(badgePulse, badgePulse)
      ctx.font = 'bold 36px Impact'
      ctx.strokeStyle = '#000'; ctx.lineWidth = 6
      ctx.strokeText('NEW BEST!', 0, 0)
      ctx.shadowColor = C_GOLD; ctx.shadowBlur = 22
      ctx.fillStyle = ALCORN_META.secondary
      ctx.fillText('NEW BEST!', 0, 0)
      ctx.shadowBlur = 0
      ctx.restore()
    }

    ctx.restore()
  }

  ctx.textAlign = 'left'
}

// ─── Helmet drawing helper (used in menu intro animation) ────────────────────
// Draws a simplified top-down football helmet at (cx, cy) with the given
// radius, primary/secondary colors, and jersey number label.
function drawHelmet(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  primary: string, secondary: string,
  label: string,
) {
  ctx.save()

  // Dome shadow
  ctx.beginPath()
  ctx.ellipse(cx + 4, cy + 6, r, r * 0.82, 0, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0,0,0,0.38)'
  ctx.fill()

  // Dome gradient fill
  const domeGrd = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r)
  domeGrd.addColorStop(0, lighten(primary, 0.45))
  domeGrd.addColorStop(0.5, primary)
  domeGrd.addColorStop(1, darken(primary, 0.3))
  ctx.beginPath()
  ctx.ellipse(cx, cy, r, r * 0.82, 0, 0, Math.PI * 2)
  ctx.fillStyle = domeGrd
  ctx.fill()

  // Helmet stripe (vertical band in secondary color)
  ctx.save()
  ctx.beginPath()
  ctx.ellipse(cx, cy, r, r * 0.82, 0, 0, Math.PI * 2)
  ctx.clip()
  ctx.fillStyle = secondary
  ctx.globalAlpha = 0.75
  ctx.fillRect(cx - r * 0.14, cy - r * 0.82, r * 0.28, r * 1.64)
  ctx.globalAlpha = 1
  ctx.restore()

  // Helmet rim / outline
  ctx.beginPath()
  ctx.ellipse(cx, cy, r, r * 0.82, 0, 0, Math.PI * 2)
  ctx.strokeStyle = darken(primary, 0.5)
  ctx.lineWidth = 3
  ctx.stroke()

  // Face-mask (two horizontal bars across the front)
  ctx.strokeStyle = secondary
  ctx.lineWidth = r * 0.12
  ctx.lineCap = 'round'
  for (let i = 0; i < 2; i++) {
    const barY = cy + r * (i === 0 ? 0.05 : 0.32)
    const halfW = r * 0.62
    ctx.beginPath()
    ctx.moveTo(cx - halfW, barY)
    ctx.lineTo(cx + halfW, barY)
    ctx.stroke()
  }

  // Jersey number
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${Math.round(r * 0.7)}px Impact`
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 4
  ctx.strokeText(label, cx, cy - r * 0.15)
  ctx.fillStyle = secondary
  ctx.shadowColor = secondary
  ctx.shadowBlur = 8
  ctx.fillText(label, cx, cy - r * 0.15)
  ctx.shadowBlur = 0
  ctx.textBaseline = 'alphabetic'

  ctx.restore()
}

function lighten(hex: string, amt: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const rr = Math.min(255, Math.round(r + (255 - r) * amt))
  const gg = Math.min(255, Math.round(g + (255 - g) * amt))
  const bb = Math.min(255, Math.round(b + (255 - b) * amt))
  return `rgb(${rr},${gg},${bb})`
}

function darken(hex: string, amt: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgb(${Math.round(r*(1-amt))},${Math.round(g*(1-amt))},${Math.round(b*(1-amt))})`
}

// ─── Menu helmet image registry ───────────────────────────────────────────────
// Real HBCU helmet images for the start-screen clash animation.
// Alcorn is always the right-side helmet; opponents rotate on the left.
interface MenuHelmetEntry { name: string; src: string }

const MENU_ALCORN_HELMET: MenuHelmetEntry = {
  name: 'ALCORN',
  src: '/sprites/helmets/alcorn.png',
}

const MENU_OPPONENT_HELMETS: MenuHelmetEntry[] = [
  { name: 'SOUTHERN',               src: '/sprites/helmets/southern.png' },
  { name: 'GRAMBLING',              src: '/sprites/helmets/grambling.png' },
  { name: 'FAMU',                   src: '/sprites/helmets/famu.png' },
  { name: 'NC A&T',                 src: '/sprites/helmets/ncat.png' },
  { name: 'HAMPTON',                src: '/sprites/helmets/hampton.png' },
  { name: 'TEXAS SOUTHERN',         src: '/sprites/helmets/texas-southern.png' },
  { name: 'PRAIRIE VIEW',           src: '/sprites/helmets/prairie-view.png' },
  { name: 'BETHUNE-COOKMAN',        src: '/sprites/helmets/bethune-cookman.png' },
  { name: 'JACKSON STATE',          src: '/sprites/helmets/jackson-state.png' },
  { name: 'HOWARD',                 src: '/sprites/helmets/howard.png' },
  { name: 'TUSKEGEE',               src: '/sprites/helmets/tuskegee.png' },
  { name: 'ALABAMA STATE',          src: '/sprites/helmets/alabama-state.png' },
  { name: 'ALABAMA A&M',            src: '/sprites/helmets/alabama-amm.png' },
  { name: 'SC STATE',               src: '/sprites/helmets/south-carolina-state.png' },
  { name: 'MISS. VALLEY',           src: '/sprites/helmets/mississippi-valley-state.png' },
  { name: 'MD EASTERN SHORE',       src: '/sprites/helmets/maryland-eastern-shore.png' },
  { name: 'WINSTON-SALEM',          src: '/sprites/helmets/winston-salem-state.png' },
  { name: 'DELAWARE STATE',         src: '/sprites/helmets/delaware-state.png' },
  { name: 'UAPB',                   src: '/sprites/helmets/uapb.png' },
  { name: 'VIRGINIA STATE',         src: '/sprites/helmets/virginia-state.png' },
  { name: 'ECSU',                   src: '/sprites/helmets/ecsu.png' },
  { name: 'LANGSTON',               src: '/sprites/helmets/langston.png' },
  { name: 'SHAW',                   src: '/sprites/helmets/shaw.png' },
  { name: 'LINCOLN (PA)',           src: '/sprites/helmets/lincoln-pa.png' },
]

// Mapping from OpponentSchool variant key → helmet sprite src. Used by the
// versus card so the matchup splash mirrors the start-screen clash with real
// HBCU helmet images instead of the procedural drawHelmet fallback.
const OPPONENT_HELMET_SRC: Record<OpponentSchool, string> = {
  southern:       '/sprites/helmets/southern.png',
  grambling:      '/sprites/helmets/grambling.png',
  famu:           '/sprites/helmets/famu.png',
  ncat:           '/sprites/helmets/ncat.png',
  morehouse:      '/sprites/helmets/morehouse.png',
  hampton:        '/sprites/helmets/hampton.png',
  texassouthern:  '/sprites/helmets/texas-southern.png',
  prairieview:    '/sprites/helmets/prairie-view.png',
  bethunecookman: '/sprites/helmets/bethune-cookman.png',
}

// Image cache: src → loaded HTMLImageElement, null on error, undefined = not started
const _menuHelmetCache = new Map<string, HTMLImageElement | null>()

function loadMenuHelmetImages(): void {
  const srcs = new Set<string>([
    MENU_ALCORN_HELMET.src,
    ...MENU_OPPONENT_HELMETS.map(e => e.src),
    ...Object.values(OPPONENT_HELMET_SRC),
  ])
  for (const src of srcs) {
    if (_menuHelmetCache.has(src)) continue
    const img = new Image()
    _menuHelmetCache.set(src, img)
    img.src = src
    img.onerror = () => { _menuHelmetCache.set(src, null) }
  }
}

// Returns the loaded image, null on failure, or undefined if not ready yet.
function getMenuHelmetImage(src: string): HTMLImageElement | null | undefined {
  const v = _menuHelmetCache.get(src)
  if (v == null) return v           // null (failed) or undefined (not started)
  if (!v.complete || v.naturalWidth === 0) return undefined  // still loading
  return v
}

// Draw a helmet image centered at (cx, cy) fitting within a circle of radius r.
// flipX=true mirrors it horizontally so the face mask faces the opposite direction.
function drawHelmetImage(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  img: HTMLImageElement,
  flipX: boolean,
) {
  const iw = img.naturalWidth, ih = img.naturalHeight
  const scale = (r * 2.2) / Math.max(iw, ih)
  const dw = iw * scale, dh = ih * scale
  ctx.save()
  ctx.translate(cx, cy)
  if (flipX) ctx.scale(-1, 1)
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh)
  ctx.restore()
}

// ─── Procedural stadium backdrop (menu) ───────────────────────────────────────
// Drawn after the flat dark overlay and before the helmet / title / effect
// layers on the menu screen. Pure 2D-canvas — no image assets. Produces a
// moody, cinematic stadium environment behind the clashing helmets:
//   • deep purple/navy atmospheric gradient for depth
//   • two stadium floodlight cones radiating from the top corners (with a
//     subtle flicker so the scene feels alive)
//   • tiered crowd silhouettes across the lower-mid band
//   • a soft fog band just above the crowd
// Fully self-contained — does not touch any global state.
function drawStadiumBackdrop(
  ctx: CanvasRenderingContext2D,
  time: number,
) {
  ctx.save()

  // ── Atmospheric gradient (deep navy → faint purple → near-black) ──────────
  const atm = ctx.createRadialGradient(
    GW / 2, GH * 0.35, GW * 0.05,
    GW / 2, GH * 0.55, GW * 0.75,
  )
  atm.addColorStop(0,   'rgba(60, 30, 95, 0.55)')
  atm.addColorStop(0.45,'rgba(28, 18, 60, 0.45)')
  atm.addColorStop(1,   'rgba(4,  2, 18, 0.65)')
  ctx.fillStyle = atm
  ctx.fillRect(0, 0, GW, GH)

  // ── Stadium floodlight cones from top-left and top-right corners ──────────
  // Light origins sit slightly above the visible top edge so the cones read
  // as descending from rim-mounted floodlight banks.
  const flicker1 = 0.85 + Math.sin(time * 3.1) * 0.06 + Math.sin(time * 11.7) * 0.03
  const flicker2 = 0.85 + Math.sin(time * 2.4 + 1.3) * 0.07 + Math.sin(time * 9.1 + 0.5) * 0.03

  const drawConeFromCorner = (
    originX: number, originY: number,
    aimX: number,    aimY: number,
    spread: number, length: number, intensity: number,
  ) => {
    const ang = Math.atan2(aimY - originY, aimX - originX)
    const halfSpread = spread / 2
    // Tip glow
    const glow = ctx.createRadialGradient(originX, originY, 4, originX, originY, length * 0.45)
    glow.addColorStop(0,   `rgba(255, 240, 200, ${0.55 * intensity})`)
    glow.addColorStop(0.4, `rgba(255, 220, 170, ${0.18 * intensity})`)
    glow.addColorStop(1,   'rgba(255, 220, 170, 0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(originX, originY, length * 0.45, 0, Math.PI * 2)
    ctx.fill()
    // Cone body — radial gradient along the cone axis
    ctx.save()
    ctx.translate(originX, originY)
    ctx.rotate(ang)
    const cone = ctx.createLinearGradient(0, 0, length, 0)
    cone.addColorStop(0,   `rgba(255, 235, 190, ${0.28 * intensity})`)
    cone.addColorStop(0.5, `rgba(220, 195, 230, ${0.10 * intensity})`)
    cone.addColorStop(1,   'rgba(180, 160, 220, 0)')
    ctx.fillStyle = cone
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(length, Math.tan(halfSpread) * length)
    ctx.lineTo(length, -Math.tan(halfSpread) * length)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  ctx.globalCompositeOperation = 'screen'
  drawConeFromCorner(
    GW * 0.05, -GH * 0.05,
    GW * 0.60, GH * 0.85,
    0.55, GH * 1.15, flicker1,
  )
  drawConeFromCorner(
    GW * 0.95, -GH * 0.05,
    GW * 0.40, GH * 0.85,
    0.55, GH * 1.15, flicker2,
  )
  ctx.globalCompositeOperation = 'source-over'

  // ── Tiered crowd silhouettes ──────────────────────────────────────────────
  // Three rows of head-shaped bumps stacked on a dark bleacher band.
  // Each row is darker / slightly offset to fake depth.
  const crowdTopY = GH * 0.62
  const crowdRows = [
    { y: crowdTopY,           headR: GH * 0.018, step: GH * 0.034, color: 'rgba(10,  6, 22, 0.92)' },
    { y: crowdTopY + GH*0.04, headR: GH * 0.020, step: GH * 0.038, color: 'rgba(14,  8, 28, 0.95)' },
    { y: crowdTopY + GH*0.085,headR: GH * 0.023, step: GH * 0.042, color: 'rgba(18, 10, 34, 0.97)' },
  ]
  for (let r = 0; r < crowdRows.length; r++) {
    const row = crowdRows[r]
    ctx.fillStyle = row.color
    // Bleacher band
    ctx.fillRect(0, row.y, GW, GH - row.y)
    // Heads — phase-shift each row so they don't line up vertically
    const phase = r * 0.37
    ctx.beginPath()
    for (let x = -row.step; x < GW + row.step; x += row.step) {
      const jitter = Math.sin((x * 0.013) + phase) * row.headR * 0.35
      ctx.moveTo(x + row.headR, row.y + jitter)
      ctx.arc(x, row.y + jitter, row.headR, 0, Math.PI * 2)
    }
    ctx.fill()
  }

  // ── Subtle atmospheric fog band hovering above the crowd ──────────────────
  const fog = ctx.createLinearGradient(0, crowdTopY - GH * 0.10, 0, crowdTopY + GH * 0.04)
  fog.addColorStop(0, 'rgba(120, 90, 160, 0)')
  fog.addColorStop(0.5,'rgba(120, 90, 160, 0.18)')
  fog.addColorStop(1, 'rgba(60,  40, 100, 0)')
  ctx.fillStyle = fog
  ctx.fillRect(0, crowdTopY - GH * 0.10, GW, GH * 0.16)

  ctx.restore()
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  g: GS,
  time: number,
  lastSubmitted: LeaderboardEntry | null,
) {
  if (g.phase === 'versus') {
    drawVersusCard(ctx, g, time)
    menuLastObservedPhase = g.phase
    return
  }
  if (g.phase === 'levelwin') {
    drawAlcornWins(ctx, g, time)
    menuLastObservedPhase = g.phase
    return
  }
  if (g.phase === 'touchdown') {
    // Score popup gets dramatically larger during the freeze window, then
    // settles back as the field starts scrolling again. Pulse cadence is
    // also faster early so the headline visibly dances with the celebration.
    const elapsed   = TD_DUR - g.tdTimer
    const freezeT   = clamp(elapsed / TD_FREEZE_DUR, 0, 1)
    // Pop-in: scale ramps from 0.55 → 1 over the first ~220ms, then settles.
    const popIn     = clamp(elapsed / 0.22, 0, 1)
    const settle    = clamp((elapsed - TD_FREEZE_DUR) / 0.5, 0, 1)
    const baseScale = 0.55 + popIn * 0.55 - settle * 0.18   // peaks at 1.10 mid-freeze
    const pulse     = 1 + Math.sin(time * (freezeT < 1 ? 9 : 5)) * 0.07
    const scale     = baseScale * pulse

    ctx.save(); ctx.translate(GW/2, GH/2 - 90); ctx.scale(scale, scale)
    ctx.textAlign = 'center'
    ctx.font = 'bold 120px Impact'
    ctx.strokeStyle = '#000'; ctx.lineWidth = 8
    ctx.strokeText('TOUCHDOWN!', 0, 0)
    const tdGrd = ctx.createLinearGradient(-360, -90, 360, 10)
    tdGrd.addColorStop(0, '#FFD700'); tdGrd.addColorStop(0.5, '#fff'); tdGrd.addColorStop(1, '#FFD700')
    ctx.fillStyle = tdGrd
    ctx.shadowColor = C_GOLD; ctx.shadowBlur = 36
    ctx.fillText('TOUCHDOWN!', 0, 0)
    ctx.shadowBlur = 0
    ctx.restore()
    menuLastObservedPhase = g.phase
    return
  }

  if (g.phase !== 'menu' && g.phase !== 'gameover') {
    menuLastObservedPhase = g.phase
    return
  }

  ctx.fillStyle = 'rgba(8, 4, 30, 0.78)'
  ctx.fillRect(0, 0, GW, GH)
  ctx.textAlign = 'center'

  if (g.phase === 'menu') {
    // Detect a fresh transition INTO the menu (e.g. coming back from
    // 'gameover' or 'versus'). When that happens, wipe the intro-anim
    // state so the helmet clash sequence replays from the title slam
    // instead of snapping straight to the settled pose.
    if (menuLastObservedPhase !== 'menu') {
      menuAnimStartTime = -1
      helmetCrackPlayed = false
      menuImpactFired   = false
      menuParticles     = []
      menuParticleLastT = -1
      // Returning from a finished run — play the announcer "don't give up!"
      // pep talk. Gated on the previous phase being 'gameover' so we don't
      // fire on first load (initial 'menu') or when leaving the versus
      // splash screen.
      if (menuLastObservedPhase === 'gameover') {
        audioManager.playDontGiveUp()
      }
    }
    menuLastObservedPhase = 'menu'

    // ── Procedural stadium backdrop ───────────────────────────────────────
    // Drawn after the flat dark overlay (above) and before any helmet /
    // title / particle layers below, so the helmets clash against a moody
    // stadium environment instead of a flat dark wash.
    drawStadiumBackdrop(ctx, time)

    // ── Anime-style helmet clash intro sequence ───────────────────────────
    // Phase 0  (0–0.48s)  : dark screen — builds anticipation before the charge.
    // Phase 1  (0.48–0.98s): helmets charge in (easeInQuint — aggressive accel).
    // Phase 2  (0.98s)    : IMPACT — SFX + starburst + speed lines + particles + shake.
    // Phase 3  (0.98–1.28s): helmets recoil then lock face-to-face (hold pose).
    // Phase 4  (1.28s+)   : title, VS, school labels, and button fade in together.
    //
    // Audio + animation sync strategy: unchanged from before — animation
    // always runs immediately; crack SFX is attempted at IMPACT_T; if the
    // AudioContext isn't unlocked yet we set helmetCrackMissed and restart
    // the animation as soon as audio is available.
    if (menuAnimStartTime < 0) {
      // Defer animation start until BOTH helmet sprites are decoded.
      // Otherwise the first 1-2 frames render the procedural drawHelmet
      // fallback and visibly snap to the real PNG when it loads — the
      // user sees the old graphic transition into the new one.
      // We pre-compute the next opponent index so we can check the
      // exact sprite that's about to appear.
      const nextOppIdx = (menuOpponentIdx + 1) % MENU_OPPONENT_HELMETS.length
      const alcReady = getMenuHelmetImage(MENU_ALCORN_HELMET.src) !== undefined
      const oppReady = getMenuHelmetImage(MENU_OPPONENT_HELMETS[nextOppIdx].src) !== undefined
      if (!alcReady || !oppReady) {
        // Hold on the dark pre-charge frame (stadium backdrop already
        // drawn above) until the sprites are ready. menuLastObservedPhase
        // was already updated at the top of this branch.
        ctx.textAlign = 'left'
        return
      }
      menuAnimStartTime = time
      helmetCrackPlayed = false
      menuImpactFired   = false
      menuParticles     = []
      menuParticleLastT = -1
      menuOpponentIdx = nextOppIdx
    }
    // If a previous pass missed the crack and audio is now ready, restart.
    if (helmetCrackMissed && audioManager.isContextRunning()) {
      menuAnimStartTime = time
      helmetCrackPlayed = false
      helmetCrackMissed = false
      menuImpactFired   = false
      menuParticles     = []
      menuParticleLastT = -1
    }
    const animT = time - menuAnimStartTime

    const isMobile = CURRENT_MODE === 'mobile'

    // ── Timing constants ───────────────────────────────────────────────────
    const SLIDE_START = 0.48
    const SLIDE_DUR   = 0.50   // faster, more aggressive charge than before
    const IMPACT_T    = SLIDE_START + SLIDE_DUR  // 0.98 s
    const RECOIL_DUR  = 0.22
    const SETTLE_T    = IMPACT_T + RECOIL_DUR + 0.08  // ~1.28 s

    // ── Helmet-crack SFX (fires once at impact) ────────────────────────────
    if (animT >= IMPACT_T && !helmetCrackPlayed) {
      if (audioManager.isContextRunning()) {
        helmetCrackPlayed = true
        helmetCrackMissed = false
        audioManager.playHelmetCrack()
      } else {
        helmetCrackMissed = true
      }
    }

    // ── Spawn impact particle burst exactly once ───────────────────────────
    if (animT >= IMPACT_T && !menuImpactFired) {
      menuImpactFired = true
      const px = GW / 2, py = GH * 0.42
      const helmetRv = isMobile ? 62 : 82
      const cols = ['#ffffff', '#cc88ff', '#FFD700', '#ff88ee', '#aaddff', '#ff4444']
      for (let i = 0; i < 60; i++) {
        const angle = Math.random() * Math.PI * 2
        const speed = 90 + Math.random() * 340
        const isShard = Math.random() < 0.45
        menuParticles.push({
          x: px + (Math.random() - 0.5) * helmetRv,
          y: py + (Math.random() - 0.5) * helmetRv * 0.5,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 30,
          life: 1,
          maxLife: 0.35 + Math.random() * 0.55,
          size: isShard ? 3 + Math.random() * 9 : 1.5 + Math.random() * 3.5,
          color: cols[Math.floor(Math.random() * cols.length)],
          type: isShard ? 'shard' : 'spark',
        })
      }
      menuParticleLastT = time
    }

    // ── Update particles (integrate velocity, gravity, drain life) ─────────
    if (menuParticles.length > 0) {
      const dt = menuParticleLastT >= 0 ? Math.min(time - menuParticleLastT, 0.05) : 0
      menuParticleLastT = time
      for (const p of menuParticles) {
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.vy += 220 * dt   // gravity
        p.vx *= 1 - dt * 1.5  // air drag
        p.life -= dt / p.maxLife
      }
      menuParticles = menuParticles.filter(p => p.life > 0)
    } else if (menuParticles.length === 0 && menuImpactFired) {
      menuParticleLastT = time
    }

    // ── Title fade-in (appears after impact settles, over the held pose) ────
    // No pre-impact title — the screen is dark during the charge so the
    // helmet collision is the pure hero moment. Title + subtitle slam in
    // with easeOutBack once the helmets lock into their face-to-face pose.
    if (animT > SETTLE_T) {
      const titleFadeDur = 0.42
      const titleProg    = Math.min((animT - SETTLE_T) / titleFadeDur, 1)
      const c1t = 1.70158, c3t = c1t + 1
      const titleEase = titleProg < 1
        ? 1 + c3t * Math.pow(titleProg - 1, 3) + c1t * Math.pow(titleProg - 1, 2)
        : 1
      const titleOffY   = (1 - titleEase) * -GH * 0.20
      const titleSize   = isMobile ? 64 : 90
      const floatPulse  = titleProg >= 1 ? 1 + Math.sin(time * 1.4) * 0.02 : 1
      const titleAlpha  = Math.min(titleProg * 1.6, 1)

      ctx.save()
      ctx.globalAlpha = titleAlpha
      ctx.translate(GW / 2, GH * 0.14 + titleOffY)
      ctx.scale(floatPulse, floatPulse)
      ctx.textAlign = 'center'
      ctx.font = `bold ${titleSize}px Impact, sans-serif`
      ctx.strokeStyle = '#000'; ctx.lineWidth = 8
      ctx.strokeText('BIG BACK BLITZ', 0, 0)
      const ttGrd = ctx.createLinearGradient(-380, -60, 380, 10)
      ttGrd.addColorStop(0, C_GOLD); ttGrd.addColorStop(0.45, '#fff9d0'); ttGrd.addColorStop(1, C_GOLD)
      ctx.fillStyle = ttGrd; ctx.shadowColor = C_GOLD; ctx.shadowBlur = 28
      ctx.fillText('BIG BACK BLITZ', 0, 0); ctx.shadowBlur = 0
      ctx.restore()

      ctx.globalAlpha = 1
    }

    // ── Helmet positions ───────────────────────────────────────────────────
    const slideProg = animT < SLIDE_START ? 0
      : Math.min((animT - SLIDE_START) / SLIDE_DUR, 1)
    // easeInQuint — fast acceleration, slams in hard
    const sp2 = slideProg * slideProg
    const slideEase = sp2 * sp2 * slideProg

    const helmetR = isMobile ? 78 : 105   // enlarged so real helmet art reads clearly
    // Position helmets so their visible bottom edges just touch the top of the
    // "PRESS ANY KEY TO PLAY" / "TAP TO PLAY" button. The button center is at
    // GH*0.50 (desktop) or GH*0.56 (mobile) with a 60px-tall body, so its top
    // sits at btnY - 30. Sprites are wider than tall (~203×135), so visible
    // vertical extent ≈ helmetR * 0.73 (half-height of rendered sprite); use
    // 0.75 with a 2px gap so the helmet's chin rests right above the button.
    const _btnTopY = (isMobile ? GH * 0.56 : GH * 0.50) - 30
    const helmetY = _btnTopY - helmetR * 0.75 - 2
    // Generous gap between helmet centers so each helmet is fully visible
    // (real helmet sprites have wider face-masks than the old procedural ovals).
    const gap     = helmetR * 0.45

    const alcornFinalX   = GW / 2 + helmetR + gap
    const southernFinalX = GW / 2 - helmetR - gap

    // Slight downward-angle approach: helmets start a bit high and dip in
    const chargeOffY = (1 - slideEase) * helmetR * 0.30

    let alcornX: number, southernX: number, alcornY: number, southernY: number
    if (animT < IMPACT_T) {
      alcornX   = GW + helmetR + 100 + (alcornFinalX   - GW - helmetR - 100) * slideEase
      southernX = 0 - helmetR - 100 + (southernFinalX - (0 - helmetR - 100)) * slideEase
      alcornY   = helmetY - chargeOffY
      southernY = helmetY - chargeOffY
    } else {
      const recoilT = Math.min((animT - IMPACT_T) / RECOIL_DUR, 1)
      const recoil  = Math.sin(recoilT * Math.PI) * helmetR * 0.24
      alcornX   = alcornFinalX   + recoil
      southernX = southernFinalX - recoil
      alcornY   = helmetY
      southernY = helmetY
    }

    if (slideProg > 0 || animT >= IMPACT_T) {
      // ── Motion-blur ghost trails during charge ─────────────────────────
      if (animT < IMPACT_T && slideProg > 0.08) {
        const numGhosts = 4
        for (let gi = 1; gi <= numGhosts; gi++) {
          const gProg = Math.max(0, slideProg - gi * 0.09)
          const gsp2  = gProg * gProg
          const gEase = gsp2 * gsp2 * gProg
          const gAX = GW + helmetR + 100 + (alcornFinalX   - GW - helmetR - 100) * gEase
          const gSX = 0 - helmetR - 100 + (southernFinalX - (0 - helmetR - 100)) * gEase
          const gY  = helmetY - (1 - gEase) * helmetR * 0.30
          const ghostR = helmetR * (1 - gi * 0.04)
          ctx.globalAlpha = (slideEase * 0.4) / (gi * 1.6)
          {
            // No procedural fallback here: the animation only starts once
            // both sprites are decoded (see menuAnimStartTime gate above),
            // so showing the older drawHelmet graphic during the clash is
            // never desired. If a sprite is somehow missing we skip the
            // ghost frame rather than mix art styles.
            const img = getMenuHelmetImage(MENU_ALCORN_HELMET.src)
            if (img) drawHelmetImage(ctx, gAX, gY, ghostR, img, true)
          }
          {
            const img = getMenuHelmetImage(MENU_OPPONENT_HELMETS[menuOpponentIdx].src)
            if (img) drawHelmetImage(ctx, gSX, gY, ghostR, img, false)
          }
          ctx.globalAlpha = 1
        }

        // Horizontal speed-line streaks behind each helmet
        ctx.save()
        ctx.globalAlpha = slideEase * 0.38
        ctx.lineWidth = 1.5
        const nLines = 10
        for (let li = 0; li < nLines; li++) {
          const lY    = alcornY + (li - nLines / 2) * helmetR * 0.19
          const lineLen = helmetR * 1.8 * slideEase
          const lineCol = li % 2 === 0 ? '#aabbff' : '#ddddff'
          ctx.strokeStyle = lineCol
          // right side (Alcorn)
          ctx.beginPath()
          ctx.moveTo(alcornX + helmetR * 0.8, lY)
          ctx.lineTo(alcornX + helmetR * 0.8 + lineLen, lY)
          ctx.stroke()
          // left side (Southern)
          ctx.beginPath()
          ctx.moveTo(southernX - helmetR * 0.8, lY)
          ctx.lineTo(southernX - helmetR * 0.8 - lineLen, lY)
          ctx.stroke()
        }
        ctx.restore()
      }

      // ── Screen shake ───────────────────────────────────────────────────
      const shakeT   = animT - IMPACT_T
      const shakeAmt = shakeT >= 0 && shakeT < 0.48
        ? Math.sin(shakeT * 42) * 13 * Math.max(0, 1 - shakeT / 0.48)
        : 0

      ctx.save()
      ctx.translate(shakeAmt, shakeAmt * 0.5)

      // Draw helmets (opponent left, Alcorn right) — real PNG sprites only.
      // Procedural drawHelmet fallback intentionally removed so we never
      // paint the old vector helmet graphic during the start-screen clash.
      // Animation start is gated on both sprites being decoded, so this
      // branch should always have a loaded image.
      {
        const img = getMenuHelmetImage(MENU_OPPONENT_HELMETS[menuOpponentIdx].src)
        if (img) drawHelmetImage(ctx, southernX, southernY, helmetR, img, false)
      }
      {
        const img = getMenuHelmetImage(MENU_ALCORN_HELMET.src)
        if (img) drawHelmetImage(ctx, alcornX, alcornY, helmetR, img, true)
      }

      ctx.restore()

      // ── Radial speed lines burst from contact point ────────────────────
      if (animT >= IMPACT_T && animT < IMPACT_T + 0.60) {
        const lineT     = (animT - IMPACT_T) / 0.60
        const lineAlpha = Math.max(0, (1 - lineT) * 0.72)
        ctx.save()
        ctx.globalAlpha = lineAlpha
        const nSL = 30
        for (let si = 0; si < nSL; si++) {
          const angle   = (si / nSL) * Math.PI * 2
          const innerR  = helmetR * 0.5
          const outerR  = helmetR * 2.2 + lineT * GW * 0.48
          const spread  = 0.016
          ctx.beginPath()
          ctx.moveTo(GW/2 + Math.cos(angle - spread) * innerR, helmetY + Math.sin(angle - spread) * innerR)
          ctx.lineTo(GW/2 + Math.cos(angle) * outerR,         helmetY + Math.sin(angle) * outerR)
          ctx.lineTo(GW/2 + Math.cos(angle + spread) * innerR, helmetY + Math.sin(angle + spread) * innerR)
          ctx.closePath()
          if      (si % 3 === 0) ctx.fillStyle = '#cc88ff'
          else if (si % 3 === 1) ctx.fillStyle = '#ffffff'
          else                   ctx.fillStyle = '#ffffbb'
          ctx.fill()
        }
        ctx.restore()
      }

      // ── Starburst impact flash ─────────────────────────────────────────
      if (animT >= IMPACT_T && animT < IMPACT_T + 0.44) {
        const flashT = (animT - IMPACT_T) / 0.44
        const fa     = Math.max(0, 1 - flashT)

        // Radial gradient glow
        const burstR   = helmetR * (0.4 + flashT * 2.2)
        const burstGrd = ctx.createRadialGradient(GW/2, helmetY, 0, GW/2, helmetY, burstR)
        burstGrd.addColorStop(0,    `rgba(255,255,255,${fa * 0.98})`)
        burstGrd.addColorStop(0.20, `rgba(230,180,255,${fa * 0.82})`)
        burstGrd.addColorStop(0.55, `rgba(110,20,190,${fa * 0.45})`)
        burstGrd.addColorStop(1,    'rgba(0,0,0,0)')
        ctx.beginPath()
        ctx.arc(GW/2, helmetY, burstR, 0, Math.PI * 2)
        ctx.fillStyle = burstGrd
        ctx.fill()

        // Elongated spike starburst
        if (flashT < 0.55) {
          ctx.save()
          ctx.translate(GW/2, helmetY)
          ctx.globalAlpha = fa * (1 - flashT / 0.55)
          const spikeLen = helmetR * (2.8 + flashT * 3.5)
          const nSpikes  = 14
          for (let ki = 0; ki < nSpikes; ki++) {
            const ang = (ki / nSpikes) * Math.PI * 2 + flashT * 0.4
            ctx.save()
            ctx.rotate(ang)
            ctx.beginPath()
            ctx.moveTo(0, 0)
            ctx.lineTo(-spikeLen * 0.06, spikeLen * 0.28)
            ctx.lineTo(0, spikeLen)
            ctx.lineTo(spikeLen * 0.06, spikeLen * 0.28)
            ctx.closePath()
            ctx.fillStyle = ki % 2 === 0 ? '#ffffff' : '#ddaaff'
            ctx.fill()
            ctx.restore()
          }
          ctx.restore()
        }

        // Full-screen white/purple tint (very brief)
        if (flashT < 0.18) {
          const screenFlash = (1 - flashT / 0.18) * 0.52
          ctx.fillStyle = `rgba(200,160,255,${screenFlash})`
          ctx.fillRect(0, 0, GW, GH)
        }
      }

      // ── Expanding shockwave rings ──────────────────────────────────────
      if (animT >= IMPACT_T && animT < IMPACT_T + 0.65) {
        const swT = (animT - IMPACT_T) / 0.65
        ctx.save()
        // Ring 1
        ctx.beginPath()
        ctx.arc(GW/2, helmetY, helmetR + swT * helmetR * 3.8, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(180,120,255,${Math.max(0, (1 - swT) * 0.85)})`
        ctx.lineWidth   = 5 * (1 - swT)
        ctx.stroke()
        // Ring 2 (delayed)
        if (swT > 0.14) {
          const sw2T = (swT - 0.14) / 0.86
          ctx.beginPath()
          ctx.arc(GW/2, helmetY, helmetR + sw2T * helmetR * 3.0, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(255,255,255,${Math.max(0, (1 - sw2T) * 0.55)})`
          ctx.lineWidth   = 3 * (1 - sw2T)
          ctx.stroke()
        }
        ctx.restore()
      }

      // ── Spark / debris particles ───────────────────────────────────────
      if (menuParticles.length > 0) {
        ctx.save()
        for (const p of menuParticles) {
          ctx.globalAlpha = Math.max(0, p.life * p.life)
          if (p.type === 'shard') {
            const t01 = 1 - p.life
            ctx.save()
            ctx.translate(p.x, p.y)
            ctx.rotate(t01 * Math.PI * 5)
            ctx.fillStyle = p.color
            ctx.shadowColor = p.color
            ctx.shadowBlur  = 7
            ctx.fillRect(-p.size / 2, -p.size * 0.28, p.size, p.size * 0.56)
            ctx.restore()
          } else {
            ctx.beginPath()
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
            ctx.fillStyle   = p.color
            ctx.shadowColor = p.color
            ctx.shadowBlur  = 9
            ctx.fill()
          }
        }
        ctx.shadowBlur = 0
        ctx.globalAlpha = 1
        ctx.restore()
      }

      // ── "VS" text (fades in after settle) ─────────────────────────────
      if (animT > SETTLE_T + 0.10) {
        const vsAlpha = Math.min((animT - SETTLE_T - 0.10) / 0.40, 1)
        ctx.globalAlpha = vsAlpha
        ctx.textAlign = 'center'
        ctx.font = `bold ${Math.round(helmetR * 0.55)}px Impact`
        ctx.strokeStyle = '#000'; ctx.lineWidth = 4
        ctx.strokeText('VS', GW / 2, helmetY + helmetR * 0.12)
        ctx.fillStyle = C_GOLD; ctx.shadowColor = C_GOLD; ctx.shadowBlur = 14
        ctx.fillText('VS', GW / 2, helmetY + helmetR * 0.12)
        ctx.shadowBlur = 0; ctx.globalAlpha = 1
      }

      // ── School labels (fade in after settle) ──────────────────────────
      if (animT > SETTLE_T + 0.05) {
        const labelAlpha = Math.min((animT - SETTLE_T - 0.05) / 0.50, 1)
        ctx.globalAlpha = labelAlpha * 0.85
        ctx.font = isMobile ? '13px Impact' : '15px Impact'
        ctx.textAlign = 'center'
        ctx.fillStyle = '#FDB913'
        ctx.fillText(MENU_OPPONENT_HELMETS[menuOpponentIdx].name, southernX, helmetY + helmetR + 20)
        ctx.fillStyle = C_GOLD
        ctx.fillText('ALCORN', alcornX, helmetY + helmetR + 20)
        ctx.globalAlpha = 1
      }
    }

    // ── Start button ───────────────────────────────────────────────────────
    // Always visible at ≥30% so there's always a tap target; fades to full
    // opacity once the impact has settled.
    const btnAlpha = Math.max(0.3, Math.min(Math.max(animT - SETTLE_T - 0.10, 0) / 0.50, 1))
    ctx.globalAlpha = btnAlpha
    const bp = 0.95 + Math.sin(time * 2.8) * 0.05
    const btnY = isMobile ? GH * 0.56 : GH * 0.50
    const btnW = isMobile ? 320 : 350
    const btnLabel = isMobile ? 'TAP TO PLAY' : 'PRESS ANY KEY TO PLAY'
    ctx.save(); ctx.translate(GW / 2, btnY); ctx.scale(1, bp)
    ctx.fillStyle = C_PURPLE
    roundRect(ctx, -btnW/2, -30, btnW, 60, 12); ctx.fill()
    ctx.strokeStyle = C_GOLD; ctx.lineWidth = 2.5
    roundRect(ctx, -btnW/2, -30, btnW, 60, 12); ctx.stroke()
    ctx.fillStyle = C_WHITE; ctx.font = isMobile ? 'bold 24px Impact' : 'bold 28px Impact'
    ctx.textAlign = 'center'
    ctx.fillText(btnLabel, 0, 14); ctx.restore()
    ctx.globalAlpha = 1

    // ── Bottom section: leaderboard panel + controls grid ──────────────────
    // Always show a compact 3-row leaderboard panel on the menu so returning
    // players can browse their scores and switch tabs before starting the
    // next run. First-time players (empty boards) see the panel's built-in
    // "No scores yet — be the first!" placeholder. drawLeaderboardPanel
    // also updates TAB_POINTS_RECT / TAB_TD_RECT so the tab toggle works.
    // The controls grid is rendered directly below the leaderboard.
    {
      const menuLbY = isMobile ? GH * 0.61 : GH * 0.55
      drawLeaderboardPanel(ctx, g, time, isMobile, null, menuLbY, 3)
    }

    // ── Controls grid (compact, below leaderboard) ─────────────────────────
    // When a gamepad is connected, render the controller hints panel in
    // place of the keyboard/touch grid so the menu doesn't overflow.
    if (GAMEPAD_CONNECTED) {
      drawControllerHints(ctx, isMobile, isMobile ? GH * 0.79 : GH * 0.82)
    } else if (isMobile) {
      const gridW = Math.min(GW - 40, 520)
      const gridY = GH * 0.78
      const gridH = 156
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      roundRect(ctx, GW/2 - gridW/2, gridY, gridW, gridH, 10); ctx.fill()
      ctx.font = '13px Impact'
      const controls = [
        ['◀ ▶ buttons', 'Change Lane'],
        ['Swipe ↑ / JUMP', 'Jump (hop over defenders)'],
        ['SPIN button', 'Spin Dodge'],
        ['TURBO button', 'Turbo (TRUCK STICK)'],
        ['Bottles', 'Grants power-ups (required)'],
      ]
      controls.forEach(([key, desc], i) => {
        const cy2 = gridY + 10 + i * 26
        ctx.fillStyle = C_GOLD; ctx.textAlign = 'left'
        ctx.fillText(key, GW/2 - gridW/2 + 14, cy2 + 14)
        ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.textAlign = 'right'
        ctx.fillText(desc, GW/2 + gridW/2 - 14, cy2 + 14)
      })
      ctx.textAlign = 'center'
      ctx.font = '11px Impact'; ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.fillText('Tab · click tabs to switch boards', GW/2, GH * 0.96)
    } else {
      const gridY = GH * 0.81
      const gridH = 100
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      roundRect(ctx, GW/2 - 340, gridY, 680, gridH, 10); ctx.fill()

      ctx.font = '14px Impact'
      const controls = [
        ['← / A', 'Move Left'],
        ['→ / D', 'Move Right'],
        ['↑ / W / Space', 'Jump'],
        ['X / Shift', 'Spin Dodge'],
        ['C', 'Turbo'],
        ['Bottle', 'Power-up'],
      ]
      controls.forEach(([key, desc], i) => {
        const col = i % 3, row = Math.floor(i / 3)
        const cx2 = GW/2 - 226 + col * 226, cy2 = gridY + 8 + row * 44
        ctx.fillStyle = C_GOLD; ctx.textAlign = 'center'
        ctx.fillText(key, cx2, cy2 + 14)
        ctx.fillStyle = 'rgba(255,255,255,0.7)'
        ctx.fillText(desc, cx2, cy2 + 30)
      })

      ctx.font = '12px Impact'; ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.fillText('Tab · click tabs to switch boards · Score touchdowns for big bonuses', GW/2, GH * 0.97)
    }

  } else if (g.phase === 'gameover') {
    const isMobile = CURRENT_MODE === 'mobile'
    // ── Compact layout for very short viewports ─────────────────────
    // Landscape phones squeeze the canvas down to GH ≈ 720, which
    // doesn't leave room for the full 10-row leaderboard PLUS the
    // banner stack, schools-faced roster, and play-again button.
    // When `isCompact` is on we shrink headline sizes, drop the
    // game-over leaderboard to 5 rows, and anchor the roster + button
    // to the panel bottom / canvas bottom (instead of GH-percentages)
    // so nothing slides past the visible edge.
    const isCompact = isMobile && GH < 900
    // ── Opponent WINS! banner (school chant) ────────────────────────
    // Headline above TACKLED tinted in the opponent's primary/secondary
    // colors so the player feels the rivalry — "GRAMBLING WINS!",
    // "FAMU WINS!", etc. Scaled with a subtle pulse so it feels alive.
    const opp = SCHOOL_META[g.opponent]
    {
      const pulse = 1 + Math.sin(time * 4.5) * 0.04
      ctx.save()
      ctx.translate(GW/2, GH * 0.06)
      ctx.scale(pulse, pulse)
      ctx.textAlign = 'center'
      const winsSize = isCompact ? 30 : isMobile ? 38 : 56
      ctx.font = `bold ${winsSize}px Impact`
      ctx.strokeStyle = '#000'; ctx.lineWidth = 7
      ctx.strokeText(`${opp.display} WINS!`, 0, 0)
      const winsGrd = ctx.createLinearGradient(-360, -40, 360, 10)
      winsGrd.addColorStop(0, opp.secondary)
      winsGrd.addColorStop(0.5, '#ffffff')
      winsGrd.addColorStop(1, opp.secondary)
      ctx.fillStyle = winsGrd
      ctx.shadowColor = opp.primary; ctx.shadowBlur = 26
      ctx.fillText(`${opp.display} WINS!`, 0, 0)
      ctx.shadowBlur = 0
      ctx.restore()
      ctx.textAlign = 'left'
    }
    // Tackled
    ctx.textAlign = 'center'
    ctx.font = isCompact ? 'bold 38px Impact' : isMobile ? 'bold 50px Impact' : 'bold 70px Impact'
    ctx.strokeStyle = '#000'; ctx.lineWidth = 7
    ctx.strokeText('TACKLED!', GW/2, GH*0.13)
    ctx.fillStyle = '#ff3333'; ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 22
    ctx.fillText('TACKLED!', GW/2, GH*0.13); ctx.shadowBlur = 0

    ctx.fillStyle = C_WHITE
    ctx.font = isCompact ? '15px Impact' : isMobile ? '18px Impact' : '26px Impact'
    ctx.fillText(`${Math.floor(g.yards)} YDS  ·  ${g.touchdowns} TDs  ·  ${g.score.toLocaleString()} PTS`, GW/2, GH*0.18)

    // ── NEW HIGH SCORE banner (animates while nhsAnim > 0) ──────────
    // Shown when the run qualifies for the POINTS board (entryRank > 0).
    // TD-only qualifiers instead show a quieter "NEW TD RECORD" notice.
    // The animation is an extra flourish driven by nhsAnim.
    //
    // bannerY sits between the stat line (GH*0.18) and the leaderboard
    // panel.  The headline draws *upward* from this anchor (alphabetic
    // baseline) and is amplified by popScale (up to 1.35×) plus a 28-px
    // gold glow, so we leave ~13% of GH between the stat baseline and
    // bannerY to absorb both the popped cap height and the glow tail.
    // The 70-px lbStartY offset still covers headline cap (~35px) +
    // subtitle (+28px) + popScale overshoot + breathing room on every
    // common viewport (desktop landscape GH=720, mobile portrait GH=1100+).
    const bannerY   = isCompact ? GH * 0.27 : GH * 0.31
    const lbStartY  = bannerY + (isCompact ? 56 : 70)
    // Game-over leaderboard rows: full 10 normally, compact 5 on short
    // viewports so the panel + roster + button all fit above GH.
    // If the player just qualified at rank 6–10, expand the compact
    // panel just enough to keep their pulsing entry row visible —
    // otherwise the player would never see the row that celebrates
    // their new high score on a landscape phone.
    const activeRankForBoard = CURRENT_BOARD_MODE === 'touchdowns'
      ? g.tdEntryRank
      : g.entryRank
    const lbRows    = isCompact
      ? Math.min(LEADERBOARD_MAX, Math.max(5, activeRankForBoard || 0))
      : LEADERBOARD_MAX

    if (g.entryActive && g.entryRank > 0) {
      const t01 = g.nhsAnim > 0 ? clamp(1 - g.nhsAnim / NHS_ANIM_DUR, 0, 1) : 1
      const popScale = (1 + (1 - t01) * 0.35) * (1 + Math.sin(time * 6) * 0.03)
      const goldFlick = 0.85 + Math.sin(time * 9) * 0.15
      ctx.save()
      ctx.translate(GW/2, bannerY)
      ctx.scale(popScale, popScale)
      ctx.shadowColor = C_GOLD; ctx.shadowBlur = 28 * goldFlick
      ctx.fillStyle = C_GOLD
      ctx.font = isMobile ? 'bold 36px Impact' : 'bold 50px Impact'
      ctx.fillText('★ NEW HIGH SCORE! ★', 0, 0)
      ctx.shadowBlur = 0
      ctx.fillStyle = '#fff7c2'
      ctx.font = isMobile ? 'bold 18px Impact' : 'bold 24px Impact'
      ctx.fillText(`YOU EARNED RANK #${g.entryRank}`, 0, 28)
      ctx.restore()
    } else if (g.entryActive && g.tdEntryRank > 0) {
      // TD-only qualifier: quieter "NEW TD RECORD" notice.
      const pulse = 1 + Math.sin(time * 6) * 0.03
      ctx.save()
      ctx.translate(GW/2, bannerY)
      ctx.scale(pulse, pulse)
      ctx.shadowColor = '#00ffcc'; ctx.shadowBlur = 20
      ctx.fillStyle = '#00ffcc'
      ctx.font = isMobile ? 'bold 26px Impact' : 'bold 36px Impact'
      ctx.fillText('🏈 NEW TD RECORD!', 0, 0)
      ctx.shadowBlur = 0
      ctx.fillStyle = '#ccffee'
      ctx.font = isMobile ? 'bold 16px Impact' : 'bold 20px Impact'
      ctx.fillText(`TOUCHDOWNS BOARD — RANK #${g.tdEntryRank}`, 0, 28)
      ctx.restore()
    } else if (g.nhsRank > 0) {
      // Run beat someone in-board mid-game but ended below their score?
      // (Possible only if our in-run drain ran but the score dropped — it
      // can't actually happen, but render the best rank achieved as a
      // smaller line so the player sees credit for the crossing.)
      ctx.fillStyle = C_GOLD; ctx.font = isMobile ? 'bold 18px Impact' : 'bold 22px Impact'
      ctx.shadowColor = C_GOLD; ctx.shadowBlur = 12
      ctx.fillText(`PEAK RANK: #${g.nhsRank}`, GW/2, bannerY)
      ctx.shadowBlur = 0
    } else if (g.highScore > 0) {
      ctx.fillStyle = 'rgba(255,215,0,0.6)'
      ctx.font = isMobile ? '15px Impact' : '20px Impact'
      ctx.fillText(`BEST: ${g.highScore.toLocaleString()} PTS`, GW/2, bannerY)
    }

    // ── Top-10 LEADERBOARD list ─────────────────────────────────────
    // Renders the current run's snapshot with the player's freshly-saved
    // entry merged in (or a "???" placeholder while typing). The entry
    // row pulses gold so it pops out of the static list.
    // lbStartY is computed above to always be 70 px below bannerY,
    // guaranteeing the panel never overlaps the banner or its subtitle.
    drawLeaderboardPanel(ctx, g, time, isMobile, lastSubmitted, lbStartY, lbRows)

    // ── HBCU "schools faced" roster ─────────────────────────────────
    // Lists every defender variant that touched this run (dodged or
    // tackling). Wraps if needed; skipped if no defenders showed up.
    if (g.schoolsSeen.size > 0) {
      const names = DEFENDER_VARIANTS
        .filter(v => g.schoolsSeen.has(v))
        .map(v => DEFENDER_DISPLAY_NAMES[v])
      // In compact mode, anchor the roster to the leaderboard panel's
      // bottom edge instead of a GH-percentage so it rides the panel
      // upward as the panel shrinks (5 rows) and never collides with
      // the play-again button at GH-32.
      // panelH mirrors drawLeaderboardPanel: headerH(58 mobile / 66 desktop)
      // + rowH(22/26)*lbRows + 16. We only need the mobile figure here
      // because isCompact implies isMobile.
      const lbPanelH = 58 + 22 * lbRows + 16
      const rosterY = isCompact
        ? lbStartY + lbPanelH + 18
        : isMobile ? GH * 0.84 : GH * 0.85
      ctx.fillStyle = C_GOLD
      ctx.font = isMobile ? 'bold 13px Impact' : 'bold 16px Impact'
      ctx.textAlign = 'center'
      ctx.fillText('SCHOOLS FACED', GW / 2, rosterY)
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.font = isMobile ? '12px Impact' : '15px Impact'
      // Word-wrap by school name across up to 2 lines.
      const maxW = isMobile ? GW - 32 : Math.min(GW - 80, 720)
      const lines: string[] = []
      let cur = ''
      for (const n of names) {
        const candidate = cur ? `${cur}  ·  ${n}` : n
        if (ctx.measureText(candidate).width > maxW && cur) {
          lines.push(cur)
          cur = n
        } else {
          cur = candidate
        }
      }
      if (cur) lines.push(cur)
      const lh = isMobile ? 16 : 19
      lines.forEach((ln, i) => {
        ctx.fillText(ln, GW / 2, rosterY + 18 + i * lh)
      })
    }

    // ── Play-Again button (gated while typing initials) ─────────────
    const canRestart = !g.entryActive || g.entrySubmitted
    const bp2 = 0.95 + Math.sin(time * 2.8) * 0.05
    // In compact mode, pin the play-again button to the canvas bottom
    // (with a small margin) so it can't be pushed off-screen by the
    // leaderboard / roster stack on landscape phones.
    const btnY = isCompact ? GH - 32 : isMobile ? GH * 0.92 : GH * 0.91
    const btnW = isMobile ? 320 : 380
    const btnLabel = canRestart
      ? (isMobile ? 'TAP TO PLAY AGAIN' : 'PRESS ANY KEY TO PLAY AGAIN')
      : 'ENTER YOUR INITIALS BELOW ↓'
    ctx.save(); ctx.translate(GW/2, btnY); ctx.scale(1, canRestart ? bp2 : 1)
    ctx.fillStyle = canRestart ? C_PURPLE : 'rgba(75, 0, 130, 0.45)'
    roundRect(ctx, -btnW/2, -26, btnW, 52, 12); ctx.fill()
    ctx.strokeStyle = canRestart ? C_GOLD : 'rgba(255, 215, 0, 0.4)'
    ctx.lineWidth = 2.5
    roundRect(ctx, -btnW/2, -26, btnW, 52, 12); ctx.stroke()
    ctx.fillStyle = canRestart ? C_WHITE : 'rgba(255,255,255,0.7)'
    ctx.font = isMobile ? 'bold 18px Impact' : 'bold 22px Impact'
    ctx.fillText(btnLabel, 0, 8); ctx.restore()

    if (GAMEPAD_CONNECTED && canRestart) {
      drawControllerHints(ctx, isMobile, isMobile ? GH * 0.96 : GH * 0.97)
    }
  }

  // Record the phase we just rendered so the next frame can detect a
  // transition INTO 'menu' and replay the helmet-clash intro.
  menuLastObservedPhase = g.phase
  ctx.textAlign = 'left'
}

// ── Top-10 leaderboard list (canvas, game-over / menu screen) ─────────────
// Builds a "preview" board by merging this run's score into the snapshot
// (using the live `entryInitials` while typing, or "___" if empty). The
// player's row pulses gold so it stands out. Once submitted, the row
// shows the saved initials and stops being treated as the typing target.
//
// The function draws two tabs at the top of the panel — "Most Points" and
// "Most Touchdowns" — and updates the module-level TAB_POINTS_RECT /
// TAB_TD_RECT hit-areas so the React pointer handler can toggle the mode.
function drawLeaderboardPanel(
  ctx: CanvasRenderingContext2D,
  g: GS,
  time: number,
  isMobile: boolean,
  lastSubmitted: LeaderboardEntry | null,
  startY?: number,
  numRows = LEADERBOARD_MAX,
): void {
  const mode = CURRENT_BOARD_MODE
  const isTd = mode === 'touchdowns'

  const panelW  = isMobile ? Math.min(GW - 32, 480) : 560
  const rowH    = isMobile ? 22 : 26
  const tabH    = isMobile ? 28 : 32          // height of the tab row
  const headerH = tabH + (isMobile ? 30 : 34) // tab row + title row
  const panelH  = headerH + rowH * numRows + 16
  const x = GW / 2 - panelW / 2
  const y = startY ?? GH * 0.32

  // ── Select active snapshot ──────────────────────────────────────────────
  // Points board: sorted by score. TD board: sorted by touchdowns.
  // We re-sort the td snapshot by TDs here in case it came from the
  // points-board storage (both snapshots share the same Entry type).
  const activeSnapshot = isTd ? g.tdSnapshot : g.lbSnapshot

  // Provisional rank of the live entry on the *active* board.
  const activeEntryRank = isTd ? g.tdEntryRank : g.entryRank

  // Compose preview rows.
  type Row = { rank: number; initials: string; primary: number; secondary: number; highlight: boolean }
  const rows: Row[] = activeSnapshot.slice(0, numRows).map((e, i) => ({
    rank: i + 1,
    initials: e.initials,
    primary:   isTd ? e.touchdowns : e.score,
    secondary: isTd ? e.score      : e.touchdowns,
    highlight: false,
  }))

  if (g.entryActive) {
    // Does this run qualify for the currently-displayed board?
    const qualifiesActive = isTd
      ? qualifiesForTdBoard(g.touchdowns, g.tdSnapshot, g.score)
      : qualifiesForBoard(g.score, g.lbSnapshot)

    if (!g.entrySubmitted && qualifiesActive && activeEntryRank > 0) {
      // Still typing: splice a live preview row at the provisional rank.
      const liveInitials = g.entryInitials.length === 0
        ? '___'
        : g.entryInitials.padEnd(INITIALS_LEN, '_')
      const insertAt = Math.max(0, Math.min(rows.length, activeEntryRank - 1))
      rows.splice(insertAt, 0, {
        rank: activeEntryRank,
        initials: liveInitials,
        primary:   isTd ? g.touchdowns : g.score,
        secondary: isTd ? g.score      : g.touchdowns,
        highlight: true,
      })
      rows.length = Math.min(rows.length, numRows)
      rows.forEach((r, i) => { r.rank = i + 1 })
    } else if (g.entrySubmitted && activeEntryRank > 0) {
      // Submitted: snapshot already contains the saved entry at the rank.
      const savedIdx = activeEntryRank - 1
      if (savedIdx >= 0 && savedIdx < rows.length) rows[savedIdx].highlight = true
    }
  } else if (lastSubmitted) {
    // No active entry for this run, but a qualifying score was submitted
    // earlier in this tab session — keep it highlighted by ts match.
    for (const row of rows) {
      const e = activeSnapshot[row.rank - 1]
      if (e && e.ts === lastSubmitted.ts
          && e.initials === lastSubmitted.initials
          && e.score === lastSubmitted.score) {
        row.highlight = true
        break
      }
    }
  }

  // ── Panel background ────────────────────────────────────────────────────
  ctx.save()
  ctx.fillStyle = 'rgba(8, 4, 30, 0.82)'
  roundRect(ctx, x, y, panelW, panelH, 12); ctx.fill()
  ctx.strokeStyle = 'rgba(255, 215, 0, 0.55)'
  ctx.lineWidth = 1.5
  roundRect(ctx, x, y, panelW, panelH, 12); ctx.stroke()

  // ── Tab row ─────────────────────────────────────────────────────────────
  const tabW      = panelW / 2 - 4
  const tabY      = y + 4
  const tabLeft   = x + 2
  const tabRight  = x + panelW / 2 + 2

  // Update hit rects (canvas-space, used by pointer handler in React).
  TAB_POINTS_RECT = { x: tabLeft,  y: tabY, w: tabW, h: tabH }
  TAB_TD_RECT     = { x: tabRight, y: tabY, w: tabW, h: tabH }

  const drawTab = (tx: number, label: string, active: boolean) => {
    ctx.fillStyle = active ? C_PURPLE : 'rgba(20, 10, 50, 0.7)'
    roundRect(ctx, tx, tabY, tabW, tabH, 8); ctx.fill()
    ctx.strokeStyle = active ? C_GOLD : 'rgba(255,215,0,0.3)'
    ctx.lineWidth = active ? 1.5 : 1
    roundRect(ctx, tx, tabY, tabW, tabH, 8); ctx.stroke()
    ctx.textAlign = 'center'
    ctx.fillStyle = active ? C_GOLD : 'rgba(255,255,255,0.5)'
    ctx.font = isMobile ? `${active ? 'bold ' : ''}12px Impact` : `${active ? 'bold ' : ''}14px Impact`
    if (active) { ctx.shadowColor = C_GOLD; ctx.shadowBlur = 8 }
    ctx.fillText(label, tx + tabW / 2, tabY + (isMobile ? 18 : 21))
    ctx.shadowBlur = 0
  }
  drawTab(tabLeft,  '🏆 MOST POINTS',     !isTd)
  drawTab(tabRight, '🏈 MOST TOUCHDOWNS', isTd)

  // ── Header title ────────────────────────────────────────────────────────
  const titleY = y + tabH + (isMobile ? 22 : 26)
  ctx.textAlign = 'center'
  ctx.fillStyle = C_GOLD
  ctx.font = isMobile ? 'bold 14px Impact' : 'bold 17px Impact'
  ctx.shadowColor = C_GOLD; ctx.shadowBlur = 8
  ctx.fillText(
    isTd ? `TOP ${numRows} · MOST TOUCHDOWNS` : `TOP ${numRows} · MOST POINTS`,
    GW / 2, titleY,
  )
  ctx.shadowBlur = 0

  // ── Empty state ─────────────────────────────────────────────────────────
  if (rows.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = isMobile ? '13px Impact' : '15px Impact'
    ctx.fillText('No scores yet — be the first!', GW / 2, y + headerH + 30)
    ctx.restore()
    ctx.textAlign = 'left'
    return
  }

  // ── Column metrics ──────────────────────────────────────────────────────
  const colRankX     = x + (isMobile ? 18 : 28)
  const colInitialsX = x + (isMobile ? 60 : 90)
  const colPrimaryX  = x + panelW - (isMobile ? (isTd ? 88 : 70) : (isTd ? 110 : 92))
  const colSecX      = x + panelW - (isMobile ? 18 : 28)
  const baseFont     = isMobile ? '15px Impact' : '17px Impact'
  const rowTopY      = y + headerH + 4

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const ry = rowTopY + i * rowH
    if (r.highlight) {
      const pulse = 0.55 + Math.sin(time * 5) * 0.25
      ctx.fillStyle = `rgba(255, 215, 0, ${0.18 * pulse + 0.10})`
      roundRect(ctx, x + 6, ry - rowH * 0.55, panelW - 12, rowH - 2, 6); ctx.fill()
      ctx.strokeStyle = `rgba(255, 215, 0, ${0.6 * pulse + 0.25})`
      ctx.lineWidth = 1.2
      roundRect(ctx, x + 6, ry - rowH * 0.55, panelW - 12, rowH - 2, 6); ctx.stroke()
    }
    ctx.font = baseFont
    // Rank
    ctx.textAlign = 'left'
    ctx.fillStyle = r.highlight ? C_GOLD : (r.rank === 1 ? '#ffe066' : 'rgba(255,255,255,0.7)')
    ctx.fillText(`#${r.rank}`, colRankX, ry)
    // Initials
    ctx.fillStyle = r.highlight ? C_WHITE : 'rgba(255,255,255,0.92)'
    ctx.font = isMobile ? 'bold 16px Impact' : 'bold 19px Impact'
    ctx.fillText(r.initials, colInitialsX, ry)
    // Primary stat
    ctx.textAlign = 'right'
    ctx.fillStyle = r.highlight ? C_GOLD : 'rgba(255,255,255,0.85)'
    ctx.font = baseFont
    if (isTd) {
      ctx.fillText(`${r.primary} TD`, colPrimaryX, ry)
      // Secondary: points in smaller / dimmed text
      ctx.fillStyle = r.highlight ? 'rgba(255,255,200,0.75)' : 'rgba(255,255,255,0.45)'
      ctx.font = isMobile ? '12px Impact' : '13px Impact'
      ctx.fillText(r.secondary.toLocaleString(), colSecX, ry)
    } else {
      ctx.fillText(r.primary.toLocaleString(), colPrimaryX, ry)
      // Secondary: touchdowns in smaller / dimmed text
      ctx.fillStyle = r.highlight ? 'rgba(255,255,200,0.75)' : 'rgba(255,255,255,0.45)'
      ctx.font = isMobile ? '12px Impact' : '13px Impact'
      ctx.fillText(`${r.secondary} TD`, colSecX, ry)
    }
  }
  ctx.restore()
  ctx.textAlign = 'left'
}

// Small panel surfacing the gamepad bindings on the start menu and the
// game-over screen. Rendered only when a controller is currently
// connected (`GAMEPAD_CONNECTED`) so keyboard-only players don't see it.
function drawControllerHints(
  ctx: CanvasRenderingContext2D,
  isMobile: boolean,
  y: number,
) {
  const w = isMobile ? Math.min(GW - 40, 560) : 680
  const h = isMobile ? 110 : 84
  const x = GW / 2 - w / 2

  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  roundRect(ctx, x, y, w, h, 10); ctx.fill()
  ctx.strokeStyle = 'rgba(255,215,0,0.35)'
  ctx.lineWidth = 1
  roundRect(ctx, x, y, w, h, 10); ctx.stroke()

  ctx.textAlign = 'center'
  ctx.fillStyle = C_GOLD
  ctx.font = isMobile ? 'bold 14px Impact' : 'bold 16px Impact'
  ctx.fillText('CONTROLLER', GW / 2, y + (isMobile ? 20 : 22))

  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  if (isMobile) {
    ctx.font = '13px Impact'
    ctx.fillText('D-Pad / Stick = Lane   ·   ↑ = Spin   ·   ↓ = Turbo', GW / 2, y + 46)
    ctx.fillText('A = Jump   ·   B = Spin   ·   Y = Turbo   ·   Start = Pause', GW / 2, y + 70)
    ctx.fillText('All moves need a power-up (collect bottles!)', GW / 2, y + 94)
  } else {
    ctx.font = '15px Impact'
    ctx.fillText('D-Pad / Stick = Lane   ·   ↑ = Spin   ·   ↓ = Turbo   ·   Start = Pause', GW / 2, y + 48)
    ctx.fillText('A = Jump   ·   B = Spin   ·   Y = Turbo   ·   All moves need a power-up!', GW / 2, y + 72)
  }
  ctx.restore()
  ctx.textAlign = 'left'
}

// ─── Main render ─────────────────────────────────────────────────────────────
function render(
  ctx: CanvasRenderingContext2D,
  g: GS,
  time: number,
  dpr: number,
  lastSubmitted: LeaderboardEntry | null,
) {
  // Re-establish base transform every frame: this both applies the DPR
  // scaling for crisp rendering on hi-dpi mobile screens AND survives any
  // canvas resize that resets the transform to identity.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.save()

  // Touchdown camera punch — a brief zoom-in centered on the screen at the
  // start of the celebration that eases back to neutral. Pure visual; the
  // game-state coordinates are unchanged so input math keeps working.
  if (g.phase === 'touchdown') {
    const elapsed = TD_DUR - g.tdTimer
    // Sharp pop on the first ~0.7s, then a slow drift back to 1.0 over the
    // rest of the freeze. After freeze the zoom is fully off.
    let zoom = 1
    if (elapsed < 0.7) {
      const t = elapsed / 0.7
      zoom = 1 + 0.085 * Math.sin(t * Math.PI)   // peak 1.085 at mid-pop
    } else if (elapsed < TD_FREEZE_DUR) {
      const t = (elapsed - 0.7) / Math.max(0.01, TD_FREEZE_DUR - 0.7)
      zoom = 1 + 0.025 * (1 - t)                  // gentle settle
    }
    if (zoom !== 1) {
      ctx.translate(GW / 2, GH / 2)
      ctx.scale(zoom, zoom)
      ctx.translate(-GW / 2, -GH / 2)
    }
  }

  ctx.translate(g.shakeX, g.shakeY)

  ctx.clearRect(-30, -30, GW+60, GH+60)

  const crowdActive = g.phase !== 'gameover' && g.phase !== 'menu' && g.phase !== 'paused'
  drawSidelines(ctx, time, crowdActive)
  drawField(ctx, g.worldOffset, g.touchdowns)

  // Depth-sort: defenders + collectibles by screenY, then player on top
  type Item = { y: number; draw: ()=>void }
  const items: Item[] = []

  for (const d of g.defs) {
    if (!d.active) continue
    const flashAmt = Math.sin(d.flashTimer) * 0.5 + 0.5
    const tint = d.tackling ? 0 : flashAmt * (d.screenY > PLAYER_Y - 180 ? 0.6 : 0)
    // Compute remaining hit-flash window (0.083s ≈ 5 frames @ 60fps) from
    // the wall-clock timestamp set on tackle contact. Using performance.now
    // here keeps the flash brief even when the update loop has stopped
    // ticking (e.g. after the gameover phase early-returns).
    const HIT_FLASH_MS = 83
    const hitFlash = d.hitFlashStart > 0
      ? Math.max(0, 1 - (performance.now() - d.hitFlashStart) / HIT_FLASH_MS)
      : 0
    items.push({ y: d.screenY, draw: () => drawDefenderSprite(ctx, d, tint, hitFlash) })
  }

  for (const c of g.cols) {
    if (c.active && !c.collected) {
      items.push({ y: c.screenY, draw: () => drawCollectible(ctx, c, time) })
    }
  }

  items.sort((a, b) => a.y - b.y)

  // Draw spin aura behind player if spinning
  if (g.spinning) {
    const spinProg = g.spinTimer / SPIN_DUR
    ctx.save()
    ctx.globalAlpha = (1 - spinProg) * 0.35
    const auraGrd = ctx.createRadialGradient(g.playerX, PLAYER_Y, 0, g.playerX, PLAYER_Y, SPIN_RADIUS)
    auraGrd.addColorStop(0, C_GOLD); auraGrd.addColorStop(1, 'transparent')
    ctx.fillStyle = auraGrd
    ctx.beginPath(); ctx.arc(g.playerX, PLAYER_Y, SPIN_RADIUS, 0, Math.PI*2); ctx.fill()
    ctx.restore()
  }

  for (const item of items) item.draw()

  // Player last (always on top of field items at same Y) — sprite-based
  drawPlayerSprite(ctx, g)
  drawSpeedEffects(ctx, g, time)

  drawParticles(ctx, g)
  drawFloatTexts(ctx, g)
  drawHUD(ctx, g, time)
  drawOverlay(ctx, g, time, lastSubmitted)

  // Screen flash
  if (g.screenFlash > 0) {
    ctx.fillStyle = g.screenFlashColor
    ctx.globalAlpha = g.screenFlash
    ctx.fillRect(0, 0, GW, GH)
    ctx.globalAlpha = 1
  }

  ctx.restore()
}

// ─── React component ──────────────────────────────────────────────────────────

// Lightweight subscription so React re-renders the touch overlay / mode
// picker when the game phase changes. The game loop owns gsRef; we poll
// it at a low frequency to keep this hook self-contained.
function useGamePhase(gsRef: React.MutableRefObject<GS>): Phase {
  return useSyncExternalStore(
    (cb) => {
      const id = window.setInterval(cb, 100)
      return () => window.clearInterval(id)
    },
    () => gsRef.current.phase,
    () => 'menu',
  )
}

export function GamePage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gsRef     = useRef<GS>(initState())
  const { mode, setMode, userPicked, suggested, orientation, viewportTick } = useDisplayMode()
  const phase = useGamePhase(gsRef)

  // Safe-area probe: a hidden zero-sized div whose `padding-top` is set to
  // `env(safe-area-inset-top)`. Reading `offsetHeight` returns the
  // resolved CSS-pixel inset, which we feed into `applyDisplayMode` so the
  // canvas-drawn HUD avoids the notch on devices that report a non-zero
  // inset. Bottom inset is not needed here — touch controls handle their
  // own bottom safe-area padding via CSS.
  const safeTopRef = useRef<HTMLDivElement>(null)
  function readSafeTop(): number {
    return safeTopRef.current?.offsetHeight ?? 0
  }

  // Pending mode is set when the player switches Desktop/Mobile from the
  // pause overlay during an active run. We don't apply it immediately —
  // that would re-layout the canvas and disrupt the run. Instead we apply
  // it at the start of the next play (in `tryStartPlay`).
  const pendingModeRef = useRef<DisplayMode | null>(null)
  // Bump this to force a re-render after mutating pendingModeRef so the
  // pause overlay reflects the new pending state.
  const [, setPendingTick] = useState(0)
  const bumpPending = useCallback(() => setPendingTick(t => t + 1), [])

  const [canvasDims, setCanvasDims] = useState(() => {
    if (typeof window !== 'undefined') {
      applyDisplayMode(mode, window.innerWidth, window.innerHeight)
    }
    const dpr = typeof window !== 'undefined'
      ? Math.min(window.devicePixelRatio || 1, 2)
      : 1
    return { w: GW, h: GH, dpr }
  })

  // Recompute layout + canvas dims whenever the mode changes or the
  // viewport settles after a rotation/resize. Keeps `CURRENT_MODE`
  // and the mutable layout constants in sync with React state, AND
  // remaps any live entity positions into the new coordinate space so
  // a mid-run orientation flip doesn't strand anything off-screen.
  //
  // Single source of truth: viewport changes are debounced inside
  // `useDisplayMode` and surfaced as a monotonic `viewportTick`. When a
  // rotation also flips `mode`, both updates land in the same React
  // batch, so this effect runs exactly once per settled rotation —
  // producing exactly one `applyDisplayMode` + one
  // `remapEntitiesForLayout` call on the final size.
  useEffect(() => {
    const old = snapshotLayout()
    applyDisplayMode(mode, window.innerWidth, window.innerHeight, readSafeTop())
    remapEntitiesForLayout(gsRef.current, old)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    setCanvasDims((prev) =>
      prev.w === GW && prev.h === GH && prev.dpr === dpr
        ? prev
        : { w: GW, h: GH, dpr }
    )
  }, [mode, viewportTick])

  // `suggested` is exposed by the hook so the menu mode picker can show
  // a "suggested" hint; we don't need to react to it here because the
  // hook auto-flips `mode` directly when the user hasn't picked.
  void suggested

  // Game start helper: reset state and begin a play. Used by every input
  // surface (keyboard, swipe, touch buttons, mobile "tap to play").
  // Applies any queued pending mode change first so the new run uses the
  // newly chosen layout.
  const tryStartPlay = useCallback(() => {
    const cur = gsRef.current.phase
    if (cur === 'playing' || cur === 'paused' || cur === 'touchdown'
        || cur === 'versus' || cur === 'levelwin') return false
    if (!spritesReadyOrFailed()) return false
    // Block "press any key to play again" while initials entry is open
    // and unsubmitted — otherwise typing the player's tag would also kick
    // off a new run on every keystroke.
    if (gsRef.current.entryActive && !gsRef.current.entrySubmitted) return false

    const pending = pendingModeRef.current
    if (pending && pending !== mode) {
      // Apply layout immediately so initState reads the right LANE_XS,
      // then update React state so the canvas resizes to match.
      applyDisplayMode(pending, window.innerWidth, window.innerHeight, readSafeTop())
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      setCanvasDims({ w: GW, h: GH, dpr })
      setMode(pending)
    }
    pendingModeRef.current = null
    bumpPending()

    const hs = gsRef.current.highScore
    gsRef.current = initState(hs)
    // New runs always open with the LEVEL 1 versus card (ALCORN vs first
    // opponent in the rotation). The card holds for VERSUS_DUR seconds
    // and then auto-transitions to 'playing'.
    gsRef.current.phase = 'versus'
    gsRef.current.versusTimer = VERSUS_DUR
    prevKeys = { left:false, right:false, up:false, down:false, spin:false, turbo:false }
    clearAllHeld(gsRef.current)
    // Reset menu intro state so that if the menu phase is ever shown again
    // (e.g. after a component remount) the slam + collision replays cleanly.
    menuAnimStartTime = -1
    helmetCrackPlayed = false
    helmetCrackMissed = false
    // Start background music on first user gesture (respects autoplay policy).
    audioManager.startMusic().catch(() => {})
    // Procedural crowd noise — starts quiet and builds with multiplier.
    audioManager.startCrowd()
    // UI click on start / restart.
    audioManager.playUIClick()
    // Reset boost-loop tracking so the edge detector starts clean.
    _sfxPrevBoostActive = false
    _sfxPrevBoostTimer  = 0
    return true
  }, [mode, setMode, bumpPending])

  // ── Leaderboard initials-entry flow ────────────────────────────────────
  // React owns the input element; gsRef is mirrored from React on each
  // change so the canvas-side leaderboard panel can render the live tag.
  // `entryOpen` controls overlay visibility and is opened on the gameover
  // transition (via a polling effect on `phase`) when the run qualifies.
  const [entryOpen, setEntryOpen] = useState(false)
  const [entryInitialsR, setEntryInitialsR] = useState('')
  const [entrySubmittedR, setEntrySubmittedR] = useState(false)
  const [entryRankR, setEntryRankR] = useState(0)
  const [entryTdRankR, setEntryTdRankR] = useState(0)

  // Detect gameover transitions and open the entry overlay if the run
  // qualified for EITHER board. Reset whenever the phase leaves gameover.
  useEffect(() => {
    if (phase !== 'gameover') {
      setEntryOpen(false)
      setEntryInitialsR('')
      setEntrySubmittedR(false)
      setEntryRankR(0)
      setEntryTdRankR(0)
      return
    }
    const g = gsRef.current
    if (g.entryActive && !g.entrySubmitted) {
      setEntryOpen(true)
      setEntryInitialsR(g.entryInitials)
      setEntrySubmittedR(false)
      setEntryRankR(g.entryRank)
      setEntryTdRankR(g.tdEntryRank)
    } else {
      setEntryOpen(false)
    }
  }, [phase])

  // Mirror the React-side initials value into gsRef so the canvas
  // leaderboard panel renders the live tag while the player types.
  useEffect(() => {
    gsRef.current.entryInitials = entryInitialsR
  }, [entryInitialsR])

  // Sanitize and clamp an incoming input value to alphanumeric uppercase.
  // Uses the same character set as `sanitizeInitials` from leaderboard.ts
  // but does NOT pad — partial values are valid mid-typing.
  const handleInitialsChange = useCallback((raw: string) => {
    const cleaned = (raw ?? '').toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, INITIALS_LEN)
    setEntryInitialsR(cleaned)
    // Keep gsRef in sync immediately so the canvas-side leaderboard
    // panel renders the correct slot contents on the very next frame
    // without waiting for the mirroring effect to flush.
    gsRef.current.entryInitials = cleaned
  }, [])

  // Tracks the player's most recent qualifying submission for this tab
  // session. Survives `gsRef.current = initState(...)` resets so the
  // gold highlight in the canvas leaderboard panel persists across
  // subsequent runs / game-over screens. In-memory only — clears on
  // page refresh, which is the desired "session ends" behavior.
  const lastSubmittedRef = useRef<LeaderboardEntry | null>(null)

  // Re-entry guard: flips synchronously the moment a submit starts so
  // double-tapping SAVE / mashing Enter / racing SKIP+SAVE can't write
  // duplicate entries before React state propagates.
  const submittingRef = useRef(false)

  // Save the run to localStorage and freeze the gameover panel so the
  // player can either play again or admire their tag in the list.
  // The entry is saved to BOTH the points board and the touchdowns board
  // if it qualifies for each. Both snapshots in gsRef are updated so the
  // canvas panel reflects the saved entry immediately on either tab.
  const submitInitials = useCallback(() => {
    const g = gsRef.current
    if (submittingRef.current) return
    if (!g.entryActive || g.entrySubmitted) return
    submittingRef.current = true
    // Read the canonical initials directly from gsRef — it's mirrored
    // synchronously by handleInitialsChange so we always see the latest
    // value, even if this callback's React-state closure is stale.
    const initials = sanitizeInitials(g.entryInitials || 'AAA')
    // Flip the gsRef flag synchronously so any concurrent re-entry
    // through the same code path (touch + Enter, etc.) bails on the
    // `g.entrySubmitted` check above.
    g.entrySubmitted = true
    const newEntry: LeaderboardEntry = {
      initials,
      score:      g.score,
      touchdowns: g.touchdowns,
      ts:         Date.now(),
    }
    // Re-load from localStorage in case another tab updated it, then
    // insert into each board the player qualifies for, then persist both.
    // Update the snapshots so the canvas list reflects the saved entry
    // without needing a full game restart to reload.
    const { points: livePoints, tds: liveTds } = loadBoards()

    let nextPoints = livePoints
    let nextTds    = liveTds
    let confirmedRank   = g.entryRank
    let confirmedTdRank = g.tdEntryRank

    if (qualifiesForBoard(g.score, livePoints)) {
      const { board, rank } = insertEntry(livePoints, newEntry)
      nextPoints     = board
      confirmedRank  = rank > 0 ? rank : g.entryRank
    }
    if (qualifiesForTdBoard(g.touchdowns, liveTds, g.score)) {
      const { board, rank } = insertEntryByTd(liveTds, newEntry)
      nextTds        = board
      confirmedTdRank = rank > 0 ? rank : g.tdEntryRank
    }

    saveBoards(nextPoints, nextTds)
    g.lbSnapshot    = nextPoints
    g.tdSnapshot    = nextTds
    g.entryInitials = initials
    g.entryRank     = confirmedRank
    g.tdEntryRank   = confirmedTdRank
    lastSubmittedRef.current = newEntry
    setEntryInitialsR(initials)
    setEntrySubmittedR(true)
    setEntryRankR(g.entryRank)
    setEntryTdRankR(g.tdEntryRank)
    setEntryOpen(false)
    submittingRef.current = false
  }, [])

  // Pause toggle — works in both desktop and mobile modes. Pause does not
  // tear down or reinitialise game state; it just halts the update loop
  // (see `update()` early-return when phase !== 'playing').
  const togglePause = useCallback(() => {
    const g = gsRef.current
    if (g.phase === 'playing') {
      g.phase = 'paused'
      // Clear held inputs (from every source) so a stale ArrowLeft or
      // held gamepad direction doesn't immediately fire on un-pause.
      clearAllHeld(g)
      // Stop the boost engine loop so it doesn't play through pause.
      audioManager.stopBoostLoop()
      _sfxPrevBoostActive = false
      audioManager.playUIClick()
    } else if (g.phase === 'paused') {
      g.phase = 'playing'
      audioManager.playUIClick()
    }
  }, [])

  // Pause-overlay mode picker handler. While playing/paused we queue the
  // change; from menu/gameover we apply immediately.
  const onPickModeContextual = useCallback((m: DisplayMode) => {
    const g = gsRef.current
    const inRun = g.phase === 'playing' || g.phase === 'paused' || g.phase === 'touchdown'
                || g.phase === 'versus' || g.phase === 'levelwin'
    if (inRun) {
      pendingModeRef.current = m === mode ? null : m
      bumpPending()
    } else {
      pendingModeRef.current = null
      setMode(m)
      bumpPending()
    }
  }, [mode, setMode, bumpPending])

  // Controller indicator toast — shown briefly on connect/disconnect.
  // `id` lets us re-trigger the auto-dismiss timer when the same text
  // would otherwise be deduped by React's identity check.
  const [gpToast, setGpToast] = useState<{ text: string; id: number } | null>(null)
  // Focus hint — shown when a controller is connected but the document
  // doesn't have focus. Without focus, the Gamepad API's button events
  // don't count as "user interaction" and the AudioContext stays locked,
  // so the player needs to click the game window first. Hidden as soon
  // as the page gains focus, the player clicks inside the game, or any
  // gamepad input edge is detected.
  const [showFocusHint, setShowFocusHint] = useState(false)
  const showFocusHintRef = useRef(false)
  const dismissFocusHint = useCallback(() => {
    if (!showFocusHintRef.current) return
    showFocusHintRef.current = false
    setShowFocusHint(false)
  }, [])
  // Mirrored copy of `gsRef.current.powerUps` so React can re-render the
  // touch controls when the inventory changes. Synced from the game loop
  // only when the value actually changes to avoid per-frame re-renders.
  const [touchPowerUps, setTouchPowerUps] = useState(0)
  useEffect(() => {
    if (!gpToast) return
    const t = window.setTimeout(() => setGpToast(null), 2200)
    return () => window.clearTimeout(t)
  }, [gpToast])

  // Gamepad — polls the active gamepad each frame and folds its state
  // into the same `g.keys` action flags that the keyboard / touch paths
  // feed. Lane changes, jump, spin, turbo and pause are edge-triggered
  // (via the existing module-level `prevKeys` snapshot for the in-play
  // actions, plus our own button-edge tracking here for pause and
  // game-start). Held directions therefore behave like a discrete tap,
  // matching how arrow keys feel today.
  //
  // Mapping (Xbox / PS / Switch Pro / MFi standard layout):
  //   d-pad + left stick  →  lane (L/R), spin (Up), turbo (Down)
  //   button 0 (bottom)   →  JUMP
  //   button 1 (right)    →  SPIN
  //   button 3 (top)      →  TURBO
  //   button 9 (Start)    →  pause / resume / start play
  //
  // Non-standard mappings fall back to face buttons + analog stick (the
  // d-pad button indices are skipped because they vary by device).
  useEffect(() => {
    let activeIndex: number | null = null
    let prevDirs = { left: false, right: false, up: false, down: false }
    let prevButtons: boolean[] = []
    let prevAnyAxisActive = false
    let raf = 0

    function showToast(text: string) {
      setGpToast({ text, id: Date.now() })
    }

    function clearGamepadKeys() {
      gpHeld.left = gpHeld.right = gpHeld.up = false
      gpHeld.spin = gpHeld.turbo = false
      mergeHeld(gsRef.current)
      prevDirs = { left: false, right: false, up: false, down: false }
      prevButtons = []
    }

    function findGamepad(): Gamepad | null {
      if (typeof navigator === 'undefined' || !navigator.getGamepads) return null
      const pads = navigator.getGamepads()
      if (!pads) return null
      if (activeIndex !== null) {
        const p = pads[activeIndex]
        if (p && p.connected) {
          return p
        }
        // Only evict the saved index when the browser explicitly reports the
        // pad as present-but-disconnected. If the slot is still null, Chrome's
        // getGamepads() snapshot may not have propagated yet after a fresh
        // `gamepadconnected` event — keep `activeIndex` so the next frame
        // can find the pad without clobbering the hint `onConnect` gave us.
        if (p && !p.connected) {
          activeIndex = null
          ACTIVE_GAMEPAD_INDEX = null
        }
      }
      // Recover from stale indices (e.g. hot-reload / browser slot churn)
      // by scanning all currently connected pads and picking the one with
      // the richest state surface.
      let best: Gamepad | null = null
      let bestScore = -1
      for (const p of pads) {
        if (p && p.connected) {
          const score = (p.buttons?.length ?? 0) + (p.axes?.length ?? 0)
          if (score > bestScore) {
            best = p
            bestScore = score
          }
        }
      }
      if (best) {
        activeIndex = best.index
        ACTIVE_GAMEPAD_INDEX = best.index
        return best
      }
      return null
    }

    function maybeShowFocusHint() {
      if (typeof document === 'undefined') return
      if (document.hasFocus && document.hasFocus()) return
      if (showFocusHintRef.current) return
      showFocusHintRef.current = true
      setShowFocusHint(true)
    }

    function onConnect(e: GamepadEvent) {
      // Only the first connected controller drives the player. A second
      // pad connecting mid-session is ignored so it can't take over.
      if (activeIndex === null) {
        activeIndex = e.gamepad.index
        ACTIVE_GAMEPAD_INDEX = activeIndex
        GAMEPAD_CONNECTED = true
        showToast('Controller connected')
        maybeShowFocusHint()
      }
    }
    function onDisconnect(e: GamepadEvent) {
      // Only react to the active controller leaving — silently ignore
      // disconnects from other pads that were never driving the player.
      if (activeIndex !== e.gamepad.index) return
      activeIndex = null
      ACTIVE_GAMEPAD_INDEX = null
      GAMEPAD_CONNECTED = false
      clearGamepadKeys()
      showToast('Controller disconnected')
      if (showFocusHintRef.current) {
        showFocusHintRef.current = false
        setShowFocusHint(false)
      }
    }
    function onWindowFocus() {
      if (showFocusHintRef.current) {
        showFocusHintRef.current = false
        setShowFocusHint(false)
      }
    }

    const DEAD = 0.35
    const BTN_THRESH = 0.55
    function btn(pad: Gamepad, i: number): boolean {
      const b = pad.buttons[i]
      return !!b && (b.pressed || b.value >= BTN_THRESH)
    }

    function hatDirs(axis: number | undefined): { up: boolean; down: boolean; left: boolean; right: boolean } {
      if (axis === undefined || Number.isNaN(axis) || axis < -1.05 || axis > 1.05) {
        return { up: false, down: false, left: false, right: false }
      }
      // Common HID hat mapping in browsers: values in [-1..1] stepping by 2/7.
      // neutral=-1, up=-1, right~ -0.43, down~ 0.14, left~ 0.71 (diagonals between).
      const sectors = [-1.0, -0.71, -0.43, -0.14, 0.14, 0.43, 0.71, 1.0]
      let nearest = sectors[0]
      let best = Infinity
      for (const s of sectors) {
        const d = Math.abs(axis - s)
        if (d < best) { best = d; nearest = s }
      }
      if (best > 0.18) return { up: false, down: false, left: false, right: false }
      if (nearest === -1.0) return { up: true, down: false, left: false, right: false }
      if (nearest === -0.71) return { up: true, down: false, left: false, right: true }
      if (nearest === -0.43) return { up: false, down: false, left: false, right: true }
      if (nearest === -0.14) return { up: false, down: true, left: false, right: true }
      if (nearest === 0.14)  return { up: false, down: true, left: false, right: false }
      if (nearest === 0.43)  return { up: false, down: true, left: true, right: false }
      if (nearest === 0.71)  return { up: false, down: false, left: true, right: false }
      return { up: true, down: false, left: true, right: false }
    }

    function poll() {
      const pad = findGamepad()
      const wasConnected = GAMEPAD_CONNECTED
      GAMEPAD_CONNECTED = !!pad
      // If polling discovered a fresh controller (Chrome/Safari can defer
      // `gamepadconnected` until the first input edge), surface the focus
      // hint the same way `onConnect` would.
      if (pad && !wasConnected) maybeShowFocusHint()
      if (!pad && showFocusHintRef.current) {
        showFocusHintRef.current = false
        setShowFocusHint(false)
      }
      if (pad) {
        const g = gsRef.current

        const ax = pad.axes[0] ?? 0
        const ay = pad.axes[1] ?? 0
        const stickLeft  = ax < -DEAD
        const stickRight = ax >  DEAD
        const stickUp    = ay < -DEAD
        const stickDown  = ay >  DEAD
        const hat = hatDirs(pad.axes[9])

        // Read d-pad button indices on every mapping. The standard
        // layout puts the d-pad at 12–15; many non-standard pads also
        // expose it there, and the task explicitly calls out keeping
        // d-pad working as the graceful fallback. Indices that don't
        // exist read as `false` via the guarded `btn()` helper.
        const dpadUp    = btn(pad, 12) || hat.up
        const dpadDown  = btn(pad, 13) || hat.down
        const dpadLeft  = btn(pad, 14) || hat.left
        const dpadRight = btn(pad, 15) || hat.right

        const dirLeft  = dpadLeft  || stickLeft
        const dirRight = dpadRight || stickRight
        const dirUp    = dpadUp    || stickUp
        const dirDown  = dpadDown  || stickDown

        const btnA = btn(pad, 0)   // bottom — JUMP
        const btnB = btn(pad, 1)   // right  — SPIN
        const btnY = btn(pad, 3)   // top    — TURBO
        const btnStart = btn(pad, 9)

        const prevA = prevButtons[0] ?? false
        const prevB = prevButtons[1] ?? false
        const prevY = prevButtons[3] ?? false
        const prevStart = prevButtons[9] ?? false

        // Pause toggle (Start). Only inside an active run; outside it,
        // Start just acts as a "press to play" trigger below.
        if (btnStart && !prevStart) {
          const cur = g.phase
          if (cur === 'playing' || cur === 'paused') {
            togglePause()
          }
        }

        // Press-any-button-to-start. From menu / gameover, an edge on
        // any face button, Start, or a fresh directional push begins a
        // new run — mirroring the keyboard's "press any key to play".
        const anyButtonNow = pad.buttons?.some((b) => !!b && (b.pressed || b.value >= BTN_THRESH)) ?? false
        const prevAnyButton = prevButtons.some(Boolean)
        const anyButtonEdge = anyButtonNow && !prevAnyButton
        const anyAxisNow = Math.abs(ax) > DEAD || Math.abs(ay) > DEAD || dirLeft || dirRight || dirUp || dirDown
        const anyAxisEdge = anyAxisNow && !prevAnyAxisActive

        const anyInputEdge =
          (btnA && !prevA) || (btnB && !prevB) ||
          (btnY && !prevY) ||
          (btnStart && !prevStart) ||
          (dirLeft  && !prevDirs.left)  ||
          (dirRight && !prevDirs.right) ||
          (dirUp    && !prevDirs.up)    ||
          (dirDown  && !prevDirs.down)  ||
          anyButtonEdge || anyAxisEdge
        if (anyInputEdge && showFocusHintRef.current) {
          showFocusHintRef.current = false
          setShowFocusHint(false)
        }
        if (g.phase === 'menu' || g.phase === 'gameover') {
          if (anyInputEdge) tryStartPlay()
        }

        // Fold gamepad state into the gamepad-source held flags. The
        // merger ORs these with the keyboard's flags into `g.keys`, so
        // a connected idle controller never suppresses keyboard input
        // and both can drive the player simultaneously.
        if (g.phase === 'playing') {
          // D-pad/stick UP = SPIN, DOWN = TURBO (held direction trigger).
          // Face buttons: A = JUMP, B = SPIN, Y = TURBO.
          gpHeld.left  = dirLeft
          gpHeld.right = dirRight
          gpHeld.up    = btnA
          gpHeld.spin  = btnB || dirUp
          gpHeld.turbo = btnY || dirDown
        } else {
          // Outside of playing, scrub any held gamepad-driven flags so
          // resuming or restarting starts from a clean slate without
          // disturbing keyboard state.
          gpHeld.left = gpHeld.right = gpHeld.up = false
          gpHeld.spin = gpHeld.turbo = false
        }
        mergeHeld(g)

        prevDirs = { left: dirLeft, right: dirRight, up: dirUp, down: dirDown }
        // Snapshot the buttons we care about (cheaper than mapping all).
        prevButtons[0] = btnA; prevButtons[1] = btnB
        prevButtons[3] = btnY
        prevButtons[9] = btnStart
        // Keep a full snapshot too so "any button" edges work on pads
        // whose standard face-button indices aren't reported consistently.
        prevButtons.length = pad.buttons.length
        for (let bi = 0; bi < pad.buttons.length; bi++) prevButtons[bi] = btn(pad, bi)
        prevAnyAxisActive = anyAxisNow
      }
      // Always reschedule — the loop must keep running even when no pad
      // is currently detected so it can pick up a controller that connects
      // (or reconnects) after the initial mount without relying solely on
      // the `gamepadconnected` event (which Chrome only fires after the
      // first user interaction with the pad).
      raf = requestAnimationFrame(poll)
    }

    // Pre-seed activeIndex if a controller was already paired before
    // this effect mounted — Chrome/Safari only fire `gamepadconnected`
    // after the first input event from the pad, so polling will pick it
    // up automatically once the player nudges a stick or button.
    if (typeof navigator !== 'undefined' && navigator.getGamepads) {
      const pads = navigator.getGamepads()
      if (pads) {
        for (const p of pads) {
          if (p && p.connected) {
            activeIndex = p.index
            ACTIVE_GAMEPAD_INDEX = p.index
            GAMEPAD_CONNECTED = true
            maybeShowFocusHint()
            break
          }
        }
      }
    }

    window.addEventListener('gamepadconnected', onConnect)
    window.addEventListener('gamepaddisconnected', onDisconnect)
    window.addEventListener('focus', onWindowFocus)
    window.addEventListener('pointerdown', dismissFocusHint, { passive: true })
    raf = requestAnimationFrame(poll)
    return () => {
      window.removeEventListener('gamepadconnected', onConnect)
      window.removeEventListener('gamepaddisconnected', onDisconnect)
      window.removeEventListener('focus', onWindowFocus)
      window.removeEventListener('pointerdown', dismissFocusHint)
      cancelAnimationFrame(raf)
      GAMEPAD_CONNECTED = false
      ACTIVE_GAMEPAD_INDEX = null
    }
  }, [togglePause, tryStartPlay, dismissFocusHint])

  // Keyboard
  useEffect(() => {
    function down(e: KeyboardEvent) {
      // Pause/resume toggle (Esc / P). Don't pass through to game keys.
      if (e.code === 'Escape' || e.code === 'KeyP') {
        const cur = gsRef.current.phase
        if (cur === 'playing' || cur === 'paused') {
          e.preventDefault()
          togglePause()
          return
        }
      }

      // Ignore movement keys while paused so players can't queue input.
      if (gsRef.current.phase === 'paused') return

      // Lane movement
      if (e.code==='ArrowLeft' ||e.code==='KeyA') kbHeld.left=true
      if (e.code==='ArrowRight'||e.code==='KeyD') kbHeld.right=true
      // Jump (up/W/Space)
      if (e.code==='ArrowUp'   ||e.code==='KeyW'||e.code==='Space') kbHeld.up=true
      // Spin dodge (X / Shift) and turbo burst (C)
      if (e.code==='KeyX' || e.code==='ShiftLeft' || e.code==='ShiftRight') kbHeld.spin=true
      if (e.code==='KeyC') kbHeld.turbo=true
      mergeHeld(gsRef.current)
      if ([
        'Space','ArrowUp','ArrowLeft','ArrowRight',
      ].includes(e.code)) e.preventDefault()

      // Tab is reserved for cycling board modes; don't let it start a game.
      if (e.code === 'Tab') return

      // Bootstrap audio on any key — covers the case where the user presses a
      // key on the menu screen *before* tapping the start button, ensuring the
      // AudioContext is unlocked and the pending helmet-crack SFX is drained.
      audioManager.startMusic().catch(() => {})

      // Gate gameplay start on sprite preload completion so the player is
      // never rendered with the placeholder fallback during the first frame.
      if (tryStartPlay()) {
        // tryStartPlay clears all held flags; re-apply this keypress so
        // it isn't lost across the menu→play transition.
        if (e.code==='ArrowLeft' ||e.code==='KeyA') kbHeld.left=true
        if (e.code==='ArrowRight'||e.code==='KeyD') kbHeld.right=true
        if (e.code==='ArrowUp'   ||e.code==='KeyW'||e.code==='Space') kbHeld.up=true
        if (e.code==='KeyX' || e.code==='ShiftLeft' || e.code==='ShiftRight') kbHeld.spin=true
        if (e.code==='KeyC') kbHeld.turbo=true
        mergeHeld(gsRef.current)
      }
    }
    function up(e: KeyboardEvent) {
      if (e.code==='ArrowLeft' ||e.code==='KeyA') kbHeld.left=false
      if (e.code==='ArrowRight'||e.code==='KeyD') kbHeld.right=false
      if (e.code==='ArrowUp'   ||e.code==='KeyW'||e.code==='Space') kbHeld.up=false
      if (e.code==='KeyX' || e.code==='ShiftLeft' || e.code==='ShiftRight') kbHeld.spin=false
      if (e.code==='KeyC') kbHeld.turbo=false
      mergeHeld(gsRef.current)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [togglePause, tryStartPlay])

  // Touch (swipe gestures, attached to the canvas element so taps on
  // overlay UI — mode toggle, on-screen control buttons, pause overlay —
  // don't trigger a "tap to start" or a stray swipe).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let sx=0, sy=0
    function ts(e: TouchEvent) {
      sx=e.touches[0].clientX; sy=e.touches[0].clientY
      // Bootstrap audio on first touch — ensures AudioContext is unlocked
      // on mobile so the pending helmet-crack SFX can drain immediately.
      audioManager.startMusic().catch(() => {})
      // Guard: don't start the game if the tap lands on a leaderboard tab.
      // TAB_POINTS_RECT / TAB_TD_RECT are in canvas-space; map the touch
      // coordinates to canvas-space using the same scale as handleCanvasPointer.
      const g = gsRef.current
      if ((g.phase === 'menu' || g.phase === 'gameover') && canvas) {
        const r = canvas.getBoundingClientRect()
        const scaleX = GW / r.width
        const scaleY = GH / r.height
        const cx = (sx - r.left) * scaleX
        const cy = (sy - r.top)  * scaleY
        const hitTab = (rect: { x: number; y: number; w: number; h: number }) =>
          cx >= rect.x && cx <= rect.x + rect.w &&
          cy >= rect.y && cy <= rect.y + rect.h
        if (hitTab(TAB_POINTS_RECT) || hitTab(TAB_TD_RECT)) return
      }
      tryStartPlay()
    }
    function te(e: TouchEvent) {
      const g = gsRef.current
      // Don't process swipes while paused — the pause overlay takes over.
      if (g.phase === 'paused') return
      const dx=e.changedTouches[0].clientX-sx, dy=e.changedTouches[0].clientY-sy
      if (Math.abs(dx)>Math.abs(dy)) {
        if (dx<-25) { if(g.targetLane>0) g.targetLane-- }
        else if (dx>25) { if(g.targetLane<NLANES-1) g.targetLane++ }
      } else {
        // Swipe up = Jump (requires a power-up).
        if (dy < -30 && g.jumpTimer <= 0 && !g.spinning) {
          if (g.powerUps > 0) {
            g.jumpTimer = JUMP_DUR
            g.jumpHitThisJump = false
            burst(g, g.playerX, PLAYER_Y + 22, '#cccccc', 8, 120)
            burst(g, g.playerX, PLAYER_Y + 22, C_WHITE, 4, 80)
          } else {
            g.screenFlash = Math.max(g.screenFlash, 0.12)
            g.screenFlashColor = 'rgba(255,80,80,0.25)'
            addFloat(g, g.playerX, PLAYER_Y - 50, 'NEED POWER-UP!', '#ff6666', 22)
          }
        }
      }
    }
    canvas.addEventListener('touchstart', ts, {passive:true})
    canvas.addEventListener('touchend', te, {passive:true})
    return () => { canvas.removeEventListener('touchstart', ts); canvas.removeEventListener('touchend', te) }
  }, [canvasDims.w, canvasDims.h, tryStartPlay])

  // Preload player sprites once, before the first gameplay frame.
  useEffect(() => {
    loadPlayerSprites().catch((err) => {
      console.warn('player sprite preload failed', err)
    })
    loadPowerUpSprites().catch((err) => {
      console.warn('power-up sprite preload failed', err)
    })
    loadDefenderSprites().catch((err) => {
      console.warn('defender sprite preload failed', err)
    })
    loadMenuHelmetImages()
  }, [])

  // Game loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let last = performance.now(), raf: number
    let lastPowerUps = gsRef.current.powerUps
    const loop = (now: number) => {
      update(gsRef.current, (now - last) / 1000)
      render(ctx, gsRef.current, now / 1000, canvasDims.dpr, lastSubmittedRef.current)
      // Sync power-up count to React state only when it actually changes,
      // so the touch buttons can re-render their available/empty visual.
      // Gate on a local ref-like variable so we don't schedule update work
      // every animation frame.
      const pu = gsRef.current.powerUps
      if (pu !== lastPowerUps) {
        lastPowerUps = pu
        setTouchPowerUps(pu)
      }
      last = now
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [canvasDims.dpr, canvasDims.w, canvasDims.h])

  // Touch button helpers — invoked by the on-screen control overlay
  // (mobile only). Mirror the same effects as the equivalent keyboard /
  // swipe input.
  const onTouchLeft = () => {
    const g = gsRef.current
    if (g.phase === 'playing' && g.targetLane > 0) g.targetLane--
  }
  const onTouchRight = () => {
    const g = gsRef.current
    if (g.phase === 'playing' && g.targetLane < NLANES - 1) g.targetLane++
  }
  const onTouchJump = () => {
    const g = gsRef.current
    if (g.phase !== 'playing' || g.jumpTimer > 0 || g.spinning) return
    if (g.powerUps > 0) {
      g.jumpTimer = JUMP_DUR
      g.jumpHitThisJump = false
      burst(g, g.playerX, PLAYER_Y + 22, '#cccccc', 8, 120)
      burst(g, g.playerX, PLAYER_Y + 22, C_WHITE, 4, 80)
    } else {
      g.screenFlash = Math.max(g.screenFlash, 0.12)
      g.screenFlashColor = 'rgba(255,80,80,0.25)'
      addFloat(g, g.playerX, PLAYER_Y - 50, 'NEED POWER-UP!', '#ff6666', 22)
    }
  }
  const onTouchSpin = () => {
    const g = gsRef.current
    if (g.phase !== 'playing' || g.spinning || g.jumpTimer > 0) return
    if (g.powerUps > 0) {
      g.spinning = true; g.spinTimer = 0; g.spinRotation = 0; g.spinHitThisActivation = false
      burst(g, g.playerX, PLAYER_Y, C_GOLD, 16, 220)
      burst(g, g.playerX, PLAYER_Y, C_WHITE, 8, 160)
    } else {
      g.screenFlash = Math.max(g.screenFlash, 0.12)
      g.screenFlashColor = 'rgba(255,80,80,0.25)'
      addFloat(g, g.playerX, PLAYER_Y - 50, 'NEED POWER-UP!', '#ff6666', 22)
    }
  }
  const onTouchTurbo = () => {
    const g = gsRef.current
    // Cannot activate turbo during a jump or spin (move exclusivity).
    if (g.phase !== 'playing' || g.boosting || g.jumpTimer > 0 || g.spinning) return
    if (g.powerUps > 0) {
      g.boosting = true; g.boostTimer = BOOST_DUR; g.turboHitThisActivation = false
      burst(g, g.playerX, PLAYER_Y + 20, C_GOLD, 12, 180)
      addFloat(g, g.playerX, PLAYER_Y - 60, 'TURBO!', C_GOLD, 32)
    } else {
      g.screenFlash = Math.max(g.screenFlash, 0.12)
      g.screenFlashColor = 'rgba(255,80,80,0.25)'
      addFloat(g, g.playerX, PLAYER_Y - 60, 'NEED POWER-UP!', '#ff6666', 22)
    }
  }
  const showTouchControls = mode === 'mobile' && phase === 'playing'
  const isLandscapeMobile = mode === 'mobile' && orientation === 'landscape'
  const showModePicker    = phase === 'menu' || phase === 'gameover'
  const showPauseButton   = phase === 'playing' || phase === 'paused'
  const showPauseOverlay  = phase === 'paused'

  // Music toggle — synced from audioManager (which persists to localStorage).
  const [musicOn, setMusicOn] = useState(() => audioManager.getMusicOn())
  const handleToggleMusic = useCallback(() => {
    // Bootstrap audio on first interaction even from the settings UI.
    audioManager.startMusic().catch(() => {})
    const next = !audioManager.getMusicOn()
    audioManager.setMusicOn(next)
    setMusicOn(next)
  }, [])

  // ── Board-mode toggle ─────────────────────────────────────────────────────
  // React owns the authoritative value and persists it to localStorage.
  // CURRENT_BOARD_MODE is a module-level mirror so drawing code can read
  // the active board without prop threading.
  const [boardMode, setBoardModeR] = useState<BoardMode>(() => CURRENT_BOARD_MODE)
  const setBoardMode = useCallback((m: BoardMode) => {
    CURRENT_BOARD_MODE = m
    setBoardModeR(m)
    try { window.localStorage.setItem(BOARD_MODE_STORAGE_KEY, m) } catch { /* ignore */ }
  }, [])
  // Keep the module-level var in sync whenever boardMode state changes
  // (e.g. initial hydration mismatch between SSR/CSR).
  CURRENT_BOARD_MODE = boardMode

  // Handle pointer-down events on the canvas so the leaderboard tabs
  // can be clicked. Converts CSS pixels → canvas-internal coordinates,
  // then checks against the hit rects updated by drawLeaderboardPanel.
  const handleCanvasPointer = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gsRef.current
    if (g.phase !== 'menu' && g.phase !== 'gameover') return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect   = canvas.getBoundingClientRect()
    const scaleX = GW / rect.width
    const scaleY = GH / rect.height
    const cx = (e.clientX - rect.left) * scaleX
    const cy = (e.clientY - rect.top)  * scaleY
    const hit = (r: { x: number; y: number; w: number; h: number }) =>
      cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h
    if (hit(TAB_POINTS_RECT)) {
      setBoardMode('points')
      e.stopPropagation()
    } else if (hit(TAB_TD_RECT)) {
      setBoardMode('touchdowns')
      e.stopPropagation()
    }
  }, [setBoardMode])

  // Also allow Tab key to cycle board modes when on menu / gameover screens.
  useEffect(() => {
    function onKeyTab(e: KeyboardEvent) {
      if (e.code !== 'Tab') return
      const g = gsRef.current
      if (g.phase !== 'menu' && g.phase !== 'gameover') return
      e.preventDefault()
      setBoardMode(CURRENT_BOARD_MODE === 'points' ? 'touchdowns' : 'points')
    }
    window.addEventListener('keydown', onKeyTab)
    return () => window.removeEventListener('keydown', onKeyTab)
  }, [setBoardMode])

  // Canvas style: in mobile mode it fills the viewport (the canvas's
  // internal aspect ratio already matches the device, so no letterbox);
  // in desktop mode it letterboxes to preserve the 16:9 layout.
  const canvasStyle: React.CSSProperties = mode === 'mobile'
    ? { width: '100vw', height: '100vh', objectFit: 'contain', display: 'block', touchAction: 'none' }
    : { width: '100%',  height: '100%',  objectFit: 'contain', display: 'block', touchAction: 'none' }

  return (
    <div
      className={`game-root game-root--${mode}${isLandscapeMobile ? ' game-root--landscape' : ''}`}
      style={{
        width: '100vw',
        height: '100vh',
        background: '#08041e',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        position: 'relative',
      }}
      onPointerDownCapture={dismissFocusHint}
    >
      <canvas
        ref={canvasRef}
        width={canvasDims.w * canvasDims.dpr}
        height={canvasDims.h * canvasDims.dpr}
        style={canvasStyle}
        onPointerDown={handleCanvasPointer}
      />

      {/* Hidden safe-area probe — see `readSafeTop()` above. */}
      <div ref={safeTopRef} className="safe-probe safe-probe--top" aria-hidden="true" />

      {showModePicker && (
        <ModePickerOverlay
          mode={mode}
          suggested={suggested}
          userPicked={userPicked}
          onPick={(m) => { audioManager.startMusic().catch(() => {}); pendingModeRef.current = null; setMode(m); bumpPending() }}
          musicOn={musicOn}
          onToggleMusic={handleToggleMusic}
        />
      )}

      {showPauseButton && (
        <button
          type="button"
          className="pause-btn"
          aria-label={phase === 'paused' ? 'Resume' : 'Pause'}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); togglePause() }}
        >
          {phase === 'paused' ? '▶' : '❚❚'}
        </button>
      )}

      {showPauseOverlay && (
        <PauseOverlay
          mode={mode}
          pendingMode={pendingModeRef.current}
          onPickMode={onPickModeContextual}
          onResume={togglePause}
          musicOn={musicOn}
          onToggleMusic={handleToggleMusic}
        />
      )}

      {showFocusHint && (
        <div
          className="gp-focus-hint"
          role="status"
          aria-live="polite"
          onPointerDownCapture={dismissFocusHint}
        >
          <svg
            className="gp-focus-hint__icon"
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 11V6a3 3 0 1 1 6 0v5" />
            <path d="M5 11h14l-1 9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 11Z" />
          </svg>
          <span className="gp-focus-hint__text">
            Click here to activate controller
          </span>
        </div>
      )}

      {gpToast && (
        <div
          key={gpToast.id}
          className="gp-toast"
          role="status"
          aria-live="polite"
        >
          <svg
            className="gp-toast__icon"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 12h4" />
            <path d="M8 10v4" />
            <circle cx="15" cy="11" r="1" />
            <circle cx="17.5" cy="13.5" r="1" />
            <path d="M17.32 5H6.68A4.68 4.68 0 0 0 2 9.68v4.64A4.68 4.68 0 0 0 6.68 19h.36a3 3 0 0 0 2.4-1.2L11 16h2l1.56 1.8A3 3 0 0 0 16.96 19h.36A4.68 4.68 0 0 0 22 14.32V9.68A4.68 4.68 0 0 0 17.32 5Z" />
          </svg>
          <span className="gp-toast__text">{gpToast.text}</span>
        </div>
      )}

      {showTouchControls && (
        <TouchControls
          landscape={isLandscapeMobile}
          powerUps={touchPowerUps}
          onLeft={onTouchLeft}
          onRight={onTouchRight}
          onJump={onTouchJump}
          onSpin={onTouchSpin}
          onTurbo={onTouchTurbo}
        />
      )}

      {entryOpen && !entrySubmittedR && (
        <InitialsEntryOverlay
          rank={entryRankR}
          tdRank={entryTdRankR}
          value={entryInitialsR}
          onChange={handleInitialsChange}
          onSubmit={submitInitials}
        />
      )}
    </div>
  )
}

// ─── Initials entry overlay ──────────────────────────────────────────────────
// Shown on the game-over screen when the run qualifies for the top-10.
// Renders three styled letter slots backed by a single hidden HTML input so
// mobile players get the OS keyboard for free. Submit on Enter or via the
// SAVE button, with a tiny SKIP fallback if the player just wants to bail
// without saving.
function InitialsEntryOverlay(props: {
  rank:   number    // points board rank (0 if doesn't qualify for points)
  tdRank: number    // touchdowns board rank (0 if doesn't qualify for TDs)
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
}) {
  const { rank, tdRank, value, onChange, onSubmit } = props
  const isPointsOnly = rank > 0 && tdRank === 0
  const isTdOnly     = rank === 0 && tdRank > 0
  const isBoth       = rank > 0 && tdRank > 0
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus the hidden input on mount so keyboards (desktop + mobile)
  // start capturing immediately.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Stop the global keydown handler from interpreting these keys as
    // "press any key to play again" — let the input handle them.
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      if (isValidInitials(value)) onSubmit()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value)
  }

  const slots: string[] = []
  for (let i = 0; i < INITIALS_LEN; i++) {
    slots.push(value[i] ?? '')
  }
  const ready = isValidInitials(value)

  return (
    <div
      className="initials-entry"
      onPointerDown={(e) => {
        e.stopPropagation()
        inputRef.current?.focus()
      }}
    >
      <div className="initials-entry__panel">
        <div className="initials-entry__title">
          {isTdOnly
            ? `🏈 NEW TD RECORD — RANK #${tdRank}`
            : isBoth
              ? `★ RANK #${rank} PTS  ·  #${tdRank} TDs ★`
              : `★ NEW HIGH SCORE — RANK #${rank} ★`}
        </div>
        <div className="initials-entry__sub">
          {isPointsOnly ? 'Points leaderboard · Enter your 3-letter tag'
            : isTdOnly  ? 'Touchdowns leaderboard · Enter your 3-letter tag'
            : 'Both leaderboards · Enter your 3-letter tag'}
        </div>

        <div className="initials-entry__slots" aria-hidden="true">
          {slots.map((c, i) => (
            <div
              key={i}
              className={`initials-entry__slot ${
                i === Math.min(value.length, INITIALS_LEN - 1) && value.length < INITIALS_LEN
                  ? 'initials-entry__slot--active'
                  : ''
              } ${c ? 'initials-entry__slot--filled' : ''}`}
            >
              {c || '_'}
            </div>
          ))}
        </div>

        {/* Single source of truth for the typed value — visually hidden
            but kept focusable so keyboards open on mobile. */}
        <input
          ref={inputRef}
          className="initials-entry__input"
          type="text"
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          maxLength={INITIALS_LEN}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          aria-label="Enter your 3-letter initials"
        />

        <div className="initials-entry__buttons">
          <button
            type="button"
            className="initials-entry__btn initials-entry__btn--skip"
            onPointerDown={(e) => {
              e.stopPropagation()
              // Set both the React-controlled value AND submit on the
              // next tick. submitInitials reads from gsRef (which
              // onChange updates synchronously) so the saved tag is
              // exactly "AAA" regardless of React state timing.
              onChange('AAA')
              setTimeout(onSubmit, 0)
            }}
          >
            SKIP
          </button>
          <button
            type="button"
            className="initials-entry__btn initials-entry__btn--save"
            disabled={!ready}
            onPointerDown={(e) => {
              e.stopPropagation()
              if (ready) onSubmit()
            }}
          >
            SAVE
          </button>
        </div>

        <div className="initials-entry__hint">
          A-Z and 0-9 · press <kbd>Enter</kbd> to save
        </div>
      </div>
    </div>
  )
}

// ─── Pause overlay ───────────────────────────────────────────────────────────
function PauseOverlay(props: {
  mode: DisplayMode
  pendingMode: DisplayMode | null
  onPickMode: (m: DisplayMode) => void
  onResume: () => void
  musicOn: boolean
  onToggleMusic: () => void
}) {
  const { mode, pendingMode, onPickMode, onResume, musicOn, onToggleMusic } = props
  const effective = pendingMode ?? mode
  return (
    <div
      className="pause-overlay"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pause-overlay__panel">
        <h2 className="pause-overlay__title">PAUSED</h2>

        <div className="pause-overlay__section">
          <div className="pause-overlay__label">DISPLAY MODE</div>
          <div className="mode-picker__row">
            <button
              type="button"
              className={`mode-picker__btn ${effective === 'desktop' ? 'is-active' : ''}`}
              onPointerDown={(e) => { e.stopPropagation(); onPickMode('desktop') }}
            >
              <span className="mode-picker__label">Desktop</span>
              {pendingMode === 'desktop' && (
                <span className="mode-picker__hint">next play</span>
              )}
            </button>
            <button
              type="button"
              className={`mode-picker__btn ${effective === 'mobile' ? 'is-active' : ''}`}
              onPointerDown={(e) => { e.stopPropagation(); onPickMode('mobile') }}
            >
              <span className="mode-picker__label">Mobile</span>
              {pendingMode === 'mobile' && (
                <span className="mode-picker__hint">next play</span>
              )}
            </button>
          </div>
          {pendingMode && (
            <p className="pause-overlay__note">
              Mode change applies on your next play.
            </p>
          )}
        </div>

        <div className="pause-overlay__section">
          <div className="pause-overlay__label">MUSIC</div>
          <button
            type="button"
            className={`music-toggle${musicOn ? ' music-toggle--on' : ''}`}
            onPointerDown={(e) => { e.stopPropagation(); onToggleMusic() }}
            aria-label={musicOn ? 'Mute music' : 'Unmute music'}
          >
            <span className="music-toggle__icon">{musicOn ? '🎵' : '🔇'}</span>
            <span className="music-toggle__label">{musicOn ? 'ON' : 'OFF'}</span>
          </button>
        </div>

        <button
          type="button"
          className="pause-overlay__resume"
          onPointerDown={(e) => { e.stopPropagation(); onResume() }}
        >
          ▶ RESUME
        </button>
      </div>
    </div>
  )
}

// ─── Mode picker overlay ─────────────────────────────────────────────────────
function ModePickerOverlay(props: {
  mode: DisplayMode
  suggested: DisplayMode
  userPicked: boolean
  onPick: (m: DisplayMode) => void
  musicOn: boolean
  onToggleMusic: () => void
}) {
  const { mode, suggested, userPicked, onPick, musicOn, onToggleMusic } = props
  // First-load users (no saved choice) see the full picker up front so they
  // can make an informed pick. Returning players whose choice is already
  // remembered see only a small gear icon in the corner; tapping it
  // reveals the picker as a popover so the start menu stays uncluttered.
  const [open, setOpen] = useState(false)

  const handlePick = (m: DisplayMode) => {
    onPick(m)
    setOpen(false)
  }

  if (!userPicked) {
    return (
      <div className="mode-picker">
        <div className="mode-picker__row">
          <button
            type="button"
            className={`mode-picker__btn ${mode === 'desktop' ? 'is-active' : ''}`}
            onPointerDown={(e) => { e.stopPropagation(); onPick('desktop') }}
          >
            <span className="mode-picker__label">Desktop</span>
            {suggested === 'desktop' && (
              <span className="mode-picker__hint">suggested</span>
            )}
          </button>
          <button
            type="button"
            className={`mode-picker__btn ${mode === 'mobile' ? 'is-active' : ''}`}
            onPointerDown={(e) => { e.stopPropagation(); onPick('mobile') }}
          >
            <span className="mode-picker__label">Mobile</span>
            {suggested === 'mobile' && (
              <span className="mode-picker__hint">suggested</span>
            )}
          </button>
        </div>
        <div className="mode-picker__music-row">
          <button
            type="button"
            className={`music-toggle music-toggle--compact${musicOn ? ' music-toggle--on' : ''}`}
            onPointerDown={(e) => { e.stopPropagation(); onToggleMusic() }}
            aria-label={musicOn ? 'Mute music' : 'Unmute music'}
          >
            <span className="music-toggle__icon">{musicOn ? '🎵' : '🔇'}</span>
            <span className="music-toggle__label">MUSIC {musicOn ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        className="mode-picker-toggle"
        aria-label="Change display mode"
        aria-expanded={open}
        onPointerDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
          audioManager.startMusic().catch(() => {})
          setOpen((o) => !o)
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
        <div
          className="mode-picker mode-picker--popover"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="mode-picker__title">DISPLAY MODE</div>
          <div className="mode-picker__row">
            <button
              type="button"
              className={`mode-picker__btn ${mode === 'desktop' ? 'is-active' : ''}`}
              onPointerDown={(e) => { e.stopPropagation(); handlePick('desktop') }}
            >
              <span className="mode-picker__label">Desktop</span>
            </button>
            <button
              type="button"
              className={`mode-picker__btn ${mode === 'mobile' ? 'is-active' : ''}`}
              onPointerDown={(e) => { e.stopPropagation(); handlePick('mobile') }}
            >
              <span className="mode-picker__label">Mobile</span>
            </button>
          </div>
          <div className="mode-picker__title" style={{ marginTop: 8 }}>MUSIC</div>
          <button
            type="button"
            className={`music-toggle music-toggle--compact${musicOn ? ' music-toggle--on' : ''}`}
            onPointerDown={(e) => { e.stopPropagation(); onToggleMusic() }}
            aria-label={musicOn ? 'Mute music' : 'Unmute music'}
          >
            <span className="music-toggle__icon">{musicOn ? '🎵' : '🔇'}</span>
            <span className="music-toggle__label">{musicOn ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      )}
    </>
  )
}

// ─── On-screen touch controls (mobile only) ──────────────────────────────────
function TouchControls(props: {
  landscape?: boolean
  powerUps: number
  onLeft: () => void
  onRight: () => void
  onJump: () => void
  onSpin: () => void
  onTurbo: () => void
}) {
  const { landscape, powerUps, onLeft, onRight, onJump, onSpin, onTurbo } = props
  // When the inventory is empty, all three action buttons render in a
  // dimmed/muted state to telegraph that they won't fire — matching the
  // desktop HUD hint behaviour. Tapping still invokes the handler so the
  // "NEED POWER-UP!" floater still shows.
  const actionDimmed = powerUps <= 0
  const actionCls = (variant: string) =>
    `touch-btn touch-btn--action touch-btn--${variant}${actionDimmed ? ' touch-btn--disabled' : ''}`
  // Use onPointerDown for snappy response. stopPropagation prevents the
  // canvas swipe/tap-to-start handlers from firing.
  const tap = (fn: () => void) => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    fn()
  }
  // Landscape arranges the five buttons as two thumb-stacks at the
  // corners (lane on the bottom, actions above) instead of the
  // portrait row. The `--landscape` class swaps the CSS layout.
  const cls = `touch-controls${landscape ? ' touch-controls--landscape' : ''}`
  return (
    <div className={cls} aria-hidden="false">
      <button
        type="button"
        className="touch-btn touch-btn--lane touch-btn--left"
        aria-label="Move left"
        onPointerDown={tap(onLeft)}
      >
        ◀
      </button>
      <button
        type="button"
        className={actionCls('jump')}
        aria-label="Jump"
        aria-disabled={actionDimmed}
        onPointerDown={tap(onJump)}
      >
        JUMP
      </button>
      <button
        type="button"
        className={actionCls('spin')}
        aria-label="Spin dodge"
        aria-disabled={actionDimmed}
        onPointerDown={tap(onSpin)}
      >
        SPIN
      </button>
      <button
        type="button"
        className={actionCls('turbo')}
        aria-label="Turbo burst"
        aria-disabled={actionDimmed}
        onPointerDown={tap(onTurbo)}
      >
        TURBO
      </button>
      <button
        type="button"
        className="touch-btn touch-btn--lane touch-btn--right"
        aria-label="Move right"
        onPointerDown={tap(onRight)}
      >
        ▶
      </button>
    </div>
  )
}
