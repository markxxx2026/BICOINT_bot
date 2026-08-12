/* ============================================================
   Importação via planilha Excel vinculada à numeração das fotos
   ------------------------------------------------------------
   Fluxo:
   Excel (parse) -> colunas reconhecidas -> normalização
   -> identificação dos números das fotos -> correspondência
   Excel <-> Fotos -> validação -> prévia -> confirmação -> lote

   A ligação é feita pelo NÚMERO (não pela linha). A coluna
   "Número" da planilha é casada com o número presente no nome
   do arquivo da foto (001.jpg, foto_001.png, IMG_001.jpeg...).
   ============================================================ */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const db = require('./database/db');
const faceService = require('./face-service');
const blur = require('./blur');
const storage = require('./storage');

const UPLOADS_DIR = path.join(__dirname, 'painel', 'uploads');
const STAGING_DIR = path.join(__dirname, 'painel', 'staging');
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'excel-importer.log');
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
fs.mkdirSync(LOG_DIR, { recursive: true });
const DEFAULT_PRICE = Number(process.env.PRICE_FULL_PHOTO || 10);
const CONCURRENCY = Math.max(1, Number(process.env.IMPORTER_CONCURRENCY || 2));
const PENDING_TTL_MS = 30 * 60 * 1000;
const MAX_ZIP_FILES = 10000;
const MAX_ZIP_BYTES = 300 * 1024 * 1024;

/* ==================== Log ==================== */

function log(line) {
  const stamp = new Date().toISOString();
  console.log('[excel-import] ' + line);
  try {
    fs.appendFileSync(LOG_FILE, `[${stamp}] ${line}\n`);
  } catch (e) { /* ignora */ }
}

/* ==================== Helpers de banco ==================== */

function dbGet(sql, params) {
  return new Promise((res, rej) => db.get(sql, params || [], (e, r) => (e ? rej(e) : res(r))));
}

function dbRun(sql, params) {
  return new Promise((res, rej) => db.run(sql, params || [], (e) => (e ? rej(e) : res())));
}

function dbAll(sql, params) {
  return new Promise((res, rej) => db.all(sql, params || [], (e, r) => (e ? rej(e) : res(r))));
}

/* ==================== Normalização de cabeçalhos/colunas ==================== */

function normHeader(h) {
  return String(h == null ? '' : h)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const HEADER_RULES = [
  { role: 'cpf', test: (n) => /cpf|cnpj|documento|\bdoc\b/.test(n) },
  { role: 'plataforma', test: (n) => /plataforma|aplicativo|\bapp\b/.test(n) },
  { role: 'uber', test: (n) => n === 'uber' || n === 'uberx99' },
  { role: 'x99', test: (n) => n === '99' || n === 'x99' },
  {
    role: 'numero',
    test: (n) =>
      ['numero', 'num', 'no', 'n', 'codigo', 'cod', 'id'].includes(n) ||
      /^n[º°o]?\.?$/.test(n) ||
      /^cod[ig]+o$/.test(n)
  },
  { role: 'nome', test: (n) => n === 'nome' || n === 'name' || n === 'cliente' },
  { role: 'descricao', test: (n) => /^desc/.test(n) || /^obs/.test(n) || /^nota/.test(n) }
];

function detectColumns(headerCells) {
  const map = {};
  for (let i = 0; i < headerCells.length; i++) {
    const n = normHeader(headerCells[i]);
    if (!n) continue;
    for (const rule of HEADER_RULES) {
      if (map[rule.role] !== undefined) continue;
      if (rule.test(n)) {
        map[rule.role] = i;
        break;
      }
    }
  }
  return map;
}

/* ==================== Números ==================== */

// " 001 " -> "001" (preserva zeros à esquerda para exibição).
function displayNumber(v) {
  if (v === null || v === undefined) return null;
  return String(v).trim();
}

// "001", "01" e "1" -> "1" (chave canônica de correspondência).
function normalizeNumberValue(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, '');
  if (!/^\d+$/.test(s)) return null;
  return String(parseInt(s, 10));
}

