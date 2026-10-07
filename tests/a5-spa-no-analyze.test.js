import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const srcFiles = readdirSync(join(root, 'src')).filter((f) => /\.(jsx?|html)$/.test(f)).map((f) => [f, readFileSync(join(root, 'src', f), 'utf8')]);
const app = readFileSync(join(root, 'src/App.jsx'), 'utf8');

test('A5: public SPA does not call /api/analyze from the browser', () => {
  for (const [name, text] of srcFiles) assert.doesNotMatch(text, /\/api\/analyze/, name);
});

test('A5: no API key is shipped to the browser (no x-api-key header, no VITE_* key)', () => {
  for (const [name, text] of srcFiles) {
    assert.doesNotMatch(text, /x-api-key/i, name);
    assert.doesNotMatch(text, /VITE_[A-Z_]*(KEY|TOKEN|SECRET)/, name);
  }
  assert.doesNotMatch(readFileSync(join(root, 'vite.config.js'), 'utf8'), /AUDIT_API_KEY|OPENAI/);
});

test('A5: SPA tells the user analysis lives in the Shopify app', () => {
  assert.match(app, /Analysis is available in the AhaRoll Shopify app/);
});

test('A5: SPA still lets users browse products via /api/fetch-products', () => {
  assert.match(app, /\/api\/fetch-products/);
});
