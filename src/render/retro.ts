import * as THREE from 'three';
import { LUMINANCE, meanLuminance } from './detail.js';

/**
 * The retexturing pass.
 *
 * Three problems make a naive texture swap useless on Kenney's kits:
 *
 * 1. **One material per kit.** All 76 Castle Kit models share a single material
 *    called "colormap", and all 167 Town Kit models share another. So a rule
 *    keyed on the material name cannot tell a roof from a wall. Rules are keyed
 *    on the *model name* instead — Kenney names things semantically
 *    (`wall-wood-door`, `roof-high-gable`), so prefix matching does the job.
 *
 * 2. **The UVs point at a palette atlas.** Each face samples a small flat patch
 *    of colormap.png. Drop a brick texture in behind those UVs and every face
 *    samples a single texel, i.e. a solid colour — no brick at all.
 *
 * 3. **The textures are gritty; the game is not.** The retro pack is dark and
 *    desaturated. Multiplied straight in, it turned the castle grey and muddy.
 *
 * So colour and pattern are split. Colour comes from Kenney's own atlas through
 * the model's UVs, as the kit intended, with its plain swatches repainted as
 * the rule's material (see repaintedAtlas) — which keeps the blue roofs and red
 * banners that make the kit read as a game. Pattern comes from the retro
 * texture, mapped **triplanar in world space** and applied as detail
 * (detail.ts), so it shades the colour without replacing it. Texel density is
 * identical everywhere regardless of how a model was unwrapped, and the pattern
 * lines up across adjacent pieces.
 */

const TEXTURE_DIR = 'assets/kenney/retro-textures';

/**
 * How a rule repaints Kenney's atlas. `stone` and `wood` turn the kit's cream,
 * tan and terracotta swatches into that material; `paint` keeps the atlas as
 * drawn.
 */
export type AtlasMode = 'stone' | 'wood' | 'paint';

export interface RetroRule {
  /** Cache key; also the material dedup key. */
  id: string;
  /** Matched against `kit/model`. */
  test: RegExp;
  /** Pattern texture, projected triplanar in world space. */
  texture: string;
  /**
   * How many texture pixels cover one world unit.
   *
   * This, rather than a repeat count, is the number that matters: it keeps a
   * brick the same size on every model. Repeats are derived from this and the
   * image's real dimensions, so the 64x128 wall textures stay square in world
   * space instead of being squashed to the aspect of whatever they land on.
   */
  texelsPerUnit?: number;
  /** Where colour comes from. Without an atlas the surface is its flat tint. */
  atlas?: AtlasMode;
  /** The flat colour without an atlas; a multiplier over it with one. */
  tint?: number;
  /** How strongly the pattern shows, 0..1. Painted swatches get less of it. */
  detail?: number;
}

/**
 * Models the retro pass must leave alone.
 *
 * World-space triplanar mapping is only meaningful on surfaces big enough to
 * span several texels. A 10cm fence post, a banner or a barrel spans a fraction
 * of one, so it samples a near-constant patch of the texture and comes out as a
 * flat, arbitrary — usually dark — colour. Small props keep Kenney's own
 * colormap, which is already doing the right thing for them.
 */
const TOO_SMALL_FOR_TRIPLANAR = /^(retro\/(structure|barrels|detail|pulley|ladder)|castle\/flag|town\/(banner|lantern|wheel))/;

/**
 * First match wins, so specific rules come before general ones — the wooden
 * palisade pieces have to be caught before the blanket castle-stone rule.
 */