// Extrai o identificador numérico do nome do arquivo da foto.
// 001.jpg -> 1 | foto_001.png -> 1 | IMG_001.jpeg -> 1 | 125.jpg -> 125
// Evita números que fazem parte de outras informações (ex.: IMG_20250101).
function extractPhotoNumber(filename) {
  const base = String(filename).replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
  const trailing = base.match(/(?:^|[\s_-])(\d{1,6})(?:\s*)$/);
  if (trailing) return String(parseInt(trailing[1], 10));
  const all = base.match(/(?:^|[\s_-])(\d{1,6})(?=$|[\s_-])/g) || [];
  if (all.length) {
    const last = all[all.length - 1].replace(/\D/g, '');
    return String(parseInt(last, 10));
  }
  return null;
}

function maskCpf(v) {
  const s = String(v == null ? '' : v).replace(/\D/g, '');
  if (!s) return '';
  if (s.length >= 8) return s.slice(0, 3) + '***' + s.slice(-2);
  if (s.length >= 5) return s.slice(0, 2) + '***' + s.slice(-2);
  return '***';
}

function normalizePlatform(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  if (!s) return null;
  if (s.includes('uber') && (s.includes('99') || s.includes('x99'))) return 'uberx99';
  if (s.includes('uber')) return 'uber';
  if (s.includes('99')) return '99';
  return null;
}

// Interpreta o valor de uma célula das colunas "Uber"/"99" como um booleano
// "pode ser vendido": V/Sim/✅/✔/"TEM CONTA" -> true | X/Não/❌/"SEM CADASTRO"/
// em branco -> false. Qualquer texto fora desses padrões conta como "não".
function platformSellable(v) {
  const s = String(v == null ? '' : v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (!s) return false;
  if (/^(v|s|sim|yes|true|1|ok|check|tem|conta|tem conta|verdadeiro|disponivel|ativo|[\u2705\u2713\u2714\u2611])$/.test(s)) return true;
  return false;
}

// Combina as colunas "Uber" e "99" (V/X) em uma plataforma única:
// V+V -> uberx99 | V+X -> uber | X+V -> 99 | X+X -> null.
function plataformaDeColunas(vUber, v99) {
  const uberOk = platformSellable(vUber);
  const n99Ok = platformSellable(v99);
  if (uberOk && n99Ok) return 'uberx99';
  if (uberOk) return 'uber';
  if (n99Ok) return '99';
  return null;
}

function prettyStem(name) {
  return String(name)
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ==================== Leitura da planilha ==================== */

function parseExcel(buf) {
  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellNF: false });
  } catch (e) {
    throw new Error('Não foi possível ler o arquivo Excel. Verifique se ele é válido (.xlsx ou .xls).');
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('A planilha está vazia.');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null, blankrows: false });
  if (!aoa.length) throw new Error('A planilha está vazia.');
  const headerCells = aoa.shift();
  const colMap = detectColumns(headerCells);
  if (colMap.numero === undefined) {
    throw new Error('A coluna "Número" não foi encontrada. Utilize o modelo Excel fornecido pelo sistema.');
  }

  const get = (row, idx) => {
    const v = row[idx];
    if (v === null || v === undefined) return null;
    return String(v).trim();
  };

  const records = aoa.map((row, i) => {
    const numeroRaw = get(row, colMap.numero);
    return {
      line: i + 2,
      numero: normalizeNumberValue(numeroRaw),
      numeroDisplay: displayNumber(numeroRaw),
      nome: colMap.nome !== undefined ? get(row, colMap.nome) : null,
      cpf: colMap.cpf !== undefined ? get(row, colMap.cpf) : null,
    descricao: colMap.descricao !== undefined ? get(row, colMap.descricao) : null,
    plataforma: colMap.plataforma !== undefined
      ? get(row, colMap.plataforma)
      : colMap.uber !== undefined || colMap.x99 !== undefined
        ? plataformaDeColunas(get(row, colMap.uber), get(row, colMap.x99))
        : null
  };
  });

  return { records, colMap };
}

/* ==================== Descoberta de fotos ==================== */

function scanPhotos(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const en of entries) {
      const full = path.join(d, en.name);
      if (en.isDirectory()) walk(full);
      else if (en.isFile() && IMAGE_RE.test(en.name)) {
        out.push({ name: en.name, full, rel: path.relative(dir, full) });
      }
    }
  };
  walk(dir);
  return out;
}

/* ==================== Upload em conjunto (zip + Excel) ==================== */

