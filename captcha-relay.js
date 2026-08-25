const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const ENV_PATH = path.join(__dirname, '.env');
loadEnv(ENV_PATH);

const HOST = '127.0.0.1';
const DATASET_DIR = path.join(__dirname, 'captcha-dataset');
const LOG_DIR = path.join(__dirname, 'logs');
const PORT = Number(process.env.CAPTCHA_RELAY_PORT || 3210);
const MAX_BODY_BYTES = 160_000;
const MAX_IMAGE_BYTES = 50_000;
const CACHE_TTL_MS = 2 * 60 * 1000;
const PADDLE_OCR_ENABLED = String(process.env.PADDLE_OCR_ENABLED || 'true').toLowerCase() !== 'false';
const PADDLE_OCR_MIN_CONFIDENCE = Number(process.env.PADDLE_OCR_MIN_CONFIDENCE || 0);
const PADDLE_OCR_VERBOSE = String(process.env.PADDLE_OCR_VERBOSE || 'false').toLowerCase() === 'true';
const AUTO_SUBMIT = String(process.env.CAPTCHA_AUTO_SUBMIT || 'false').toLowerCase() === 'true';

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;

    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

const solveCache = new Map();
let paddleWorkerPromise = null;
let paddleRequestId = 0;

function jsonResponse(res, statusCode, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': 'https://secure.e-konsulat.gov.pl',
    'Access-Control-Allow-Headers': 'Content-Type, X-Visa-Captcha-Relay',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(data);
}

function assertAllowedRequest(req) {
  const origin = req.headers.origin;
  if (origin && origin !== 'https://secure.e-konsulat.gov.pl') {
    throw Object.assign(new Error('Origin is not allowed'), { statusCode: 403 });
  }
  if (req.headers['x-visa-captcha-relay'] !== '1') {
    throw Object.assign(new Error('Missing relay header'), { statusCode: 403 });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function normalizeImage(image) {
  if (typeof image !== 'string') {
    throw Object.assign(new Error('image must be a Base64 string'), { statusCode: 400 });
  }

  const base64 = image
    .replace(/^data:image\/(?:png|jpe?g|gif);base64,/i, '')
    .replace(/\s+/g, '');

  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw Object.assign(new Error('Invalid Base64 image'), { statusCode: 400 });
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 100 || bytes.length > MAX_IMAGE_BYTES) {
    throw Object.assign(
      new Error(`Image size must be between 100 and ${MAX_IMAGE_BYTES} bytes`),
      { statusCode: 400 },
    );
  }

  return { base64, bytes };
}

function getPaddleWorker() {
  if (paddleWorkerPromise) return paddleWorkerPromise;

  paddleWorkerPromise = new Promise((resolve, reject) => {
    const pythonPath = path.join(__dirname, '.venv-paddle', 'Scripts', 'python.exe');
    const workerPath = path.join(__dirname, 'paddle-ocr-worker.py');
    const child = spawn(pythonPath, [workerPath], {
      cwd: __dirname,
      windowsHide: true,
      env: {
        ...process.env,
        PADDLE_PDX_CACHE_HOME: path.join(__dirname, '.paddlex'),
        PADDLE_PDX_MODEL_SOURCE: 'BOS',
        PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    let ready = false;

    readline.createInterface({ input: child.stdout }).on('line', line => {
      if (line.startsWith('OCR_READY ')) {
        ready = true;
        console.log('[paddleocr] worker ready');
        resolve({ child, pending });
        return;
      }
      if (!line.startsWith('OCR_RESULT ')) return;
      const result = JSON.parse(line.slice('OCR_RESULT '.length));
      const request = pending.get(result.id);
      if (!request) return;
      pending.delete(result.id);
      clearTimeout(request.timeout);
      if (result.error) request.reject(new Error(result.error));
      else request.resolve(result);
    });
    readline.createInterface({ input: child.stderr }).on('line', line => {
      if (PADDLE_OCR_VERBOSE && line && !line.includes('ccache')) console.error(`[paddleocr] ${line}`);
    });
    child.on('error', reject);
    child.on('exit', code => {
      const error = new Error(`PaddleOCR worker exited with code ${code}`);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      paddleWorkerPromise = null;
      if (!ready) reject(error);
    });
  });
  return paddleWorkerPromise;
}

async function solveWithPaddle(base64, expectedLength) {
  const worker = await getPaddleWorker();
  const id = ++paddleRequestId;
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.pending.delete(id);
      reject(new Error('PaddleOCR result timeout'));
    }, 10_000);
    worker.pending.set(id, { resolve, reject, timeout });
    worker.child.stdin.write(`${JSON.stringify({ id, image: base64 })}\n`);
  });
  const text = String(result.text || '').trim();
  const confidence = Number(result.confidence || 0);
  console.log(`[paddleocr] ${text.length} chars, confidence ${confidence.toFixed(3)}, ${result.elapsedMs} ms`);
  if (!text || (expectedLength && text.length !== expectedLength)) {
    throw Object.assign(
      new Error(`PaddleOCR returned ${text.length} characters`),
      { expectedMiss: true },
    );
  }
  if (confidence < PADDLE_OCR_MIN_CONFIDENCE) {
    throw Object.assign(
      new Error(`PaddleOCR confidence ${confidence.toFixed(3)} is below ${PADDLE_OCR_MIN_CONFIDENCE}`),
      { expectedMiss: true },
    );
  }
  return { text, taskId: null, cost: 0, provider: 'paddleocr', confidence };
}

