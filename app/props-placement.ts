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

  // Sprau Tower (90, 20)
  {
    kind: 'bench',
    east: 80,
    north: 20,
    count: 2,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2.2,
  },
  {
    kind: 'bench',
    east: 100,
    north: 20,
    count: 2,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2.2,
  },

  // Kanley Chapel (245, -225)
  { kind: 'sign', east: 245, north: -237 },
  { kind: 'cone', east: 253, north: -225 },
  {
    kind: 'bench',
    east: 235,
    north: -217,
    count: 2,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2.2,
  },
  {
    kind: 'trash',
    east: 245,
    north: -215,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Cone Crown (70, -205)
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

  // Parking Meters (-180, -180)
  {
    kind: 'cone',
    east: -180,
    north: -192,
    count: 5,
    pattern: 'row',
    heading: 0,
    spacing: 2,
  },
  {
    kind: 'cone',
    east: -180,
    north: -165,
    count: 5,
    pattern: 'row',
    heading: 0,
    spacing: 2,
  },
  {
    kind: 'trash',
    east: -170,
    north: -180,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Bernhard Center/Student Center (120, -120)
  {
    kind: 'bench',
    east: 110,
    north: -125,
    count: 2,
    pattern: 'row',
    heading: 0,
    spacing: 2.2,
  },
  {
    kind: 'bench',
    east: 130,
    north: -115,
    count: 2,
    pattern: 'row',
    heading: 0,
    spacing: 2.2,
  },
  {
    kind: 'trash',
    east: 120,
    north: -110,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Sangren Hall (150, 60)
  {
    kind: 'bike',
    east: 155,
    north: 75,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Student Megaphone (400, -210)
  { kind: 'sign', east: 400, north: -222 },
  { kind: 'trash', east: 408, north: -210 },
  {
    kind: 'bench',
    east: 410,
    north: -210,
    count: 2,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2.2,
  },
  {
    kind: 'trash',
    east: 390,
    north: -220,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Bike Xylophone (475, -285)
  {
    kind: 'bike',
    east: 485,
    north: -285,
    count: 5,
    pattern: 'cluster',
    spacing: 2,
  },
  {
    kind: 'trash',
    east: 465,
    north: -290,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Cafeteria Tray (395, -218)
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
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Waldo Library (520, -75)
  {
    kind: 'trash',
    east: 515,
    north: -65,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },
  {
    kind: 'bike',
    east: 540,
    north: -75,
    count: 4,
    pattern: 'cluster',
    spacing: 2,
  },

  // Acorn Offering (350, 255)
  {
    kind: 'bench',
    east: 360,
    north: 255,
    count: 3,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2,
  },
  {
    kind: 'trash',
    east: 345,
    north: 265,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Bench Catapult (300, 315)
  {
    kind: 'bench',
    east: 310,
    north: 315,
    count: 3,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2,
  },
  {
    kind: 'bike',
    east: 290,
    north: 310,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Bronco Bucker (-60, 245)
  {
    kind: 'flag',
    east: -72,
    north: 245,
    count: 6,
    pattern: 'ring',
    spacing: 4,
  },
  {
    kind: 'trash',
    east: -70,
    north: 255,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Flamingo Dominoes (-330, 85)
  {
    kind: 'bench',
    east: -340,
    north: 85,
    count: 3,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2,
  },
  {
    kind: 'bike',
    east: -340,
    north: 75,
    count: 4,
    pattern: 'cluster',
    spacing: 2,
  },

  // Goose Choir (-180, 410)
  {
    kind: 'bench',
    east: -180,
    north: 420,
    count: 3,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2,
  },
  {
    kind: 'bike',
    east: -190,
    north: 420,
    count: 4,
    pattern: 'cluster',
    spacing: 2,
  },

  // Goldsworth Valley Dorms (-10 to 60, 480 to 620)
  {
    kind: 'bike',
    east: 30,
    north: 530,
    count: 4,
    pattern: 'cluster',
    spacing: 2,
  },
  {
    kind: 'bench',
    east: 50,
    north: 550,
    count: 2,
    pattern: 'row',
    heading: 0,
    spacing: 2.2,
  },
  {
    kind: 'trash',
    east: 40,
    north: 510,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },

  // Parking Ramp (130, -420)
  {
    kind: 'cone',
    east: 130,
    north: -432,
    count: 5,
    pattern: 'row',
    heading: 0,
    spacing: 2,
  },
  {
    kind: 'cone',
    east: 125,
    north: -405,
    count: 5,
    pattern: 'row',
    heading: 0,
    spacing: 2,
  },

  // Waldo Stadium (690, -250)
  {
    kind: 'flag',
    east: 690,
    north: -265,
    count: 6,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 5,
  },
  {
    kind: 'flag',
    east: 705,
    north: -240,
    count: 5,
    pattern: 'ring',
    spacing: 3,
  },
  {
    kind: 'cone',
    east: 690,
    north: -265,
    count: 5,
    pattern: 'row',
    heading: 0,
    spacing: 2,
  },

  // Miller Auditorium (180, -630)
  {
    kind: 'flag',
    east: 180,
    north: -630,
    count: 6,
    pattern: 'ring',
    spacing: 3,
  },
  {
    kind: 'cone',
    east: 190,
    north: -640,
    count: 4,
    pattern: 'row',
    heading: Math.PI / 2,
    spacing: 2,
  },

  // Scattered nearby props for fill
  { kind: 'cone', east: 85, north: -210 },
  { kind: 'trash', east: -165, north: -180 },
  { kind: 'bike', east: 465, north: -290 },
  { kind: 'bench', east: -330, north: 100 },
  { kind: 'flag', east: 280, north: -225 },
  { kind: 'trash', east: 395, north: -210 },
  { kind: 'cone', east: 110, north: -420 },
  { kind: 'flag', east: -840, north: -770 },
  { kind: 'trash', east: -1520, north: -900 },
  { kind: 'bike', east: -1500, north: -880 },

  // Fraternity Row (old-goat-simulator -425.4, -424.4 and fraternity-honkening -878.6, -756.9)
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

  // Downtown Library (library-after-hours -1513.3, -887.2)
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
    count: 4,
    pattern: 'cluster',
    spacing: 2,
  },

  // Bronson Hospital (2608.3, 581)
  {
    kind: 'cone',
    east: 2620,
    north: 590,
    count: 6,
    pattern: 'ring',
    spacing: 3,
  },
  {
    kind: 'flag',
    east: 2620,
    north: 595,
    count: 4,
    pattern: 'cluster',
    spacing: 2,
  },
  {
    kind: 'trash',
    east: 2600,
    north: 575,
    count: 3,
    pattern: 'cluster',
    spacing: 2,
  },
];
