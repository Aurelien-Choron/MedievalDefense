// Minimal GLB reader: just enough to measure a model's world-space bounding box
// without pulling three.js into node. Every accessor already carries min/max, so
// we never have to decode the vertex buffer — we only walk the node hierarchy
// and transform the eight corners of each primitive's local box.
import fs from 'node:fs';

const JSON_CHUNK = 0x4e4f534a;

/** Reads the JSON chunk of a .glb file. */
export function readGltf(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`not a GLB: ${file}`);

  let offset = 12; // past the 12-byte header
  while (offset < buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    if (type === JSON_CHUNK)
      return JSON.parse(buf.subarray(offset + 8, offset + 8 + length).toString('utf8'));
    offset += 8 + length + ((4 - (length % 4)) % 4);
  }
  throw new Error(`no JSON chunk in ${file}`);
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4x4 multiply, matching the glTF convention. */
function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

/** Builds a node's local matrix from either `matrix` or its TRS components. */
function localMatrix(node) {
  if (node.matrix) return node.matrix;

  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];

  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function transformPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * World-space bounds of a GLB.
 * @returns {{min: number[], max: number[], size: number[], meshes: number}}
 */
export function bounds(file) {
  const gltf = readGltf(file);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let meshes = 0;

  const visit = (nodeIndex, parent) => {
    const node = gltf.nodes[nodeIndex];
    const world = multiply(parent, localMatrix(node));

    if (node.mesh !== undefined) {
      for (const primitive of gltf.meshes[node.mesh].primitives ?? []) {
        const accessor = gltf.accessors?.[primitive.attributes?.POSITION];
        if (!accessor?.min || !accessor?.max) continue;
        meshes++;
        // Transform all 8 corners: a rotated box's AABB is not the transformed AABB.
        for (let corner = 0; corner < 8; corner++) {
          const local = [
            corner & 1 ? accessor.max[0] : accessor.min[0],
            corner & 2 ? accessor.max[1] : accessor.min[1],
            corner & 4 ? accessor.max[2] : accessor.min[2],
          ];
          const p = transformPoint(world, local);
          for (let i = 0; i < 3; i++) {
            if (p[i] < min[i]) min[i] = p[i];
            if (p[i] > max[i]) max[i] = p[i];
          }
        }
      }
    }

    for (const child of node.children ?? []) visit(child, world);
  };

  const scene = gltf.scenes?.[gltf.scene ?? 0];
  for (const nodeIndex of scene?.nodes ?? []) visit(nodeIndex, IDENTITY);

  if (!meshes) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], meshes: 0 };
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], meshes };
}
