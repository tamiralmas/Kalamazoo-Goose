'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bird,
  Gauge,
  MapPin,
  Navigation,
  Pause,
  PlaneLanding,
  Volume2,
  VolumeX,
  Waves,
  Wind,
} from 'lucide-react';
import * as THREE from 'three';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const SPAWN = { lat: 42.284996, lon: -85.61771 };
const METERS_PER_LAT = 111_320;
const METERS_PER_LON = METERS_PER_LAT * Math.cos((SPAWN.lat * Math.PI) / 180);
const MAP_ZOOM = 16;

type GooseMode = 'flying' | 'waddling' | 'swimming';

type HudState = {
  speed: number;
  altitude: number;
  lat: number;
  lon: number;
  mode: GooseMode;
  destination: string;
  distance: number;
};

type WaterFeature = {
  name: string;
  lat: number;
  lon: number;
  x: number;
  z: number;
  rx: number;
  rz: number;
};

type TrafficCar = {
  group: THREE.Group;
  laneX: number;
  direction: 1 | -1;
  speed: number;
  yielded: boolean;
  brakeMaterial: THREE.MeshStandardMaterial;
};

type SplashEffect = {
  droplets: Array<{ mesh: THREE.Mesh; velocity: THREE.Vector3 }>;
  ring: THREE.Mesh;
  life: number;
  dropletMaterial: THREE.MeshBasicMaterial;
  ringMaterial: THREE.MeshBasicMaterial;
  geometry: THREE.SphereGeometry;
};

const WATER_DATA = [
  { name: 'Goldsworth Valley Pond', lat: 42.287985, lon: -85.616343, rx: 58, rz: 92 },
  { name: 'Woods Lake', lat: 42.262581, lon: -85.612376, rx: 145, rz: 120 },
  { name: 'Asylum Lake', lat: 42.26648, lon: -85.64158, rx: 220, rz: 145 },
  { name: 'Little Asylum Lake', lat: 42.2618, lon: -85.6349, rx: 78, rz: 52 },
].map((water) => ({
  ...water,
  x: (water.lon - SPAWN.lon) * METERS_PER_LON,
  z: (SPAWN.lat - water.lat) * METERS_PER_LAT,
})) satisfies WaterFeature[];

const MODE_LABEL: Record<GooseMode, string> = {
  flying: 'In flight',
  waddling: 'Waddling',
  swimming: 'On the water',
};

const KEY_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'];

function localToGeo(x: number, z: number) {
  return {
    lat: SPAWN.lat - z / METERS_PER_LAT,
    lon: SPAWN.lon + x / METERS_PER_LON,
  };
}

function lonToTile(lon: number) {
  return ((lon + 180) / 360) * 2 ** MAP_ZOOM;
}

function latToTile(lat: number) {
  const radians = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) *
    2 ** MAP_ZOOM
  );
}

function createGoose() {
  const group = new THREE.Group();
  group.name = 'Canada goose';

  const feather = new THREE.MeshStandardMaterial({ color: 0xf5f0dc, roughness: 0.78 });
  const darkFeather = new THREE.MeshStandardMaterial({ color: 0x171c18, roughness: 0.86 });
  const warmGray = new THREE.MeshStandardMaterial({ color: 0x777468, roughness: 0.9 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xee9836, roughness: 0.7 });

  const body = new THREE.Mesh(new THREE.SphereGeometry(2.15, 24, 18), warmGray);
  body.scale.set(0.94, 0.68, 1.35);
  body.position.y = 0.2;
  group.add(body);

  const chest = new THREE.Mesh(new THREE.SphereGeometry(1.65, 22, 16), feather);
  chest.scale.set(0.78, 0.68, 0.88);
  chest.position.set(0, 0.15, -1.15);
  group.add(chest);

  const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.57, 3.25, 7, 14), darkFeather);
  neck.rotation.x = -0.25;
  neck.position.set(0, 2.12, -1.47);
  group.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.82, 20, 15), darkFeather);
  head.position.set(0, 4.05, -2.04);
  group.add(head);

  const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.54, 18, 12), feather);
  cheek.scale.set(1.25, 0.67, 0.95);
  cheek.position.set(0, 3.86, -2.65);
  group.add(cheek);

  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.38, 1.32, 4), orange);
  beak.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
  beak.position.set(0, 3.8, -3.34);
  group.add(beak);

  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x050706 });
  [-1, 1].forEach((side) => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), eyeMaterial);
    eye.position.set(side * 0.68, 4.2, -2.48);
    group.add(eye);
  });

  const wings: THREE.Group[] = [];
  [-1, 1].forEach((side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 1.65, 0.5, -0.15);
    const wing = new THREE.Mesh(new THREE.SphereGeometry(1.7, 20, 14), warmGray);
    wing.scale.set(0.34, 0.2, 1.28);
    wing.position.x = side * 0.92;
    pivot.add(wing);
    group.add(pivot);
    wings.push(pivot);
  });

  const legs: THREE.Group[] = [];
  [-1, 1].forEach((side) => {
    const leg = new THREE.Group();
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.2, 10), orange);
    shin.position.y = -0.45;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.12, 0.95), orange);
    foot.position.set(0, -1.02, -0.28);
    leg.add(shin, foot);
    leg.position.x = side * 0.65;
    leg.position.y = -1.35;
    group.add(leg);
    legs.push(leg);
  });

  group.scale.setScalar(0.53);
  return { group, wings, legs };
}