export const RETRO_RULES: readonly RetroRule[] = [
  // --- castle kit ---
  { id: 'palisade', test: /^castle\/wall-narrow-wood/, texture: 'floor_wood_planks.png', atlas: 'wood', detail: 0.6 },
  { id: 'drawbridge', test: /^castle\/bridge/, texture: 'floor_wood_planks.png', atlas: 'wood', detail: 0.6 },
  { id: 'portcullis', test: /^castle\/metal-gate/, texture: 'door_metal_gate.png', texelsPerUnit: 32, atlas: 'paint', detail: 0.8 },
  { id: 'castle-gate', test: /^castle\/(gate|door)/, texture: 'door_wood.png', texelsPerUnit: 32, atlas: 'wood', detail: 0.6 },
  { id: 'siege', test: /^castle\/siege/, texture: 'floor_wood_planks.png', texelsPerUnit: 16, atlas: 'wood', detail: 0.6 },
  { id: 'castle-stone', test: /^castle\//, texture: 'wall_brick_stone_center.png', atlas: 'stone', detail: 0.7 },

  // --- town kit: the keep's four tiers ---
  { id: 'roof-thatch', test: /^town\/roof.*(gable|point)/, texture: 'roof_thatch_center.png', tint: 0xe9b95a, detail: 0.55 },
  // Tile and slate patterns smear on steep triplanar slopes, so they are kept faint.
  { id: 'roof-tile', test: /^town\/roof/, texture: 'roof_clay_red_center.png', tint: 0xde5a3c, detail: 0.3 },
  { id: 'timber', test: /^town\/(wall-wood|planks|pillar-wood|stairs-wood|stairs-wide-wood)/, texture: 'wall_timber.png', atlas: 'wood', detail: 0.6 },
  { id: 'town-stone', test: /^town\//, texture: 'wall_brick_stone_center.png', atlas: 'stone', detail: 0.6 },

  // --- skins only: never matched by name, picked by id (PlacedPiece.skin) ---
  { id: 'roof-slate', test: /(?!)/, texture: 'roof_clay_grey_center.png', tint: 0x6d7d96, detail: 0.3 },
  // Deeper-cut masonry, a shade darker: reads as heavier than a plain stone wall.
  { id: 'reinforced', test: /(?!)/, texture: 'wall_brick_stone_center_depth.png', atlas: 'stone', tint: 0xd2cabe, detail: 0.85 },

  // --- retro kit: one texture per material, so a flat tint carries the colour ---
  { id: 'retro-planks', test: /^retro\/(wood-floor|planks|structure|fence|dock)/, texture: 'floor_wood_planks.png', tint: 0xc08a50, detail: 0.6 },
  { id: 'retro-stone', test: /^retro\//, texture: 'wall_stone.png', tint: 0xcdc7bc, detail: 0.6 },
];

/** Share of a rule's pattern strength that painted atlas swatches receive. */
const PAINT_DETAIL = 0.3;

interface Loaded {
  image: TexImageSource;
  mean: number;
}

const cache = new Map<string, THREE.Texture>();
const loaded = new Map<string, Loaded>();
/** Callbacks waiting for a texture's image, so its size and luminance can be read. */
const waiting = new Map<string, ((image: Loaded) => void)[]>();
const atlases = new Map<string, THREE.Texture>();

/** ?retro=0 skips the pass and leaves Kenney's own colormaps in place. */
export const retroEnabled =
  typeof location === 'undefined' || new URLSearchParams(location.search).get('retro') !== '0';

export function ruleFor(kit: string, model: string): RetroRule | null {
  if (!retroEnabled) return null;
  const key = `${kit}/${model}`;
  if (TOO_SMALL_FOR_TRIPLANAR.test(key)) return null;
  return RETRO_RULES.find((rule) => rule.test.test(key)) ?? null;
}

function texture(file: string, onImage: (image: Loaded) => void): THREE.Texture {
  let tex = cache.get(file);
  if (tex) {
    const ready = loaded.get(file);
    if (ready) onImage(ready);
    else waiting.get(file)?.push(onImage);
    return tex;
  }

  const listeners = [onImage];
  waiting.set(file, listeners);
  tex = new THREE.TextureLoader().load(`${TEXTURE_DIR}/${file}`, (done) => {
    const ready = { image: done.image as TexImageSource, mean: meanLuminance(done.image) };
    loaded.set(file, ready);
    for (const listener of listeners) listener(ready);
    listeners.length = 0;
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Filtered, not nearest: the pattern is soft shading under a painted colour
  // now, and mipmaps let it fade out cleanly at the whole-map zoom instead of
  // shimmering.
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(file, tex);
  return tex;
}

/** 0 at `from`, 1 at `to`, smooth in between; either order. */
const ramp = (from: number, to: number, x: number): number => {
  const t = Math.min(Math.max((x - from) / (to - from), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Kenney's colormap with its plain swatches repainted as one material.
 *
 * The kits paint masonry and timber alike in cream, tan and terracotta: warm
 * hue, low chroma. Those become stone grey or honey wood of matching lightness.
 * Anything saturated is paint — blue roofs, red banners, gold trim — and keeps
 * its colour. Alpha records which is which, so the pattern can go easy on
 * paint: bricks belong on a wall, not on a roof.
 *
 * Built as a DataTexture from raw bytes rather than a canvas, because a canvas
 * premultiplies alpha and would quantise the colour of every painted swatch.
 */
function repaintedAtlas(kit: string, mode: AtlasMode, source: THREE.Texture): THREE.Texture {
  const key = `${kit}:${mode}`;
  const cached = atlases.get(key);
  if (cached) return cached;

  const image = source.image as (CanvasImageSource & { width: number; height: number }) | null;
  const context = image?.width ? document.createElement('canvas').getContext('2d') : null;
  if (!image || !context) return source;
  context.canvas.width = image.width;
  context.canvas.height = image.height;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;

  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const max = Math.max(r, g, b);
    const chroma = max - Math.min(r, g, b);
    const warm = r >= g && g >= b && r - b > 12;
    // The Town Kit paints its masonry pale blue-grey rather than cream, so for
    // stone, near-neutral swatches of any hue count as plain too.
    let plain = mode === 'paint' ? 0 : warm ? ramp(150, 100, chroma) : mode === 'stone' ? ramp(60, 30, chroma) : 0;

    let nr = r;
    let ng = g;
    let nb = b;
    if (mode === 'stone') {
      // Only the light swatches are masonry; the dark browns are doors and
      // beams, and stay wood.
      plain *= ramp(160, 200, max);
      const grey = 48 + 0.76 * (0.2126 * r + 0.7152 * g + 0.0722 * b);
      nr = grey;
      ng = grey * 0.98;
      nb = grey * 0.94;
    } else if (mode === 'wood') {
      const value = max * 0.9;
      nr = value;
      ng = value * 0.72;
      nb = value * 0.48;
    }

    out[i] = Math.round(r + (nr - r) * plain);
    out[i + 1] = Math.round(g + (ng - g) * plain);
    out[i + 2] = Math.round(b + (nb - b) * plain);
    out[i + 3] = mode === 'paint' ? 255 : Math.round(255 * (PAINT_DETAIL + (1 - PAINT_DETAIL) * plain));
  }

  const atlas = new THREE.DataTexture(out, image.width, image.height, THREE.RGBAFormat);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.flipY = false; // glTF convention, same as the texture it replaces
  atlas.magFilter = THREE.LinearFilter;
  atlas.minFilter = THREE.LinearFilter;
  atlas.generateMipmaps = false;
  atlas.needsUpdate = true;
  atlases.set(key, atlas);
  return atlas;
}

/**
 * A Lambert material: atlas colour through the model's UVs, times a pattern
 * sampled triplanar in world space.
 *
 * Instancing is handled explicitly: three.js applies instanceMatrix during
 * projection, so a world position taken before that would put every instance
 * of a model on the same patch of texture.
 */
export function makeRetroMaterial(
  rule: RetroRule,
  kit: string,
  kitAtlas: THREE.Texture | null,
): THREE.MeshLambertMaterial {
  const texels = rule.texelsPerUnit ?? 20;
  // Provisional until the image arrives; these textures are all 64 wide.
  const scale = new THREE.Vector2(texels / 64, texels / 64);
  const mean = { value: 0.5 };

  const pattern = texture(rule.texture, ({ image, mean: measured }) => {
    const { width, height } = image as { width: number; height: number };
    // Deriving both axes from the real pixel size keeps texels square in world
    // space, so the 64x128 wall textures are not squashed to whatever aspect
    // the surface they land on happens to have.
    if (width && height) scale.set(texels / width, texels / height);
    mean.value = measured;
  });

  const material = new THREE.MeshLambertMaterial({
    map: rule.atlas && kitAtlas ? repaintedAtlas(kit, rule.atlas, kitAtlas) : null,
    color: new THREE.Color(rule.tint ?? 0xffffff),
    flatShading: true,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.mdPattern = { value: pattern };
    shader.uniforms.mdScale = { value: scale };
    shader.uniforms.mdMean = mean;
    shader.uniforms.mdDetail = { value: rule.detail ?? 0.6 };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 mdWorldPos;
        varying vec3 mdWorldNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 mdPos = vec4( transformed, 1.0 );
        vec3 mdNrm = objectNormal;
        #ifdef USE_INSTANCING
          mdPos = instanceMatrix * mdPos;
          mdNrm = mat3( instanceMatrix ) * mdNrm;
        #endif
        mdWorldPos = ( modelMatrix * mdPos ).xyz;
        mdWorldNormal = normalize( mat3( modelMatrix ) * mdNrm );`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D mdPattern;
        uniform vec2 mdScale;
        uniform float mdMean;
        uniform float mdDetail;
        varying vec3 mdWorldPos;
        varying vec3 mdWorldNormal;`,
      )
      // Replaces the stock map lookup: the atlas alpha is a detail weight here,
      // not opacity, and must never reach the (transparent) canvas.
      //
      // The two side projections put world Y on the texture's v axis, while the
      // top-down projection is horizontal on both axes and so uses the u scale
      // twice — otherwise a non-square texture would stretch on flat surfaces.
      .replace(
        '#include <map_fragment>',
        `vec3 mdBlend = abs( normalize( mdWorldNormal ) );
        mdBlend /= max( mdBlend.x + mdBlend.y + mdBlend.z, 0.0001 );
        vec3 mdTexel =
            texture2D( mdPattern, vec2( mdWorldPos.z * mdScale.x, mdWorldPos.y * mdScale.y ) ).rgb * mdBlend.x
          + texture2D( mdPattern, mdWorldPos.xz * mdScale.x ).rgb * mdBlend.y
          + texture2D( mdPattern, vec2( mdWorldPos.x * mdScale.x, mdWorldPos.y * mdScale.y ) ).rgb * mdBlend.z;
        float mdWeight = mdDetail;
        #ifdef USE_MAP
          vec4 mdAtlas = texture2D( map, vMapUv );
          diffuseColor.rgb *= mdAtlas.rgb;
          mdWeight *= mdAtlas.a;
        #endif
        diffuseColor.rgb *= mix( 1.0, dot( mdTexel, ${LUMINANCE} ) / mdMean, mdWeight );`,
      );
  };

  // Materials with different onBeforeCompile bodies must not share a program.
  material.customProgramCacheKey = () => 'retro-detail';
  return material;
}
