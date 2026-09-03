import * as THREE from 'three';

/**
 * A soft shadow disc under a character.
 *
 * Real shadow maps are out of reach here: the ground is MapLibre's terrain
 * mesh, not a Three.js surface, so nothing of ours can receive a shadow. A
 * blurred disc laid on whatever the character is over does most of the
 * same perceptual work. It spreads and fades with altitude, so a landing
 * goose visibly meets its own shadow and a cruising one leaves a faint
 * smudge on the roofs below, exactly the cue that stops the bird looking
 * pasted onto the photo.
 */
export type ContactShadow = {
  readonly mesh: THREE.Mesh;
  /**
   * Place the disc under a character. `surfaceY` is the height of whatever
   * is directly beneath it (terrain or a roof), `agl` its height above
   * that, `scale` the character's size multiplier.
   */
  update(
    x: number,
    surfaceY: number,
    z: number,
    agl: number,
    scale: number,
  ): void;
  setVisible(visible: boolean): void;
  dispose(): void;
};

/** Altitude above which the disc has faded out entirely. */
const FADE_OUT_AGL = 42;

/** Height above the surface the disc floats at, so it never z-fights it. */
const SURFACE_LIFT = 0.08;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float distance = length(vUv - 0.5) * 2.0;
    // Dense core, wide soft edge: a penumbra rather than a painted disc.
    float alpha = smoothstep(1.0, 0.18, distance);
    alpha *= alpha;
    gl_FragColor = vec4(0.035, 0.028, 0.02, alpha * uOpacity);
  }
`;

export const createContactShadow = (baseRadius: number): ContactShadow => {
  const material = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.5 } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    // The map's projection mirrors an axis, so a single-sided quad would
    // face away from the camera.
    side: THREE.DoubleSide,
    // Sit on top of the terrain mesh when the two are coplanar.
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.visible = false;
  let shown = true;
  return {
    mesh,
    update(x, surfaceY, z, agl, scale) {
      const height = Math.max(0, agl);
      const fade = 1 - THREE.MathUtils.smoothstep(height, 0, FADE_OUT_AGL);
      const opacity = 0.55 * fade;
      if (!shown || opacity < 0.015) {
        mesh.visible = false;
        return;
      }
      // The penumbra widens with altitude: the disc grows while it fades.
      const radius = baseRadius * scale * (1 + Math.min(height, 30) * 0.055);
      mesh.visible = true;
      mesh.position.set(x, surfaceY + SURFACE_LIFT + radius * 0.02, z);
      mesh.scale.set(radius, radius, 1);
      material.uniforms.uOpacity.value = opacity;
    },
    setVisible(visible) {
      shown = visible;
      if (!visible) mesh.visible = false;
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
};
