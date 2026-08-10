/* ============================================================
   Importador automático de fotos
   ------------------------------------------------------------
   Observa a pasta painel/uploads (e subpastas) e importa cada
   imagem (jpg/jpeg/png/webp) para o catálogo:

   - Gera o embedding facial (obrigatório para a busca funcionar)
   - Gera hash SHA-256 e evita duplicados
   - Metadados opcionais: JSON com o mesmo nome da foto (ex.:
     foto.jpg + foto.json) com campos title, description,
     category, price, tags, gender, vehicle, platform
   - Pasta = categoria (ex.: uploads/Praia/x.jpg -> categoria "Praia")
   - Grava a foto no armazenamento local (disco) ANTES
     de gravar no banco; só apaga a original depois de tudo ok
   - Fila + concorrência limitada + retry com backoff
   - Logs em logs/importer.log e status em tempo real
   ============================================================ */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./database/db');
const faceService = require('./face-service');
const blur = require('./blur');
const storage = require('./storage');

const UPLOADS_DIR = path.join(__dirname, 'painel', 'uploads');
const REJECTED_DIR = path.join(__dirname, 'painel', 'rejected');
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'importer.log');

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
const POLL_MS = Number(process.env.IMPORTER_POLL_MS || 2000);
const CONCURRENCY = Math.max(1, Number(process.env.IMPORTER_CONCURRENCY || 2));
const MAX_RETRIES = Math.max(1, Number(process.env.IMPORTER_MAX_RETRIES || 3));
const DEFAULT_PRICE = Number(process.env.PRICE_FULL_PHOTO || 10);

const status = {
  startedAt: null,
  finishedAt: null,
  queued: 0,
  processing: 0,
  done: 0,
  failed: 0,
  rejected: 0,
  duplicates: 0,
  current: [],
  lastError: null,
  lastRun: null
};

let started = false;
let pollTimer = null;
let active = 0;
let remoteActive = 0;
const queue = [];
const inflight = new Set();
let idle = Promise.resolve();

