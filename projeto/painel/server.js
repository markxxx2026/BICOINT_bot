require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('../database/db');
const faceService = require('../face-service');
const blur = require('../blur');
const storage = require('../storage');
const importer = require('../importer');
const excelImport = require('../excel-import');

const app = express();
const PORT = process.env.PANEL_PORT || 3000;

const FACES_DIR = path.join(__dirname, 'faces');

const sessions = new Map();

function parseCookies(req) {
  const cookie = req.headers.cookie;
  if (!cookie) return {};
  return cookie.split(';').reduce((acc, part) => {
    const [key, ...rest] = part.trim().split('=');
    acc[key] = rest.join('=');
    return acc;
  }, {});
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// (O diretório uploads é a pasta do importador automático e NÃO fica exposto
// publicamente — fotos originais aguardando importação não devem ser acessíveis.)

// Fotos servidas do armazenamento local (disco).
async function serveStored(req, res, keyPrefix) {
  const file = path.basename(req.params.file || '');
  if (!file || file === '.' || file === '..') return res.status(400).send('Nome inválido.');
  const buf = await storage.get(keyPrefix + file);
  if (!buf) return res.status(404).send('Arquivo não encontrado.');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  if (/\.(png)$/i.test(file)) res.type('png');
  else if (/\.(webp)$/i.test(file)) res.type('webp');
  else res.type('jpeg');
  res.send(buf);
}

app.get('/faces/:file', (req, res) => serveStored(req, res, 'photos/'));
app.get('/blurred/:file', (req, res) => serveStored(req, res, 'photos/blurred/'));

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(test));
}

function seedAdmin() {
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASS || crypto.randomBytes(6).toString('hex');
  db.get('SELECT id FROM admins WHERE username = ?', [username], (err, row) => {
    if (err) return console.error(err);
    if (!row) {
      db.run('INSERT INTO admins (username, password) VALUES (?, ?)', [username, hashPassword(password)]);
      console.log('Admin padrão criado -> usuário:', username, '| senha:', password);
    }
  });
}

function auth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.session;
  const admin = sessions.get(token);
  if (!token || !admin) return res.redirect('/login');
  res.locals.admin = admin;
  next();
}

const upload = multer({ dest: path.join(__dirname, 'uploads') });
const faceUpload = multer({ dest: FACES_DIR });
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// --- Imagens personalizáveis: logo (login/menu), fundo da dashboard e login ----
const BRAND_KEYS = {
  logo: { mime: 'logo_mime', data: 'logo_data', prefix: 'logo' },
  bg: { mime: 'bg_mime', data: 'bg_data', prefix: 'bg' },
  loginbg: { mime: 'loginbg_mime', data: 'loginbg_data', prefix: 'loginbg' }
};

let logoDataUrl = null;
let bgDataUrl = null;
let loginBgDataUrl = null;
let brandReady = null;
function loadBrandSettings() {
  brandReady = new Promise((resolve) => {
    db.all('SELECT key, value FROM settings WHERE key IN ("logo_mime","logo_data","bg_mime","bg_data","loginbg_mime","loginbg_data")', (err, rows) => {
      const map = {};
      (rows || []).forEach((r) => { map[r.key] = r.value; });
      logoDataUrl = (map.logo_data && map.logo_mime)
        ? `data:${map.logo_mime};base64,${map.logo_data}`
        : null;
      bgDataUrl = (map.bg_data && map.bg_mime)
        ? `data:${map.bg_mime};base64,${map.bg_data}`
        : null;
      loginBgDataUrl = (map.loginbg_data && map.loginbg_mime)
        ? `data:${map.loginbg_mime};base64,${map.loginbg_data}`
        : null;
      resolve();
    });
  });
}
loadBrandSettings();

app.use((req, res, next) => {
  const p = brandReady || Promise.resolve();
  p.then(() => {
    res.locals.logo = logoDataUrl;
    res.locals.bg = bgDataUrl;
    res.locals.loginbg = loginBgDataUrl;
    next();
  });
});

function detectImageMime(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function handleImageUpload(req, res, which) {
  const { mime, data, prefix } = BRAND_KEYS[which];
  const back = (msg, isErr) =>
    res.redirect('/config?' + prefix + (isErr ? 'Error' : 'Msg') + '=' + encodeURIComponent(msg));
  if (!req.file) return back('Escolha um arquivo de imagem.', true);
  const buf = req.file.buffer;
  const mimeType = detectImageMime(buf);
  if (!mimeType) return back('Formato inválido. Use JPG, PNG ou WEBP.', true);
  const upsert = (key, value, nextFn) => db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
    nextFn
  );
  upsert(mime, mimeType, () => {
    upsert(data, buf.toString('base64'), () => {
      loadBrandSettings();
      back('Imagem salva com sucesso.', false);
    });
  });
}

