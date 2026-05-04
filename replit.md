# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Artifacts

### Big Back Blitz (`artifacts/big-back-blitz`)
- Top-down American football endless runner — Subway Surfers style
- Pure HTML Canvas 2D rendering (no WebGL dependency)
- Tech: React + Vite, plain `<canvas>` with `requestAnimationFrame`
- Top-down camera: scrolling football field with yard lines, hash marks, end zones
- 5 lanes across field width; Alcorn State purple/gold theme vs blue visitors
- Stadium crowd on both sidelines (colored seat sections)
- Mechanics: ←→ lane change, ↑/Space spin dodge (clears nearby defenders), ↓ turbo burst
- 3 defender types: Safety (track), Linebacker (large/slow), Corner (diagonal approach)
- Collectibles: coins, footballs (+boost charge), star power-ups (+multiplier)
- Particle system: sparks, grass trail, confetti on touchdown
- Float text popups, screen shake, screen flash, depth-sorted rendering
- Touchdowns every 100 virtual yards → bonus score + speed increase + confetti
- Score multiplier builds with consecutive dodges (up to 8x)
- Session high score tracking, game-over/restart flow, touch swipe on mobile
- Local top-10 leaderboard (localStorage `bbb:leaderboard:v1`) with 3-char alphanumeric initials entry on game-over and animated "NEW HIGH SCORE!" banner when the live score crosses a board entry mid-run (`src/game/leaderboard.ts`)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
