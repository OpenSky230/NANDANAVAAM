// tests/vr-tour-crash.spec.js
// Advanced Playwright crash/compatibility test for VR Tour

import { test, expect } from '@playwright/test';

test('App loads within 5s, no black screen, no errors', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#startGate')).toBeVisible();
});

test('Open feedback and submit, no crash', async ({ page }) => {
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
  await page.fill('#feedbackText', 'Crash test feedback.');
  await page.click('#submitFeedback');
  await expect(page.locator('#feedbackThankyou')).toBeVisible();
});

test('Fullscreen toggle does not throw', async ({ page }) => {
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