app.post('/logo', auth, importUpload.single('logo'), (req, res) => handleImageUpload(req, res, 'logo'));

app.post('/logo/remove', auth, (req, res) => {
  db.run("DELETE FROM settings WHERE key IN ('logo_mime', 'logo_data')", () => {
    loadBrandSettings();
    res.redirect('/config?logoMsg=' + encodeURIComponent('Logo removida.'));
  });
});

app.post('/bg', auth, importUpload.single('bg'), (req, res) => handleImageUpload(req, res, 'bg'));

app.post('/bg/remove', auth, (req, res) => {
  db.run("DELETE FROM settings WHERE key IN ('bg_mime', 'bg_data')", () => {
    loadBrandSettings();
    res.redirect('/config?bgMsg=' + encodeURIComponent('Fundo removido (volta ao padrão).'));
  });
});

app.post('/loginbg', auth, importUpload.single('loginbg'), (req, res) => handleImageUpload(req, res, 'loginbg'));

app.post('/loginbg/remove', auth, (req, res) => {
  db.run("DELETE FROM settings WHERE key IN ('loginbg_mime', 'loginbg_data')", () => {
    loadBrandSettings();
    res.redirect('/config?loginbgMsg=' + encodeURIComponent('Fundo do login removido (volta ao preto).'));
  });
});

app.get('/', (req, res) => res.redirect('/login'));

