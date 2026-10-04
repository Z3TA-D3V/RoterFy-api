import { writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_TOOL === 'ffmpeg') {
  writeFileSync(path.resolve(args.at(-1)), Buffer.from('converted-video'));
} else if (args.includes('--dump-single-json')) {
  process.stdout.write(JSON.stringify({ title: 'Vídeo de prueba', duration: 95, id: 'abcdefghijk',
    width: process.env.FAKE_PORTRAIT === '1' ? 1080 : 1920,
    height: process.env.FAKE_PORTRAIT === '1' ? 1920 : 1080 }));
} else {
  if (process.env.FAKE_FORMAT_FAIL === '1' && args.join(' ').includes('vcodec^=avc')) {
    process.stderr.write('ERROR: Requested format is not available\n');
    process.exitCode = 1;
  } else {
  const output = args[args.indexOf('-o') + 1];
  const ext = args.includes('-x') ? 'wav' : args.includes('mkv') ? 'mkv' : 'mp4';
  const file = output.replace('%(ext)s', ext);
  if (process.env.FAKE_YTDLP_WAIT === '1') {
    process.stderr.write('download:10%\n');
    setInterval(() => {}, 1000);
  } else if (process.env.FAKE_UNMERGED === '1' && ext === 'mp4') {
    const prefix = output.replace('.%(ext)s', '');
    writeFileSync(path.resolve(`${prefix}.f137.mp4`), Buffer.from('video-only'));
    writeFileSync(path.resolve(`${prefix}.f140.m4a`), Buffer.from('audio-only'));
    process.stderr.write('download:100%\n');
  } else {
    writeFileSync(path.resolve(file), ext === 'wav' ? Buffer.from('RIFFxxxxWAVEfake') : Buffer.from('video'));
    process.stderr.write('download:50%\n');
    process.stderr.write('download:100%\n');
  }
  }
}
