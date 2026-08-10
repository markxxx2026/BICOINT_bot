/* ============================================================
   Armazenamento: R2/S3 para MÍDIA + banco 100% local
   ------------------------------------------------------------
   - Fotos (photos/ e photos/blurred/): enviadas para o R2/S3 e
     servidas por URL assinada (presigned) — o Telegram e o
     navegador baixam direto do bucket, sem consumir a banda da
     Render. Cache local em faces/ e blurred/ como fallback.
   - Banco (painel.db): SEMPRE local, no disco da instância.
     NENHUM backup, push ou pull do banco para o R2/S3.
     Chaves `data/` são forçadas a ficar locais (guarda rígida) e
     nunca são mapeadas para o banco nem enviadas ao bucket.
   ============================================================ */

const path = require('path');
const fs = require('fs');

const FACES_DIR = path.join(__dirname, 'painel', 'faces');
const BLURRED_DIR = path.join(__dirname, 'painel', 'blurred');

let client = null;
let bucket = null;
let usingRemote = false;

function detectConfig() {
  if (
    process.env.R2_BUCKET &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_ACCOUNT_ID
  ) {
    return {
      mode: 'R2',
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      bucket: process.env.R2_BUCKET,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    };
  }
  if (
    process.env.S3_BUCKET &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY
  ) {
    return {
      mode: 'S3',
      region: process.env.S3_REGION || 'us-east-1',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: false,
      bucket: process.env.S3_BUCKET,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    };
  }
  return null;
}

function contentTypeFor(key) {
  const ext = path.extname(key).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

// Mapeia a chave lógica para o arquivo local correspondente.
// O banco (painel.db) NÃO passa por aqui: nenhuma chave `data/` existe no
// storage.js — o banco é sempre manipulado diretamente pelo painel.
function localPathFor(key) {
  if (key.startsWith('photos/blurred/')) {
    return path.join(BLURRED_DIR, key.slice('photos/blurred/'.length));
  }
  if (key.startsWith('photos/')) {
    return path.join(FACES_DIR, key.slice('photos/'.length));
  }
  return path.join(__dirname, 'storage', key);
}

function isImageKey(key) {
  return /\.(jpg|jpeg|png|webp)$/i.test(key);
}

// Guarda rígida: o banco (data/) NUNCA vai para o armazenamento remoto.
function isRemoteAllowed(key) {
  return !String(key).startsWith('data/');
}

async function init() {
  const cfg = detectConfig();
  fs.mkdirSync(FACES_DIR, { recursive: true });
  fs.mkdirSync(BLURRED_DIR, { recursive: true });
  if (!cfg) {
    usingRemote = false;
    client = null;
    bucket = null;
    const r2vars = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
    console.log('[storage] Modo local (R2/S3 não configurado).');
    console.log('[storage] Diagnóstico R2: ' + r2vars.map((v) => `${v}=${process.env[v] ? 'SIM' : 'NÃO'}`).join(' | '));
    return;
  }
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: cfg.credentials
    });
    bucket = cfg.bucket;
    usingRemote = true;
    console.log(`[storage] R2/S3 ativo para MÍDIA (bucket=${bucket}); banco permanece 100% local.`);
    try {
      const { HeadBucketCommand } = require('@aws-sdk/client-s3');
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      console.log('[storage] Conexão com o bucket verificada.');
    } catch (e) {
      console.error('[storage] AVISO: bucket não acessível ainda:', e.message);
    }
  } catch (e) {
    usingRemote = false;
    client = null;
    console.error('[storage] Falha ao inicializar armazenamento remoto:', e.message);
  }
}

function isRemote() {
  return usingRemote;
}

async function get(key) {
  const lp = localPathFor(key);
  try {
    if (fs.existsSync(lp)) return fs.readFileSync(lp);
  } catch (e) { /* ignora */ }

  if (!usingRemote || !isRemoteAllowed(key)) return null;
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const buf = Buffer.from(await out.Body.transformToByteArray());
    try {
      fs.mkdirSync(path.dirname(lp), { recursive: true });
      fs.writeFileSync(lp, buf);
    } catch (e) { /* cache local opcional */ }
    return buf;
  } catch (e) {
    if (e && (e.name === 'NoSuchKey' || e.name === 'NotFound')) return null;
    console.error(`[storage] get falhou "${key}":`, e.message);
    return null;
  }
}