app.get('/login', (req, res) => {
  const cookies = parseCookies(req);
  if (sessions.has(cookies.session)) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM admins WHERE username = ?', [username], (err, row) => {
    if (err) return res.status(500).render('login', { error: 'Erro interno.' });
    if (!row || !verifyPassword(password, row.password)) {
      return res.status(401).render('login', { error: 'Usuário ou senha inválidos.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, username);
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=86400`);
    res.redirect('/dashboard');
  });
});

app.get('/logout', (req, res) => {
  const cookies = parseCookies(req);
  sessions.delete(cookies.session);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/login');
});

const AVAILABLE_SQL =
  "COALESCE(antecedentes, 0) = 0 AND (" +
  "(platform IN ('uber','uberx99') AND COALESCE(sold_uber, 0) = 0) OR " +
  "(platform IN ('99','uberx99') AND COALESCE(sold_99, 0) = 0))";

app.get('/dashboard', auth, async (req, res) => {
  try {
    const q = (sql, p = []) => new Promise((res2, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res2(r))));
    const [admins, faces, sold, users, unlockRev, refillRev, pendingU, pendingR] = await Promise.all([
      q('SELECT COUNT(*) AS total FROM admins'),
      q(`SELECT COUNT(*) AS total FROM faces WHERE ${AVAILABLE_SQL}`),
      q('SELECT COUNT(*) AS total FROM faces WHERE COALESCE(sold_uber, 0) = 1 OR COALESCE(sold_99, 0) = 1'),
      q('SELECT COUNT(*) AS total FROM bot_users'),
      q("SELECT COALESCE(SUM(amount),0) AS total FROM unlocks WHERE status = 'pago'"),
      q("SELECT COALESCE(SUM(amount),0) AS total FROM refills WHERE status = 'pago'"),
      q("SELECT COUNT(*) AS total FROM unlocks WHERE status = 'pendente'"),
      q("SELECT COUNT(*) AS total FROM refills WHERE status = 'pendente'")
    ]);
    const adminsList = await new Promise((res2, rej) => db.all(
      'SELECT id, username, created_at FROM admins ORDER BY id',
      (e, r) => (e ? rej(e) : res2(r))
    ));
    const gifts = await new Promise((res2, rej) => db.all(
      'SELECT * FROM gifts ORDER BY id DESC LIMIT 20',
      (e, r) => (e ? rej(e) : res2(r))
    ));

    // Dados dos gráficos da dashboard.
    const qAll = (sql, p = []) => new Promise((res2, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res2(r))));
    const salesByPlatform = await qAll(
      `SELECT COALESCE(NULLIF(platform, ''), 'outros') AS plat, COUNT(*) AS n
       FROM unlocks WHERE status = 'pago' GROUP BY plat`
    );
    const revenueByDay = await qAll(
      `SELECT date(COALESCE(paid_at, created_at)) AS dia, COALESCE(SUM(amount), 0) AS total
       FROM unlocks WHERE status = 'pago'
       AND date(COALESCE(paid_at, created_at)) >= date('now', 'localtime', '-6 days')
       GROUP BY dia`
    );

    const platNames = { uber: 'UBER', '99': '99POP', outros: 'Outros' };
    const pieLabels = salesByPlatform.map((r) => platNames[r.plat] || r.plat);
    const pieValues = salesByPlatform.map((r) => r.n);

    const dayLabels = [];
    const dayValues = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      dayLabels.push(key);
      const row = revenueByDay.find((r) => r.dia === key);
      dayValues.push(row ? row.total : 0);
    }

    res.render('dashboard', {
      stats: {
        admins: admins.total,
        faces: faces.total,
        sold: sold.total,
        users: users.total,
        receita: (unlockRev.total || 0) + (refillRev.total || 0),
        pendentes: (pendingU.total || 0) + (pendingR.total || 0)
      },
      chartPie: { labels: JSON.stringify(pieLabels), values: JSON.stringify(pieValues) },
      chartBar: { labels: JSON.stringify(dayLabels), values: JSON.stringify(dayValues) },
      gifts,
      adminsList,
      newGift: req.query.gift || null
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/config', auth, (req, res) => {
  res.render('config', {
    logoMsg: req.query.logoMsg || null,
    logoError: req.query.logoError || null,
    bgMsg: req.query.bgMsg || null,
    bgError: req.query.bgError || null,
    loginbgMsg: req.query.loginbgMsg || null,
    loginbgError: req.query.loginbgError || null
  });
});

app.get('/cadastrar', auth, (req, res) => {
  res.render('cadastrar', { error: null, success: null });
});

app.post('/cadastrar', auth, (req, res) => {
  const { username, password, confirm } = req.body;
  if (!username || !password || !confirm) {
    return res.status(400).render('cadastrar', { error: 'Preencha todos os campos.', success: null });
  }
  if (password !== confirm) {
    return res.status(400).render('cadastrar', { error: 'As senhas não coincidem.', success: null });
  }
  if (password.length < 6) {
    return res.status(400).render('cadastrar', { error: 'A senha deve ter pelo menos 6 caracteres.', success: null });
  }
  db.run(
    'INSERT INTO admins (username, password) VALUES (?, ?)',
    [username, hashPassword(password)],
    (err) => {
      if (err) {
        const msg = err.code === 'SQLITE_CONSTRAINT' ? 'Usuário já existe.' : 'Erro ao cadastrar.';
        return res.status(400).render('cadastrar', { error: msg, success: null });
      }
      res.render('cadastrar', { error: null, success: `Admin "${username}" cadastrado com sucesso.` });
    }
  );
});

app.post('/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado.' });
  res.json({ ok: true, filename: req.file.filename });
});

// Sanitiza o caminho relativo recebido do cliente (mantém pastas p/ categoria,
// bloqueia "..", só aceita imagens).
function sanitizeRelPath(rel) {
  const parts = String(rel || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) return null;
  const filename = parts[parts.length - 1];
  if (!importer.IMAGE_RE.test(filename)) return null;
  return parts.join(path.sep);
}

// Chave de staging usada no upload DIRETO ao R2 (presigned PUT). O navegador
// gera a chave; aqui validamos que ela está sob o prefixo esperado, sem "..",
// com segmentos razoáveis e extensão de imagem — nunca confiamos no cliente.
const STAGING_PREFIX = 'staging/uploads/';
function sanitizeUploadKey(raw) {
  const s = String(raw || '').replace(/\\/g, '/');
  if (!s.startsWith(STAGING_PREFIX)) return null;
  const parts = s.split('/').filter((p) => p && p !== '.' && p !== '..');
  if (parts.length < 3) return null;
  if (parts.some((p) => p.length > 120)) return null;
  const filename = parts[parts.length - 1];
  if (!importer.IMAGE_RE.test(filename)) return null;
  return parts.join('/');
}

// Fonte do byte da foto no cadastro/edição: pode vir de um staging no R2
// (upload direto do navegador) ou do multipart legado (fallback sem R2).
async function resolveUploadPhoto(req) {
  if (req.body && req.body.stagingKey) {
    const key = sanitizeUploadKey(req.body.stagingKey);
    if (!key) return null;
    const buf = await storage.get(key);
    if (!buf) return null;
    return { buffer: buf, stagingKey: key };
  }
  if (req.file) {
    const filePath = req.file.path;
    const buffer = fs.readFileSync(filePath);
    return { buffer, filePath };
  }
  return null;
}

// Grava a foto no local final: se veio do staging, tenta CopyObject (sem
// egress da Render) e cai em get+put se a cópia falhar.
async function placePhoto(photo, key) {
  if (photo.stagingKey) {
    const copied = await storage.copyObject(photo.stagingKey, key);
    await storage.remove(photo.stagingKey).catch(() => {});
    if (copied) return;
  }
  await storage.put(key, photo.buffer);
  if (photo.stagingKey) await storage.remove(photo.stagingKey).catch(() => {});
}

// Descarta o arquivo temporário (disco do multipart ou staging no R2).
async function discardUpload(photo) {
  if (!photo) return;
  if (photo.filePath) {
    try { fs.unlinkSync(photo.filePath); } catch (e) { /* ignora */ }
  } else if (photo.stagingKey) {
    await storage.remove(photo.stagingKey).catch(() => {});
  }
}

// Adiciona uma URL pública a cada foto. Sem remoto ativo, mantém o proxy
// local /faces/ como fallback.
async function withPhotoUrls(faces) {
  return Promise.all(
    faces.map(async (f) => {
      const url = await storage.presignedUrl('photos/' + f.photo);
      return { ...f, url: url || '/faces/' + f.photo };
    })
  );
}

app.get('/importar', auth, (req, res) => {
  res.render('importer', { status: importer.getStatus(), error: null, success: null });
});

app.post('/api/importer/upload', auth, importUpload.array('files'), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado.' });

  let relpaths = [];
  try {
    relpaths = JSON.parse(req.body.relpaths || '[]');
  } catch (e) { /* segue com nomes originais */ }

  const baseDir = path.join(__dirname, 'uploads');
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const hasMeta = !!(title || description);
  const written = [];
  const skipped = [];
  files.forEach((f, i) => {
    const rel = sanitizeRelPath(relpaths[i] || f.originalname);
    if (!rel) {
      skipped.push(f.originalname);
      return;
    }
    try {
      const target = path.join(baseDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.buffer);
      if (hasMeta) {
        const jsonTarget = path.join(path.dirname(target), path.basename(target, path.extname(target)) + '.json');
        if (!fs.existsSync(jsonTarget)) {
          const meta = {};
          if (title) meta.title = title;
          if (description) meta.description = description;
          fs.writeFileSync(jsonTarget, JSON.stringify(meta));
        }
      }
      written.push(rel);
    } catch (e) {
      skipped.push(f.originalname);
    }
  });

  importer.triggerScan();
  res.json({ ok: true, written, skipped });
});

// Gera a URL assinada de UPLOAD (presigned PUT). O navegador envia o arquivo
// DIRETO para o R2 — nenhum byte de imagem passa pelo body/multipart aqui.
app.post('/api/get-upload-url', auth, (req, res) => {
  const key = sanitizeUploadKey(req.body && req.body.key);
  if (!key) return res.status(400).json({ ok: false, error: 'Chave de upload inválida.' });
  const contentType = String((req.body && req.body.contentType) || 'image/jpeg');
  storage.presignedUploadUrl(key, contentType).then((url) => {
    if (!url) {
      return res.json({ ok: false, error: 'Upload direto indisponível (R2/S3 não configurado no servidor).' });
    }
    res.json({ ok: true, url, key });
  }).catch((e) => {
    res.status(500).json({ ok: false, error: e.message });
  });
});

// Confirma imagens já enviadas ao R2 (staging) e as encaminha ao importador.
// Aqui só trafega JSON (chaves/relpaths), nunca bytes de imagem.
app.post('/api/importer/complete', auth, (req, res) => {
  const rawKeys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
  const relpaths = Array.isArray(req.body && req.body.relpaths) ? req.body.relpaths : [];
  const title = String((req.body && req.body.title) || '').trim();
  const description = String((req.body && req.body.description) || '').trim();
  const accepted = [];
  rawKeys.forEach((k, i) => {
    const key = sanitizeUploadKey(k);
    if (!key) return;
    const rel = sanitizeRelPath(relpaths[i]);
    importer.importRemote(key, rel || path.basename(key), { title, description });
    accepted.push(key);
  });
  res.json({ ok: true, queued: accepted.length });
});

app.get('/api/importer/status', auth, (req, res) => {
  res.json(importer.getStatus());
});

/* ==================== Importação via Excel ==================== */

// Limpa uma prévia antiga com fotos em staging (zip) antes de substituí-la.
function clearOldStaging(token) {
  const old = excelImport.getPending(token);
  if (old && old.opts && old.opts.stagingDir) {
    excelImport.cleanupStaging(old.opts.stagingDir);
  }
}

app.post('/api/excel/parse', auth, importUpload.single('excel'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo Excel enviado.' });
    const filename = req.file.originalname || '';
    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xls') {
      return res.status(400).json({ ok: false, error: 'Formato inválido. Envie um arquivo .xlsx ou .xls.' });
    }
    const data = await excelImport.buildPreview(req.file.buffer, filename);
    const token = parseCookies(req).session;
    clearOldStaging(token);
    excelImport.setPending(token, data);
    // Pausa o importador automático enquanto a prévia estiver aberta,
    // para ele não renomear/consumir as fotos numeradas antes da confirmação.
    importer.stop();
    res.json({
      ok: true,
      preview: { summary: data.summary, table: data.table, filename }
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Upload em conjunto: pasta de fotos (.zip) + Excel. As fotos ficam em staging
// e só entram no catálogo na confirmação (o importador automático não as vê).
const bothUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const d = path.join(excelImport.STAGING_DIR, 'tmp');
      fs.mkdirSync(d, { recursive: true });
      cb(null, d);
    },
    filename: (req, file, cb) => {
      const safe = String(file.originalname || 'arquivo').replace(/[^\w.\-]/g, '_');
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safe}`);
    }
  }),
  limits: { fileSize: 300 * 1024 * 1024, files: 2 }
});

