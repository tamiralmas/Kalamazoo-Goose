# Kalamazoo Goose

Kalamazoo Goose is a chaotic 3D browser sandbox set across Western Michigan University and Kalamazoo. Fly over a real map, splash down in water, waddle through crowds, stop traffic, recruit a flock, and hunt for secrets from campus to downtown.

## Play

[Play Kalamazoo Goose on GitHub Pages](https://tamiralmas.github.io/Kalamazoo-Goose/)

## Play locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local address shown in the terminal. `npm run build:pages` produces the static GitHub Pages build in `dist-pages/`.

## Controls

Keyboard and mouse:

- `W` / `S`: dive / pull up while flying; waddle forward / back up on the ground
- `A` / `D`: bank while flying; steer on the ground or water
- `Space`: tap for one wingbeat, hold for continuous flapping; takes off from the ground or water
- `Shift`: flare and airbrake (softens landings); brakes while planing on water
- `E` or `H`: honk (scatters students, stops traffic, recruits geese, triggers secrets)
- Mouse drag: orbit the camera · scroll wheel or the camera buttons: zoom · double-click: reset the camera
- Respawn button (top right): return to the WMU spawn without losing score or secrets

Touch: on-screen controls appear on phones and tablets. Drag to orbit, pinch to zoom, double-tap to reset the camera.

## World data

The game combines OpenStreetMap-derived roads, buildings, water, trails, and vegetation (via OpenFreeMap) with Mapterhorn terrain and State of Michigan MiSAIL aerial imagery across Kalamazoo.
