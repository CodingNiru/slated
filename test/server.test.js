const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
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

test('Vercel serves the page and returns an explicit API error when storage config is missing', () => {
  const script = `
    const http = require('node:http');
    const app = require('./server');
    const server = app.listen(0, async () => {
      const request = (pathname) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: pathname }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
        }).on('error', reject);
      });

      try {
        const page = await request('/');
        const health = await request('/api/health');
        console.log(JSON.stringify({
          pageStatus: page.status,
          healthStatus: health.status,
          healthBody: JSON.parse(health.body),
        }));
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      } finally {
        server.close();
      }
    });
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      VERCEL: '1',
      PERSISTENCE: 'postgres',
      DATABASE_URL: '',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  const result = JSON.parse(output.trim().split(/\r?\n/).pop());

  assert.equal(result.pageStatus, 200);
  assert.equal(result.healthStatus, 503);
  assert.deepEqual(result.healthBody, { error: 'Persistent storage is unavailable.' });
});
