/* ============================================================
   Armazenamento local (disco)
   ------------------------------------------------------------
   Solução simples e local, sem sincronização externa (R2/S3),
   pull/push ou backup constante. O bot e o painel leem e gravam
   direto no disco da instância:
     - Fotos originais: projeto/painel/faces/
     - Fotos borradas:  projeto/painel/blurred/
     - Banco:           projeto/database/painel.db
   Atenção: em serviços com disco efêmero (ex.: Render free), o
   conteúdo local é perdido a cada deploy/reinício.
   ============================================================ */

const path = require('path');
const fs = require('fs');

const FACES_DIR = path.join(__dirname, 'painel', 'faces');
const BLURRED_DIR = path.join(__dirname, 'painel', 'blurred');

const usingRemote = false;

// Mapeia a chave lógica para o arquivo local correspondente.
function localPathFor(key) {
  if (key.startsWith('photos/blurred/')) {
    return path.join(BLURRED_DIR, key.slice('photos/blurred/'.length));
  }
  if (key.startsWith('photos/')) {
    return path.join(FACES_DIR, key.slice('photos/'.length));
  }
  if (key.startsWith('data/')) {
    return path.join(__dirname, 'database', key.slice('data/'.length));
  }
  return path.join(__dirname, 'storage', key);
}

async function init() {
  fs.mkdirSync(FACES_DIR, { recursive: true });
  fs.mkdirSync(BLURRED_DIR, { recursive: true });
  fs.mkdirSync(path.join(__dirname, 'storage'), { recursive: true });
  console.log('[storage] Armazenamento local ativo (sem sincronização externa).');
  return { mode: 'local', bucket: null };
}

function isRemote() {
  return usingRemote;
}

function get(key) {
  return new Promise((resolve) => {
    fs.readFile(localPathFor(key), (err, buf) => (err ? resolve(null) : resolve(buf)));
  });
}

function put(key, buf) {
  return new Promise((resolve, reject) => {
    const p = localPathFor(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFile(p, buf, (err) => (err ? reject(err) : resolve(true)));
  });
}

function remove(key) {
  return new Promise((resolve) => {
    fs.unlink(localPathFor(key), () => resolve());
  });
}

function exists(key) {
  return new Promise((resolve) => {
    fs.access(localPathFor(key), fs.constants.F_OK, (err) => resolve(!err));
  });
}

function listLocal(dir, prefix, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = prefix + e.name;
    if (e.isDirectory()) listLocal(full, rel + '/', out);
    else out.push(rel);
  }
}

function list(prefix = 'photos/') {
  return new Promise((resolve) => {
    const dir = localPathFor(prefix);
    if (!fs.existsSync(dir)) return resolve([]);
    const out = [];
    try {
      listLocal(dir, prefix, out);
    } catch (e) {
      /* ignora */
    }
    resolve(out);
  });
}

// Sem remoto: retorna nulo e os chamadores caem no fallback local
// (proxy /faces/ no painel e envio por buffer no bot).
async function presignedUrl() {
  return null;
}

// Sincronizações externas: desativadas (nada é enviado/recebido).
async function uploadDbSnapshot() {
  return null;
}

async function restoreDb() {
  return false;
}

async function syncLocalPhotosToRemote() {
  /* no-op */
}

function startDbBackup() {
  /* no-op */
}

// Rotina de inicialização usada pelas entradas (deploy.js / start-all.js).
async function boot() {
  await init();
}

module.exports = {
  init,
  boot,
  isRemote,
  get,
  put,
  remove,
  exists,
  list,
  presignedUrl,
  uploadDbSnapshot,
  restoreDb,
  syncLocalPhotosToRemote,
  startDbBackup,
  FACES_DIR,
  BLURRED_DIR
};