app.post('/api/excel/import-zip', auth, bothUpload.fields([{ name: 'excel', maxCount: 1 }, { name: 'zip', maxCount: 1 }]), async (req, res) => {
  const token = parseCookies(req).session;
  let stagingDir = null;
  try {
    const excelFile = req.files && req.files.excel && req.files.excel[0];
    const zipFile = req.files && req.files.zip && req.files.zip[0];
    if (!excelFile) return res.status(400).json({ ok: false, error: 'Envie o arquivo Excel junto com o .zip.' });
    if (!zipFile) return res.status(400).json({ ok: false, error: 'Envie a pasta de fotos em .zip.' });
    if (path.extname(excelFile.originalname).toLowerCase() !== '.xlsx' && path.extname(excelFile.originalname).toLowerCase() !== '.xls') {
      return res.status(400).json({ ok: false, error: 'Excel inválido. Use .xlsx ou .xls.' });
    }
    if (path.extname(zipFile.originalname).toLowerCase() !== '.zip') {
      return res.status(400).json({ ok: false, error: 'Formato inválido. O arquivo de fotos deve ser .zip.' });
    }
    const excelBuf = fs.readFileSync(excelFile.path);
    const extracted = excelImport.extractZipPhotos(zipFile.path);
    stagingDir = extracted.dir;
    const data = await excelImport.buildPreview(excelBuf, excelFile.originalname, { photosDir: extracted.dir });
    clearOldStaging(token);
    excelImport.setPending(token, data, { stagingDir });
    importer.stop();
    res.json({
      ok: true,
      preview: { summary: data.summary, table: data.table, filename: excelFile.originalname, fotosZip: extracted.photos.length }
    });
  } catch (e) {
    if (stagingDir) excelImport.cleanupStaging(stagingDir);
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    for (const key of ['excel', 'zip']) {
      const f = req.files && req.files[key] && req.files[key][0];
      if (f) { try { fs.unlinkSync(f.path); } catch (err) { /* ignora */ } }
    }
  }
});

