import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isIP } from 'node:net';

const root = fileURLToPath(new URL('../', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

test('source distribution includes MIT terms and distinguishes original game materials', async () => {
  for (const path of ['LICENSE', 'NOTICE.md']) assert.ok(tracked.includes(path), path);
  const license = await readFile(join(root, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License\r?\n/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  const notice = await readFile(join(root, 'NOTICE.md'), 'utf8');
  assert.match(notice, /\[MIT 许可证\]\(LICENSE\)/);
  assert.match(notice, /`references\/`/);
  assert.match(notice, /不适用本项目的 MIT 许可证/);
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  assert.match(readme, /\[MIT 许可证\]\(LICENSE\)/);
  assert.match(readme, /\[许可与原作素材\]\(NOTICE\.md\)/);
  assert.doesNotMatch(readme, /私有仓库需要先登录/);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.license, 'MIT');
  assert.equal(lockfile.packages[''].license, manifest.license);
});

test('distribution excludes local settings, saved identities, keys and private backups', () => {
  for (const path of tracked) {
    assert.doesNotMatch(path, /^(data|config|state|logs|private|backups|test-results|node_modules)\//, path);
    assert.doesNotMatch(path, /(^|\/)\.env($|\.(?!example$))|\.(pem|key|bundle)$/i, path);
    assert.doesNotMatch(path, /(^|\/)(access|rooms|fixed-entry|isolation-backup)\.json$/, path);
  }
  const privatePaths = ['.env', '.env.production', 'data/access.json', 'config/tunnel.json',
    'private/operations.md', 'backups/history.bundle', 'cert.pem', 'server.key'];
  const ignored = execFileSync('git', ['check-ignore', '--no-index', ...privatePaths], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.deepEqual(ignored, privatePaths);
});

test('published text uses example game hosts and contains no hardcoded personal profile paths', async () => {
  // Official software dependencies, publisher attribution and standards are legitimate references.
  const official = new Set(['github.com', 'nodejs.org', 'developers.cloudflare.com', 'registry.npmmirror.com',
    'registry.npmjs.org', 'ejingar.sakura.ne.jp', 'www.w3.org']);
  for (const path of tracked.filter(name => !name.startsWith('references/'))) {
    const text = await readFile(join(root, path), 'utf8');
    for (const [, value] of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      const host = value.toLowerCase();
      const example = host === 'localhost' || /(^|\.)(example\.(com|org|net)|example|test)$/.test(host)
        || ['...trycloudflare.com', 'example.trycloudflare.com'].includes(host);
      const exampleAddress = isIP(host) && (host.startsWith('127.') || host === '192.168.1.10');
      assert.ok(official.has(host) || example || exampleAddress, `${path}: use an example hostname for a game deployment`);
    }
    const paths = text.replaceAll('\\\\', '\\').replaceAll('\\', '/');
    assert.doesNotMatch(paths, /[A-Z]:\/Users\/(?!Public\b|Default\b|example\b)[^\s/'"<>]+/i,
      `${path}: use an environment variable instead of a personal profile path`);
  }
});

test('reference JPEGs retain only neutral color headers and a minimal orientation tag', async () => {
  const pictures = tracked.filter(path => /^references\/.*\.jpg$/i.test(path));
  assert.equal(pictures.length, 42);
  for (const path of pictures) {
    const bytes = await readFile(join(root, path));
    assert.equal(bytes.readUInt16BE(0), 0xffd8, path);
    assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9, `${path}: trailing private data`);
    let offset = 2;
    while (offset < bytes.length) {
      assert.equal(bytes[offset++], 0xff, path);
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(offset);
      assert.ok(length >= 2 && offset + length <= bytes.length, path);
      const payload = bytes.subarray(offset + 2, offset + length);
      offset += length;
      assert.notEqual(marker, 0xfe, `${path}: JPEG comment metadata`);
      if (marker < 0xe0 || marker > 0xef) continue;
      if (marker === 0xe0) {
        assert.equal(payload.length, 14, path);
        assert.equal(payload.subarray(0, 5).toString('ascii'), 'JFIF\0', path);
        assert.equal(payload.readUInt16BE(12), 0, `${path}: embedded thumbnail`);
      } else if (marker === 0xe2) {
        assert.equal(payload.subarray(0, 12).toString('ascii'), 'ICC_PROFILE\0', path);
      } else if (marker === 0xe1) {
        assert.equal(payload.length, 32, `${path}: extra EXIF data`);
        assert.equal(payload.subarray(0, 6).toString('ascii'), 'Exif\0\0', path);
        const tiff = payload.subarray(6);
        const little = tiff.subarray(0, 2).toString('ascii') === 'II';
        assert.ok(little || tiff.subarray(0, 2).toString('ascii') === 'MM', path);
        const short = position => little ? tiff.readUInt16LE(position) : tiff.readUInt16BE(position);
        const long = position => little ? tiff.readUInt32LE(position) : tiff.readUInt32BE(position);
        assert.equal(short(2), 42, path);
        assert.equal(long(4), 8, path);
        assert.equal(short(8), 1, `${path}: EXIF may contain only Orientation`);
        assert.equal(short(10), 0x112, path);
        assert.equal(short(12), 3, path);
        assert.equal(long(14), 1, path);
        assert.ok(short(18) >= 1 && short(18) <= 8, path);
        assert.equal(long(22), 0, `${path}: nested EXIF`);
      } else assert.fail(`${path}: private APP metadata`);
    }
  }
});

test('advanced deployment tools require the deployer to choose a runtime directory', { skip: process.platform !== 'win32' }, async () => {
  for (const file of ['deploy-runtime.ps1', 'setup-isolation.ps1']) {
    const env = { ...process.env };
    delete env.XIANGWA_RUNTIME_ROOT;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', file)],
      { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'close');
    assert.notEqual(code, 0, output);
    assert.match(output, /Specify your own runtime directory/);
  }
});
