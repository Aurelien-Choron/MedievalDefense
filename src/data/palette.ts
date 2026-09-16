/**
 * Colour overrides applied to Kenney materials at load time.
 *
 * Measured from the extracted kits (tools/build-manifest.mjs + material dump):
 *
 *   nature  329 models, 0 textures, 23 named materials  -> recolour by name
 *   castle   76 models, one "colormap" texture          -> retexture by name
 *   town    167 models, "colormap" + "Water"            -> retexture by name
 *   retro   105 models, 10 named textured materials     -> retexture by name
 *
 * That is the whole reason this table is keyed on material name rather than on
 * the texture: a 23-entry map repaints all 329 Nature Kit models, and a single
 * entry repaints the entire Castle Kit.
 *
 * The Nature Kit ships a deliberately stylised palette — turquoise foliage,
 * salmon bark, pale cyan stone (confirmed against Kenney's own preview
 * renders). Candy colours are not a medieval look, but muddy earth tones are
 * not a game look either: the kit is remapped onto bright, saturated natural
 * colours that match the terrain's. Pass ?raw=1 to see Kenney's original.
 */

/** Material name -> sRGB hex. Applies to untextured (Nature Kit) materials. */
export const NATURE_PALETTE: Readonly<Record<string, number>> = {
  // foliage: turquoise -> sunny green, matching terrain grass
  grass: 0x7fb34f,
  leafsGreen: 0x64ad4a,
  leafsDark: 0x3c8a40,
  leafsFall: 0xeea03c,

  // soil: salmon -> warm brown
  dirt: 0xc9955a,
  dirtDark: 0x9a6b3e,

  // rock: pale cyan -> light warm grey
  stone: 0xc6c0b5,
  stoneDark: 0x958e84,

  // timber: orange -> honey oak
  wood: 0xcf9152,
  woodDark: 0x9c683a,
  woodBark: 0x8f5d37,
  woodBarkDark: 0x6c4529,
  woodBirch: 0xf2e9d4,
  woodInner: 0xe8c38c,

  water: 0x4cc3e0,

  // cloth and flowers: Kenney's washed-out pink -> heraldic red and gold
  colorRed: 0xd9493a,
  colorRedDark: 0xa8362c,
  colorYellow: 0xf5c542,
};

/**
 * Per-piece recolours for Nature Kit models, chosen by PlacedPiece.skin.
 * The kit names its materials after colours rather than roles, so the same
 * "stone" that greys a boulder also paints a bridge deck.
 */
export const NATURE_SKINS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'bridge-planks': { stone: 0xc39a64 },
};

/** Which kits carry no textures and are therefore recoloured, not retextured. */
export const UNTEXTURED_KITS = new Set(['nature']);

/**
 * Retro texture pack file to use for a given kit material, relative to
 * assets/kenney/retro-textures/. Populated during P1; an entry that is absent
 * simply leaves Kenney's own colormap in place.
 */
export const RETRO_TEXTURES: Readonly<Record<string, string>> = {
  // retro kit materials already sit in this visual family, so they map one-to-one
  'retro:bricks': 'wall_brick_stone_center.png',
  'retro:stones': 'wall_stone.png',
  'retro:planks': 'floor_wood_planks.png',
  'retro:roof': 'roof_clay_red_center.png',
};