function addCampusBuildings(scene: THREE.Scene) {
  const wallMaterials = [
    new THREE.MeshStandardMaterial({ color: 0xb79c70, roughness: 0.9 }),
    new THREE.MeshStandardMaterial({ color: 0x9e7b55, roughness: 0.9 }),
    new THREE.MeshStandardMaterial({ color: 0xc2b59e, roughness: 0.92 }),
  ];
  const roofMaterial = new THREE.MeshStandardMaterial({ color: 0x4e5048, roughness: 1 });
  const blocks = [
    [-8, -12, 38, 19, 15, 0],
    [46, -42, 27, 40, 23, 1],
    [33, 42, 48, 18, 12, 2],
    [-72, -84, 44, 22, 17, 0],
    [-122, 18, 30, 52, 13, 1],
    [102, 8, 52, 29, 18, 2],
    [18, 104, 58, 22, 10, 0],
    [-22, 142, 35, 24, 14, 1],
    [136, 114, 63, 31, 20, 2],
    [-152, -155, 52, 27, 12, 0],
    [-24, -198, 76, 33, 18, 1],
  ];

  blocks.forEach(([x, z, width, depth, height, materialIndex]) => {
    const building = new THREE.Group();
    const walls = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      wallMaterials[materialIndex],
    );
    walls.position.y = height / 2 + 0.18;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(width + 0.8, 0.7, depth + 0.8), roofMaterial);
    roof.position.y = height + 0.5;
    building.add(walls, roof);
    building.position.set(x, 0, z);
    scene.add(building);
  });
}

function addTrees(scene: THREE.Scene) {
  const count = 92;
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.42, 0.55, 4.2, 7),
    new THREE.MeshStandardMaterial({ color: 0x65513a, roughness: 1 }),
    count,
  );
  const crowns = new THREE.InstancedMesh(
    new THREE.ConeGeometry(3.1, 8.5, 8),
    new THREE.MeshStandardMaterial({ color: 0x315b3d, roughness: 1 }),
    count,
  );
  const dummy = new THREE.Object3D();
  let seed = 71029;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (let index = 0; index < count; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 45 + random() * 250;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const scale = 0.72 + random() * 0.72;
    if (Math.abs(x + 62) < 12) continue;

    dummy.position.set(x, 2.1 * scale, z);
    dummy.scale.set(scale, scale, scale);
    dummy.rotation.y = random() * Math.PI;
    dummy.updateMatrix();
    trunks.setMatrixAt(index, dummy.matrix);

    dummy.position.y = 7.3 * scale;
    dummy.updateMatrix();
    crowns.setMatrixAt(index, dummy.matrix);
  }
  scene.add(trunks, crowns);
}

