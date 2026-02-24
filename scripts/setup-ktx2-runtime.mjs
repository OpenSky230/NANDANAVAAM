#!/usr/bin/env node
/**
 * Downloads Babylon KTX2 decoder + wasm dependencies into `public/ktx2/`
 * so Quest/Android doesn't have to fetch them from a CDN at runtime.
 */
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public", "ktx2");
const CDN = "https://cdn.babylonjs.com/";

const TRANSCODERS = `${CDN}ktx2Transcoders/1/`;

const ASSETS = {
  "babylon.ktx2Decoder.js": `${CDN}babylon.ktx2Decoder.js`,
  "msc_basis_transcoder.js": `${TRANSCODERS}msc_basis_transcoder.js`,
  "uastc_astc.wasm": `${TRANSCODERS}uastc_astc.wasm`,
  "uastc_bc7.wasm": `${TRANSCODERS}uastc_bc7.wasm`,
  "uastc_rgba8_unorm_v2.wasm": `${TRANSCODERS}uastc_rgba8_unorm_v2.wasm`,
  "uastc_rgba8_srgb_v2.wasm": `${TRANSCODERS}uastc_rgba8_srgb_v2.wasm`,
  "uastc_r8_unorm.wasm": `${TRANSCODERS}uastc_r8_unorm.wasm`,
  "uastc_rg8_unorm.wasm": `${TRANSCODERS}uastc_rg8_unorm.wasm`,
  "msc_basis_transcoder.wasm": `${TRANSCODERS}msc_basis_transcoder.wasm`,
  "zstddec.wasm": `${CDN}zstddec.wasm`,
};

async function download(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  await fs.promises.mkdir(OUT_DIR, { recursive: true });

  let wrote = 0;
  for (const [name, url] of Object.entries(ASSETS)) {
    const dst = path.join(OUT_DIR, name);
    const buf = await download(url);
    await fs.promises.writeFile(dst, buf);
    wrote++;
    console.log(`[ktx2-runtime] wrote ${path.relative(ROOT, dst)} (${(buf.length / 1024).toFixed(1)} KB)`);
  }

  console.log(`[ktx2-runtime] done (${wrote} files)`);
})().catch((e) => {
  console.error("[ktx2-runtime] failed:", e?.message || e);
  process.exit(1);
});
