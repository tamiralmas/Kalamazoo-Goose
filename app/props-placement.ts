import { PropPlacement } from './game-contract';

// Coordinate frame: east/north in meters, relative to WMU_CONTENT_ANCHOR.
// Positive north is up; positive east is right.
// The goose spawns at authored (69.7, -12.8), on the lawn east of the Fetzer
// Center, flying north. The first cone row is the harness test row.

export const PROP_PLACEMENTS: readonly PropPlacement[] = [
  // Spawn lawn area. The goose spawns at authored (69.7, -12.8) flying north,
  // so this group is offset to sit on the real lawn. The first row is the
  // harness test row: 6 cones straight ahead of the touchdown spot.
  {
    kind: 'cone',
    east: 69.7,
    north: -6.8,
    count: 6,
    pattern: 'row',
    heading: 0,
    spacing: 3.4,
  },
  {
    kind: 'bench',
    east: 94.7,
    north: -12.8,
    count: 2,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2.2,
  },
  {
    kind: 'bench',
    east: 44.7,
    north: -12.8,
    count: 2,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2.2,
  },
  {
    kind: 'bench',
    east: 55.7,
    north: 15.2,
    count: 2,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2.2,
  },
  {
    kind: 'trash',
    east: 84.7,
    north: -32.8,
    count: 3,
    pattern: 'cluster',
    spacing: 3,
  },
  { kind: 'trash', east: 49.7, north: -2.8, count: 1 },
  { kind: 'sign', east: 81.7, north: 17.2, heading: Math.PI },
  {
    kind: 'flag',
    east: 39.7,
    north: -42.8,
    count: 4,
    pattern: 'ring',
    spacing: 3,
  },
  // Kanley bell (245, -225): sign and nearby cone
  { kind: 'sign', east: 245, north: -237 },
  { kind: 'cone', east: 253, north: -225 },

  // Library (520, -75): trash and bench
  {
    kind: 'trash',
    east: 515,
    north: -65,
    count: 4,
    pattern: 'cluster',
    spacing: 3,
  },
  { kind: 'bench', east: 530, north: -75 },

  // Student megaphone (400, -210): sign and trash
  { kind: 'sign', east: 400, north: -222 },
  { kind: 'trash', east: 408, north: -210 },

  // Parking meters (-180, -180): cone row
  {
    kind: 'cone',
    east: -180,
    north: -192,
    count: 5,
    pattern: 'row',
    heading: 0,
    spacing: 2,
  },

  // Goose choir (-180, 410): bench row
  {
    kind: 'bench',
    east: -180,
    north: 420,
    count: 3,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2,
  },

  // Cone crown (70, -205): two cone rows
  {
    kind: 'cone',
    east: 70,
    north: -217,
    count: 5,
    pattern: 'row',
    heading: 0,
    spacing: 2,
  },
  {
    kind: 'cone',
    east: 70,
    north: -193,
    count: 5,
    pattern: 'row',
    heading: 0,
    spacing: 2,
  },

  // Bike xylophone (475, -285): bike cluster
  {
    kind: 'bike',
    east: 485,
    north: -285,
    count: 6,
    pattern: 'cluster',
    spacing: 3,
  },

  // Cafeteria tray (395, -218): benches and trash
  {
    kind: 'bench',
    east: 405,
    north: -218,
    count: 3,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2,
  },
  {
    kind: 'trash',
    east: 395,
    north: -228,
    count: 4,
    pattern: 'cluster',
    spacing: 2,
  },

  // Bronco (-60, 245): flag ring
  {
    kind: 'flag',
    east: -72,
    north: 245,
    count: 6,
    pattern: 'ring',
    spacing: 4,
  },

  // Flamingo lawn (-330, 85): bench row
  {
    kind: 'bench',
    east: -340,
    north: 85,
    count: 3,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2,
  },

  // Acorn (350, 255): bench row
  {
    kind: 'bench',
    east: 360,
    north: 255,
    count: 3,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2,
  },

  // Bench catapult (300, 315): bench row
  {
    kind: 'bench',
    east: 310,
    north: 315,
    count: 3,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2,
  },

  // Parking ramp (130, -420): cone row
  {
    kind: 'cone',
    east: 130,
    north: -432,
    count: 5,
    pattern: 'row',
    heading: 0,
    spacing: 2,
  },

  // Waldo field (690, -250): flag row
  {
    kind: 'flag',
    east: 690,
    north: -265,
    count: 8,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 5,
  },

  // Fraternity row (-878.6, -756.9): cones and trash
  {
    kind: 'cone',
    east: -890,
    north: -768,
    count: 8,
    pattern: 'row',
    heading: 0,
    spacing: 2,
  },
  {
    kind: 'trash',
    east: -880,
    north: -750,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Downtown library (-1513.3, -887.2): benches and bikes
  {
    kind: 'bench',
    east: -1520,
    north: -890,
    count: 4,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2,
  },
  {
    kind: 'bike',
    east: -1510,
    north: -885,
    count: 5,
    pattern: 'cluster',
    spacing: 3,
  },

  // Bronson (2608.3, 581): cone ring
  {
    kind: 'cone',
    east: 2620,
    north: 590,
    count: 6,
    pattern: 'ring',
    spacing: 3,
  },

  // Scattered additional props
  { kind: 'cone', east: 50, north: -205 },
  { kind: 'cone', east: 85, north: -210 },
  { kind: 'bench', east: 250, north: -215 },
  { kind: 'trash', east: -165, north: -180 },
  { kind: 'bike', east: 465, north: -290 },
  { kind: 'bench', east: -330, north: 100 },
  { kind: 'flag', east: 280, north: -225 },
  { kind: 'trash', east: 395, north: -210 },
  { kind: 'cone', east: 110, north: -420 },
  { kind: 'bench', east: 690, north: -240 },
  { kind: 'flag', east: -840, north: -770 },
  { kind: 'trash', east: -1520, north: -900 },
  { kind: 'bike', east: -1500, north: -880 },
];
