#!/usr/bin/env node
/**
 * Generate JPEG fallbacks for all pano sources so that non-KTX2 fallback is always `.jpg`.
 * - Scans public/experiences/(*)/panos/(*) .webp/.png
 * - Writes JPG alongside if missing or older than source
 *
 * Options:
 * - `--exp "<folder name>"` to target one experience (example: "Varuna & Aditya")
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const ROOT = process.cwd();
const EXPERIENCES_ROOT = path.join(ROOT, 'public', 'experiences');

function parseArgs(argv){
  const out = { exp: null };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '--exp') out.exp = String(argv[++i] ?? '').trim();
  }
  return out;
}

async function* walk(dir){
  const ents = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of ents){
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function isPanoSource(p){
  return /[\\/]panos[\\/].+\.(?:webp|png)$/i.test(p);
}

async function ensureJpegFor(srcPath){
  const jpgPath = srcPath.replace(/\.(?:webp|png)$/i, '.jpg');
  try{
    const [srcStat, dstStat] = await Promise.allSettled([
      fs.promises.stat(srcPath),
      fs.promises.stat(jpgPath),
    ]);
    if (dstStat.status === 'fulfilled'){
      if (srcStat.status === 'fulfilled' && +srcStat.value.mtime <= +dstStat.value.mtime){
        return { skipped:true, jpgPath };
      }
    }
  }catch{}

  await fs.promises.mkdir(path.dirname(jpgPath), { recursive: true });
  await sharp(srcPath)
    .flatten({ background: '#000' })
    .jpeg({ quality: 88, progressive: true, mozjpeg: true })
    .toFile(jpgPath);
  return { created:true, jpgPath };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const GLOB_ROOT = args.exp ? path.join(EXPERIENCES_ROOT, args.exp) : EXPERIENCES_ROOT;
  let total=0, created=0, skipped=0;
  for await (const file of walk(GLOB_ROOT)){
    if (!isPanoSource(file)) continue;
    total++;
    try{
      const res = await ensureJpegFor(file);
      if (res.created) created++; else skipped++;
      process.stdout.write('.');
    }catch(err){
      console.error('\n[make-jpeg-fallbacks] failed for', file, err.message);
    }
  }
  console.log(`\n[jpeg-fallbacks] total:${total} created:${created} skipped:${skipped}`);
})().catch((e)=>{ console.error(e); process.exit(1); });
