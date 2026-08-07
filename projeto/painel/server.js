require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('../database/db');
const faceService = require('../face-service');
const blur = require('../blur');
const referrals = require('../referrals');
const storage = require('../storage');
const importer = require('../importer');

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

// Fotos servidas do armazenamento persistente (R2/S3 com cache local).
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
      storage.uploadDbSnapshot().catch(() => {});
      back('Imagem salva com sucesso.', false);
    });
  });
}

app.post('/logo', auth, importUpload.single('logo'), (req, res) => handleImageUpload(req, res, 'logo'));

app.post('/logo/remove', auth, (req, res) => {
  db.run("DELETE FROM settings WHERE key IN ('logo_mime', 'logo_data')", () => {
    loadBrandSettings();
    storage.uploadDbSnapshot().catch(() => {});
    res.redirect('/config?logoMsg=' + encodeURIComponent('Logo removida.'));
  });
});

app.post('/bg', auth, importUpload.single('bg'), (req, res) => handleImageUpload(req, res, 'bg'));

app.post('/bg/remove', auth, (req, res) => {
  db.run("DELETE FROM settings WHERE key IN ('bg_mime', 'bg_data')", () => {
    loadBrandSettings();
    storage.uploadDbSnapshot().catch(() => {});
    res.redirect('/config?bgMsg=' + encodeURIComponent('Fundo removido (volta ao padrão).'));
  });
});

app.post('/loginbg', auth, importUpload.single('loginbg'), (req, res) => handleImageUpload(req, res, 'loginbg'));

app.post('/loginbg/remove', auth, (req, res) => {
  db.run("DELETE FROM settings WHERE key IN ('loginbg_mime', 'loginbg_data')", () => {
    loadBrandSettings();
    storage.uploadDbSnapshot().catch(() => {});
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

app.get('/api/importer/status', auth, (req, res) => {
  res.json(importer.getStatus());
});

const LIST_SQL = 'SELECT * FROM faces WHERE COALESCE(antecedentes, 0) = 0 ORDER BY id';

app.get('/cadastrar-face', auth, (req, res) => {
  db.all(LIST_SQL, (err, faces) => {
    if (err) return res.status(500).send(err.message);
    res.render('cadastrar-face', { error: null, success: null, faces });
  });
});

app.post('/cadastrar-face', auth, faceUpload.single('foto'), async (req, res) => {
  const render = (error, success) => {
    db.all(LIST_SQL, (err, faces) => {
      if (err) return res.status(500).send(err.message);
      res.render('cadastrar-face', { error, success, faces });
    });
  };

  if (!req.file) return render('Envie uma foto.', null);
  if (!req.body.name || !req.body.name.trim()) {
    fs.unlinkSync(req.file.path);
    return render('Preencha o nome.', null);
  }

  const filePath = req.file.path;
  try {
    const buffer = fs.readFileSync(filePath);
    const embedding = await faceService.extractEmbedding(buffer, { inputSize: 224 });
    if (!embedding) {
      fs.unlinkSync(filePath);
      return render('Nenhum rosto detectado na foto. Tente outra imagem.', null);
    }

    db.get('SELECT COALESCE(MAX(id), 1000) AS maxId FROM faces', (err, row) => {
      if (err) return render(err.message, null);
      const nextId = row.maxId + 1;
      const finalName = `${nextId}.jpg`;

      // Envia a foto para o armazenamento persistente (R2/S3) + cache local.
      storage.put('photos/' + finalName, buffer)
        .then(() => {
          blur.cacheBlurred(finalName).catch(() => {});
        })
        .then(() => {
          try { fs.unlinkSync(filePath); } catch (e) { /* já removido */ }
          db.run(
            'INSERT INTO faces (id, name, photo, embedding, gender, vehicle, platform, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [nextId, req.body.name.trim(), finalName, JSON.stringify(embedding), req.body.gender || null, req.body.vehicle || null, req.body.platform || null, req.body.description || null],
            (err2) => {
              if (err2) return render(err2.message, null);
              render(null, `Face cadastrada com ID ${nextId}.`);
            }
          );
        })
        .catch((err3) => {
          try { fs.unlinkSync(filePath); } catch (e) { /* já removido */ }
          render('Erro ao salvar a foto no armazenamento: ' + err3.message, null);
        });
    });
  } catch (err) {
    fs.unlinkSync(filePath);
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

app.get('/faces/:id/editar', auth, (req, res) => {
  const id = Number(req.params.id);
  db.get('SELECT * FROM faces WHERE id = ?', [id], (err, face) => {
    if (err) return res.status(500).send(err.message);
    if (!face) return res.status(404).send('Face não encontrada.');
    res.render('editar-face', { face, error: null, success: null });
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
    if (req.file) {
      const filePath = req.file.path;
      try {
        const buffer = fs.readFileSync(filePath);
        const emb = await faceService.extractEmbedding(buffer, { inputSize: 224 });
        if (!emb) {
          fs.unlinkSync(filePath);
          return render('Nenhum rosto detectado na nova foto. A foto original foi mantida.', null);
        }
        // Substitui a foto no armazenamento persistente (R2/S3) + cache local.
        await storage.put('photos/' + face.photo, buffer);
        blur.cacheBlurred(face.photo).catch(() => {});
        try { fs.unlinkSync(filePath); } catch (e2) { /* já removido */ }
        embedding = JSON.stringify(emb);
      } catch (e) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
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

app.post('/api/asaas/webhook', (req, res) => {
  const token = req.headers['x-webhook-token'] || req.query.token || req.body.token;
  if (token !== process.env.WEBHOOK_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Token inválido.' });
  }
  const event = req.body && req.body.event;
  const payment = req.body && req.body.payment;
  if (!payment || !payment.id) return res.status(400).json({ ok: false, error: 'payment id obrigatório.' });
  if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
    db.get('SELECT id FROM unlocks WHERE asaas_id = ?', [payment.id], (err, unlock) => {
      if (err || !unlock) {
        db.get('SELECT id FROM refills WHERE asaas_id = ?', [payment.id], (err2, refill) => {
          if (err2 || !refill) return res.json({ ok: true, found: false });
          db.run(
            "UPDATE refills SET status = 'pago', paid_at = datetime('now','localtime') WHERE id = ? AND status = 'pendente'",
            [refill.id]
          );
          db.run(
            `INSERT INTO balances (chat_id, credits, updated_at)
             VALUES (?, ?, datetime('now','localtime'))
             ON CONFLICT(chat_id) DO UPDATE SET
               credits = credits + excluded.credits,
               updated_at = datetime('now','localtime')`,
            [refill.chat_id, payment.value || 0]
          );
          referrals.creditReferralForRefill(refill.chat_id);
          res.json({ ok: true, found: true });
        });
        return;
      }
      confirmUnlock(unlock.id, () => res.json({ ok: true, found: true }));
    });
  } else {
    res.json({ ok: true });
  }
});

seedAdmin();

storage.init().catch((e) => console.error('Erro ao iniciar storage:', e.message));

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