function sanitizeEntryName(name) {
  let n = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  if (/\.\.(\/|$)/.test(n)) return null;
  if (/^[a-zA-Z]:/.test(n)) return null;
  return n;
}

// Extrai as fotos numeradas de um .zip para uma pasta de staging (fora do
// uploads monitorado pelo importador automático). Retorna { dir, photos }.
// As fotos só entram no catálogo quando a importação for confirmada.
function extractZipPhotos(zipSrc) {
  let zip;
  try {
    if (typeof zipSrc === 'string' && fs.existsSync(zipSrc) && fs.statSync(zipSrc).size > MAX_ZIP_BYTES) {
      throw new Error('O .zip é grande demais (máximo de 300 MB de fotos).');
    }
    const buf = Buffer.isBuffer(zipSrc) ? zipSrc : fs.readFileSync(zipSrc);
    zip = new AdmZip(buf);
  } catch (e) {
    throw new Error('Não foi possível ler o arquivo .zip. Verifique se ele é válido.');
  }
  const entries = zip.getEntries().filter((en) => !en.isDirectory);
  if (!entries.length) throw new Error('O arquivo .zip está vazio.');

  fs.mkdirSync(STAGING_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(STAGING_DIR, 'zip-'));
  let count = 0;
  let total = 0;
  const photos = [];
  for (const en of entries) {
    const rel = sanitizeEntryName(en.entryName);
    if (!rel || !IMAGE_RE.test(rel)) continue;
    const base = path.basename(rel);
    if (base.startsWith('._') || base.startsWith('.')) continue; // AppleDouble/lixo
    if (++count > MAX_ZIP_FILES) {
      cleanupStaging(dir);
      throw new Error(`O .zip contém mais de ${MAX_ZIP_FILES} fotos. Envie em lotes menores.`);
    }
    total += Number(en.header.size || 0);
    if (total > MAX_ZIP_BYTES) {
      cleanupStaging(dir);
      throw new Error('O .zip é grande demais (máximo de 300 MB de fotos).');
    }
    const relPath = path.join(dir, rel);
    fs.mkdirSync(path.dirname(relPath), { recursive: true });
    fs.writeFileSync(relPath, en.getData());
    photos.push({ name: path.basename(rel), full: relPath, rel });
  }
  if (!photos.length) {
    cleanupStaging(dir);
    throw new Error('Nenhuma foto (.jpg/.jpeg/.png/.webp) encontrada dentro do .zip.');
  }
  return { dir, photos };
}

function cleanupStaging(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { /* ignora */ }
}

// Remove todas as pastas de staging (ex.: restos de sessões/previews antigas).
function purgeStaging() {
  try {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
    for (const en of fs.readdirSync(STAGING_DIR)) {
      cleanupStaging(path.join(STAGING_DIR, en));
    }
  } catch (e) { /* ignora */ }
}

/* ==================== Prévia ==================== */

