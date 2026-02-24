// tests/vr-tour.spec.js
// Playwright test: VR Tour crash/compatibility

import { test, expect } from '@playwright/test';

test('App loads and main UI appears', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#startGate')).toBeVisible();
});

test('Guided flow shows role gate', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    try { document.getElementById('rotateOverlay')?.setAttribute('style', 'display:none'); } catch {}
  });
  await page.click('#btnGuided');
  await expect(page.locator('#roleGate')).toBeVisible();
  await page.click('#btnViewer');
  await expect(page.locator('#btnViewer')).toHaveAttribute('aria-pressed', 'true');
});

test('Can open and submit feedback modal', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    try { localStorage.setItem('nandanavanam:pwa-hint:v1', '1'); } catch {}
    try { document.getElementById('pwaHint')?.setAttribute('style', 'display:none'); } catch {}
    try { document.getElementById('rotateOverlay')?.setAttribute('style', 'display:none'); } catch {}
    try { document.getElementById('startGate')?.setAttribute('style', 'display:none'); } catch {}
    try { document.getElementById('roleGate')?.setAttribute('style', 'display:none'); } catch {}
    const btn = document.getElementById('finishExpBtn');
    if (!btn) return;
    btn.hidden = false;
    btn.style.display = '';
  });
  await page.evaluate(() => { try { document.getElementById('finishExpBtn')?.click(); } catch {} });
  await expect(page.locator('#feedbackOverlay')).toBeVisible();
  await page.fill('#feedbackText', 'Automated test feedback.');
  await page.click('#submitFeedback');
  await expect(page.locator('#feedbackThankyou')).toBeVisible();
});

test('Fullscreen can be toggled (regression smoke)', async ({ page }) => {
  await page.goto('/');
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
  await page.evaluate(() => { try { document.getElementById('exitFSBtn')?.click(); } catch {} });
});
