const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { saveSessionLog } = require('../captcha-relay.js');

test('session log creates one readable file and appends entries', t => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visa-session-log-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  const first = saveSessionLog({
    sessionId: '2026-08-21_19-35-51_abc123',
    timestamp: '2026-08-21T17:35:51.000Z',
    displayTime: '19:35:51',
    message: 'Шаг 4/4: Выбор даты...',
  }, logDir);
  saveSessionLog({
    sessionId: '2026-08-21_19-35-51_abc123',
    timestamp: '2026-08-21T17:35:52.000Z',
    displayTime: '19:35:52',
    message: 'Ожидаю доступные даты',
  }, logDir);

  assert.equal(first.file, 'visa-session-2026-08-21_19-35-51_abc123.log');
  const content = fs.readFileSync(path.join(logDir, first.file), 'utf8');
  assert.match(content, /Visa automation session: 2026-08-21_19-35-51_abc123/);
  assert.match(content, /Format: compact-v1/);
  assert.match(content, /\[19:35:51\] Шаг 4\/4: Выбор даты/);
  assert.match(content, /\[19:35:52\] Ожидаю доступные даты/);
});

test('session log rejects unsafe session IDs', () => {
  assert.throws(
    () => saveSessionLog({
      sessionId: '../outside',
      timestamp: '2026-08-21T17:35:51.000Z',
      message: 'unsafe',
    }),
    /Invalid log session ID/,
  );
});
