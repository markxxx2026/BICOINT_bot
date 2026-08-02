/* ============================================================
   Miniapp API — rotas da loja do Telegram Mini App
   Autenticação: validação do Telegram WebApp initData
   (HMAC-SHA256 com o token do bot). Nada de login próprio.
   ============================================================ */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const db = require('../database/db');
const asaas = require('../asaas');
const faceService = require('../face-service');
const blur = require('../blur');

const router = express.Router();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PRICE = Number(process.env.PRICE_FULL_PHOTO || 10);

/* ---------- Validação do initData do Telegram ---------- */
function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (e) {
    return null;
  }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  // Constroi a data_check_string: pares ordenados "chave=valor"
  const dataCheckString = [...params.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (calcHash !== hash) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;
  try {
    return JSON.parse(userRaw);
  } catch (e) {
    return null;
  }
}

/* ---------- Middleware de autenticação ---------- */
router.use((req, res, next) => {
  const initData =
    req.headers['x-init-data'] ||
    (req.body && req.body.initData) ||
    (req.query && req.query.initData);
  const user = validateInitData(initData);
  if (!user || !user.id) {
    if (!process.env.MINIAPP_AUTH_SILENT) {
      console.warn(
        `[miniapp] AUTH falhou: ${req.method} ${req.path} | header present=${!!req.headers['x-init-data']} | ` +
        `len=${initData ? String(initData).length : 0} | hash present=${initData ? String(initData).includes('hash=') : false}`
      );
    }
    return res.status(401).json({ ok: false, error: 'Não autenticado via Telegram.' });
  }
  req.tgUser = user;
  next();
});

const q = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );

