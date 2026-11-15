const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeAndValidateCanvasUrl } = require('../server');

test('Canvas base URLs normalize to an HTTPS origin', () => {
  assert.equal(
    normalizeAndValidateCanvasUrl('https://canvas.example.edu/school/courses?token=ignored'),
    'https://canvas.example.edu'
  );
});

test('Canvas base URLs reject private, loopback, and link-local IP addresses', () => {
  const blockedUrls = [
    'https://10.1.2.3',
    'https://127.0.0.1',
    'https://169.254.169.254',
    'https://172.31.9.4',
    'https://192.168.1.3',
    'https://[::1]',
    'https://[fc00::1]',
    'https://[fe80::1]',
  ];

  for (const url of blockedUrls) {
    assert.throws(() => normalizeAndValidateCanvasUrl(url), { status: 400 }, url);
  }
});

test('Canvas base URLs reject non-HTTPS and non-standard ports', () => {
  for (const url of ['http://canvas.example.edu', 'https://canvas.example.edu:8443']) {
    assert.throws(() => normalizeAndValidateCanvasUrl(url), { status: 400 }, url);
  }
});
