import { writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--dump-single-json')) {
  process.stdout.write(JSON.stringify({ title: 'Vídeo de prueba', duration: 95, id: 'abcdefghijk' }));
} else {
  const output = args[args.indexOf('-o') + 1];
  const ext = args.includes('-x') ? 'wav' : 'mp4';
  const file = output.replace('%(ext)s', ext);
  if (process.env.FAKE_YTDLP_WAIT === '1') {
    process.stderr.write('download:10%\n');
    setInterval(() => {}, 1000);
  } else {
    writeFileSync(path.resolve(file), ext === 'wav' ? Buffer.from('RIFFxxxxWAVEfake') : Buffer.from('video'));
    process.stderr.write('download:50%\n');
    process.stderr.write('download:100%\n');
  }
}
