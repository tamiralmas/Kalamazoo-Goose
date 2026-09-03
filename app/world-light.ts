import type { LightSpecification } from '@maplibre/maplibre-gl-style-spec';

/**
 * One sun for the whole world.
 *
 * The MiSAIL photography under the goose was flown with the sun in the
 * south-east: lamp posts and trees cast their shadows to the north-west,
 * about as long as they are tall. Everything the game lights itself (the
 * building walls MapLibre extrudes, the hillshade over the DEM, and every
 * Three.js object) reads its light direction from here, so a wall, a tree
 * and the shadow baked into the ground under it all agree on where the sun
 * is. Before this the three disagreed, and the campus read as a map with
 * things on it rather than a place.
 */

/** Compass bearing the light arrives from, degrees clockwise from north. */
export const SUN_AZIMUTH_DEGREES = 130;

/** Height of the sun above the horizon, degrees. */
export const SUN_ELEVATION_DEGREES = 40;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Unit vector from the ground toward the sun in the engine's local frame
 * (x east, y up, z north).
 */
export const sunDirection = () => {
  const azimuth = toRadians(SUN_AZIMUTH_DEGREES);
  const elevation = toRadians(SUN_ELEVATION_DEGREES);
  const horizontal = Math.cos(elevation);
  return {
    x: Math.sin(azimuth) * horizontal,
    y: Math.sin(elevation),
    z: Math.cos(azimuth) * horizontal,
  };
};

/**
 * MapLibre's light specification for the same sun. The `map` anchor pins
 * the light to the compass so the lit side of a building stays put while
 * the chase camera swings around the goose; the default viewport anchor
 * would move the sun with every turn.
 */
export const MAPLIBRE_SUN_LIGHT: LightSpecification = {
  anchor: 'map',
  position: [1.15, SUN_AZIMUTH_DEGREES, 90 - SUN_ELEVATION_DEGREES],
  color: '#fff4de',
  intensity: 0.38,
};

/** Hillshade illumination for the same sun (degrees clockwise from north). */
export const HILLSHADE_ILLUMINATION_DIRECTION = SUN_AZIMUTH_DEGREES;
