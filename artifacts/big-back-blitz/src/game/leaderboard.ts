// Local top-10 leaderboard, persisted in localStorage.
//
// v2 stores TWO ranked views of the same entries:
//   "points"      — sorted by score descending (original behaviour)
//   "touchdowns"  — sorted by touchdown count descending (score as tie-
//                   breaker, then timestamp)
//
// v1 entries (score-only) are migrated on first load; they appear on the
// points board and on the touchdowns board with touchdowns = 0.
//
// All API is defensive: load returns empty boards on parse failure, save
// swallows quota errors so private-mode browsers don't crash the game.

const STORAGE_KEY_V2 = 'bbb:leaderboard:v2'
const STORAGE_KEY_V1 = 'bbb:leaderboard:v1'   // read-only; for migration
export const LEADERBOARD_MAX = 10
export const INITIALS_LEN = 3

export type BoardMode = 'points' | 'touchdowns'
export const BOARD_MODE_STORAGE_KEY = 'bbb:boardMode'

export type LeaderboardEntry = {
  initials:   string  // exactly INITIALS_LEN chars, uppercase A-Z / 0-9
  score:      number
  touchdowns: number  // 0 for entries migrated from v1
  ts:         number  // epoch ms; stable tiebreaker (older wins ties)
}

/** Strip non-alphanumeric, uppercase, clamp to 3 chars, pad with 'A'. */
export function sanitizeInitials(raw: string): string {
  const cleaned = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, INITIALS_LEN)
  return cleaned.padEnd(INITIALS_LEN, 'A')
}

/** True if the candidate looks like a fully-typed 3-char alphanumeric tag. */
export function isValidInitials(raw: string): boolean {
  return /^[A-Z0-9]{3}$/.test(raw ?? '')
}

// ─── Internal parse helper ─────────────────────────────────────────────────
function parseEntry(e: { initials: unknown; score: unknown; touchdowns?: unknown; ts?: unknown }): LeaderboardEntry {
  return {
    initials:   sanitizeInitials(String(e.initials)),
    score:      Math.max(0, Math.floor(Number(e.score)      || 0)),
    touchdowns: Math.max(0, Math.floor(Number(e.touchdowns) || 0)),
    ts: typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : 0,
  }
}

function sortPoints(arr: LeaderboardEntry[]): LeaderboardEntry[] {
  return arr.slice().sort((a, b) => b.score - a.score || a.ts - b.ts).slice(0, LEADERBOARD_MAX)
}

function sortTds(arr: LeaderboardEntry[]): LeaderboardEntry[] {
  return arr.slice().sort((a, b) => b.touchdowns - a.touchdowns || b.score - a.score || a.ts - b.ts).slice(0, LEADERBOARD_MAX)
}

// ─── Public load / save ────────────────────────────────────────────────────

export function loadBoards(): { points: LeaderboardEntry[]; tds: LeaderboardEntry[] } {
  if (typeof window === 'undefined') return { points: [], tds: [] }
  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY_V2)
    if (rawV2) {
      const parsed: unknown = JSON.parse(rawV2)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>

        const parseBoard = (arr: unknown): LeaderboardEntry[] => {
          if (!Array.isArray(arr)) return []
          return arr
            .filter((e): e is { initials: unknown; score: unknown } =>
              !!e && typeof e === 'object' && 'initials' in e && 'score' in e
            )
            .map(parseEntry)
            .filter(e => e.score > 0)
        }

        const points = sortPoints(parseBoard(obj.points))
        const tds    = sortTds(parseBoard(obj.tds))
        return { points, tds }
      }
    }

    // ── Migrate from v1 (score-only entries) ───────────────────────────────
    const rawV1 = window.localStorage.getItem(STORAGE_KEY_V1)
    if (!rawV1) return { points: [], tds: [] }
    const parsedV1: unknown = JSON.parse(rawV1)
    if (!Array.isArray(parsedV1)) return { points: [], tds: [] }
    const migrated: LeaderboardEntry[] = parsedV1
      .filter((e): e is { initials: unknown; score: unknown } =>
        !!e && typeof e === 'object' && 'initials' in e && 'score' in e
      )
      .map(e => parseEntry({ ...e, touchdowns: 0 }))
      .filter(e => e.score > 0)
    // Migrated entries appear on BOTH boards; their touchdowns=0 so they
    // occupy the lowest TD-board slots (sorted by score as tiebreaker).
    return { points: sortPoints(migrated), tds: sortTds(migrated) }
  } catch {
    return { points: [], tds: [] }
  }
}

export function saveBoards(
  points: LeaderboardEntry[],
  tds:    LeaderboardEntry[],
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY_V2, JSON.stringify({
      points: sortPoints(points),
      tds:    sortTds(tds),
    }))
  } catch {
    // quota exceeded / private-mode / disabled storage — silent fallback
  }
}

// ─── Per-level best scores ─────────────────────────────────────────────────
//
// Tracks the highest single-level score the player has earned for each level
// number. Used to power the "NEW BEST!" badge on the level-win overlay so
// good play is rewarded across runs. Persisted in localStorage; survives
// page refreshes. Defensive against quota / private-mode failures.

