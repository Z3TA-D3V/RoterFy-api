import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const audioDir = path.resolve(process.env.AUDIO_DIR || path.join(root, '..', 'public', 'assets', 'audio'));
const imagesDir = path.resolve(process.env.IMAGES_DIR || path.join(path.dirname(audioDir), 'images'));
const manifestPath = path.join(audioDir, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
await fs.mkdir(imagesDir, { recursive: true });
let migrated = 0;
for (const sound of manifest) {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(sound.coverImage || '');
  if (!match || !/^[a-zA-Z0-9_-]+$/.test(sound.id)) continue;
  const file = `${sound.id}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
  try { await fs.writeFile(path.join(imagesDir, file), Buffer.from(match[2], 'base64'), { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  sound.coverImage = `/assets/images/${file}`;
  migrated++;
}
if (migrated) {
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rename(temporaryPath, manifestPath);
}
console.log(`${migrated} portadas migradas a ${imagesDir}`);
