# Vertex Colors Debug — Project Documentation

## What this is

A standalone, single-page viewer for inspecting baked vertex colors on a GLB model. It's a **subset extraction** from `onboarding-game-frontend` (the 3D onboarding game) — this repo contains only the debug viewer, nothing else. It exists so the viewer can be deployed to Netlify on its own, without pulling in the game (Rapier physics, ecctrl controller, NPC system, zustand stores, Livewire bridge, etc.).

- **Framework:** React 19 + TypeScript
- **3D:** Three.js + @react-three/fiber + @react-three/drei
- **Build:** Vite 7
- **Route:** `/debug/vertex-colors` (any other path redirects there client-side — see below)
- **Port (dev):** 5175

## Why this repo exists

The original game repo (`onboarding-game-frontend`) has a dev-only route at `/debug/vertex-colors` (`src/app/DebugVertexColors.tsx`), gated by `import.meta.env.DEV` in `main.tsx` — it never renders in a production build there, and the game repo isn't meant to be hosted standalone on Netlify (its prod `base` is hardcoded to `/assets/onboarding-game/` for embedding under a Laravel/Livewire app).

Rather than fight that setup, the viewer was extracted verbatim into this separate, minimal project that:
- has no `DEV`-only gate — the route works in a production build,
- builds with `base: '/'` for a normal root-domain static host,
- has no dependency on the game (no Rapier, ecctrl, zustand, GameBridge) — only what `DebugVertexColors.tsx` actually imports (`react`, `three`, `@react-three/fiber`, `@react-three/drei`, `@utils/assetPath`),
- ships with a Netlify SPA redirect (`public/_redirects` + `netlify.toml`) so a direct load/refresh of `/debug/vertex-colors` doesn't 404.

**This repo has its own git history** (`git init` from scratch) — it is not a clone/fork of the game repo, since only one file's worth of functionality was needed. If the debug viewer changes upstream in the game repo, re-copy `src/app/DebugVertexColors.tsx` and `src/utils/assetPath.ts` here by hand (see "Syncing with the game repo" below).

## What was carried over vs. dropped

| Kept (copied as-is from the game repo) | Dropped |
|---|---|
| `src/app/DebugVertexColors.tsx` | Rapier physics, ecctrl player controller |
| `src/utils/assetPath.ts` (`assetUrl()` helper) | NPC system, zustand stores (`gameStore`, `npcStore`) |
| `src/index.css`, `src/vite-env.d.ts` | GameBridge / Livewire event integration |
| `public/3d-models-min/3dobjects/level_2/central_plaza_test_compressed(.glb / _prev.glb)` — the test model the viewer loads by default | Everything else in `src/three/`, `src/app/Rooms/`, `src/config/`, `src/mocks/`, etc. |
| `@utils` path alias (the only alias the viewer actually uses) | All other path aliases (`@app`, `@stores`, `@three`, `@bridge`, ...) — unused here |

`src/main.tsx` was **rewritten** (not copied) to drop the `App` / game branch entirely and always mount `DebugVertexColors`, redirecting to `/debug/vertex-colors` if loaded from another path.

## Architecture

```
src/main.tsx              # Entry point — mounts DebugVertexColors, redirects to /debug/vertex-colors
  └─ src/app/DebugVertexColors.tsx   # The actual viewer: Canvas, model loader, controls overlay
       └─ src/utils/assetPath.ts     # Resolves GLB URL against Vite's BASE_URL
```

`DebugVertexColors.tsx` loads a GLB via `useGLTF`, lets you switch between `MeshBasicMaterial` / `MeshStandardMaterial`, toggle vertex colors on/off, pick which `COLOR_0..N` attribute to view, blend it against the base texture (multiply/add/screen/overlay/mix), and swap in a local file via a file picker. It also reports mesh/triangle counts and which color attributes exist per mesh.

## Build & Dev

```bash
npm install
npm run dev         # http://localhost:5175
npm run build        # → dist/
npm run preview      # preview the production build locally
npm run type-check
```

No lint script / ESLint config in this repo (the game repo's config wasn't copied — add one if needed).

## Deployment (Netlify)

- `netlify.toml` sets build command `npm run build`, publish dir `dist`, and a catch-all `/* → /index.html` redirect (required because there's no real router — the app is a client-side pathname check, so deep-linking to `/debug/vertex-colors` needs the rewrite to avoid a 404 on static hosts).
- `public/_redirects` duplicates the same rule (belt-and-suspenders — Netlify reads either).
- Connect via Netlify → **Add new site → Import from Git**, point at this repo. No env vars required.

## Path Aliases

Configured in both `tsconfig.json` and `vite.config.ts`:
```
@utils → src/utils
```

## Syncing with the game repo

This is a manual, one-way extraction, not an automated sync. If `DebugVertexColors.tsx` or `assetPath.ts` change in `onboarding-game-frontend`, re-copy them here:

```bash
cp ../onboarding-game/src/app/DebugVertexColors.tsx src/app/DebugVertexColors.tsx
cp ../onboarding-game/src/utils/assetPath.ts src/utils/assetPath.ts
```

Watch for new imports when doing this — if the viewer starts depending on something outside `react`/`three`/`@react-three/*`/`@utils`, that dependency needs to be added to `package.json` here too.

To update the test model, replace the files under `public/3d-models-min/3dobjects/level_2/` and update `MODEL_PATH` in `DebugVertexColors.tsx` if the filename changes.

---

**Extracted from:** `onboarding-game-frontend` (private, separate repo)