async function put(key, buf) {
  if (!Buffer.isBuffer(buf)) {
    try { buf = Buffer.from(buf); } catch (e) { return false; }
  }
  const lp = localPathFor(key);
  try {
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, buf);
  } catch (e) {
    console.error(`[storage] cache local falhou "${key}":`, e.message);
  }
  if (!usingRemote || !isRemoteAllowed(key)) return true;
  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buf,
      ContentType: contentTypeFor(key)
    }));
    return true;
  } catch (e) {
    console.error(`[storage] put falhou "${key}":`, e.message);
    return false;
  }
}

async function remove(key) {
  const lp = localPathFor(key);
  try {
    if (fs.existsSync(lp)) fs.unlinkSync(lp);
  } catch (e) { /* ignora */ }
  if (!usingRemote || !isRemoteAllowed(key)) return;
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    console.error(`[storage] delete falhou "${key}":`, e.message);
  }
}

async function exists(key) {
  const lp = localPathFor(key);
  if (fs.existsSync(lp)) return true;
  if (!usingRemote || !isRemoteAllowed(key)) return false;
  try {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if (e && (e.name === 'NotFound' || e.name === 'NoSuchKey')) return false;
    console.error(`[storage] exists remoto falhou "${key}":`, e.message);
    return false;
  }
}

// URL assinada (presigned GET) — o Telegram e o navegador baixam direto
// do R2/S3, sem o tráfego passar pelo servidor (não consome a banda da
// Render). A URL expira e é assinada (não é um link público permanente).
async function presignedUrl(key, expiresIn = 3600) {
  if (!usingRemote || !isRemoteAllowed(key)) return null;
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
  } catch (e) {
    console.error(`[storage] presigned falhou "${key}":`, e.message);
    return null;
  }
}

async function list(prefix = 'photos/') {
  if (!usingRemote) {
    const dir = prefix === 'photos/blurred/' ? BLURRED_DIR : FACES_DIR;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => isImageKey(f))
      .map((f) => prefix + f)
      .sort();
  }
  try {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const keys = [];
    let continuation = undefined;
    do {
      const out = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuation
      }));
      for (const c of out.Contents || []) {
        if (c.Key && isImageKey(c.Key)) keys.push(c.Key);
      }
      continuation = out.NextContinuationToken;
    } while (continuation);
    return keys.sort();
  } catch (e) {
    console.error(`[storage] list falhou "${prefix}":`, e.message);
    return [];
  }
}

// Sobe fotos locais que ainda não estão no bucket (migração automática das
// fotos existentes no repositório). Só toca em mídia — nunca no banco.
async function syncLocalPhotosToRemote() {
  if (!usingRemote) return;
  try {
    const existing = new Set(await list('photos/'));
    if (!fs.existsSync(FACES_DIR)) return;
    let uploaded = 0;
    for (const f of fs.readdirSync(FACES_DIR)) {
      if (!isImageKey(f)) continue;
      const key = 'photos/' + f;
      if (existing.has(key)) continue;
      try {
        await put(key, fs.readFileSync(path.join(FACES_DIR, f)));
        uploaded++;
      } catch (e) {
        console.error(`[storage] falha ao migrar foto "${f}":`, e.message);
      }
    }
    if (uploaded > 0) console.log(`[storage] ${uploaded} foto(s) migrada(s) para o armazenamento persistente.`);
  } catch (e) {
    console.error('[storage] erro ao migrar fotos locais:', e.message);
  }
}

// Inicialização usada pelas entradas (deploy.js / start-all.js).
// Só prepara mídia: garante pastas, conecta o bucket e sobe fotos locais.
// Nenhum acesso ao banco acontece aqui.
async function boot() {
  await init();
  await syncLocalPhotosToRemote();
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
  syncLocalPhotosToRemote,
  FACES_DIR,
  BLURRED_DIR
};
