# RotVault API

Servidor local independiente para guardar, editar y borrar audios, portadas,
vídeos de stock y guiones de RotVault. Esta carpeta tiene su propio `package.json` y se puede
mover a otro repositorio.

## Iniciar

```bash
npm install
npm run dev
```

Escucha en `http://127.0.0.1:3001`. El frontend se ejecuta por separado en
`http://127.0.0.1:3000`.

Para usar **Descargas**, instala `yt-dlp`, `ffmpeg` y `ffprobe` en la máquina de
esta API. `YTDLP_PATH` y `FFMPEG_PATH` permiten indicar ejecutables fuera de
`PATH`. La API inicia los procesos con argumentos separados, sin consola de
comandos del navegador. `API_HOST` cambia la interfaz de escucha (por defecto
`127.0.0.1`); para una red privada, consulta las instrucciones del README
principal y configura también `FRONTEND_ORIGIN` y `VITE_API_URL`.
Las tareas se persisten en `DATA_DIR/download-jobs.json` (o en
`public/assets/data/download-jobs.json`). Al reiniciar, las tareas a medias
quedan marcadas como interrumpidas y se pueden reintentar desde la interfaz.
La calidad admite `best`, `1080`, `720` y `480`; los Shorts verticales usan el
ancho como límite. Si falta un MP4 compatible, la API intenta otro formato y
lo convierte a H.264/AAC con `ffmpeg`.
El límite por archivo se puede ajustar desde **Descargas** entre 1 y 10 GB
(predeterminado: 10 GB). Si `yt-dlp` deja pistas de vídeo y audio separadas,
la API intenta fusionarlas con `ffmpeg` antes de guardar el vídeo.

Para usar el asistente de Guiones, configura `OPENAI_API_KEY` **antes de arrancar
la API y en la misma ventana de PowerShell**:

```powershell
cd 'C:\ruta\a\rotvault\api'
$env:OPENAI_API_KEY = 'tu-clave-privada'
$env:OPENAI_API_KEY.Length  # Debe ser mayor que cero; no imprime la clave.
pnpm dev
```

También puedes crear `api/.env` (está ignorado por Git) con una línea
`OPENAI_API_KEY=tu-clave-privada` y arrancar con `pnpm dev`. La API lee ese
archivo automáticamente; si la variable ya existe en el proceso, tiene
prioridad. Si cambias la variable o el archivo después de arrancar, detén y
reinicia la API. `$env:OPENAI_API_KEY = ''` deja la clave vacía.

La clave nunca se envía al frontend. `POST /api/scripts/:id/chat` usa la SDK
oficial de OpenAI y emite eventos NDJSON `delta`, `done` o `error`. La API
conserva en `scripts.json` el historial, el uso de tokens y el coste aproximado
de cada respuesta. El coste depende de las tarifas vigentes y puede diferir
de la factura final.

## Pruebas

```bash
pnpm install
pnpm test
```

Las pruebas usan directorios temporales y comprueban el alta, consulta, edición y
borrado de guiones, vídeos y audios con portada. También comprueban que un fallo
al actualizar el catálogo conserva el WAV y la portada anteriores. GitHub Actions las ejecuta
en cada push y pull request.

`PUT /api/sounds/:id` reemplaza el WAV y, si se envía `coverBase64`, la portada
del sonido existente. Conserva el ID, el nombre del archivo, la fecha de alta,
el favorito y el contador de reproducciones. El cuerpo usa el mismo formato
que `POST /api/sounds`: `sound`, `audioBase64` y `coverBase64` opcional.

Por defecto, `AUDIO_DIR` apunta a `../public/assets/audio` cuando esta carpeta
está dentro del proyecto frontend. Si mueves la API a otro repositorio, define
`AUDIO_DIR` con la ruta absoluta de la carpeta que contiene `manifest.json` y
los WAV. Las carpetas `images`, `videos` y `data` se crean junto a `audio`.
También puedes configurar `IMAGES_DIR`, `VIDEOS_DIR` y `DATA_DIR` de forma
independiente. En PowerShell, por ejemplo:

```powershell
$env:AUDIO_DIR = 'C:\ruta\a\rotvault\public\assets\audio'
npm run dev
```

Los archivos anteriores que todavía tenían una portada incrustada en
`manifest.json` se pueden mover a `images` con `node migrate-covers.js`.

También puedes configurar `PORT` y `FRONTEND_ORIGIN` mediante variables de
entorno. Por defecto se aceptan páginas abiertas en `localhost` o `127.0.0.1`
en cualquier puerto. La API solo escucha en `127.0.0.1`.
