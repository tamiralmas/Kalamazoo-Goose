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

Open the local address shown in the terminal. The game saves your progress in the browser. `npm run build:pages` produces the static GitHub Pages build in `dist-pages/`.

## Controls

Keyboard and mouse:

- `W` / `S`: dive / pull up while flying; waddle forward / back up on the ground
- `A` / `D`: bank while flying; steer on the ground or water
- `Space`: tap for one wingbeat, hold for continuous flapping; takes off from the ground or water
- `Shift`: flare and airbrake (softens landings); brakes while planing on water
- `E` or `H`: honk (scatters students, stops traffic, recruits geese, triggers secrets)
- `F`: grab a prop (cone, bench, trash can, bike, sign, flag) or steal a student's item (phone, coffee, sandwich, ID card, umbrella); press again to throw
- `R`: ragdoll on demand
- `Tab`: open the quest log
- `Esc`: open the pause menu (quests, goose locker, fast travel, options); closes any open drawer first
- Mouse drag: orbit the camera · scroll wheel or the camera buttons: zoom · double-click: reset the camera
- Respawn button (top right): return to the WMU spawn without losing score or secrets

Touch: on-screen controls appear on phones and tablets. Drag to orbit, pinch to zoom, double-tap to reset the camera.

## Progression

Kalamazoo Goose saves your progress automatically. Complete quests throughout the game to earn tokens, which you spend in the Goose Locker to unlock special abilities and skins. The Locker features five unlockable abilities (Jet, Angel, Giga, Party, Bronco Goose) and cosmetic skins purchased with tokens. Each game's best score, completed quests, and discovered secrets are remembered in your browser.

If you want to start over, the pause menu (press Esc) includes a "Fresh goose" option in settings to wipe all saved progress.

The pause menu's Options tab also has a Render scale control (Auto, Crisp, or Fast) that trades 3D world sharpness for frame rate, useful on older or integrated GPUs.

## World data

The game combines OpenStreetMap-derived roads, buildings, water, trails, and vegetation (via OpenFreeMap) with Mapterhorn terrain and State of Michigan MiSAIL aerial imagery across Kalamazoo.

### Building heights

Within roughly five kilometres of campus, buildings rise to their real roof height instead of OpenStreetMap's storey count guess. The heights come from the USGS 3D Elevation Program's 2015 Kalamazoo LiDAR flight (public domain), measured against each OpenStreetMap footprint, and are shipped as the game's own zoom-14 vector tiles under `public/buildings`. Outside that area the OpenFreeMap buildings take over, so the join is seamless and the whole map keeps its walls.

To regenerate the tiles:

1. Open `scripts/lidar-heights/index.html` in a browser and run it. It fetches the footprints from Overpass, streams the point cloud from the public `usgs-lidar-public` bucket (about 1.7 GB), measures every footprint, and downloads `kalamazoo-buildings.json.gz`. The committed copy lives in `data/`.
2. Run `node scripts/build-building-tiles.mjs data/kalamazoo-buildings.json.gz`. It writes the tiles and updates `app/building-tiles-coverage.ts` with the tile range they cover.

### Trees

Across the nine kilometres of Kalamazoo covered by `app/tree-tiles-coverage.ts`, the trees are the ones the same 2015 LiDAR flight actually measured: about 280,000 trunks with a height, a crown radius and a canopy closure each, shipped as the game's own zoom-14 binary tiles under `public/trees` and streamed in around the goose. Inside that rectangle the measured trees replace the OpenStreetMap woodland and street-tree placement, which still plants the rest of the map.

To regenerate them: open `scripts/lidar-trees/index.html` in a browser and run it (it streams about 1 GB of points, builds a canopy height model with the building footprints cut out, picks the crowns, and downloads `kalamazoo-trees.json.gz`; the committed copy lives in `data/`), then run `node scripts/build-tree-tiles.mjs data/kalamazoo-trees.json.gz`.

### Water

Ponds and lakes are drawn as animated surfaces: a lit, moving water sheet over each OpenStreetMap water polygon within reach, with a fresnel sky reflection, a sun glint from the same sun as everything else, a fade at the banks, and ripples where the goose lands.