app.post('/api/excel/confirm', auth, (req, res) => {
  const token = parseCookies(req).session;
  const pending = excelImport.getPending(token);
  if (!pending) return res.status(400).json({ ok: false, error: 'Nenhuma prévia aguardando confirmação. Importe o Excel novamente.' });
  const stagingDir = pending.opts && pending.opts.stagingDir;
  const p = excelImport.startImport(pending.data.rows, {
    onDone: stagingDir ? () => excelImport.cleanupStaging(stagingDir) : null
  });
  if (p === false) return res.status(409).json({ ok: false, error: 'Já existe uma importação em andamento.' });
  excelImport.clearPending(token);
  res.json({ ok: true });
});

app.post('/api/excel/cancel', auth, (req, res) => {
  const token = parseCookies(req).session;
  const pending = excelImport.getPending(token);
  if (pending && pending.opts && pending.opts.stagingDir) {
    excelImport.cleanupStaging(pending.opts.stagingDir);
  }
  excelImport.clearPending(token);
  excelImport.cancelJob();
  importer.start();
  res.json({ ok: true });
});

app.get('/api/excel/status', auth, (req, res) => {
  res.json(excelImport.getJobStatus());
});

app.get('/api/excel/template', auth, (req, res) => {
  const buf = excelImport.generateTemplate();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo_importacao.xlsx"');
  res.send(buf);
});