async function buildPreview(buf, filename, opts = {}) {
  const photosDir = opts.photosDir || UPLOADS_DIR;
  const includeFaces = opts.includeFaces !== false;
  const parsed = parseExcel(buf);

  const photos = scanPhotos(photosDir);
  const photosByNum = new Map();
  photos.forEach((p) => {
    const n = extractPhotoNumber(p.name);
    if (n) {
      if (!photosByNum.has(n)) photosByNum.set(n, []);
      photosByNum.get(n).push(p);
    }
  });

  const existingById = new Map();
  if (includeFaces) {
    const faces = await dbAll('SELECT id, name FROM faces');
    faces.forEach((f) => existingById.set(String(f.id), f));
  }

  const excelByNum = new Map();
  const dupExcelNums = new Set();
  parsed.records.forEach((r) => {
    if (!r.numero) return;
    if (excelByNum.has(r.numero)) dupExcelNums.add(r.numero);
    else excelByNum.set(r.numero, r);
  });

  const dupPhotoNums = new Set(
    [...photosByNum.entries()].filter(([, arr]) => arr.length > 1).map(([n]) => n)
  );

  const records = parsed.records.map((r) => {
    const n = r.numero;
    let status;
    let photo = null;
    if (!n) status = 'sem-numero';
    else if (dupExcelNums.has(n)) status = 'dup-excel';
    else if (dupPhotoNums.has(n)) {
      status = 'dup-foto';
      photo = photosByNum.get(n)[0];
    } else {
      const ph = (photosByNum.get(n) || [])[0];
      const existing = existingById.get(n);
      if (ph && existing) {
        status = 'atualizar';
        photo = ph;
      } else if (ph) {
        status = 'ok';
        photo = ph;
      } else {
        status = 'sem-foto';
      }
    }
    return { ...r, status, photo };
  });

  const photosWithoutExcel = photos.filter((p) => {
    const n = extractPhotoNumber(p.name);
    if (!n) return true;
    return !excelByNum.has(n);
  });

  const matches = records.filter((r) => r.status === 'ok' || r.status === 'atualizar');
  const summary = {
    fotosEncontradas: photos.length,
    registrosExcel: records.length,
    correspondencias: matches.length,
    fotosSemExcel: photosWithoutExcel.length,
    excelSemFoto: records.filter((r) => r.status === 'sem-foto').length,
    erros: records.filter((r) => r.status === 'dup-excel' || r.status === 'dup-foto' || r.status === 'sem-numero').length,
    bloqueados: new Set([
      ...dupExcelNums,
      ...dupPhotoNums,
      ...records.filter((r) => r.status === 'sem-numero').map(() => 'x')
    ]).size
  };

  const table = records.map((r) => ({
    status: r.status,
    foto: r.photo ? r.photo.name : null,
    numeroDisplay: r.numeroDisplay,
    nome: r.nome,
    cpfMasked: maskCpf(r.cpf),
    descricao: r.descricao,
    plataforma: r.plataforma
  }));

  const rows = records
    .filter((r) => r.status === 'ok' || r.status === 'atualizar')
    .map((r) => ({
      status: r.status,
      numero: r.numero,
      numeroDisplay: r.numeroDisplay,
      nome: r.nome,
      cpf: r.cpf,
      descricao: r.descricao,
      plataforma: r.plataforma,
      foto: r.photo.name,
      relPath: r.photo.full,
      rel: r.photo.rel
    }));

  return { summary, table, rows, filename, cols: parsed.colMap };
}

/* ==================== Prévia pendente (por sessão) ==================== */

const pending = new Map();
let resumeCallback = null;

setInterval(() => {
  const now = Date.now();
  for (const [token, p] of pending) {
    if (now > p.expiresAt) pending.delete(token);
  }
}, 5 * 60 * 1000).unref();

function setResumeCallback(fn) {
  resumeCallback = fn;
}

function setPending(token, data, opts = {}) {
  pending.set(token, { data, opts, expiresAt: Date.now() + PENDING_TTL_MS });
}

function getPending(token) {
  const p = pending.get(token);
  if (!p) return null;
  if (Date.now() > p.expiresAt) {
    pending.delete(token);
    return null;
  }
  return p;
}

function clearPending(token) {
  pending.delete(token);
}

/* ==================== Importação em lote ==================== */

const job = {
  running: false,
  total: 0,
  done: 0,
  ok: 0,
  failed: 0,
  current: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  cancelled: false
};

function getJobStatus() {
  return { ...job };
}