function saveCaptchaFeedback(body) {
  const { bytes } = normalizeImage(body.image);
  const actual = String(body.actual || '').trim();
  const predicted = String(body.predicted || '').trim();

  if (actual.length !== 4) {
    throw Object.assign(new Error('Feedback answer must contain exactly 4 characters'), { statusCode: 400 });
  }
  if (predicted.length > 20) {
    throw Object.assign(new Error('Predicted answer is too long'), { statusCode: 400 });
  }

  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(DATASET_DIR, { recursive: true });

  const imageName = `${hash}.png`;
  const imagePath = path.join(DATASET_DIR, imageName);
  if (!fs.existsSync(imagePath)) fs.writeFileSync(imagePath, bytes);

  const record = {
    hash,
    image: imageName,
    actual,
    predicted,
    correct: predicted === actual,
    taskId: body.taskId || null,
    createdAt: new Date().toISOString(),
  };
  fs.appendFileSync(path.join(DATASET_DIR, 'answers.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  console.log(`[feedback ${hash.slice(0, 8)}] saved (${record.correct ? 'correct' : 'corrected'})`);
  return { hash, correct: record.correct };
}

function saveSessionLog(body, logDir = LOG_DIR) {
  const sessionId = String(body.sessionId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) {
    throw Object.assign(new Error('Invalid log session ID'), { statusCode: 400 });
  }

  const message = String(body.message || '').replace(/[\r\n]+/g, ' ').trim();
  if (!message || message.length > 4000) {
    throw Object.assign(new Error('Log message must contain 1-4000 characters'), { statusCode: 400 });
  }

  const timestamp = new Date(body.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    throw Object.assign(new Error('Invalid log timestamp'), { statusCode: 400 });
  }
  const requestedDisplayTime = String(body.displayTime || '').trim();
  const displayTime = /^\d{1,2}:\d{2}:\d{2}$/.test(requestedDisplayTime)
    ? requestedDisplayTime
    : timestamp.toLocaleTimeString('ru-RU');

  fs.mkdirSync(logDir, { recursive: true });
  const fileName = `visa-session-${sessionId}.log`;
  const filePath = path.join(logDir, fileName);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(
      filePath,
      `Visa automation session: ${sessionId}\nStarted: ${timestamp.toISOString()}\nFormat: compact-v1\n\n`,
      'utf8',
    );
  }
  fs.appendFileSync(filePath, `[${displayTime}] ${message}\n`, 'utf8');
  return { file: fileName };
}

async function solveDeduplicated(image, expectedLength) {
  const { base64, bytes } = normalizeImage(image);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const cacheKey = `${hash}:${expectedLength || 0}`;
  const now = Date.now();

  for (const [key, value] of solveCache) {
    if (value.expiresAt <= now) solveCache.delete(key);
  }

  const cached = solveCache.get(cacheKey);
  if (cached) {
    console.log(`[cache ${hash.slice(0, 8)}] reused`);
    return cached.promise;
  }

  const promise = (async () => {
    if (!PADDLE_OCR_ENABLED) {
      throw Object.assign(new Error('PaddleOCR is disabled'), { statusCode: 503 });
    }
    try {
      return await solveWithPaddle(base64, expectedLength);
    } catch (error) {
      if (!error.expectedMiss) throw Object.assign(error, { statusCode: 502 });
      throw Object.assign(
        new Error(`PaddleOCR answer must contain exactly ${expectedLength} characters`),
        { statusCode: 422, quiet: true },
      );
    }
  })();
  solveCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, promise });
  promise.catch(() => {
    if (solveCache.get(cacheKey)?.promise === promise) solveCache.delete(cacheKey);
  });
  return promise;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': 'https://secure.e-konsulat.gov.pl',
        'Access-Control-Allow-Headers': 'Content-Type, X-Visa-Captcha-Relay',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      jsonResponse(res, 200, {
        ok: true,
        provider: 'paddleocr',
        paddleOcrEnabled: PADDLE_OCR_ENABLED,
        paddleOcrMinConfidence: PADDLE_OCR_MIN_CONFIDENCE,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/log') {
      assertAllowedRequest(req);
      const body = await readJson(req);
      const log = saveSessionLog(body);
      jsonResponse(res, 200, { ok: true, ...log });
      return;
    }

    if (req.method === 'POST' && req.url === '/feedback') {
      assertAllowedRequest(req);
      const body = await readJson(req);
      const feedback = saveCaptchaFeedback(body);
      jsonResponse(res, 200, { ok: true, ...feedback });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/solve') {
      jsonResponse(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    assertAllowedRequest(req);
    const body = await readJson(req);
    const expectedLength = Number(body.expectedLength || 4);
    if (expectedLength !== 4) {
      throw Object.assign(new Error('This relay accepts only four-character CAPTCHAs'), { statusCode: 400 });
    }

    const solution = await solveDeduplicated(body.image, expectedLength);
    jsonResponse(res, 200, { ok: true, autoSubmit: AUTO_SUBMIT, ...solution });
  } catch (error) {
    const statusCode = error.statusCode || 502;
    if (!error.quiet && statusCode >= 500) {
      console.error(`[relay] ${error.message}`);
    }
    jsonResponse(res, statusCode, { ok: false, error: error.message });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Captcha relay listening on http://${HOST}:${PORT}`);
    console.log('Local-only mode; duplicate images are cached for 2 minutes');
    console.log(`PaddleOCR: ${PADDLE_OCR_ENABLED ? `enabled (min confidence ${PADDLE_OCR_MIN_CONFIDENCE})` : 'disabled'}`);
    console.log(`CAPTCHA auto-submit outside userscript automation: ${AUTO_SUBMIT ? 'enabled' : 'disabled'}`);
  });
}

module.exports = { saveSessionLog };