function log(line) {
  const stamp = new Date().toISOString();
  console.log('[importer] ' + line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${stamp}] ${line}\n`);
  } catch (e) { /* ignora */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ==================== Helpers de banco ==================== */

function dbGet(sql, params) {
  return new Promise((res, rej) => db.get(sql, params || [], (e, r) => (e ? rej(e) : res(r))));
}

function dbRun(sql, params) {
  return new Promise((res, rej) => db.run(sql, params || [], (e) => (e ? rej(e) : res())));
}

// Serializa trechos críticos (cálculo do próximo ID + INSERT) para nunca
// gerar IDs duplicados mesmo com múltiplas importações em paralelo.
function enqueueIdle(fn) {
  const p = idle.then(fn, fn);
  idle = p.catch(() => {});
  return p;
}

/* ==================== Descoberta de arquivos ==================== */

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const en of entries) {
    const full = path.join(dir, en.name);
    if (en.isDirectory()) walk(full, out);
    else if (en.isFile() && IMAGE_RE.test(en.name)) out.push(full);
  }
  return out;
}

function loadMetadata(imagePath) {
  const dir = path.dirname(imagePath);
  const base = path.basename(imagePath, path.extname(imagePath));
  const jsonPath = path.join(dir, base + '.json');
  let meta = {};
  try {
    if (fs.existsSync(jsonPath)) meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) || {};
  } catch (e) {
    log(`Metadados inválidos em ${jsonPath}: ${e.message}`);
  }
  return meta;
}

function folderCategoryFor(imagePath) {
  const rel = path.relative(UPLOADS_DIR, path.dirname(imagePath));
  if (!rel || rel === '.' || rel === '..') return null;
  return rel.split(path.sep)[0];
}

function prettyStem(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extFor(filePath) {
  const m = /\.(jpe?g|png|webp)$/i.exec(filePath);
  if (!m) return 'jpg';
  const e = m[1].toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* ==================== Ciclo de vida do arquivo ==================== */

function cleanupFile(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { /* ignora */ }
  const base = path.basename(filePath, path.extname(filePath));
  const json = path.join(path.dirname(filePath), base + '.json');
  try { if (fs.existsSync(json)) fs.unlinkSync(json); } catch (e) { /* ignora */ }
  inflight.delete(filePath);
}

function rejectFile(filePath) {
  try {
    fs.mkdirSync(REJECTED_DIR, { recursive: true });
    fs.renameSync(filePath, path.join(REJECTED_DIR, path.basename(filePath)));
    log(`Arquivo movido para rejected/: ${path.basename(filePath)}`);
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch (e2) { /* ignora */ }
  }
  inflight.delete(filePath);
}

async function putWithRetry(key, buf, rel) {
  for (let a = 1; a <= MAX_RETRIES; a++) {
    try {
      const ok = await storage.put(key, buf);
      if (ok) return true;
      throw new Error('storage.put retornou false');
    } catch (e) {
      if (a === MAX_RETRIES) {
        log(`Falha permanente ao gravar ${rel} no armazenamento: ${e.message}`);
        return false;
      }
      log(`Falha ao gravar ${rel} (tentativa ${a}/${MAX_RETRIES}): ${e.message}. Tentando de novo...`);
      await sleep(1000 * a);
    }
  }
  return false;
}

/* ==================== Importação de um arquivo ==================== */

async function importFile(filePath) {
  const rel = path.relative(UPLOADS_DIR, filePath);

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (e) {
    inflight.delete(filePath);
    return;
  }

  const hash = sha256(buffer);

  // Dedup por hash — nunca cadastra a mesma foto duas vezes.
  const existing = await dbGet('SELECT id FROM faces WHERE photo_hash = ?', [hash]);
  if (existing) {
    status.duplicates++;
    log(`Duplicado (hash ${hash.slice(0, 12)}…) — ${rel} já é a face #${existing.id}. Removido.`);
    cleanupFile(filePath);
    return;
  }

  log(`Processando ${rel} (${buffer.length} bytes)...`);
  status.current.push(rel);

  let embedding = null;
  try {
    embedding = await faceService.extractEmbedding(buffer);
  } catch (e) {
    status.current = status.current.filter((c) => c !== rel);
    status.rejected++;
    log(`Erro ao extrair rosto de ${rel}: ${e.message}`);
    rejectFile(filePath);
    return;
  }
  status.current = status.current.filter((c) => c !== rel);

  if (!embedding) {
    status.rejected++;
    log(`Nenhum rosto detectado em ${rel}. Movendo para rejected/.`);
    rejectFile(filePath);
    return;
  }

  const meta = loadMetadata(filePath);
  const folderCat = folderCategoryFor(filePath);
  const stem = prettyStem(path.basename(filePath));
  const name = String(meta.title || meta.name || stem).trim() || stem;
  const description = meta.description || null;
  const category = meta.category || folderCat || null;
  const priceRaw = Number(meta.price);
  const price = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : DEFAULT_PRICE;
  const gender = meta.gender || null;
  const vehicle = meta.vehicle || null;
  const platform = meta.platform || null;
  const tags = Array.isArray(meta.tags) ? meta.tags.filter(Boolean) : [];
  let desc = description;
  if (tags.length) desc = desc ? desc + '\n\nTags: ' + tags.join(', ') : 'Tags: ' + tags.join(', ');

  // Seção crítica serializada: próximo ID + gravação local + INSERT + blur.
  await enqueueIdle(async () => {
    try {
      const row = await dbGet('SELECT COALESCE(MAX(id), 1000) AS maxId FROM faces');
      const nextId = row.maxId + 1;
      const finalName = `${nextId}.${extFor(filePath)}`;

      const ok = await putWithRetry('photos/' + finalName, buffer, rel);
      if (!ok) {
        status.failed++;
        log(`Importação de ${rel} falhou no armazenamento. Movendo para rejected/.`);
        rejectFile(filePath);
        return;
      }

      blur.cacheBlurred(finalName).catch(() => {});

      await dbRun(
        'INSERT INTO faces (id, name, photo, embedding, gender, vehicle, platform, description, category, price, photo_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [nextId, name, finalName, JSON.stringify(embedding), gender, vehicle, platform, desc, category, price, hash]
      );

      cleanupFile(filePath);
      log(`Importada ${rel} -> face #${nextId} (${finalName}) | nome="${name}" categoria="${category || '—'}"`);
    } catch (e) {
      status.failed++;
      log(`Erro ao cadastrar ${rel}: ${e.message}`);
      rejectFile(filePath);
    }
  });
}

