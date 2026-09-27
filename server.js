import express from 'express';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const audioDir = path.resolve(process.env.AUDIO_DIR || path.join(root, '..', 'public', 'assets', 'audio'));
const manifestPath = path.join(audioDir, 'manifest.json');
const assetsDir = path.dirname(audioDir);
const imagesDir = path.resolve(process.env.IMAGES_DIR || path.join(assetsDir, 'images'));
const videosDir = path.resolve(process.env.VIDEOS_DIR || path.join(assetsDir, 'videos'));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(assetsDir, 'data'));
const scriptsPath = path.join(dataDir, 'scripts.json');
const videosPath = path.join(dataDir, 'stock-videos.json');
const app = express();
const port = Number(process.env.PORT || 3001);
const frontendOrigins = process.env.FRONTEND_ORIGIN?.split(',').map((origin) => origin.trim());
let pendingMutation = Promise.resolve();

function serializeMutation(work) {
  const result = pendingMutation.then(work);
  pendingMutation = result.catch(() => {});
  return result;
}

app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    let allowed = frontendOrigins?.includes(origin);
    if (!frontendOrigins) {
      try {
        const url = new URL(origin);
        allowed = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
      } catch { allowed = false; }
    }
    if (!allowed) return res.status(403).json({ error: 'Origen no autorizado' });
  }
  if (origin) res.set('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  next();
});
app.use('/api', express.json({ limit: '100mb' }));

async function readManifest() {
  const contents = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(contents);
  if (!Array.isArray(manifest)) throw new Error('Catálogo de audio no válido');
  return manifest;
}

async function writeManifest(manifest) {
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rename(temporaryPath, manifestPath);
}

async function readList(file) {
  const items = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(items)) throw new Error('Catálogo de datos no válido');
  return items;
}