function createRoadAndTraffic(scene: THREE.Scene) {
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(15, 1300),
    new THREE.MeshStandardMaterial({ color: 0x414642, roughness: 0.97, transparent: true, opacity: 0.92 }),
  );
  road.rotation.x = -Math.PI / 2;
  road.position.set(-62, 0.16, 0);
  scene.add(road);

  const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xecd88b });
  for (let z = -620; z < 620; z += 18) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 8), lineMaterial);
    line.rotation.x = -Math.PI / 2;
    line.position.set(-62, 0.19, z);
    scene.add(line);
  }

  const colors = [0xcf553e, 0x356c92, 0xe4b949, 0x6b736e, 0xe9e6d9, 0x574b78];
  const cars: TrafficCar[] = [];
  for (let index = 0; index < 8; index += 1) {
    const direction = (index % 2 === 0 ? 1 : -1) as 1 | -1;
    const laneX = direction === 1 ? -65.4 : -58.6;
    const group = new THREE.Group();
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: colors[index % colors.length], roughness: 0.72 });
    const glassMaterial = new THREE.MeshStandardMaterial({ color: 0x233d45, roughness: 0.3, metalness: 0.25 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.1, 6.2), bodyMaterial);
    body.position.y = 0.96;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.55, 1.05, 3.1), glassMaterial);
    cabin.position.set(0, 1.85, 0.1);
    const brakeMaterial = new THREE.MeshStandardMaterial({
      color: 0x8f0e08,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    const brake = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.3, 0.14), brakeMaterial);
    brake.position.set(0, 1, direction === 1 ? -3.16 : 3.16);
    group.add(body, cabin, brake);
    group.position.set(laneX, 0, -520 + index * 142);
    if (direction === -1) group.rotation.y = Math.PI;
    scene.add(group);
    cars.push({ group, laneX, direction, speed: 8 + (index % 3), yielded: false, brakeMaterial });
  }
  return cars;
}

function addWater(scene: THREE.Scene) {
  const waterMaterial = new THREE.MeshStandardMaterial({
    color: 0x2387a1,
    emissive: 0x083743,
    emissiveIntensity: 0.2,
    roughness: 0.2,
    metalness: 0.18,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
  });
  WATER_DATA.forEach((water) => {
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 72), waterMaterial);
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.set(water.rx, water.rz, 1);
    mesh.position.set(water.x, 0.22, water.z);
    scene.add(mesh);
  });
}

function isInsideWater(x: number, z: number) {
  return WATER_DATA.find((water) => {
    const nx = (x - water.x) / water.rx;
    const nz = (z - water.z) / water.rz;
    return nx * nx + nz * nz <= 1;
  });
}

function nearestWater(x: number, z: number) {
  let nearest = WATER_DATA[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  WATER_DATA.forEach((water) => {
    const distance = Math.hypot(x - water.x, z - water.z);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = water;
    }
  });
  return { water: nearest, distance: nearestDistance };
}

function createSplash(scene: THREE.Scene, position: THREE.Vector3) {
  const geometry = new THREE.SphereGeometry(0.17, 6, 5);
  const dropletMaterial = new THREE.MeshBasicMaterial({ color: 0xcaf6ff, transparent: true });
  const droplets: SplashEffect['droplets'] = [];
  for (let index = 0; index < 26; index += 1) {
    const mesh = new THREE.Mesh(geometry, dropletMaterial);
    const angle = (index / 26) * Math.PI * 2 + Math.random() * 0.25;
    const speed = 4.5 + Math.random() * 8;
    mesh.position.copy(position);
    scene.add(mesh);
    droplets.push({
      mesh,
      velocity: new THREE.Vector3(Math.cos(angle) * speed, 5 + Math.random() * 7, Math.sin(angle) * speed),
    });
  }
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xe2fbff,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.25, 48), ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(position).setY(0.45);
  scene.add(ring);
  return { droplets, ring, life: 0, dropletMaterial, ringMaterial, geometry } satisfies SplashEffect;
}