const STORAGE_KEY_LEVEL_BESTS = 'bbb:levelBests:v1'

export type LevelBests = Record<number, number>

export function loadLevelBests(): LevelBests {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_LEVEL_BESTS)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: LevelBests = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const lvl = Number(k)
      const score = Math.max(0, Math.floor(Number(v) || 0))
      if (Number.isFinite(lvl) && lvl > 0 && score > 0) out[lvl] = score
    }
    return out
  } catch {
    return {}
  }
}

export function saveLevelBests(bests: LevelBests): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY_LEVEL_BESTS, JSON.stringify(bests))
  } catch {
    // quota / private-mode — silent fallback, in-memory state still updates
  }
}

/** Convenience: load only the points board (for callers that only need one). */
export function loadLeaderboard(): LeaderboardEntry[] {
  return loadBoards().points
}

/** Convenience: update only the points board while preserving the tds board. */
export function saveLeaderboard(board: LeaderboardEntry[]): void {
  const { tds } = loadBoards()
  saveBoards(board, tds)
}

// ─── Qualification checks ──────────────────────────────────────────────────

/** Score qualifies for a top-10 points slot? */
export function qualifiesForBoard(
  score: number,
  board: LeaderboardEntry[],
): boolean {
  if (score <= 0) return false
  if (board.length < LEADERBOARD_MAX) return true
  return score > board[board.length - 1].score
}

/** Touchdown count qualifies for a top-10 TD slot?
 *  Uses the full comparator: TD count first, then score as tie-breaker.
 *  A run with equal TDs but a higher score beats the last board entry.
 */
export function qualifiesForTdBoard(
  touchdowns: number,
  board:      LeaderboardEntry[],
  score = 0,
): boolean {
  if (touchdowns <= 0) return false
  if (board.length < LEADERBOARD_MAX) return true
  const last = board[board.length - 1]
  return touchdowns > last.touchdowns ||
    (touchdowns === last.touchdowns && score > last.score)
}

// ─── Insert helpers ────────────────────────────────────────────────────────

/**
 * Insert into the points board. Returns the new board (capped at 10) and
 * the 1-based rank. Rank 0 = bumped off the bottom.
 */
export function insertEntry(
  board: LeaderboardEntry[],
  entry: LeaderboardEntry,
): { board: LeaderboardEntry[]; rank: number } {
  const next = sortPoints([...board, entry])
  const idx = next.indexOf(entry)
  return { board: next, rank: idx >= 0 ? idx + 1 : 0 }
}

/**
 * Insert into the touchdowns board. Returns the new board (capped at 10)
 * and the 1-based rank. Rank 0 = bumped off the bottom.
 */
export function insertEntryByTd(
  board: LeaderboardEntry[],
  entry: LeaderboardEntry,
): { board: LeaderboardEntry[]; rank: number } {
  const next = sortTds([...board, entry])
  const idx = next.indexOf(entry)
  return { board: next, rank: idx >= 0 ? idx + 1 : 0 }
}

// ─── In-run threshold markers ──────────────────────────────────────────────

/**
 * Build the list of in-run "you just passed someone!" thresholds from the
 * current board, sorted ascending by score so they pop one at a time as the
 * player's live score grows past each entry. Empty when the board is empty.
 */
export type ThresholdMarker = {
  score: number
  initials: string
  rankAchieved: number
}

export function buildThresholds(board: LeaderboardEntry[]): ThresholdMarker[] {
  return board
    .map((e, i) => ({ score: e.score, initials: e.initials, rankAchieved: i + 1 }))
    .sort((a, b) => a.score - b.score)
}

/**
 * In-run touchdown threshold marker. Mirrors ThresholdMarker but keyed on
 * touchdown count rather than score.
 */
export type TdThresholdMarker = {
  touchdowns: number
  initials: string
  rankAchieved: number
}

/**
 * Build the list of in-run "you just passed someone on the TD board!"
 * thresholds from the touchdowns board, sorted ascending by TD count so
 * they pop one at a time as the player's run TD total climbs past each
 * entry. Entries with touchdowns = 0 are skipped (passing them is not
 * meaningful) and the player must STRICTLY beat each entry's TD count
 * to fire the banner — matching the count alone isn't a "pass".
 */
export function buildTdThresholds(board: LeaderboardEntry[]): TdThresholdMarker[] {
  return board
    .map((e, i) => ({ touchdowns: e.touchdowns, initials: e.initials, rankAchieved: i + 1 }))
    .filter(m => m.touchdowns > 0)
    .sort((a, b) => a.touchdowns - b.touchdowns)
    // Collapse duplicates at the same TD count: keep the BEST (lowest) rank
    // that gets achieved when you cross that count, and drop the rest so we
    // don't fire multiple banners for one increment.
    .reduce<TdThresholdMarker[]>((acc, m) => {
      const last = acc[acc.length - 1]
      if (last && last.touchdowns === m.touchdowns) {
        if (m.rankAchieved < last.rankAchieved) acc[acc.length - 1] = m
      } else {
        acc.push(m)
      }
      return acc
    }, [])
}
