/**
 * Texture as detail, not as colour.
 *
 * The retro pack's textures are dark and desaturated — navy water, grey brick.
 * Multiplied straight in, they sink any bright game palette. Used as detail,
 * a surface takes its colour from a tint (or a vertex colour), and the texture
 * only modulates its brightness around 1.0: the pattern survives, its colour
 * does not.
 *
 * For the modulation to average out to exactly 1, each texture is divided by
 * its own mean luminance, measured once from the image. The tint is then the
 * colour the player actually sees, which is what makes a palette tunable.
 */

/** GLSL luminance weights, in the same (linear) space as meanLuminance. */
export const LUMINANCE = 'vec3( 0.2126, 0.7152, 0.0722 )';

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

/**
 * Mean linear luminance of a loaded image. Textures are tagged sRGB, so the GPU
 * hands the shader linear values; averaging in linear space keeps the two
 * agreeing.
 */
export function meanLuminance(image: unknown): number {
  const source = image as CanvasImageSource & { width: number; height: number };
  const { width, height } = source;
  const context = width && height ? document.createElement('canvas').getContext('2d') : null;
  if (!context) return 0.5;

  context.canvas.width = width;
  context.canvas.height = height;
  context.drawImage(source, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;

  let sum = 0;
  for (let i = 0; i < data.length; i += 4)
    sum +=
      0.2126 * srgbToLinear(data[i]! / 255) +
      0.7152 * srgbToLinear(data[i + 1]! / 255) +
      0.0722 * srgbToLinear(data[i + 2]! / 255);
  return Math.max(sum / (width * height), 1e-3);
}
