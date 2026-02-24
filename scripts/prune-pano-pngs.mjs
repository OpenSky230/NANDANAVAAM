#!/usr/bin/env node
/**
 * Remove pano PNGs after JPEG fallbacks have been generated.
 * We only delete files under `public/experiences/<experience>/panos/*.png`.
 * Safety: delete only when a same-name `.jpg` exists alongside.
 *
 * Options:
 * - `--exp "<folder name>"` to target one experience (example: "Varuna & Aditya")
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const EXPERIENCES = path.join(ROOT, 'public', 'experiences');

function parseArgs(argv){
  const out = { exp: null };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '--exp') out.exp = String(argv[++i] ?? '').trim();
  }
  return out;
}

async function* walk(dir) {
  const ents = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function isPanoPng(p) {
  return /[\\/]panos[\\/].+\.png$/i.test(p);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const ROOT_DIR = args.exp ? path.join(EXPERIENCES, args.exp) : EXPERIENCES;
  let total = 0, deleted = 0, skipped = 0, missingJpg = 0;
  for await (const file of walk(ROOT_DIR)) {
    if (!isPanoPng(file)) continue;
    total++;
    const jpg = file.replace(/\.png$/i, '.jpg');
    try {
      await fs.promises.access(jpg, fs.constants.F_OK);
    } catch {
      missingJpg++;
      continue;
    }
    try {
      await fs.promises.unlink(file);
      deleted++;
      process.stdout.write('.');
    } catch {
      skipped++;
    }
  }
  console.log(`\n[prune-pano-pngs] total:${total} deleted:${deleted} skipped:${skipped} missingJpg:${missingJpg}`);
  if (missingJpg > 0) process.exitCode = 2;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