const LIST_SQL = 'SELECT * FROM faces WHERE COALESCE(antecedentes, 0) = 0 ORDER BY id';

app.get('/cadastrar-face', auth, async (req, res) => {
  db.all(LIST_SQL, async (err, faces) => {
    if (err) return res.status(500).send(err.message);
    const withUrl = await withPhotoUrls(faces || []);
    res.render('cadastrar-face', { error: null, success: null, faces: withUrl });
  });
});

app.post('/cadastrar-face', auth, faceUpload.single('foto'), async (req, res) => {
  const render = (error, success) => {
    db.all(LIST_SQL, async (err, faces) => {
      if (err) return res.status(500).send(err.message);
      const withUrl = await withPhotoUrls(faces || []);
      res.render('cadastrar-face', { error, success, faces: withUrl });
    });
  };

  let photo = null;
  try {
    photo = await resolveUploadPhoto(req);
  } catch (e) {
    return render('Erro ao ler a foto: ' + e.message, null);
  }
  if (!photo) return render('Envie uma foto.', null);
  if (!req.body.name || !req.body.name.trim()) {
    await discardUpload(photo);
    return render('Preencha o nome.', null);
  }

  try {
    const embedding = await faceService.extractEmbedding(photo.buffer, { inputSize: 224 });
    if (!embedding) {
      await discardUpload(photo);
      return render('Nenhum rosto detectado na foto. Tente outra imagem.', null);
    }

    db.get('SELECT COALESCE(MAX(id), 1000) AS maxId FROM faces', async (err, row) => {
      if (err) return render(err.message, null);
      const nextId = row.maxId + 1;
      const finalName = `${nextId}.jpg`;

      try {
        await placePhoto(photo, 'photos/' + finalName);
        blur.cacheBlurred(finalName).catch(() => {});
        db.run(
          'INSERT INTO faces (id, name, photo, embedding, gender, vehicle, platform, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [nextId, req.body.name.trim(), finalName, JSON.stringify(embedding), req.body.gender || null, req.body.vehicle || null, req.body.platform || null, req.body.description || null],
          (err2) => {
            if (err2) return render(err2.message, null);
            render(null, `Face cadastrada com ID ${nextId}.`);
          }
        );
      } catch (err3) {
        await discardUpload(photo);
        render('Erro ao salvar a foto no armazenamento: ' + err3.message, null);
      }
    });
  } catch (err) {
    await discardUpload(photo);
    render('Erro ao processar a foto: ' + err.message, null);
  }
});

app.post('/faces/:id/delete', auth, (req, res) => {
  const id = Number(req.params.id);
  db.get('SELECT * FROM faces WHERE id = ?', [id], async (err, face) => {
    if (err) return res.status(500).send(err.message);
    if (!face) return res.status(404).send('Face não encontrada.');
    await storage.remove('photos/' + face.photo);
    await blur.deleteBlurred(face.photo);
    db.run('DELETE FROM faces WHERE id = ?', [id], (err2) => {
      if (err2) return res.status(500).send(err2.message);
      res.redirect('/cadastrar-face');
    });
  });
});

app.post('/faces/:id/antecedentes', auth, (req, res) => {
  const id = Number(req.params.id);
  db.run('UPDATE faces SET antecedentes = 1 WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).send(err.message);
    res.redirect('/cadastrar-face');
  });
});

// Marca (ou desmarca) o produto como vendido em UMA plataforma específica,
// mantendo a outra categoria ainda disponível para venda.
app.post('/faces/:id/vender', auth, (req, res) => {
  const id = Number(req.params.id);
  const platform = req.body.platform;
  const value = req.body.value === '0' ? 0 : 1;
  if (platform !== 'uber' && platform !== '99') {
    return res.status(400).send('Plataforma inválida.');
  }
  db.get('SELECT * FROM faces WHERE id = ?', [id], (err, face) => {
    if (err) return res.status(500).send(err.message);
    if (!face) return res.status(404).send('Face não encontrada.');
    const supports =
      platform === 'uber'
        ? (face.platform === 'uber' || face.platform === 'uberx99' || !face.platform)
        : (face.platform === '99' || face.platform === 'uberx99' || !face.platform);
    if (!supports) return res.status(400).send('Produto não disponível nessa plataforma.');
    const col = platform === 'uber' ? 'sold_uber' : 'sold_99';
    db.run(`UPDATE faces SET ${col} = ? WHERE id = ?`, [value, id], (err2) => {
      if (err2) return res.status(500).send(err2.message);
      res.redirect('/cadastrar-face');
    });
  });
});

