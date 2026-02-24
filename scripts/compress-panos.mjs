// Compress panorama images in-place without quality loss
// Uses mozjpeg for superior compression with perceptually lossless quality
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const ROOT = process.cwd();
const EXPERIENCES = path.join(ROOT, 'public', 'experiences');
const WALKTHROUGH = 'walkthrough.json';

// High-quality compression settings (perceptually lossless)
const JPEG_QUALITY = 90; // mozjpeg at 90 is visually identical to 95+ but much smaller
const WEBP_QUALITY = 92; // WebP is more efficient than JPEG

async function* walk(dir) {
  try {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) yield* walk(p);
      else yield p;
    }
  } catch (e) {
    console.warn(`[compress] cannot read directory: ${dir}`, e.message);
  }
}

function isPanoFile(file) {
  // Only process files in 'panos' folder (not panos-mobile*)
  return /[\\/]panos[\\/].+\.(?:webp|jpg|jpeg|png)$/i.test(file) &&
         !/panos-mobile/i.test(file);
}

async function fileExists(p) {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

function coerceWalkthroughCandidate(raw) {
  return (raw && (raw.data || raw.project)) || raw || {};
}

async function updateWalkthroughForExperience(expDir) {
  const walkthroughPath = path.join(expDir, WALKTHROUGH);
  if (!(await fileExists(walkthroughPath))) return { updated: false };

  let raw;
  try {
    raw = JSON.parse(await fs.promises.readFile(walkthroughPath, 'utf8'));
  } catch {
    console.warn(`[compress] skip invalid JSON: ${path.relative(ROOT, walkthroughPath)}`);
    return { updated: false };
  }

  const candidate = coerceWalkthroughCandidate(raw);
  const nodes = Array.isArray(candidate.nodes) ? candidate.nodes : null;
  if (!nodes) return { updated: false };

  const panosDir = path.join(expDir, 'panos');
  let changed = false;
  for (const node of nodes) {
    const file = typeof node?.file === 'string' ? node.file : '';
    if (!/\.png$/i.test(file)) continue;
    const jpg = file.replace(/\.png$/i, '.jpg');
    if (await fileExists(path.join(panosDir, jpg))) {
      node.file = jpg;
      changed = true;
    }
  }

  if (!changed) return { updated: false };
  await fs.promises.writeFile(walkthroughPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  console.log(`[compress] updated ${path.relative(ROOT, walkthroughPath)} (png->jpg refs)`);
  return { updated: true };
}

async function updateAllWalkthroughs() {
  try {
    const entries = await fs.promises.readdir(EXPERIENCES, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      await updateWalkthroughForExperience(path.join(EXPERIENCES, e.name));
    }
  } catch (e) {
    console.warn('[compress] cannot update walkthrough refs:', e?.message || e);
  }
}

async function compressImage(srcPath) {
  try {
    const ext = path.extname(srcPath).toLowerCase();
    const tmpPath = srcPath + '.tmp';

    // Get original file size
    const originalStat = await fs.promises.stat(srcPath);
    const originalSize = originalStat.size;

    // Load and get metadata
    const image = sharp(srcPath);
    const metadata = await image.metadata();

    console.log(`\n[compress] Processing: ${path.basename(srcPath)}`);
    console.log(`  Original: ${(originalSize / 1024 / 1024).toFixed(2)} MB (${metadata.width}x${metadata.height})`);

    // Compress based on format
    if (ext === '.webp') {
      await image
        .webp({
          quality: WEBP_QUALITY,
          effort: 6, // Max compression effort (0-6)
          nearLossless: true, // Perceptually lossless
          smartSubsample: true // Better color compression
        })
        .toFile(tmpPath);
    } else {
      // JPEG or PNG -> convert to optimized JPEG
      const outputPath = ext === '.png' ? srcPath.replace(/\.png$/i, '.jpg') : tmpPath;
      await image
        .jpeg({
          quality: JPEG_QUALITY,
          mozjpeg: true, // Use mozjpeg for superior compression
          progressive: true, // Progressive loading
          chromaSubsampling: '4:2:0', // Standard subsampling
          optimizeScans: true // Optimize scan order
        })
        .toFile(outputPath);

      // If PNG was converted to JPG, use the new path
      if (ext === '.png') {
        try { await fs.promises.unlink(srcPath); } catch {}
        const newStat = await fs.promises.stat(outputPath);
        const newSize = newStat.size;
        const savings = ((1 - newSize / originalSize) * 100).toFixed(1);
        console.log(`  Compressed: ${(newSize / 1024 / 1024).toFixed(2)} MB (${savings}% smaller) [PNG→JPG]`);
        return newSize < originalSize;
      }
    }

    // Check if compressed version is smaller
    const compressedStat = await fs.promises.stat(tmpPath);
    const compressedSize = compressedStat.size;

    if (compressedSize < originalSize) {
      // Replace original with compressed version
      await fs.promises.unlink(srcPath);
      await fs.promises.rename(tmpPath, srcPath);
      const savings = ((1 - compressedSize / originalSize) * 100).toFixed(1);
      console.log(`  Compressed: ${(compressedSize / 1024 / 1024).toFixed(2)} MB (${savings}% smaller)`);
      return true;
    } else {
      // Keep original (it's already well compressed)
      await fs.promises.unlink(tmpPath);
      console.log(`  Kept original (already optimized)`);
      return false;
    }
  } catch (e) {
    console.error(`[compress] Failed: ${srcPath}`, e.message);
    // Clean up temp file if it exists
    try { await fs.promises.unlink(srcPath + '.tmp'); } catch {}
    return false;
  }
}

(async () => {
  console.log('[compress] Starting panorama compression...\n');

  let totalFiles = 0;
  let compressedFiles = 0;
  let originalTotalSize = 0;
  let compressedTotalSize = 0;

  for await (const file of walk(EXPERIENCES)) {
    if (!isPanoFile(file)) continue;

    totalFiles++;
    const originalStat = await fs.promises.stat(file);
    originalTotalSize += originalStat.size;

    const compressed = await compressImage(file);

    if (compressed) {
      compressedFiles++;
      const newStat = await fs.promises.stat(file.replace(/\.png$/i, '.jpg')); // Handle PNG->JPG conversion
      compressedTotalSize += newStat.size;
    } else {
      compressedTotalSize += originalStat.size;
    }
  }

  // After PNG->JPG conversions, ensure walkthrough.json points to the new files.
  await updateAllWalkthroughs();

  console.log('\n' + '='.repeat(60));
  console.log('[compress] Summary:');
  console.log(`  Files processed: ${totalFiles}`);
  console.log(`  Files compressed: ${compressedFiles}`);
  console.log(`  Original total: ${(originalTotalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Compressed total: ${(compressedTotalSize / 1024 / 1024).toFixed(2)} MB`);
  const totalSavings = ((1 - compressedTotalSize / originalTotalSize) * 100).toFixed(1);
  console.log(`  Total savings: ${((originalTotalSize - compressedTotalSize) / 1024 / 1024).toFixed(2)} MB (${totalSavings}%)`);
  console.log('='.repeat(60));
})().catch((e) => {
  console.error('[compress] Fatal error:', e);
  process.exit(1);
});