/* ---------- GET /products — produtos da loja ---------- */
router.get('/products', async (req, res) => {
  try {
    const rows = await q(
      `SELECT id, name, description, photo, gender, vehicle, platform
       FROM faces
       WHERE COALESCE(sold, 0) = 0 AND COALESCE(antecedentes, 0) = 0
       ORDER BY id`
    );
    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description || '',
      photo: r.photo,
      category: r.gender || 'geral',
      vehicle: r.vehicle || '',
      platform: r.platform || '',
      price: PRICE
    }));
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------- GET /me — perfil e saldo ---------- */
router.get('/me', async (req, res) => {
  try {
    const chatId = req.tgUser.id;
    const rows = await q('SELECT COALESCE(SUM(credits), 0) AS credits FROM balances WHERE chat_id = ?', [chatId]);
    res.json({
      ok: true,
      id: chatId,
      first_name: req.tgUser.first_name || '',
      username: req.tgUser.username || '',
      photo_url: req.tgUser.photo_url || '',
      balance: rows.length ? rows[0].credits : 0
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------- GET /orders — pedidos do usuário ---------- */
router.get('/orders', async (req, res) => {
  try {
    const rows = await q(
      `SELECT u.id, u.face_id, u.status, u.amount, u.created_at, f.name, f.photo
       FROM unlocks u
       JOIN faces f ON f.id = u.face_id
       WHERE u.chat_id = ?
       ORDER BY u.id DESC
       LIMIT 50`,
      [req.tgUser.id]
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------- GET /statement — extrato da carteira ---------- */
router.get('/statement', async (req, res) => {
  try {
    const chatId = req.tgUser.id;
    const rows = await q(
      `SELECT 'recarga' AS tipo, id, amount, created_at FROM refills WHERE chat_id = ?
       UNION ALL
       SELECT 'compra' AS tipo, id, amount, created_at FROM unlocks WHERE chat_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 50`,
      [chatId, chatId]
    );
    const items = rows.map((r) => ({
      id: r.id,
      credits: r.tipo === 'recarga' ? r.amount : -Math.abs(r.amount),
      desc: r.tipo === 'recarga' ? 'Depósito PIX' : 'Compra de bico',
      created_at: r.created_at
    }));
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------- POST /search — puxada (busca por similaridade) ---------- */
router.post('/search', async (req, res) => {
  const { photo_base64, gender, vehicle, platform, similarity, limit } = req.body || {};
  if (!photo_base64) {
    return res.status(400).json({ ok: false, error: 'Envie uma foto para buscar.' });
  }
  const buffer = Buffer.from(String(photo_base64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (!buffer.length) {
    return res.status(400).json({ ok: false, error: 'Foto inválida ou vazia.' });
  }

  let embedding;
  try {
    embedding = await faceService.extractEmbedding(buffer, { inputSize: 224 });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Erro ao processar a foto: ' + err.message });
  }
  if (!embedding) {
    return res.status(400).json({ ok: false, error: 'Nenhum rosto encontrado na foto. Tente outra imagem.' });
  }

  try {
    const where = ['COALESCE(sold, 0) = 0', 'COALESCE(antecedentes, 0) = 0'];
    const params = [];
    if (gender) {
      where.push('gender = ?');
      params.push(gender);
    }
    if (vehicle) {
      if (String(vehicle).includes(',')) {
        const list = String(vehicle).split(',').map((v) => v.trim()).filter(Boolean);
        where.push('vehicle IN (' + list.map(() => '?').join(', ') + ')');
        params.push(...list);
      } else {
        where.push('vehicle = ?');
        params.push(vehicle);
      }
    }
    if (platform) {
      if (platform === 'uber' || platform === '99') {
        where.push('(platform = ? OR platform = ?)');
        params.push(platform, 'uberx99');
      } else {
        where.push('platform = ?');
        params.push(platform);
      }
    }

    const rows = await q('SELECT * FROM faces WHERE ' + where.join(' AND '), params);
    if (!rows.length) {
      return res.json({ ok: true, items: [], best: null, total: 0, message: 'Nenhuma face encontrada com esses filtros.' });
    }

    const scored = rows
      .map((face) => {
        const stored = JSON.parse(face.embedding);
        const dist = faceService.euclideanDistance(embedding, stored);
        const sim = Math.max(0, Math.min(100, Math.round((1 - dist / 2) * 100)));
        return { face, sim };
      })
      .sort((a, b) => b.sim - a.sim || a.face.id - b.face.id);

    const min = similarity && similarity !== 'top' ? parseInt(similarity, 10) : 0;
    const filtered = min ? scored.filter((x) => x.sim >= min) : scored;
    if (!filtered.length) {
      return res.json({
        ok: true,
        items: [],
        best: null,
        total: 0,
        message: `Nenhum rosto com similaridade ≥ ${min}% foi encontrado. Melhor resultado: ${scored[0].sim}%.`
      });
    }

    const top = filtered.slice(0, Math.min(limit || 5, 10));
    await Promise.all(top.map((x) => blur.ensureBlurred(x.face.photo).catch(() => null)));

    const map = (x) => ({
      id: x.face.id,
      name: x.face.name,
      similarity: x.sim,
      photo: x.face.photo,
      blurred: '/blurred/' + x.face.photo.replace(/\.[^.]+$/, '') + '.jpg',
      category: x.face.gender || 'geral',
      vehicle: x.face.vehicle || '',
      platform: x.face.platform || '',
      price: PRICE
    });
    const items = top.map(map);
    res.json({ ok: true, items, best: items[0], total: filtered.length, message: null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------- POST /buy — comprar com saldo ---------- */
router.post('/buy', (req, res) => {
  const chatId = req.tgUser.id;
  const productId = Number(req.body.product_id);
  if (!productId) return res.status(400).json({ ok: false, error: 'product_id obrigatório.' });

  db.get('SELECT * FROM faces WHERE id = ?', [productId], (err, face) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!face) return res.status(404).json({ ok: false, error: 'Produto não encontrado.' });
    if (face.sold) return res.status(409).json({ ok: false, error: 'Produto já vendido.' });
    if (face.antecedentes) return res.status(409).json({ ok: false, error: 'Produto indisponível.' });

    db.get('SELECT COALESCE(SUM(credits), 0) AS credits FROM balances WHERE chat_id = ?', [chatId], (err2, bal) => {
      if (err2) return res.status(500).json({ ok: false, error: err2.message });
      if (!bal || bal.credits < PRICE) {
        return res.status(402).json({ ok: false, error: 'Saldo insuficiente. Adicione saldo.' });
      }
      const novo = bal.credits - PRICE;
      // SQLite em modo serializado: BEGIN/UPDATE/INSERT/COMMIT rodam em ordem
      db.run('BEGIN TRANSACTION');
      db.run('UPDATE balances SET credits = ? WHERE chat_id = ?', [novo, chatId]);
      db.run('UPDATE faces SET sold = 1 WHERE id = ?', [productId]);
      db.run(
        "INSERT INTO unlocks (chat_id, face_id, amount, status, notified) VALUES (?, ?, 0, 'pago', 0)",
        [chatId, productId],
        (err3) => {
          if (err3) {
            db.run('ROLLBACK');
            return res.status(500).json({ ok: false, error: err3.message });
          }
          db.run('COMMIT');
          res.json({ ok: true, balance: novo, photo: true, description: face.description || '' });
        }
      );
    });
  });
});

/* ---------- POST /add-balance — gerar PIX (Asaas) ---------- */
router.post('/add-balance', async (req, res) => {
  const chatId = req.tgUser.id;
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  if (!amount || amount < 5) {
    return res.status(400).json({ ok: false, error: 'Valor mínimo de R$ 5,00.' });
  }
  if (!process.env.ASAAS_API_KEY) {
    return res.status(500).json({ ok: false, error: 'Pagamento PIX não configurado.' });
  }
  try {
    const externalReference = `REFILL${chatId}_${Date.now()}`;
    const payment = await asaas.createPixPayment({
      chatId,
      value: amount,
      externalReference,
      description: `Recarga Mini App R$ ${amount.toFixed(2).replace('.', ',')}`
    });
    const qr = await asaas.getPixQrCode(payment.id);
    db.run(
      "INSERT INTO refills (chat_id, amount, asaas_id, status) VALUES (?, ?, ?, 'pendente')",
      [chatId, amount, payment.id],
      function (err) {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        res.json({
          ok: true,
          refill_id: this && this.lastID,
          payload: qr.payload || null,
          qr_base64: String(qr.encodedImage || '').replace(/^data:image\/\w+;base64,/, '')
        });
      }
    );
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