// Ações em massa na listagem de faces (exclusão, antecedentes e venda),
// com a MESMA lógica das rotas individuais, para a seleção múltipla.
app.post('/faces/bulk', auth, async (req, res) => {
  let ids = req.body.ids;
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  ids = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return res.status(400).send('Nenhuma face selecionada.');
  const inClause = ids.join(',');

  if (req.body.action === 'delete') {
    db.all(`SELECT * FROM faces WHERE id IN (${inClause})`, async (err, faces) => {
      if (err) return res.status(500).send(err.message);
      try {
        for (const f of faces) {
          await storage.remove('photos/' + f.photo);
          await blur.deleteBlurred(f.photo).catch(() => {});
        }
      } catch (e) { /* falha de storage não impede a exclusão local */ }
      db.run(`DELETE FROM faces WHERE id IN (${inClause})`, (err2) => {
        if (err2) return res.status(500).send(err2.message);
        res.redirect('/cadastrar-face');
      });
    });
    return;
  }

  if (req.body.action === 'antecedentes') {
    db.run(`UPDATE faces SET antecedentes = 1 WHERE id IN (${inClause})`, (err) => {
      if (err) return res.status(500).send(err.message);
      res.redirect('/cadastrar-face');
    });
    return;
  }

  if (req.body.action === 'vender') {
    const platform = req.body.platform;
    const value = req.body.value === '0' ? 0 : 1;
    if (platform !== 'uber' && platform !== '99') {
      return res.status(400).send('Plataforma inválida.');
    }
    const col = platform === 'uber' ? 'sold_uber' : 'sold_99';
    db.all(`SELECT * FROM faces WHERE id IN (${inClause})`, (err, faces) => {
      if (err) return res.status(500).send(err.message);
      const target = faces.filter((f) =>
        platform === 'uber'
          ? (f.platform === 'uber' || f.platform === 'uberx99' || !f.platform)
          : (f.platform === '99' || f.platform === 'uberx99' || !f.platform)
      ).map((f) => f.id);
      if (!target.length) return res.redirect('/cadastrar-face');
      db.run(`UPDATE faces SET ${col} = ? WHERE id IN (${target.join(',')})`, [value], (err2) => {
        if (err2) return res.status(500).send(err2.message);
        res.redirect('/cadastrar-face');
      });
    });
    return;
  }

  res.status(400).send('Ação inválida.');
});

app.get('/faces/:id/editar', auth, (req, res) => {
  const id = Number(req.params.id);
  db.get('SELECT * FROM faces WHERE id = ?', [id], async (err, face) => {
    if (err) return res.status(500).send(err.message);
    if (!face) return res.status(404).send('Face não encontrada.');
    const url = await storage.presignedUrl('photos/' + face.photo);
    res.render('editar-face', { face: { ...face, url: url || '/faces/' + face.photo }, error: null, success: null });
  });
});

app.post('/faces/:id/editar', auth, faceUpload.single('foto'), (req, res) => {
  const id = Number(req.params.id);
  db.get('SELECT * FROM faces WHERE id = ?', [id], async (err, face) => {
    if (err) return res.status(500).send(err.message);
    if (!face) return res.status(404).send('Face não encontrada.');
    const render = (error, success) =>
      res.render('editar-face', { face: { ...face, name: (req.body.name || '').trim() }, error, success });

    const name = (req.body.name || '').trim();
    if (!name) return render('Preencha o nome.', null);

    let photo = face.photo;
    let embedding = face.embedding;
    let newUpload = null;
    try {
      newUpload = await resolveUploadPhoto(req);
    } catch (e) {
      return render('Erro ao ler a nova foto: ' + e.message, null);
    }
    if (newUpload) {
      try {
        const emb = await faceService.extractEmbedding(newUpload.buffer, { inputSize: 224 });
        if (!emb) {
          await discardUpload(newUpload);
          return render('Nenhum rosto detectado na nova foto. A foto original foi mantida.', null);
        }
        // Substitui a foto no armazenamento.
        await placePhoto(newUpload, 'photos/' + face.photo);
        blur.cacheBlurred(face.photo).catch(() => {});
        embedding = JSON.stringify(emb);
      } catch (e) {
        await discardUpload(newUpload);
        return render('Erro ao processar a nova foto: ' + e.message, null);
      }
    }

    db.run(
      'UPDATE faces SET name = ?, description = ?, gender = ?, vehicle = ?, platform = ?, photo = ?, embedding = ? WHERE id = ?',
      [name, req.body.description || null, req.body.gender || null, req.body.vehicle || null, req.body.platform || null, photo, embedding, id],
      (err2) => {
        if (err2) return render(err2.message, null);
        db.get('SELECT * FROM faces WHERE id = ?', [id], (e3, updated) => {
          if (e3 || !updated) return res.redirect('/faces/' + id + '/editar');
          res.render('editar-face', { face: updated, error: null, success: 'Produto atualizado com sucesso.' });
        });
      }
    );
  });
});