async function writeList(file, items) {
  const temporaryPath = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(items, null, 2)}\n`);
  await fs.rename(temporaryPath, file);
}

function dataRoutes(name, file, requiredFields) {
  app.get(`/api/${name}`, async (_req, res, next) => {
    try { res.set('Cache-Control', 'no-store').json(await readList(file)); }
    catch (error) { next(error); }
  });
  app.post(`/api/${name}`, async (req, res, next) => {
    try {
      const item = req.body;
      if (!item || !validId(item.id) || requiredFields.some((key) => typeof item[key] !== 'string')) {
        return res.status(400).json({ error: 'Datos no válidos' });
      }
      const saved = await serializeMutation(async () => {
        const items = await readList(file);
        const previous = items.find((entry) => entry.id === item.id);
        const record = name === 'stock-videos' && previous?.localPath
          ? { ...item, localPath: previous.localPath }
          : item;
        await writeList(file, [record, ...items.filter((entry) => entry.id !== item.id)]);
        return record;
      });
      res.json(saved);
    } catch (error) { next(error); }
  });
  app.delete(`/api/${name}/:id`, async (req, res, next) => {
    try {
      const deleted = await serializeMutation(async () => {
        const items = await readList(file);
        const item = items.find((entry) => entry.id === req.params.id);
        if (!item) return null;
        await writeList(file, items.filter((entry) => entry.id !== req.params.id));
        return item;
      });
      if (!deleted) return res.status(404).json({ error: 'Elemento no encontrado' });
      if (name === 'stock-videos' && deleted.localPath?.startsWith('/assets/videos/')) {
        const basename = path.basename(deleted.localPath);
        if (basename.startsWith(`${deleted.id}.`)) await fs.unlink(path.join(videosDir, basename)).catch(() => {});
      }
      res.status(204).end();
    } catch (error) { next(error); }
  });
}

dataRoutes('scripts', scriptsPath, ['title', 'content', 'category', 'status']);
dataRoutes('stock-videos', videosPath, ['title', 'category', 'format', 'durationText', 'notes']);

app.put('/api/stock-videos/:id/file', async (req, res, next) => {
  const id = req.params.id;
  const mime = req.get('content-type')?.split(';')[0];
  const extension = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }[mime];
  if (!validId(id) || !extension) return res.status(400).json({ error: 'Se espera un MP4, WebM o MOV' });
  const temporaryPath = path.join(videosDir, `${id}.${process.pid}.upload`);
  try {
    let bytes = 0;
    await pipeline(req, new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024 * 1024) {
          const error = new Error('El vídeo supera 1 GB');
          error.status = 413;
          callback(error);
        } else callback(null, chunk);
      },
    }), createWriteStream(temporaryPath, { flags: 'wx' }));
    if (!bytes) throw new Error('Vídeo vacío');
    const record = await serializeMutation(async () => {
      const items = await readList(videosPath);
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) { const error = new Error('Vídeo no encontrado'); error.status = 404; throw error; }
      const filename = `${id}.${extension}`;
      const finalPath = path.join(videosDir, filename);
      await fs.rename(temporaryPath, finalPath);
      const previous = items[index].localPath;
      items[index] = { ...items[index], localPath: `/assets/videos/${filename}` };
      await writeList(videosPath, items);
      if (previous?.startsWith(`/assets/videos/${id}.`) && previous !== items[index].localPath) {
        await fs.unlink(path.join(videosDir, path.basename(previous))).catch(() => {});
      }
      return items[index];
    });
    res.json(record);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    next(error);
  }
});

function publicSound(sound, file) {
  const { audioBlob, audioBlobUrl, sourceType, ...metadata } = sound;
  return { ...metadata, file };
}

function validId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}

function invalidSound(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function parseSoundUpload(body, expectedId) {
  const { sound, audioBase64, coverBase64 } = body || {};
  if (!sound || !validId(sound.id) || (expectedId && sound.id !== expectedId) ||
      typeof sound.title !== 'string' || typeof audioBase64 !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64)) {
    invalidSound('Audio o datos no válidos');
  }
  const audio = Buffer.from(audioBase64, 'base64');
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' ||
      audio.toString('ascii', 8, 12) !== 'WAVE') invalidSound('Se esperaba un archivo WAV');

  let cover = null;
  if (coverBase64 !== undefined) {
    const match = typeof coverBase64 === 'string'
      ? coverBase64.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/)
      : null;
    if (!match) invalidSound('Portada no válida');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 10 * 1024 * 1024 || bytes.length < 8) invalidSound('Portada demasiado grande o vacía');
    cover = { bytes, extension: match[1] === 'jpeg' ? 'jpg' : match[1] };
  }
  return { sound, audio, cover };
}

app.get('/api/sounds', async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').json(await readManifest());
  } catch (error) { next(error); }
});

app.post('/api/sounds', async (req, res, next) => {
  try {
    const { sound, audio, cover } = parseSoundUpload(req.body);
    const record = await serializeMutation(async () => {
      const manifest = await readManifest();
      if (manifest.some((item) => item.id === sound.id)) {
        const error = new Error('Ya existe un audio con ese ID');
        error.status = 409;
        throw error;
      }
      const file = `${sound.id}.wav`;
      const audioPath = path.join(audioDir, file);
      await fs.writeFile(audioPath, audio, { flag: 'wx' });
      const coverPath = cover ? path.join(imagesDir, `${sound.id}.${cover.extension}`) : null;
      try {
        if (coverPath) await fs.writeFile(coverPath, cover.bytes, { flag: 'wx' });
        const saved = publicSound(sound, file);
        if (coverPath) saved.coverImage = `/assets/images/${path.basename(coverPath)}`;
        await writeManifest([saved, ...manifest]);
        return saved;
      } catch (error) {
        await fs.unlink(audioPath);
        if (coverPath) await fs.unlink(coverPath).catch(() => {});
        throw error;
      }
    });
    res.status(201).json(record);
  } catch (error) { next(error); }
});

app.put('/api/sounds/:id', async (req, res, next) => {
  try {
    const { sound, audio, cover } = parseSoundUpload(req.body, req.params.id);
    const updated = await serializeMutation(async () => {
      const manifest = await readManifest();
      const index = manifest.findIndex((item) => item.id === req.params.id);
      if (index < 0) return null;
      const previous = manifest[index];
      if (!/^[a-zA-Z0-9_-]+\.wav$/.test(previous.file)) invalidSound('Archivo de audio no válido');

      const incoming = publicSound(sound, previous.file);
      if (incoming.coverImage === undefined) delete incoming.coverImage;
      const record = { ...previous, ...incoming, id: previous.id, file: previous.file,
        addedAt: previous.addedAt, favorite: previous.favorite, playCount: previous.playCount };
      if (cover) record.coverImage = `/assets/images/${previous.id}.${cover.extension}`;

      const audioPath = path.join(audioDir, previous.file);
      const oldCoverPath = previous.coverImage?.startsWith(`/assets/images/${previous.id}.`)
        ? path.join(imagesDir, path.basename(previous.coverImage)) : null;
      const replaceOldCover = oldCoverPath && (cover || record.coverImage !== previous.coverImage);
      const newCoverPath = cover ? path.join(imagesDir, `${previous.id}.${cover.extension}`) : null;
      if (newCoverPath && newCoverPath !== oldCoverPath) {
        try {
          await fs.access(newCoverPath);
          const error = new Error('Ya existe una portada con ese nombre');
          error.status = 409;
          throw error;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const token = randomUUID();
      const audioTemp = `${audioPath}.${token}.upload`;
      const audioBackup = `${audioPath}.${token}.backup`;
      const coverTemp = newCoverPath ? `${newCoverPath}.${token}.upload` : null;
      const coverBackup = replaceOldCover ? `${oldCoverPath}.${token}.backup` : null;
      let audioBackedUp = false;
      let coverBackedUp = false;
      let audioInstalled = false;
      let coverInstalled = false;
      try {
        await fs.writeFile(audioTemp, audio, { flag: 'wx' });
        if (coverTemp) await fs.writeFile(coverTemp, cover.bytes, { flag: 'wx' });
        await fs.rename(audioPath, audioBackup);
        audioBackedUp = true;
        if (coverBackup) {
          await fs.rename(oldCoverPath, coverBackup);
          coverBackedUp = true;
        }
        await fs.rename(audioTemp, audioPath);
        audioInstalled = true;
        if (coverTemp) {
          await fs.rename(coverTemp, newCoverPath);
          coverInstalled = true;
        }
        manifest[index] = record;
        await writeManifest(manifest);
      } catch (error) {
        if (audioInstalled) await fs.unlink(audioPath).catch(() => {});
        if (coverInstalled) await fs.unlink(newCoverPath).catch(() => {});
        if (audioBackedUp) await fs.rename(audioBackup, audioPath);
        if (coverBackedUp) await fs.rename(coverBackup, oldCoverPath);
        throw error;
      } finally {
        await fs.unlink(audioTemp).catch(() => {});
        if (coverTemp) await fs.unlink(coverTemp).catch(() => {});
      }
      await fs.unlink(audioBackup).catch(() => {});
      if (coverBackup) await fs.unlink(coverBackup).catch(() => {});
      return record;
    });
    if (!updated) return res.status(404).json({ error: 'Audio no encontrado' });
    res.json(updated);
  } catch (error) { next(error); }
});

app.patch('/api/sounds/:id', async (req, res, next) => {
  try {
    const updated = await serializeMutation(async () => {
      const manifest = await readManifest();
      const index = manifest.findIndex((item) => item.id === req.params.id);
      if (index < 0) return null;
      const { id, file } = manifest[index];
      manifest[index] = { ...manifest[index], ...publicSound(req.body || {}, file), id, file };
      await writeManifest(manifest);
      return manifest[index];
    });
    if (!updated) return res.status(404).json({ error: 'Audio no encontrado' });
    res.json(updated);
  } catch (error) { next(error); }
});

app.post('/api/sounds/:id/play', async (req, res, next) => {
  try {
    const playCount = await serializeMutation(async () => {
      const manifest = await readManifest();
      const sound = manifest.find((item) => item.id === req.params.id);
      if (!sound) return null;
      sound.playCount = (sound.playCount || 0) + 1;
      await writeManifest(manifest);
      return sound.playCount;
    });
    if (playCount === null) return res.status(404).json({ error: 'Audio no encontrado' });
    res.json({ playCount });
  } catch (error) { next(error); }
});

app.delete('/api/sounds/:id', async (req, res, next) => {
  try {
    const deleted = await serializeMutation(async () => {
      const manifest = await readManifest();
      const sound = manifest.find((item) => item.id === req.params.id);
      if (!sound) return false;
      if (!/^[a-zA-Z0-9_-]+\.wav$/.test(sound.file)) {
        const error = new Error('Archivo de audio no válido');
        error.status = 400;
        throw error;
      }
      const audioPath = path.join(audioDir, sound.file);
      const trashPath = `${audioPath}.${process.pid}.tmp`;
      await fs.rename(audioPath, trashPath);
      try {
        await writeManifest(manifest.filter((item) => item.id !== req.params.id));
      } catch (error) {
        await fs.rename(trashPath, audioPath);
        throw error;
      }
      await fs.unlink(trashPath);
      if (sound.coverImage?.startsWith(`/assets/images/${sound.id}.`)) {
        await fs.unlink(path.join(imagesDir, path.basename(sound.coverImage))).catch(() => {});
      }
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'Audio no encontrado' });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.use('/api/audio', express.static(audioDir, {
  setHeaders(res, file) {
    if (file.endsWith('manifest.json')) res.setHeader('Cache-Control', 'no-store');
  },
}));
app.use('/api/images', express.static(imagesDir));
app.use('/api/videos', express.static(videosDir));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Error al guardar el audio' });
});

await fs.access(manifestPath);
await Promise.all([imagesDir, videosDir, dataDir].map((directory) => fs.mkdir(directory, { recursive: true })));
await Promise.all([scriptsPath, videosPath].map(async (file) => {
  try { await fs.writeFile(file, '[]\n', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}));
app.listen(port, '127.0.0.1', () => console.log(`RotVault API: http://127.0.0.1:${port}`));
