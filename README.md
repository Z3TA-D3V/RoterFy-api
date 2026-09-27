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

## Pruebas

```bash
pnpm install
pnpm test
```

Las pruebas usan directorios temporales y comprueban el alta, consulta y
borrado de guiones, vídeos y audios con portada. GitHub Actions las ejecuta
en cada push y pull request.

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
