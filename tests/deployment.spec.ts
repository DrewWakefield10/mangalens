import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('nested routes refresh and the same-origin proxy retains session, upload and image behavior', async ({ page }) => {
  await page.goto('/settings');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your reading ritual.', exact: true })).toBeVisible();
  const headers = { 'X-MangaLens-Client': 'web' };
  const session = await page.request.post('/api/session', { headers });
  expect(session.ok()).toBeTruthy();
  const original = readFileSync('samples/japanese-page.png');
  // Exercise a >4.5MB multipart upload through the rewrite, not a Function.
  const upload = await page.request.post('/api/projects/upload', {
    headers, multipart: { authorized:'true', title:'Root deployment check', files: {
      name:'page.png', mimeType:'image/png', buffer:Buffer.concat([original, Buffer.alloc(5 * 1024 * 1024)]),
    } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const project = await upload.json();
  try {
    await page.goto('/projects/' + project.id);
    await page.reload();
    await expect(page.getByRole('heading', { name:'Root deployment check', exact:true })).toBeVisible();
    const detail = await page.request.get('/api/projects/' + project.id);
    expect(detail.ok()).toBeTruthy();
    expect(detail.headers()['cache-control']).toContain('no-store');
    const image = await page.request.get('/api/pages/' + project.pages[0].id + '/image/original');
    expect(image.ok()).toBeTruthy();
    expect(image.headers()['content-type']).toContain('image/png');
    expect((await image.body()).length).toBeGreaterThan(1000);
    const invalid = await page.request.post('/api/projects/upload', { headers,
      multipart: { authorized:'true', files: {name:'invalid.png',mimeType:'image/png',buffer:Buffer.from('invalid')} } });
    expect(invalid.ok()).toBeFalsy();
    expect(await invalid.text()).toMatch(/image|corrupt|supported/i);
  } finally {
    await page.request.delete('/api/projects/' + project.id, { headers });
  }
});