export function GooseGame() {
  const mountRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const mutedRef = useRef(false);
  const actionsRef = useRef<{ setKey: (code: string, active: boolean) => void; honk: () => void } | null>(null);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState('');
  const [hud, setHud] = useState<HudState>({
    speed: 18,
    altitude: 27,
    lat: SPAWN.lat,
    lon: SPAWN.lon,
    mode: 'flying',
    destination: WATER_DATA[0].name,
    distance: 350,
  });

  useEffect(() => {
    startedRef.current = started;
  }, [started]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9bd2da);
    scene.fog = new THREE.Fog(0x9bd2da, 380, 820);

    const camera = new THREE.PerspectiveCamera(54, 1, 0.1, 2500);
    camera.position.set(34, 34, 76);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.innerWidth < 800 ? 1.35 : 1.8));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xe8fbff, 0x40533d, 2.65));
    const sun = new THREE.DirectionalLight(0xfff0cb, 3.1);
    sun.position.set(-120, 220, 90);
    scene.add(sun);

    const fallbackGround = new THREE.Mesh(
      new THREE.PlaneGeometry(12000, 12000),
      new THREE.MeshStandardMaterial({ color: 0x6f8f58, roughness: 1 }),
    );
    fallbackGround.rotation.x = -Math.PI / 2;
    fallbackGround.position.y = -0.08;
    scene.add(fallbackGround);

    const tileGroup = new THREE.Group();
    scene.add(tileGroup);
    const textureLoader = new THREE.TextureLoader();
    textureLoader.setCrossOrigin('anonymous');
    const tiles = new Map<string, THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>>();
    const tileMeters = (40_075_016.686 * Math.cos((SPAWN.lat * Math.PI) / 180)) / 2 ** MAP_ZOOM;
    const originTileX = lonToTile(SPAWN.lon);
    const originTileY = latToTile(SPAWN.lat);
    let centerTileKey = '';

    const updateTiles = (x: number, z: number) => {
      const geo = localToGeo(x, z);
      const centerX = Math.floor(lonToTile(geo.lon));
      const centerY = Math.floor(latToTile(geo.lat));
      const nextCenterKey = `${centerX}/${centerY}`;
      if (nextCenterKey === centerTileKey) return;
      centerTileKey = nextCenterKey;
      const desired = new Set<string>();

      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const tileX = centerX + dx;
          const tileY = centerY + dy;
          const key = `${MAP_ZOOM}/${tileX}/${tileY}`;
          desired.add(key);
          if (tiles.has(key)) continue;

          const material = new THREE.MeshStandardMaterial({ color: 0x8aa46d, roughness: 0.95 });
          const mesh = new THREE.Mesh(new THREE.PlaneGeometry(tileMeters * 1.006, tileMeters * 1.006), material);
          mesh.rotation.x = -Math.PI / 2;
          mesh.position.set(
            (tileX + 0.5 - originTileX) * tileMeters,
            0.02,
            (tileY + 0.5 - originTileY) * tileMeters,
          );
          tiles.set(key, mesh);
          tileGroup.add(mesh);

          textureLoader.load(
            `https://tile.openstreetmap.org/${MAP_ZOOM}/${tileX}/${tileY}.png`,
            (texture) => {
              if (tiles.get(key) !== mesh) {
                texture.dispose();
                return;
              }
              texture.colorSpace = THREE.SRGBColorSpace;
              texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
              material.map = texture;
              material.color.setHex(0xffffff);
              material.needsUpdate = true;
            },
            undefined,
            () => {
              material.color.setHex(0x769263);
            },
          );
        }
      }

      tiles.forEach((mesh, key) => {
        if (desired.has(key)) return;
        tileGroup.remove(mesh);
        mesh.material.map?.dispose();
        mesh.material.dispose();
        mesh.geometry.dispose();
        tiles.delete(key);
      });
    };
    updateTiles(0, 0);

    addWater(scene);
    addCampusBuildings(scene);
    addTrees(scene);
    const traffic = createRoadAndTraffic(scene);
    const goose = createGoose();
    scene.add(goose.group);

    const contactShadow = new THREE.Mesh(
      new THREE.CircleGeometry(2.5, 32),
      new THREE.MeshBasicMaterial({ color: 0x102019, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    contactShadow.rotation.x = -Math.PI / 2;
    scene.add(contactShadow);

    const game = {
      position: new THREE.Vector3(0, 28, 26),
      yaw: 0,
      roll: 0,
      pitch: 0,
      speed: 18,
      verticalSpeed: 0,
      mode: 'flying' as GooseMode,
      keys: Object.fromEntries(KEY_CODES.map((code) => [code, false])) as Record<string, boolean>,
      time: 0,
      lastHud: 0,
      lastTileUpdate: 0,
    };
    goose.group.position.copy(game.position);

    const effects: SplashEffect[] = [];
    let audioContext: AudioContext | null = null;
    const honk = () => {
      setToast('HONK! Campus has been notified.');
      if (mutedRef.current) return;
      audioContext ??= new AudioContext();
      if (audioContext.state === 'suspended') void audioContext.resume();
      const now = audioContext.currentTime;
      const filter = audioContext.createBiquadFilter();
      const gain = audioContext.createGain();
      const oscillator = audioContext.createOscillator();
      const overtone = audioContext.createOscillator();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(820, now);
      oscillator.type = 'square';
      overtone.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(185, now);
      oscillator.frequency.exponentialRampToValueAtTime(112, now + 0.34);
      overtone.frequency.setValueAtTime(260, now);
      overtone.frequency.exponentialRampToValueAtTime(150, now + 0.31);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.13, now + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
      oscillator.connect(filter);
      overtone.connect(filter);
      filter.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now);
      overtone.start(now);
      oscillator.stop(now + 0.38);
      overtone.stop(now + 0.38);
    };

    actionsRef.current = {
      setKey: (code, active) => {
        game.keys[code] = active;
      },
      honk,
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (KEY_CODES.includes(event.code)) {
        event.preventDefault();
        game.keys[event.code] = true;
      }
      if (event.code === 'KeyH' && !event.repeat && startedRef.current) honk();
      if (event.code === 'Escape' && startedRef.current) setStarted(false);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (KEY_CODES.includes(event.code)) game.keys[event.code] = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      camera.aspect = clientWidth / Math.max(clientHeight, 1);
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, clientWidth < 800 ? 1.35 : 1.8));
      renderer.setSize(clientWidth, clientHeight, false);
    };
    resize();
    window.addEventListener('resize', resize);

    const forward = new THREE.Vector3();
    const cameraTarget = new THREE.Vector3();
    const cameraDesired = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();
    const menuCameraOffset = new THREE.Vector3(34, 10, 50);
    const menuLookOffset = new THREE.Vector3(0, 1, -8);
    const clock = new THREE.Clock();
    let frame = 0;

    const updateEffects = (delta: number) => {
      for (let index = effects.length - 1; index >= 0; index -= 1) {
        const effect = effects[index];
        effect.life += delta;
        effect.droplets.forEach((drop) => {
          drop.velocity.y -= 16 * delta;
          drop.mesh.position.addScaledVector(drop.velocity, delta);
        });
        effect.ring.scale.setScalar(1 + effect.life * 7.5);
        effect.ringMaterial.opacity = Math.max(0, 0.85 - effect.life * 0.7);
        effect.dropletMaterial.opacity = Math.max(0, 1 - effect.life * 0.75);
        if (effect.life > 1.35) {
          effect.droplets.forEach((drop) => scene.remove(drop.mesh));
          scene.remove(effect.ring);
          effect.geometry.dispose();
          effect.dropletMaterial.dispose();
          effect.ring.geometry.dispose();
          effect.ringMaterial.dispose();
          effects.splice(index, 1);
        }
      }
    };

    const triggerSplash = () => {
      effects.push(createSplash(scene, game.position.clone().setY(0.42)));
      setToast('SPLASH! Water landing +250');
    };

    const updateTraffic = (delta: number) => {
      const grounded = game.mode !== 'flying';
      traffic.forEach((car) => {
        const ahead = (game.position.z - car.group.position.z) * car.direction;
        const gooseInLane = grounded && Math.abs(game.position.x - car.laneX) < 5.8;
        const mustYield = gooseInLane && ahead > -2 && ahead < 34;
        const targetSpeed = mustYield ? 0 : 8.5;
        car.speed = THREE.MathUtils.damp(car.speed, targetSpeed, mustYield ? 4.4 : 1.8, delta);
        car.group.position.z += car.direction * car.speed * delta;
        car.brakeMaterial.emissive.setHex(mustYield ? 0xff1208 : 0x000000);
        car.brakeMaterial.emissiveIntensity = mustYield ? 2.2 : 0;
        if (mustYield && car.speed < 1.2 && !car.yielded) {
          car.yielded = true;
          setToast('Traffic stopped. Goose has right of way.');
        }
        if (!mustYield) car.yielded = false;
        if (car.direction === 1 && car.group.position.z > 640) car.group.position.z = -640;
        if (car.direction === -1 && car.group.position.z < -640) car.group.position.z = 640;
      });
    };

    const updateSimulation = (delta: number) => {
      game.time += delta;
      const turnInput = (game.keys.KeyA ? 1 : 0) - (game.keys.KeyD ? 1 : 0);
      const forwardInput = (game.keys.KeyW ? 1 : 0) - (game.keys.KeyS ? 1 : 0);
      forward.set(-Math.sin(game.yaw), 0, -Math.cos(game.yaw));

      if (game.mode === 'flying') {
        game.yaw += turnInput * 1.18 * delta;
        const targetSpeed = 18 + forwardInput * 9;
        game.speed = THREE.MathUtils.damp(game.speed, targetSpeed, 2.2, delta);
        const descending = game.keys.ShiftLeft || game.keys.ShiftRight;
        const targetVertical = game.keys.Space ? 8.8 : descending ? -8.2 : 0;
        game.verticalSpeed = THREE.MathUtils.damp(game.verticalSpeed, targetVertical, 2.6, delta);
        game.position.addScaledVector(forward, game.speed * delta);
        game.position.y += game.verticalSpeed * delta;
        game.roll = THREE.MathUtils.damp(game.roll, -turnInput * 0.48, 3.6, delta);
        game.pitch = THREE.MathUtils.damp(game.pitch, game.verticalSpeed * 0.025, 3.4, delta);

        const water = isInsideWater(game.position.x, game.position.z);
        const surfaceHeight = water ? 1.42 : 1.06;
        if (game.position.y <= surfaceHeight) {
          game.position.y = surfaceHeight;
          game.verticalSpeed = 0;
          game.speed = 0;
          game.mode = water ? 'swimming' : 'waddling';
          game.keys.ShiftLeft = false;
          game.keys.ShiftRight = false;
          if (water) triggerSplash();
          else setToast('Touchdown. Time to waddle.');
        }
      } else {
        game.yaw += turnInput * 2.05 * delta;
        forward.set(-Math.sin(game.yaw), 0, -Math.cos(game.yaw));
        const walkingSpeed = forwardInput * (game.mode === 'swimming' ? 5.2 : 4.2);
        game.speed = THREE.MathUtils.damp(game.speed, walkingSpeed, 7, delta);
        game.position.addScaledVector(forward, game.speed * delta);
        game.roll = THREE.MathUtils.damp(game.roll, 0, 5.5, delta);
        game.pitch = THREE.MathUtils.damp(game.pitch, 0, 5.5, delta);

        const water = isInsideWater(game.position.x, game.position.z);
        const nextMode: GooseMode = water ? 'swimming' : 'waddling';
        if (nextMode !== game.mode) {
          game.mode = nextMode;
          setToast(water ? 'Paddle mode' : 'Back on dry land');
        }
        game.position.y = water ? 1.42 : 1.06;

        if (game.keys.Space) {
          game.mode = 'flying';
          game.position.y += 1.3;
          game.verticalSpeed = 8.8;
          game.speed = 11;
          game.keys.Space = false;
          setToast('Takeoff!');
        }
      }

      if (game.position.y > 180) game.position.y = 180;
      forward.set(-Math.sin(game.yaw), 0, -Math.cos(game.yaw));
      updateTraffic(delta);
      updateEffects(delta);

      goose.group.position.copy(game.position);
      goose.group.rotation.set(game.pitch, game.yaw, game.roll, 'YXZ');
      const flightFlap = game.mode === 'flying' ? Math.sin(game.time * 10) * 0.85 : 0;
      goose.wings[0].rotation.z = 0.22 + flightFlap;
      goose.wings[1].rotation.z = -0.22 - flightFlap;
      goose.legs.forEach((leg, index) => {
        leg.visible = game.mode !== 'swimming';
        leg.rotation.x = game.mode === 'waddling' ? Math.sin(game.time * 8 + index * Math.PI) * 0.55 : 0;
      });
      if (game.mode === 'waddling') {
        goose.group.position.y += Math.abs(Math.sin(game.time * 8)) * 0.13;
        goose.group.rotation.z += Math.sin(game.time * 8) * 0.09;
      } else if (game.mode === 'swimming') {
        goose.group.position.y += Math.sin(game.time * 3) * 0.08;
      }

      contactShadow.position.set(game.position.x, 0.31, game.position.z);
      const shadowScale = Math.max(0.55, 1 - game.position.y / 120);
      contactShadow.scale.setScalar(shadowScale);
      (contactShadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.03, 0.24 - game.position.y / 180);

      if (game.time - game.lastTileUpdate > 0.75) {
        updateTiles(game.position.x, game.position.z);
        game.lastTileUpdate = game.time;
      }

      const geo = localToGeo(game.position.x, game.position.z);
      const target = nearestWater(game.position.x, game.position.z);
      if (game.time - game.lastHud > 0.12) {
        setHud({
          speed: Math.abs(game.speed),
          altitude: Math.max(0, game.position.y - 1),
          lat: geo.lat,
          lon: geo.lon,
          mode: game.mode,
          destination: target.water.name,
          distance: target.distance,
        });
        game.lastHud = game.time;
      }

      cameraDesired.copy(game.position).addScaledVector(forward, game.mode === 'flying' ? -18 : -10);
      cameraDesired.y += game.mode === 'flying' ? 7.5 : 5.2;
      camera.position.lerp(cameraDesired, 1 - Math.exp(-5 * delta));
      lookTarget.copy(game.position).addScaledVector(forward, game.mode === 'flying' ? 12 : 7);
      lookTarget.y += 2.1;
      cameraTarget.lerp(lookTarget, 1 - Math.exp(-7 * delta));
      camera.lookAt(cameraTarget);
    };

    const animate = () => {
      const delta = Math.min(clock.getDelta(), 0.05);
      if (startedRef.current) {
        updateSimulation(delta);
      } else {
        game.time += delta;
        goose.group.position.y = game.position.y + Math.sin(game.time * 1.7) * 0.32;
        goose.group.rotation.z = Math.sin(game.time * 1.15) * 0.04;
        goose.wings[0].rotation.z = 0.2 + Math.sin(game.time * 4.5) * 0.18;
        goose.wings[1].rotation.z = -0.2 - Math.sin(game.time * 4.5) * 0.18;
        forward.set(-Math.sin(game.yaw), 0, -Math.cos(game.yaw));
        cameraDesired.copy(game.position).add(menuCameraOffset);
        camera.position.lerp(cameraDesired, 1 - Math.exp(-2.4 * delta));
        lookTarget.copy(game.position).add(menuLookOffset);
        cameraTarget.lerp(lookTarget, 1 - Math.exp(-3.5 * delta));
        camera.lookAt(cameraTarget);
        updateEffects(delta);
        updateTraffic(delta);
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      actionsRef.current = null;
      void audioContext?.close();
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.InstancedMesh)) return;
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => {
          if (material instanceof THREE.MeshStandardMaterial) material.map?.dispose();
          material.dispose();
        });
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  const press = (code: string) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      actionsRef.current?.setKey(code, true);
    },
    onPointerUp: () => actionsRef.current?.setKey(code, false),
    onPointerCancel: () => actionsRef.current?.setKey(code, false),
  });

  const launch = () => {
    setStarted(true);
    setToast('Flight controls online');
  };

  return (
    <main className="game-shell">
      <div ref={mountRef} className="game-canvas" aria-label="A playable 3D OpenStreetMap world centered on Western Michigan University" />
      <div className="sky-vignette" aria-hidden="true" />

      <header className="game-topbar">
        <div className="brand-lockup" aria-label="Wild Goose Open Earth">
          <span className="brand-mark"><Bird /></span>
          <span>
            <strong>WILD GOOSE</strong>
            <small>OPEN EARTH</small>
          </span>
        </div>

        <div className="location-chip">
          <MapPin aria-hidden="true" />
          <span>
            <strong>{Math.abs(hud.lat - SPAWN.lat) < 0.018 ? 'Western Michigan University' : 'Kalamazoo, Michigan'}</strong>
            <small>{hud.lat.toFixed(5)}° N · {Math.abs(hud.lon).toFixed(5)}° W</small>
          </span>
        </div>

        <div className="top-actions">
          {started && (
            <Button variant="secondary" size="icon-lg" className="hud-button" aria-label="Pause game" onClick={() => setStarted(false)}>
              <Pause />
            </Button>
          )}
          <Button
            variant="secondary"
            size="icon-lg"
            className="hud-button"
            aria-label={muted ? 'Turn sound on' : 'Mute sound'}
            onClick={() => setMuted((value) => !value)}
          >
            {muted ? <VolumeX /> : <Volume2 />}
          </Button>
        </div>
      </header>

      {!started ? (
        <section className="launch-card" aria-labelledby="launch-title">
          <div className="eyebrow"><span /> GOOSE 01 · WMU AIRSPACE</div>
          <h1 id="launch-title">The whole world.<br />One curious goose.</h1>
          <p>Fly a living map of Kalamazoo. Touch down on water, waddle into traffic, and honk whenever the moment calls for it.</p>
          <Button className="launch-button" size="lg" onClick={launch}>
            <Navigation data-icon="inline-start" /> Fly from WMU
          </Button>
          <div className="launch-features" aria-label="Game features">
            <span><Wind /> Free flight</span>
            <span><Waves /> Water landings</span>
            <span><Bird /> Premium waddling</span>
          </div>
          <p className="launch-note">OpenStreetMap world · Third-person exploration</p>
        </section>
      ) : (
        <>
          <section className="telemetry-panel" aria-label="Flight telemetry">
            <div>
              <span className="telemetry-icon"><Gauge /></span>
              <span><small>Ground speed</small><strong>{Math.round(hud.speed * 3.6)}</strong><em>km/h</em></span>
            </div>
            <div>
              <span className="telemetry-icon"><Wind /></span>
              <span><small>Altitude</small><strong>{Math.round(hud.altitude)}</strong><em>m</em></span>
            </div>
          </section>

          <section className="objective-card" aria-label="Nearest landing spot">
            <span className="objective-icon"><Waves /></span>
            <span>
              <small>Nearest water</small>
              <strong>{hud.destination}</strong>
              <em>{hud.distance < 1000 ? `${Math.round(hud.distance)} m` : `${(hud.distance / 1000).toFixed(1)} km`} away</em>
            </span>
          </section>

          <div className="flight-reticle" aria-hidden="true"><i /><span /></div>

          <div className="mode-stack">
            <Badge className={`mode-badge mode-${hud.mode}`}>
              {hud.mode === 'swimming' ? <Waves /> : hud.mode === 'waddling' ? <Bird /> : <Navigation />}
              {MODE_LABEL[hud.mode]}
            </Badge>
            <span>{hud.mode === 'flying' ? 'Hold Shift to descend and land' : 'Press Space to take off'}</span>
          </div>

          <nav className="control-deck" aria-label="Game controls">
            <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> steer</span>
            <i />
            <span><kbd>Space</kbd> flap / take off</span>
            <i />
            <span><kbd>Shift</kbd> descend</span>
            <i />
            <button type="button" onClick={() => actionsRef.current?.honk()}><kbd>H</kbd> honk</button>
          </nav>

          <div className="mobile-controls" aria-label="Touch controls">
            <div className="touch-pad">
              <button aria-label="Move forward" {...press('KeyW')}><ArrowUp /></button>
              <button aria-label="Turn left" {...press('KeyA')}><ArrowLeft /></button>
              <button aria-label="Move backward" {...press('KeyS')}><ArrowDown /></button>
              <button aria-label="Turn right" {...press('KeyD')}><ArrowRight /></button>
            </div>
            <div className="touch-actions">
              <button aria-label="Honk" onPointerDown={() => actionsRef.current?.honk()}><Bird /><span>Honk</span></button>
              <button aria-label="Descend or land" {...press('ShiftLeft')}><PlaneLanding /><span>Land</span></button>
              <button className="flap-action" aria-label="Flap or take off" {...press('Space')}><Wind /><span>Flap</span></button>
            </div>
          </div>
        </>
      )}

      {toast && <output className="game-toast" aria-live="polite">{toast}</output>}

      <footer className="game-footer">
        <span>{hud.lat.toFixed(4)}° N</span><i /> <span>{Math.abs(hud.lon).toFixed(4)}° W</span>
        <span className="map-credit">
          © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>
        </span>
      </footer>
    </main>
  );
}