async function processItem(item) {
  const id = Number(item.numero);
  const buf = fs.readFileSync(item.relPath);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const existing = await dbGet('SELECT id FROM faces WHERE id = ?', [id]);
  const name = (item.nome && item.nome.trim()) || prettyStem(item.foto);
  const platform = normalizePlatform(item.plataforma);

  if (!existing) {
    let embedding = null;
    try {
      embedding = await faceService.extractEmbedding(buf);
    } catch (e) {
      log(`Erro ao extrair rosto de ${item.foto}: ${e.message}`);
      embedding = null;
    }
    const ok = await storage.put('photos/' + item.foto, buf);
    if (!ok) throw new Error(`Falha ao salvar a foto ${item.foto} no armazenamento.`);
    blur.cacheBlurred(item.foto).catch(() => {});
    await dbRun(
      `INSERT INTO faces (id, name, photo, embedding, gender, vehicle, platform, description, cpf, category, price, photo_hash)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?)`,
      [id, name, item.foto, embedding ? JSON.stringify(embedding) : '[]', platform, item.descricao || null, item.cpf || null, DEFAULT_PRICE, hash]
    );
    log(`Cadastrada face #${id} (${item.foto}) da planilha | nome="${name}" plataforma="${platform || '—'}"`);
  } else {
    await dbRun(
      'UPDATE faces SET name = ?, platform = ?, description = ?, cpf = ? WHERE id = ?',
      [name, platform || null, item.descricao || null, item.cpf || null, id]
    );
    log(`Atualizada face #${id} com dados da planilha | nome="${name}" plataforma="${platform || '—'}"`);
  }

  // Remove a original do uploads (e o JSON sidecar) para o importador
  // automático não reprocessar/re-cadastrar a mesma foto.
  try {
    if (fs.existsSync(item.relPath)) fs.unlinkSync(item.relPath);
  } catch (e) { /* ignora */ }
  try {
    const jsonSidecar = path.join(path.dirname(item.relPath), path.basename(item.foto, path.extname(item.foto)) + '.json');
    if (fs.existsSync(jsonSidecar)) fs.unlinkSync(jsonSidecar);
  } catch (e) { /* ignora */ }
}

function startImport(rows, opts = {}) {
  if (job.running) return false;
  const items = rows || [];
  job.running = true;
  job.total = items.length;
  job.done = 0;
  job.ok = 0;
  job.failed = 0;
  job.current = null;
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.lastError = null;
  job.cancelled = false;

  log(`Iniciando importação de ${items.length} registro(s) da planilha.`);

  const promise = (async () => {
    let index = 0;
    const worker = async () => {
      while (index < items.length && !job.cancelled) {
        const item = items[index++];
        job.current = item.foto;
        try {
          await processItem(item);
          job.ok++;
        } catch (e) {
          job.failed++;
          job.lastError = e.message;
          log(`Falha ao importar ${item.foto}: ${e.message}`);
        }
        job.done++;
      }
    };
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
    job.current = null;
    job.finishedAt = new Date().toISOString();
    job.running = false;
    log(`Importação concluída: ${job.ok} ok, ${job.failed} falha(s).`);
    if (opts.onDone) {
      try { await opts.onDone(); } catch (e) { log(`Falha no onDone: ${e.message}`); }
    }
    if (resumeCallback) resumeCallback();
    return { ok: job.ok, failed: job.failed };
  })();

  return promise;
}

function cancelJob() {
  if (!job.running) return false;
  job.cancelled = true;
  log('Cancelamento solicitado — aguardando workers pararem.');
  return true;
}

/* ==================== Modelo Excel ==================== */

function generateTemplate() {
  const data = XLSX.utils.aoa_to_sheet([
    ['Número', 'Nome', 'CPF', 'Descrição', 'Plataforma'],
    ['001', 'João Silva', '00000000000', 'Cliente ativo', 'Uber'],
    ['002', 'Maria Souza', '11111111111', 'Cliente novo', '99']
  ]);
  data['!cols'] = [{ wch: 12 }, { wch: 22 }, { wch: 16 }, { wch: 32 }, { wch: 14 }];

  const instr = XLSX.utils.aoa_to_sheet([
    ['IMPORTANTE'],
    [''],
    ['A coluna NÚMERO é a responsável pela ligação com a foto.'],
    ['Ex.: 001  ->  a foto 001.jpg (ou foto_001.png, IMG_001.jpeg...)'],
    [''],
    ['A correspondência é feita pelo número, não pela linha.'],
    ['Colunas reconhecidas: Número, Nome, CPF, Descrição, Plataforma.'],
    ['Preencha os dados na aba "Dados" e importe o arquivo na página de Importação.']
  ]);
  instr['!cols'] = [{ wch: 62 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, data, 'Dados');
  XLSX.utils.book_append_sheet(wb, instr, 'Instruções');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  extractPhotoNumber,
  normalizeNumberValue,
  displayNumber,
  maskCpf,
  normalizePlatform,
  detectColumns,
  parseExcel,
  buildPreview,
  extractZipPhotos,
  cleanupStaging,
  purgeStaging,
  setPending,
  getPending,
  clearPending,
  startImport,
  cancelJob,
  getJobStatus,
  setResumeCallback,
  generateTemplate,
  UPLOADS_DIR,
  STAGING_DIR
};
