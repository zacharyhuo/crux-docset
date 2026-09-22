import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

export const iconSizes = { 'icon.png': 16, 'icon@2x.png': 32 };
export const maximumIconBytes = 256 * 1024;

export function validateIcon(data, size) {
  // Bound dimensions before allowing the decoder to allocate pixel buffers.
  if (data.length < 33 || data.length > maximumIconBytes ||
      !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR' ||
      data.readUInt32BE(16) !== size || data.readUInt32BE(20) !== size) {
    throw new Error(`icon must be a ${size}x${size} PNG within ${maximumIconBytes} bytes`);
  }
  PNG.sync.read(data, { checkCRC: true });
}

export async function loadRecipeIcons(recipeDirectory) {
  const directory = path.join(recipeDirectory, 'assets');
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('icon assets directory must not be a symlink');
  const icons = {};
  for (const [name, size] of Object.entries(iconSizes)) {
    const file = path.join(directory, name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > maximumIconBytes) throw new Error(`icon must be a bounded regular file: ${name}`);
    const data = await readFile(file);
    validateIcon(data, size);
    icons[name] = data;
  }
  return icons;
}
