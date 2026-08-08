/* ============================================================
   Armazenamento persistente (Cloudflare R2 / Amazon S3)
   ------------------------------------------------------------
   - Pasta lógica: photos/  (fotos originais) e photos/blurred/ (borradas)
   - Se R2 ou S3 estiver configurado, TODAS as fotos e o backup do
     banco são gravados lá. A Render pode reiniciar/deployar à vontade.
   - Sem configuração, funciona em modo local (pasta faces/ e blurred/),
     mantendo o comportamento atual de desenvolvimento.
   ============================================================ */

const path = require('path');
const fs = require('fs');

const FACES_DIR = path.join(__dirname, 'painel', 'faces');
const BLURRED_DIR = path.join(__dirname, 'painel', 'blurred');
const DB_PATH = path.join(__dirname, 'database', 'painel.db');
const TMP_DIR = path.join(__dirname, 'tmp');

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
  if (ext === '.db') return 'application/octet-stream';
  return 'application/octet-stream';
}

// Mapeia a chave lógica para o arquivo local correspondente
// (espelha o que hoje existe em faces/ e blurred/).
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

function isImageKey(key) {
  return /\.(jpg|jpeg|png|webp)$/i.test(key);
}

function requireS3() {
  if (!client) throw new Error('Armazenamento remoto não inicializado.');
  return require('@aws-sdk/client-s3');
}

async function init() {
  const cfg = detectConfig();
  if (!cfg) {
    usingRemote = false;
    const r2vars = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
    console.log('[storage] Modo local (R2/S3 não configurado).');
    console.log('[storage] Diagnóstico R2: ' + r2vars.map((v) => `${v}=${process.env[v] ? 'SIM' : 'NÃO'}`).join(' | '));
    if (!process.env.R2_ACCOUNT_ID && !process.env.R2_BUCKET) {
      console.log('[storage] Nenhuma variável R2_* encontrada. Confirme que estão no Environment do serviço CERTO na Render e clique em Deploy após salvar.');
    }
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
    console.log(`[storage] Armazenamento persistente ativo: ${cfg.mode} (bucket=${bucket})`);
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

  if (!usingRemote) return null;
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
  if (!usingRemote) return true;
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
  if (!usingRemote) return;
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
  if (!usingRemote) return false;
  return existsRemote(key);
}

// Checa SOMENTE o armazenamento remoto (ignora cache local).
async function existsRemote(key) {
  if (!usingRemote) return false;
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

// Baixa SOMENTE do armazenamento remoto (ignora cache local).
async function getRemote(key) {
  if (!usingRemote) return null;
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await out.Body.transformToByteArray());
  } catch (e) {
    if (e && (e.name === 'NoSuchKey' || e.name === 'NotFound')) return null;
    console.error(`[storage] get remoto falhou "${key}":`, e.message);
    return null;
  }
}

// Gera uma URL assinada (presigned GET) para o objeto — o Telegram e o
// navegador baixam direto do R2/S3, sem o tráfego passar pelo servidor
// (evita estourar a banda da Render). Sem remoto ativo, retorna null.
async function presignedUrl(key, expiresIn = 3600) {
  if (!usingRemote) return null;
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

/* ==================== Backup do banco (metadados) ==================== */

let lastDbSig = { mtimeMs: 0, size: -1 };

function dbSignature() {
  try {
    const st = fs.statSync(DB_PATH);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    return null;
  }
}

// Snapshot consistente do painel.db e envio para o armazenamento.
async function uploadDbSnapshot() {
  if (!usingRemote) return null;
  try {
    const sig = dbSignature();
    if (!sig) return null;
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const tmp = path.join(TMP_DIR, `painel-snapshot-${Date.now()}.db`);
    fs.copyFileSync(DB_PATH, tmp);
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    await put('data/painel.db', buf);
    lastDbSig = sig;
    console.log('[storage] Banco de dados sincronizado para o armazenamento persistente.');
    return sig;
  } catch (e) {
    console.error('[storage] upload do banco falhou:', e.message);
    return null;
  }
}

// Restaura o painel.db do armazenamento persistente (fonte de verdade).
// Se existir backup no R2/S3, ele SEMPRE vence o arquivo local (que pode ser
// um clone antigo do repositório). Deve rodar ANTES de qualquer módulo abrir o banco.
async function restoreDb() {
  if (!usingRemote) return false;
  const hasBackup = await existsRemote('data/painel.db');
  if (!hasBackup) {
    console.log('[storage] Nenhum backup do banco no armazenamento (primeira execução). Mantendo o local.');
    return false;
  }
  const buf = await getRemote('data/painel.db');
  if (!buf) {
    console.log('[storage] Falha ao baixar o backup do banco. Mantendo o local.');
    return false;
  }
  try {
    fs.writeFileSync(DB_PATH, buf);
    const sig = dbSignature();
    lastDbSig = sig;
    console.log('[storage] Banco de dados restaurado do armazenamento persistente.');
    return true;
  } catch (e) {
    console.error('[storage] falha ao restaurar o banco:', e.message);
    return false;
  }
}

// Sobe fotos locais que ainda não estão no armazenamento remoto
// (migração automática das fotos existentes no repositório).
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

// Loop que envia o banco a cada alteração (por assinatura de arquivo).
function startDbBackup(intervalMs) {
  if (!usingRemote) return;
  const ms = intervalMs || 5000;
  setInterval(async () => {
    try {
      const sig = dbSignature();
      if (!sig) return;
      if (sig.mtimeMs !== lastDbSig.mtimeMs || sig.size !== lastDbSig.size) {
        await uploadDbSnapshot();
      }
    } catch (e) { /* ignora */ }
  }, ms);
  process.on('SIGTERM', () => { uploadDbSnapshot().catch(() => {}); });
  process.on('SIGINT', () => { uploadDbSnapshot().catch(() => {}); });
}

// Rotina de inicialização usada pelas entradas (deploy.js / start-all.js).
// Restaura o banco e migra fotos ANTES de os serviços serem carregados.
async function boot() {
  await init();
  await restoreDb();
  await syncLocalPhotosToRemote();
  if (usingRemote) {
    await uploadDbSnapshot();
    startDbBackup();
  }
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
