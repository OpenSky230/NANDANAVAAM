import { test, expect } from '@playwright/test';

test('Fullscreen toggles on and off', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#renderCanvas')).toBeVisible();

  // Make fullscreen button clickable in tests (normally shown only after experience load).
  await page.evaluate(() => {
    try { localStorage.setItem('nandanavanam:pwa-hint:v1', '1'); } catch {}
    try { document.getElementById('pwaHint')?.setAttribute('style', 'display:none'); } catch {}
    try { document.getElementById('rotateOverlay')?.setAttribute('style', 'display:none'); } catch {}
    try { document.getElementById('startGate')?.setAttribute('style', 'display:none'); } catch {}
    try { document.getElementById('roleGate')?.setAttribute('style', 'display:none'); } catch {}
    try { document.body.setAttribute('data-experience', '1'); } catch {}
    try {
      const btn = document.getElementById('btnFullscreen');
      if (btn) btn.style.display = 'flex';
    } catch {}
  });

  await page.click('#btnFullscreen');

  await expect(page.locator('#exitFSBtn')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    return Boolean(document.fullscreenElement || document.body.classList.contains('fakefs'));
  })).toBe(true);

  await page.click('#exitFSBtn', { force: true });

  await expect.poll(async () => page.evaluate(() => {
    return Boolean(document.fullscreenElement || document.body.classList.contains('fakefs'));
  })).toBe(false);
});
