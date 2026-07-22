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
const PORT = Number(process.env.CAPMONSTER_RELAY_PORT || 3210);
const MAX_BODY_BYTES = 160_000;
const MAX_IMAGE_BYTES = 50_000;
const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_TASKS_PER_HOUR = Number(process.env.CAPMONSTER_MAX_TASKS_PER_HOUR || 100);
const CONFIDENCE_THRESHOLD = Number(process.env.CAPMONSTER_CONFIDENCE_THRESHOLD || 90);
const CAPMONSTER_MODULE = String(process.env.CAPMONSTER_MODULE || '').trim();
const CAPMONSTER_FALLBACK_ENABLED = String(process.env.CAPMONSTER_FALLBACK_ENABLED || 'false').toLowerCase() === 'true';
const PADDLE_OCR_ENABLED = String(process.env.PADDLE_OCR_ENABLED || 'true').toLowerCase() !== 'false';
const PADDLE_OCR_MIN_CONFIDENCE = Number(process.env.PADDLE_OCR_MIN_CONFIDENCE || 0);
const AUTO_SUBMIT = String(process.env.CAPMONSTER_AUTO_SUBMIT || 'false').toLowerCase() === 'true';
const CAPMONSTER_API = 'https://api.capmonster.cloud';

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

const API_KEY = process.env.CAPMONSTER_API_KEY || process.env.CAPMONSTER_API;
if (CAPMONSTER_FALLBACK_ENABLED && !API_KEY) {
  console.error('Missing CAPMONSTER_API (or CAPMONSTER_API_KEY) in .env');
  process.exit(1);
}

const solveCache = new Map();
const createdTaskTimes = [];
let totalTasksCreated = 0;
let paddleWorkerPromise = null;
let paddleRequestId = 0;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
      if (line && !line.includes('ccache')) console.error(`[paddleocr] ${line}`);
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
    throw new Error(`PaddleOCR returned ${text.length} characters`);
  }
  if (confidence < PADDLE_OCR_MIN_CONFIDENCE) {
    throw new Error(`PaddleOCR confidence ${confidence.toFixed(3)} is below ${PADDLE_OCR_MIN_CONFIDENCE}`);
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

function enforceHourlyBudget() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (createdTaskTimes.length && createdTaskTimes[0] < cutoff) {
    createdTaskTimes.shift();
  }
  if (createdTaskTimes.length >= MAX_TASKS_PER_HOUR) {
    throw Object.assign(
      new Error(`Hourly safety limit reached (${MAX_TASKS_PER_HOUR} tasks)`),
      { statusCode: 429 },
    );
  }
}

async function capMonsterRequest(endpoint, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`${CAPMONSTER_API}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CapMonster HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function solveWithCapMonster(base64, expectedLength) {
  enforceHourlyBudget();

  const created = await capMonsterRequest('createTask', {
    clientKey: API_KEY,
    task: {
      type: 'ImageToTextTask',
      body: base64,
      ...(CAPMONSTER_MODULE ? { capMonsterModule: CAPMONSTER_MODULE } : {}),
      recognizingThreshold: CONFIDENCE_THRESHOLD,
      case: true,
      numeric: 0,
      math: false,
    },
  });

  if (created.errorId || !created.taskId) {
    throw new Error(created.errorDescription || created.errorCode || 'Could not create task');
  }

  createdTaskTimes.push(Date.now());
  totalTasksCreated += 1;
  console.log(`[task ${created.taskId}] created (${createdTaskTimes.length}/${MAX_TASKS_PER_HOUR} this hour)`);

  await delay(500);
  const deadline = Date.now() + 12_000;

  while (Date.now() < deadline) {
    const result = await capMonsterRequest('getTaskResult', {
      clientKey: API_KEY,
      taskId: created.taskId,
    });

    if (result.errorId) {
      throw new Error(result.errorDescription || result.errorCode || 'Could not get task result');
    }

    if (result.status === 'ready') {
      const text = String(result.solution?.text || '').trim();
      if (!text) throw new Error('CapMonster returned an empty answer');
      if (expectedLength && text.length !== expectedLength) {
        throw new Error(`Unexpected answer length: ${text.length}, expected ${expectedLength}`);
      }
      console.log(`[task ${created.taskId}] solved: ${text.length} characters`);
      return { text, taskId: created.taskId, cost: result.cost || null, provider: 'capmonster' };
    }

    await delay(2000);
  }

  throw new Error('CapMonster result timeout');
}

async function solveDeduplicated(image, expectedLength) {
  const { base64, bytes } = normalizeImage(image);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const now = Date.now();

  for (const [key, value] of solveCache) {
    if (value.expiresAt <= now) solveCache.delete(key);
  }

  const cached = solveCache.get(hash);
  if (cached) {
    console.log(`[cache ${hash.slice(0, 8)}] reused`);
    return cached.promise;
  }

  const promise = (async () => {
    if (PADDLE_OCR_ENABLED) {
      try {
        return await solveWithPaddle(base64, expectedLength);
      } catch (error) {
        console.log(`[paddleocr] local solve failed: ${error.message}`);
      }
    }
    if (!CAPMONSTER_FALLBACK_ENABLED) {
      throw new Error('Local PaddleOCR could not produce an accepted answer; CapMonster fallback is disabled');
    }
    return solveWithCapMonster(base64, expectedLength);
  })();
  solveCache.set(hash, { expiresAt: now + CACHE_TTL_MS, promise });
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
        tasksCreated: totalTasksCreated,
        tasksLastHour: createdTaskTimes.length,
        hourlyLimit: MAX_TASKS_PER_HOUR,
        module: CAPMONSTER_MODULE || 'universal',
        capMonsterFallbackEnabled: CAPMONSTER_FALLBACK_ENABLED,
        paddleOcrEnabled: PADDLE_OCR_ENABLED,
        paddleOcrMinConfidence: PADDLE_OCR_MIN_CONFIDENCE,
      });
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
    const expectedLength = Number(body.expectedLength || 0);
    if (expectedLength && (!Number.isInteger(expectedLength) || expectedLength < 1 || expectedLength > 20)) {
      throw Object.assign(new Error('Invalid expectedLength'), { statusCode: 400 });
    }

    const solution = await solveDeduplicated(body.image, expectedLength);
    jsonResponse(res, 200, { ok: true, autoSubmit: AUTO_SUBMIT, ...solution });
  } catch (error) {
    console.error(`[relay] ${error.message}`);
    jsonResponse(res, error.statusCode || 502, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Captcha relay listening on http://${HOST}:${PORT}`);
  console.log(`Budget guard: ${MAX_TASKS_PER_HOUR} new tasks/hour; duplicate images are cached for 2 minutes`);
  console.log(`CapMonster module: ${CAPMONSTER_MODULE || 'universal'}`);
  console.log(`CapMonster fallback: ${CAPMONSTER_FALLBACK_ENABLED ? 'enabled' : 'disabled'}`);
  console.log(`PaddleOCR: ${PADDLE_OCR_ENABLED ? `enabled (min confidence ${PADDLE_OCR_MIN_CONFIDENCE})` : 'disabled'}`);
  console.log(`CAPTCHA auto-submit: ${AUTO_SUBMIT ? 'enabled' : 'disabled (verification mode)'}`);
});