app.get('/pagamentos', auth, (req, res) => {
  db.all('SELECT * FROM unlocks ORDER BY id DESC', (err, unlocks) => {
    if (err) return res.status(500).send(err.message);
    res.render('pagamentos', { unlocks });
  });
});

app.post('/gifts/gerar', auth, (req, res) => {
  const price = Number(process.env.PRICE_FULL_PHOTO || 10);
  const code = 'GIFT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  db.run(
    'INSERT INTO gifts (code, credits, status) VALUES (?, ?, ?)',
    [code, price, 'ativo'],
    (err) => {
      if (err) return res.status(500).send(err.message);
      res.redirect('/dashboard?gift=' + encodeURIComponent(code));
    }
  );
});

function confirmUnlock(id, cb) {
  db.get('SELECT * FROM unlocks WHERE id = ?', [id], (err, unlock) => {
    if (err) return cb(err);
    if (!unlock) return cb(new Error('Pagamento não encontrado.'));
    if (unlock.status === 'pago') return cb(null, { alreadyPaid: true });
    db.run("UPDATE unlocks SET status = 'pago', paid_at = datetime('now','localtime') WHERE id = ?", [id], (err) => {
      if (err) return cb(err);
      if (unlock.face_id) {
        const col = unlock.platform === 'uber' ? 'sold_uber' : unlock.platform === '99' ? 'sold_99' : null;
        if (col) db.run(`UPDATE faces SET ${col} = 1, sold = 1 WHERE id = ?`, [unlock.face_id]);
        else db.run('UPDATE faces SET sold = 1 WHERE id = ?', [unlock.face_id]);
      }
      cb(null, { alreadyPaid: false });
    });
  });
}

app.post('/pagamentos/:id/confirmar', auth, (req, res) => {
  const id = Number(req.params.id);
  confirmUnlock(id, (err) => {
    if (err) return res.status(400).send(err.message);
    res.redirect('/pagamentos');
  });
});

app.post('/api/payments/confirm', (req, res) => {
  const token = req.headers['x-webhook-token'] || req.body.token;
  if (token !== process.env.WEBHOOK_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Token inválido.' });
  }
  const id = Number(req.body.unlock_id || req.body.id);
  if (!id) return res.status(400).json({ ok: false, error: 'unlock_id obrigatório.' });
  confirmUnlock(id, (err, result) => {
    if (err) return res.status(404).json({ ok: false, error: err.message });
    res.json({ ok: true, alreadyPaid: result.alreadyPaid });
  });
});

seedAdmin();

// Ao terminar (ou cancelar) uma importação via Excel, retoma o
// importador automático de fotos que foi pausado durante a prévia.
excelImport.setResumeCallback(() => importer.start());

// Limpa pastas de staging (zip) órfãs de sessões/previews anteriores.
excelImport.purgeStaging();

// No boot, re-fila uploads diretos que ficaram em staging (ex.: o servidor
// reiniciou durante a importação). Purga antes os órfãos mais velhos.
async function requeueStaging() {
  if (!storage.isRemote()) return;
  let keys;
  try {
    keys = await storage.list('staging/uploads/');
  } catch (e) {
    return;
  }
  for (const k of keys) {
    const rel = k.replace(/^staging\/uploads\/[^/]+\//, '');
    importer.importRemote(k, rel, {});
  }
}

storage.init()
  .catch((e) => console.error('Erro ao iniciar storage:', e.message))
  .then(() => {
    storage.purgeStaging().catch(() => {});
    requeueStaging();
  });

faceService.warmup()
  .then(() => {
    console.log('Modelos de reconhecimento pré-carregados (painel).');
    importer.start();
  })
  .catch((err) => {
    console.error('Erro ao pré-carregar modelos:', err.message);
    importer.start();
  });

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Painel rodando em http://localhost:${PORT}`);
  });
} else {
  module.exports = app;
}