/* ==================== Importação direta (upload p/ R2) ==================== */

// Processa uma imagem que já está no bucket (staging/uploads/...) e que foi
// enviada DIRETO pelo navegador via presigned PUT (sem passar pelo Express).
// O byte chega aqui apenas como leitura do R2 (ingresso na Render, que não
// conta na cota de saída); a "promoção" para o local final usa CopyObject
// (servidor-a-servidor, sem egress da Render) com fallback get+put.
async function importRemoteInner(key, rel, meta) {
  rel = String(rel || '').replace(/\\/g, '/');
  const tag = rel || key;

  let buffer;
  try {
    buffer = await storage.get(key);
  } catch (e) {
    status.failed++;
    log(`Erro ao ler ${tag} do armazenamento: ${e.message}`);
    await storage.remove(key).catch(() => {});
    return;
  }
  if (!buffer) {
    status.failed++;
    log(`Arquivo ${tag} não encontrado no armazenamento. Removido da fila.`);
    return;
  }

  const hash = sha256(buffer);

  const existing = await dbGet('SELECT id FROM faces WHERE photo_hash = ?', [hash]);
  if (existing) {
    status.duplicates++;
    log(`Duplicado (hash ${hash.slice(0, 12)}…) — ${tag} já é a face #${existing.id}. Removido.`);
    await storage.remove(key).catch(() => {});
    return;
  }

  log(`Processando ${tag} (${buffer.length} bytes)...`);
  status.current.push(tag);

  let embedding = null;
  try {
    embedding = await faceService.extractEmbedding(buffer);
  } catch (e) {
    status.current = status.current.filter((c) => c !== tag);
    status.rejected++;
    log(`Erro ao extrair rosto de ${tag}: ${e.message}`);
    await storage.remove(key).catch(() => {});
    return;
  }
  status.current = status.current.filter((c) => c !== tag);

  if (!embedding) {
    status.rejected++;
    log(`Nenhum rosto detectado em ${tag}. Removido.`);
    await storage.remove(key).catch(() => {});
    return;
  }

  const stem = prettyStem(path.basename(String(rel || key)));
  const name = String(meta.title || stem).trim() || stem;
  const description = meta.description || null;
  const folderCat = rel ? String(rel).split('/')[0] : null;
  const category = folderCat || null;
  const price = DEFAULT_PRICE;
  const gender = meta.gender || null;
  const vehicle = meta.vehicle || null;
  const platform = meta.platform || null;
  const tags = Array.isArray(meta.tags) ? meta.tags.filter(Boolean) : [];
  let desc = description;
  if (tags.length) desc = desc ? desc + '\n\nTags: ' + tags.join(', ') : 'Tags: ' + tags.join(', ');

  await enqueueIdle(async () => {
    try {
      const row = await dbGet('SELECT COALESCE(MAX(id), 1000) AS maxId FROM faces');
      const nextId = row.maxId + 1;
      const finalName = `${nextId}.${extFor(String(rel || key))}`;

      const copied = await storage.copyObject(key, 'photos/' + finalName);
      if (!copied) {
        const ok = await putWithRetry('photos/' + finalName, buffer, tag);
        if (!ok) {
          status.failed++;
          log(`Importação de ${tag} falhou no armazenamento. Removido.`);
          await storage.remove(key).catch(() => {});
          return;
        }
      }

      blur.cacheBlurred(finalName).catch(() => {});

      await dbRun(
        'INSERT INTO faces (id, name, photo, embedding, gender, vehicle, platform, description, category, price, photo_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [nextId, name, finalName, JSON.stringify(embedding), gender, vehicle, platform, desc, category, price, hash]
      );

      await storage.remove(key).catch(() => {});
      log(`Importada ${tag} -> face #${nextId} (${finalName}) | nome="${name}" categoria="${category || '—'}"`);
    } catch (e) {
      status.failed++;
      log(`Erro ao cadastrar ${tag}: ${e.message}`);
      await storage.remove(key).catch(() => {});
    }
  });
}

function importRemote(key, rel, meta) {
  const run = () => {
    remoteActive++;
    importRemoteInner(key, rel, meta || {})
      .catch((e) => {
        status.failed++;
        log(`Erro inesperado ao importar ${rel || key}: ${e.message}`);
      })
      .finally(() => {
        remoteActive--;
        status.lastRun = new Date().toISOString();
        releaseRemote();
        if (remoteActive === 0 && active === 0 && queue.length === 0) {
          status.finishedAt = new Date().toISOString();
        }
      });
  };
  gateRemote(run);
}

// Limita a concorrência das importações remotas (embedding é caro em CPU).
let remoteSlots = CONCURRENCY;
const remoteWaiters = [];
function gateRemote(fn) {
  if (remoteSlots > 0) { remoteSlots--; fn(); return; }
  remoteWaiters.push(fn);
}
function releaseRemote() {
  const next = remoteWaiters.shift();
  if (next) { next(); return; }
  remoteSlots++;
}

/* ==================== Fila + concorrência ==================== */

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const item = queue.shift();
    status.queued = Math.max(0, status.queued - 1);
    status.processing++;
    active++;
    importFile(item)
      .catch((e) => {
        status.failed++;
        log(`Erro inesperado ao importar ${item}: ${e.message}`);
        inflight.delete(item);
      })
      .finally(() => {
        active--;
        status.processing = Math.max(0, status.processing - 1);
        status.done++;
        status.lastRun = new Date().toISOString();
        pump();
      });
  }
  if (active === 0 && queue.length === 0) {
    status.finishedAt = new Date().toISOString();
  }
}

function scan() {
  if (!started) return;
  const files = walk(UPLOADS_DIR);
  for (const f of files) {
    if (inflight.has(f)) continue;
    inflight.add(f);
    status.queued++;
    queue.push(f);
  }
  if (queue.length) pump();
}

/* ==================== Ciclo de vida do módulo ==================== */

function start() {
  if (started) return;
  started = true;
  status.startedAt = new Date().toISOString();
  log(`Importador iniciado. Pasta: ${UPLOADS_DIR} (poll=${POLL_MS}ms, concorrência=${CONCURRENCY}, retries=${MAX_RETRIES}).`);
  try {
    fs.mkdirSync(REJECTED_DIR, { recursive: true });
  } catch (e) { /* ignora */ }
  scan();
  pollTimer = setInterval(scan, POLL_MS);
}

function stop() {
  started = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function triggerScan() {
  scan();
}

function getStatus() {
  const total = status.done + status.failed + status.rejected + status.duplicates + status.queued + status.processing;
  return {
    ...status,
    total,
    idle: active === 0 && queue.length === 0 && remoteActive === 0,
    uploadsDir: UPLOADS_DIR,
    rejectedDir: REJECTED_DIR,
    concurrency: CONCURRENCY
  };
}

module.exports = { start, stop, triggerScan, importRemote, getStatus, UPLOADS_DIR, REJECTED_DIR, IMAGE_RE };
