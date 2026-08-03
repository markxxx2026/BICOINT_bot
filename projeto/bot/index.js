require('dotenv').config();
const path = require('path');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const db = require('../database/db');
const faceService = require('../face-service');
const blur = require('../blur');
const asaas = require('../asaas');
const { renderPixQr } = require('../pix');
const referrals = require('../referrals');
const { morphFaces } = require('../mescla');

const token = process.env.TELEGRAM_BOT_TOKEN;
const PRICE = Number(process.env.PRICE_FULL_PHOTO || 10);

// Na nuvem (Render define PORT) ou com webhook configurado, nunca usa polling.
// Se estiver na nuvem sem TELEGRAM_WEBHOOK_URL, cai em polling (fallback) para o bot nunca ficar sem processar.
const IS_CLOUD = !!process.env.PORT;
const WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || '';

const bot = new TelegramBot(token, { polling: !(IS_CLOUD && WEBHOOK_URL) });

let BOT_USERNAME = '';
bot.getMe()
  .then((me) => { BOT_USERNAME = me.username || ''; })
  .catch(() => {});

bot.on('polling_error', (err) => {
  console.error('Erro de polling (será reconectado):', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('Erro não tratado:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Rejeição não tratada:', reason);
});

console.log('Bot iniciado com sucesso!');

db.get(
  'SELECT COUNT(*) AS total, SUM(sold) AS sold, SUM(COALESCE(antecedentes, 0)) AS ant FROM faces',
  (err, row) => {
    if (err) return console.error('[DB] erro ao contar faces:', err.message);
    const total = row ? row.total : 0;
    const disp = total - (row.sold || 0) - (row.ant || 0);
    console.log(`[DB] faces=${total} vendidas=${row.sold || 0} antecedentes=${row.ant || 0} disponiveis=${disp}`);
  }
);

faceService.warmup()
  .then(async () => {
    const photosDir = path.join(__dirname, '..', 'painel', 'faces');
    const candidates = ['1003.jpg', '1004.jpg', '1005.jpg'];
    for (const c of candidates) {
      const fp = path.join(photosDir, c);
      if (!fs.existsSync(fp)) continue;
      try {
        const t0 = Date.now();
        const emb = await faceService.extractEmbedding(fs.readFileSync(fp));
        console.log(`[SELFTEST] ${c} -> rosto ${emb ? 'OK (128)' : 'NULL'} em ${Date.now() - t0}ms`);
      } catch (e) {
        console.error(`[SELFTEST] ${c} -> ERRO: ${e.message}`);
      }
    }
  })
  .then(() => console.log('Modelos de reconhecimento pré-carregados.'))
  .catch((err) => console.error('Erro ao pré-carregar modelos:', err.message));

// Menu de filtros em InlineKeyboardMarkup
const FILTER_GROUPS = {
  gender: [
    { id: 'male', label: '👨 Homens', cb: 'gender_male' },
    { id: 'female', label: '👱 Mulheres + R$', cb: 'gender_female' }
  ],
  vehicle: [
    { id: 'both', label: '🚗🏍️ Carro e Moto', cb: 'vehicle_car_moto' }
  ],
  app: [
    { id: '99', label: '99', cb: 'app_99' },
    { id: 'uber', label: 'UBER', cb: 'app_uber' }
  ],
  name: [
    { id: 'random', label: '🎲 Nome aleatório', cb: 'name_random' },
    { id: 'first', label: '📝 Primeiro nome + ...', cb: 'name_first' }
  ],
  quality: {
    mark: '🟢',
    options: [
      { id: '40', label: '40%', cb: 'quality_40' },
      { id: '50', label: '50%', cb: 'quality_50' },
      { id: '60', label: '60%', cb: 'quality_60' },
      { id: 'top', label: 'TOP%', cb: 'quality_top' }
    ]
  }
};

const REQUIRED_FILTERS = [
  { group: 'gender', label: 'Sexo' },
  { group: 'vehicle', label: 'Veículo' },
  { group: 'app', label: 'Aplicativo' },
  { group: 'name', label: 'Nome' }
];

function defaultMenuState() {
  return { gender: null, vehicle: null, app: null, name: null, firstName: null, quality: 'top' };
}

function buildKeyboard(state) {
  const rows = Object.keys(FILTER_GROUPS).map((group) => {
    const def = FILTER_GROUPS[group];
    const opts = Array.isArray(def) ? def : def.options;
    const mark = Array.isArray(def) ? '✅' : (def.mark || '✅');
    return opts.map((opt) => {
      const selected = state[group] === opt.id;
      return {
        text: selected ? `${mark} ${opt.label}` : opt.label,
        callback_data: opt.cb,
        ...(selected ? { style: 'success' } : {})
      };
    });
  });
  rows.push([{ text: '✅ Confirmar', callback_data: 'confirm', style: 'success' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function updateSelection(state, callback) {
  for (const group of Object.keys(FILTER_GROUPS)) {
    const def = FILTER_GROUPS[group];
    const opts = Array.isArray(def) ? def : def.options;
    const opt = opts.find((o) => o.cb === callback);
    if (opt) {
      state[group] = opt.id;
      return { group, opt };
    }
  }
  return null;
}

function validateSelections(state) {
  const missing = REQUIRED_FILTERS.filter((r) => !state[r.group]);
  if (missing.length) {
    return { ok: false, missing: missing.map((r) => r.label) };
  }
  if (state.name === 'first' && !state.firstName) {
    return { ok: false, missing: ['o primeiro nome (digite o nome)'] };
  }
  return { ok: true, missing: [] };
}

function menuStateToFilters(s) {
  return {
    gender: s.gender === 'male' ? 'homem' : s.gender === 'female' ? 'mulher' : null,
    vehicle: s.vehicle === 'both' ? 'carro,moto' : null,
    platform: s.app === 'uber' ? 'uber' : s.app === '99' ? '99' : null,
    randomName: s.name === 'random',
    firstName: s.firstName,
    similarity: s.quality
  };
}

function startSearch(chatId) {
  const f = session[chatId];
  if (!f) return bot.sendMessage(chatId, 'Envie uma foto primeiro.');
  const parts = [];
  if (f.gender) parts.push(f.gender);
  if (f.vehicle) parts.push(f.vehicle);
  if (f.platform) parts.push(f.platform);
  if (f.randomName) parts.push('nome aleatório');
  if (f.firstName) parts.push('nome: ' + f.firstName);
  parts.push(f.similarity === 'top' ? 'similaridade TOP' : `similaridade ${f.similarity}%`);
  bot.sendMessage(chatId, `🔎 Buscando com: ${parts.join(', ')}...`).catch(() => {});
  return runSearch(chatId);
}

const SUPPORT_URL = 'https://t.me/alta_sc';

const MENU_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ['🔎 PROCURAR BICO'],
      ['💰 ABASTECER CRÉDITOS'],
      ['📊 TABELA DE PREÇOS'],
      ['📋 HISTÓRICO DE COMPRAS'],
      ['👥 INDIQUE E GANHE'],
      ['📞 SUPORTE']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

const RANDOM_NAMES = [
  'Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabriela',
  'Hugo', 'Isabela', 'João', 'Larissa', 'Mateus', 'Nina', 'Otávio',
  'Paula', 'Rafael', 'Sofia', 'Thiago', 'Valentina', 'Yuri'
];

const session = {};
const awaitingName = {};
const awaitingRefill = {};
const mesclaSessions = {};

function randomName() {
  return RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
}

function parseRefillValue(raw) {
  if (typeof raw !== 'string') return null;
  let v = raw.replace(/r\$\s*/i, '').trim();
  v = v.replace(/\./g, '').replace(',', '.');
  const num = parseFloat(v);
  if (!isFinite(num) || num <= 0) return null;
  return Math.round(num * 100) / 100;
}

function startRefill(chatId) {
  awaitingRefill[chatId] = true;
  bot.sendMessage(
    chatId,
    '💰 ABASTECER CRÉDITOS\n\n' +
    'Qual valor você deseja depositar?\n\n' +
    'Envie o valor, por exemplo: 50 ou 100,00\n' +
    '(depósito mínimo: R$ 5,00)'
  );
}

function showBalance(chatId) {
  db.get('SELECT COALESCE(SUM(credits), 0) AS total FROM balances WHERE chat_id = ?', [chatId], (err, row) => {
    if (err || !row) return bot.sendMessage(chatId, 'Erro ao consultar saldo.');
    const total = row.total || 0;
    bot.sendMessage(
      chatId,
      `💰 SEU SALDO\n\n` +
      `Créditos disponíveis: R$ ${total.toFixed(2).replace('.', ',')}`
    );
  });
}

async function startRefillPayment(chatId, value) {
  if (!process.env.ASAAS_API_KEY) {
    return bot.sendMessage(chatId, '⚠️ Pagamento PIX ainda não configurado. Fale com o suporte.');
  }
  if (value < 5) {
    return bot.sendMessage(chatId, '⚠️ Depósito mínimo de R$ 5,00. Envie um valor maior.');
  }
  bot.sendMessage(chatId, '🔄 Gerando QR Code PIX...').catch(() => {});
  try {
    const externalReference = `REFILL${chatId}_${Date.now()}`;
    const payment = await asaas.createPixPayment({
      chatId,
      value,
      externalReference,
      description: `Recarga de créditos R$ ${value.toFixed(2).replace('.', ',')}`
    });
    const qr = await asaas.getPixQrCode(payment.id);

    db.run(
      "INSERT INTO refills (chat_id, amount, asaas_id, status) VALUES (?, ?, ?, 'pendente')",
      [chatId, value, payment.id],
      async (err2) => {
        if (err2) return bot.sendMessage(chatId, 'Erro ao gerar o pagamento.');

        let qrBuffer;
        if (qr.encodedImage) {
          qrBuffer = Buffer.from(String(qr.encodedImage).replace(/^data:image\/\w+;base64,/, ''), 'base64');
        }
        if (!qrBuffer || !qrBuffer.length) {
          qrBuffer = await renderPixQr(qr.payload);
        }

        await bot.sendPhoto(chatId, qrBuffer, {
          caption:
            `💰 DEPÓSITO PIX\n\n` +
            `Valor: R$ ${value.toFixed(2).replace('.', ',')}\n\n` +
            `PIX Copia e Cola:\n` +
            `<code>${qr.payload}</code>\n\n` +
            `Assim que o pagamento for confirmado, os créditos serão adicionados à sua conta.`,
          parse_mode: 'HTML'
        });
      }
    );
  } catch (err2) {
    console.error('Erro ao gerar recarga:', err2.message);
    bot.sendMessage(chatId, 'Erro ao gerar o QR Code. Tente novamente.');
  }
}

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;

  // Fluxo de mescla (intercepta a foto antes da busca)
  if (mesclaSessions[chatId]) {
    return handleMesclaPhoto(chatId, msg, mesclaSessions[chatId]);
  }

  try {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    const ack = await bot.sendMessage(chatId, '📸 Foto recebida! Analisando o rosto...');

    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const tmpDir = path.join(__dirname, '..', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = await bot.downloadFile(fileId, tmpDir);
    const buffer = fs.readFileSync(filePath);
    fs.unlinkSync(filePath);

    const t0 = Date.now();
    const embedding = await faceService.extractEmbedding(buffer);
    console.log(`[FOTO] chat=${chatId} bytes=${buffer.length} resultado=${embedding ? 'OK' : 'NULL'} tempo=${Date.now() - t0}ms`);
    if (!embedding) {
      bot.deleteMessage(chatId, ack.message_id).catch(() => {});
      return bot.sendMessage(chatId, 'Não encontrei nenhum rosto na foto. Tente outra imagem.');
    }

    session[chatId] = { embedding, ...defaultMenuState() };
    bot.deleteMessage(chatId, ack.message_id).catch(() => {});
    bot.sendMessage(
      chatId,
      '📸 Foto analisada!\n\nSelecione as opções abaixo.\nQuando terminar, toque em ✅ Confirmar para buscar tudo de uma vez.',
      buildKeyboard(session[chatId])
    );
  } catch (err) {
    console.error('Erro ao processar foto:', err.message);
    bot.sendMessage(chatId, 'Erro ao processar a foto. Tente novamente.');
  }
});

async function downloadPhotoBuffer(chatId, msg) {
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const tmpDir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = await bot.downloadFile(fileId, tmpDir);
  const buffer = fs.readFileSync(filePath);
  fs.unlinkSync(filePath);
  return buffer;
}

async function handleMesclaPhoto(chatId, msg, mescla) {
  try {
    const buffer = await downloadPhotoBuffer(chatId, msg);
    if (mescla.step === 'foto1') {
      mescla.buf1 = buffer;
      mescla.step = 'foto2';
      return bot.sendMessage(chatId, '📸 1ª foto recebida (a do CLIENTE).\n\nAgora envie a 2ª foto, na ordem certa: a foto do BICO:');
    }

    bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
    const loading = await bot.sendMessage(chatId, '🔄 Mesclando os rostos...');
    try {
      const merged = await morphFaces(mescla.buf1, buffer);
      await bot.sendPhoto(chatId, merged, {
        caption: '🧬 Fusão de rosto criada!\n\n1ª foto (cliente) + 2ª foto (bico).'
      });
    } catch (err2) {
      console.error('Erro ao mesclar:', err2.message);
      await bot.sendMessage(chatId, err2.message || 'Erro ao mesclar as fotos. Envie fotos válidas e tente /mesclas novamente.');
    }
    bot.deleteMessage(chatId, loading.message_id).catch(() => {});
  } catch (err) {
    console.error('Erro no fluxo de mescla:', err.message);
    bot.sendMessage(chatId, 'Erro ao processar as fotos. Tente novamente.');
  } finally {
    delete mesclaSessions[chatId];
  }
}

async function runSearch(chatId) {
  const f = session[chatId];
  if (!f) return bot.sendMessage(chatId, 'Envie uma foto primeiro.');

  try {
    await playSearchAnimation(chatId);

    const where = ['COALESCE(sold, 0) = 0', 'COALESCE(antecedentes, 0) = 0'];
    const params = [];
    if (f.gender) { where.push('gender = ?'); params.push(f.gender); }
    if (f.vehicle) {
      if (f.vehicle.includes(',')) {
        const list = f.vehicle.split(',').map((v) => v.trim()).filter(Boolean);
        where.push('vehicle IN (' + list.map(() => '?').join(', ') + ')');
        params.push(...list);
      } else {
        where.push('vehicle = ?');
        params.push(f.vehicle);
      }
    }
    if (f.platform) {
      if (f.platform === 'uber') {
        where.push('(platform = ? OR platform = ?)');
        params.push('uber', 'uberx99');
      } else if (f.platform === '99') {
        where.push('(platform = ? OR platform = ?)');
        params.push('99', 'uberx99');
      } else {
        where.push('platform = ?');
        params.push(f.platform);
      }
    }

    const sql = 'SELECT * FROM faces WHERE ' + where.join(' AND ');

    const faces = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    if (!faces.length) return bot.sendMessage(chatId, 'Nenhuma face encontrada com esses filtros.');

    const match = faceService.findClosest(f.embedding, faces);

    if (f.similarity !== 'top') {
      const min = parseInt(f.similarity, 10);
      if (match.similarity < min) {
        return bot.sendMessage(
          chatId,
          `Nenhum rosto com similaridade ≥ ${min}% foi encontrado.\nMelhor resultado: ${match.similarity}%.`
        );
      }
    }

    const caption =
      `Encontramos uma possível correspondência.\n` +
      `📊 Similaridade: ${match.similarity}%.\n\n` +
      `Para desbloquear a foto em alta qualidade e visualizar todas as informações, realize o pagamento abaixo.`;

    bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
    const blurredPath = await blur.ensureBlurred(match.face.photo);
    if (blurredPath) {
      await bot.sendPhoto(chatId, blurredPath, {
        caption,
        reply_markup: {
          inline_keyboard: [[
            { text: '💰 Pagar e desbloquear', callback_data: `unlock:${match.face.id}`, style: 'success' }
          ]]
        }
      });
    } else {
      await bot.sendMessage(chatId, caption);
    }

    delete session[chatId];

    // QR Code PIX gerado automaticamente no momento da correspondência.
    try {
      await generatePixUnlock(chatId, match.face);
    } catch (err3) {
      console.error('Erro ao gerar PIX automático:', err3.message);
      bot.sendMessage(chatId, '⚠️ Não consegui gerar o PIX. Toque em "💰 Pagar e desbloquear" para tentar novamente.').catch(() => {});
    }
  } catch (err) {
    console.error('Erro na busca:', err.message);
    bot.sendMessage(chatId, 'Ocorreu um erro durante a busca. Tente novamente.');
  }
}

// Gera (ou reutiliza) a cobrança PIX de um produto. Evita cobranças duplicadas.
async function generatePixUnlock(chatId, face) {
  if (!process.env.ASAAS_API_KEY) {
    return bot.sendMessage(chatId, '⚠️ Pagamento PIX ainda não configurado. Fale com o suporte.');
  }
  const amount = Number(process.env.PRICE_FULL_PHOTO || 10);

  const existing = await new Promise((resolve, reject) => {
    db.get(
      "SELECT id, asaas_id FROM unlocks WHERE chat_id = ? AND face_id = ? AND status = 'pendente' AND asaas_id IS NOT NULL AND asaas_id != '' ORDER BY id DESC LIMIT 1",
      [chatId, face.id],
      (err, row) => (err ? reject(err) : resolve(row))
    );
  });

  let asaasId;
  if (existing && existing.asaas_id) {
    asaasId = existing.asaas_id;
  } else {
    const externalReference = `BICO${chatId}_${face.id}_${Date.now()}`;
    const payment = await asaas.createPixPayment({
      chatId,
      value: amount,
      externalReference,
      description: `Foto completa ${face.name} (ID ${face.id})`
    });
    asaasId = payment.id;
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO unlocks (chat_id, face_id, amount, pix_code, asaas_id, status) VALUES (?, ?, ?, ?, ?, 'pendente')`,
        [chatId, face.id, amount, null, payment.id],
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  const qr = await asaas.getPixQrCode(asaasId);
  let qrBuffer;
  if (qr.encodedImage) {
    qrBuffer = Buffer.from(String(qr.encodedImage).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  }
  if (!qrBuffer || !qrBuffer.length) {
    qrBuffer = await renderPixQr(qr.payload);
  }

  await bot.sendPhoto(chatId, qrBuffer, {
    caption:
      `💰 <b>Pagamento PIX</b>\n\n` +
      `Valor: R$ ${amount.toFixed(2).replace('.', ',')}\n\n` +
      `PIX Copia e Cola:\n` +
      `<code>${qr.payload}</code>\n\n` +
      `Assim que o pagamento for confirmado, a foto em alta qualidade e todas as informações serão enviadas aqui automaticamente.`,
    parse_mode: 'HTML'
  });
}

async function playSearchAnimation(chatId) {
  const steps = [
    '⚙️ Processando Busca...',
    '🔥 Analisando agora!',
    '🔍 Comparando com base de dados...\n\n⏳ Finalizando...'
  ];
  for (const step of steps) {
    await bot.sendMessage(chatId, step);
    await new Promise((r) => setTimeout(r, 300));
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  db.run(
    `INSERT INTO bot_users (chat_id, first_name, username, started_at)
     VALUES (?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(chat_id) DO UPDATE SET
       first_name = excluded.first_name,
       username = excluded.username`,
    [chatId, from.first_name || null, from.username || null]
  );
  const payload = String(msg.text || '').split(' ')[1] || '';
  if (/^ref_\d+$/.test(payload)) {
    const referrerId = Number(payload.replace('ref_', ''));
    referrals.registerReferral(referrerId, chatId);
  }
  bot.sendMessage(msg.chat.id, '👋 Bem-vindo!\n\nEscolha uma opção:', MENU_KEYBOARD);
});

function showReferralInfo(chatId) {
  referrals.countStats(chatId, (err, stats) => {
    const s = stats || { pendentes: 0, pagos: 0, ganho: 0 };
    const link = `https://t.me/${BOT_USERNAME}?start=ref_${chatId}`;
    bot.sendMessage(
      chatId,
      `🎁 PROGRAMA DE INDICAÇÃO\n\n` +
      `Indique um amigo e ganhe <b>R$ ${referrals.REFERRAL_REWARD.toFixed(2).replace('.', ',')}</b> quando ele fizer o primeiro depósito!\n\n` +
      `🔗 Seu link de indicação:\n<code>${link}</code>\n\n` +
      `Envie esse link para os amigos. Quando ele entrar pelo link e fizer um depósito, você recebe o prêmio na sua carteira automaticamente.\n\n` +
      `📊 SEUS INDICADOS:\n` +
      `⏳ Aguardando depósito: ${s.pendentes}\n` +
      `✅ Confirmados: ${s.pagos}\n` +
      `💰 Total ganho: R$ ${Number(s.ganho || 0).toFixed(2).replace('.', ',')}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });
}

bot.onText(/\/referencias/, (msg) => showReferralInfo(msg.chat.id));

bot.onText(/\/comparar/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    '📸 ENVIE A FOTO DO ROSTO PARA COMPARAR\n\n' +
    'Envie a imagem do rosto que você quer que eu realize a comparação.\n\n' +
    'Depois, você escolhe os filtros e confirma a busca.'
  );
});

bot.onText(/\/mesclas/, (msg) => {
  const chatId = msg.chat.id;
  mesclaSessions[chatId] = { step: 'foto1', buf1: null };
  bot.sendMessage(
    chatId,
    '🧬 FUSÃO DE ROSTO\n\n' +
    '⚠️ ENVIE AS 2 FOTOS NA ORDEM CORRETA:\n\n' +
    '1️⃣ PRIMEIRA: a foto do CLIENTE\n' +
    '2️⃣ SEGUNDA: a foto do BICO\n\n' +
    'Envie agora a 1ª foto:'
  );
});

bot.onText(/\/abastecer/, (msg) => startRefill(msg.chat.id));
bot.onText(/\/saldo/, (msg) => showBalance(msg.chat.id));

bot.onText(/\/suporte/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '📞 Precisa de ajuda? Fale direto com o suporte:', {
    reply_markup: {
      inline_keyboard: [[{ text: '💬 CHAMAR SUPORTE', url: SUPPORT_URL }]]
    }
  });
});

bot.onText(/\/carteira/, (msg) => showBalance(msg.chat.id));

bot.onText(/\/pedidos/, (msg) => {
  const chatId = msg.chat.id;
  db.all(
    `SELECT u.id, u.face_id, u.status, u.created_at, f.name
     FROM unlocks u JOIN faces f ON f.id = u.face_id
     WHERE u.chat_id = ? ORDER BY u.id DESC LIMIT 10`,
    [chatId],
    (err, rows) => {
      if (err) return bot.sendMessage(chatId, 'Erro ao buscar o histórico.');
      if (!rows || rows.length === 0) {
        return bot.sendMessage(chatId, '📋 Nenhuma compra encontrada ainda.');
      }
      const lines = rows.map((r) => {
        const status = r.status === 'pago' ? '✅ Pago' : '⏳ Pendente';
        return `#${r.face_id} ${r.name || ''} — ${status} (${r.created_at})`;
      });
      bot.sendMessage(chatId, '📋 SEUS PEDIDOS\n\n' + lines.join('\n'));
    }
  );
});

bot.onText(/\/resgatar\s+(.+)/i, (msg, match) => {
  const chatId = msg.chat.id;
  const code = String(match[1] || '').trim().toUpperCase();
  if (!code) return bot.sendMessage(chatId, 'Use: /resgatar CODIGO');

  db.get('SELECT * FROM gifts WHERE code = ?', [code], (err, gift) => {
    if (err || !gift) return bot.sendMessage(chatId, '❌ Gift não encontrado. Verifique o código e tente novamente.');
    if (gift.status === 'usado') return bot.sendMessage(chatId, '❌ Este gift já foi utilizado.');

    db.run(
      "UPDATE gifts SET status = 'usado', used_by = ?, used_at = datetime('now','localtime') WHERE id = ? AND status = 'ativo'",
      [chatId, gift.id],
      function (err2) {
        if (err2) return bot.sendMessage(chatId, '❌ Erro ao resgatar o gift. Tente novamente.');
        if (this.changes === 0) return bot.sendMessage(chatId, '❌ Este gift já foi utilizado.');

        db.run(
          `INSERT INTO balances (chat_id, credits, updated_at)
           VALUES (?, ?, datetime('now','localtime'))
           ON CONFLICT(chat_id) DO UPDATE SET
             credits = credits + excluded.credits,
             updated_at = datetime('now','localtime')`,
          [chatId, gift.credits],
          () => {
            db.get('SELECT COALESCE(SUM(credits), 0) AS total FROM balances WHERE chat_id = ?', [chatId], (e, row) => {
              bot.sendMessage(
                chatId,
                `🎁 Gift resgatado com sucesso!\n\n` +
                `Código: ${gift.code}\n` +
                `Créditos adicionados: R$ ${gift.credits.toFixed(2).replace('.', ',')} (equivale a 1 compra)\n\n` +
                `💰 Seu saldo atual: R$ ${(row ? row.total : 0).toFixed(2).replace('.', ',')}`
              ).catch(() => {});
            });
          }
        );
      }
    );
  });
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  if (awaitingRefill[chatId]) {
    delete awaitingRefill[chatId];
    const value = parseRefillValue(text);
    if (!value) {
      return bot.sendMessage(chatId, '⚠️ Valor inválido. Envie apenas o número do valor, por exemplo: 50 ou 100,00');
    }
    return startRefillPayment(chatId, value);
  }

  if (awaitingName[chatId]) {
    delete awaitingName[chatId];
    if (session[chatId]) session[chatId].firstName = text;
    return bot.sendMessage(chatId, `✅ Primeiro nome definido: "${text}".`, {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔎 Buscar e confirmar compra', callback_data: 'confirm_search', style: 'success' }
        ]]
      }
    });
  }

  switch (text) {
    case '🔎 PROCURAR BICO':
      return bot.sendMessage(
        chatId,
        '📸 Envie a foto do rosto para comparar\n\nEnvie a imagem do rosto que você quer que eu realize a comparação.'
      );
    case '💰 ABASTECER CRÉDITOS':
      return startRefill(chatId);
    case '📊 TABELA DE PREÇOS':
      return bot.sendMessage(chatId, 'Tabela de preços.');
    case '📋 HISTÓRICO DE COMPRAS':
      return bot.sendMessage(chatId, 'Histórico de compras.');
    case '👥 INDIQUE E GANHE':
      return showReferralInfo(chatId);
    case '📞 SUPORTE':
      return bot.sendMessage(chatId, '📞 Precisa de ajuda? Fale direto com o suporte:', {
        reply_markup: {
          inline_keyboard: [[{ text: '💬 CHAMAR SUPORTE', url: SUPPORT_URL }]]
        }
      });
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';

  if (data === 'confirm_search') {
    await bot.answerCallbackQuery(query.id);
    const st = session[chatId];
    if (st) session[chatId] = { embedding: st.embedding, ...menuStateToFilters(st) };
    return startSearch(chatId);
  }

  const f = session[chatId];
  if (f) {
    const selection = updateSelection(f, data);
    if (selection) {
      await bot.answerCallbackQuery(query.id);
      try {
        await bot.editMessageReplyMarkup(buildKeyboard(f).reply_markup, {
          chat_id: chatId,
          message_id: query.message.message_id
        });
      } catch (err) {
        console.error('Erro ao atualizar teclado:', err.message);
      }
      if (selection.group === 'name' && selection.opt.id === 'first') {
        awaitingName[chatId] = true;
        return bot.sendMessage(chatId, '✏️ Digite o primeiro nome para filtrar:');
      }
      return;
    }

    if (data === 'confirm') {
      const check = validateSelections(f);
      if (!check.ok) {
        return bot.answerCallbackQuery(query.id, {
          text: `Faltou selecionar: ${check.missing.join(', ')}.`,
          show_alert: true
        });
      }
      await bot.answerCallbackQuery(query.id, { text: '🔎 Buscando...' });
      session[chatId] = { embedding: f.embedding, ...menuStateToFilters(f) };
      return startSearch(chatId);
    }
  }

  if (!data.startsWith('unlock:')) return;
  await bot.answerCallbackQuery(query.id);
  const faceId = Number(data.split(':')[1]);

  db.get('SELECT * FROM faces WHERE id = ?', [faceId], async (err, face) => {
    if (err || !face) return bot.sendMessage(chatId, 'Face não encontrada.');
    if (face.antecedentes) {
      return bot.sendMessage(chatId, '⚠️ Produto indisponível.');
    }
    if (face.sold) {
      return bot.sendMessage(chatId, '⚠️ Este produto já foi vendido.');
    }

    const amount = PRICE;
    db.get('SELECT COALESCE(SUM(credits), 0) AS total FROM balances WHERE chat_id = ?', [chatId], async (e, balRow) => {
      if (!e && balRow && (balRow.total || 0) >= amount) {
        const novoSaldo = balRow.total - amount;
        db.run(
          "UPDATE balances SET credits = ?, updated_at = datetime('now','localtime') WHERE chat_id = ?",
          [novoSaldo, chatId]
        );
        db.run(
          "INSERT INTO unlocks (chat_id, face_id, amount, status, notified) VALUES (?, ?, ?, 'pago', 1)",
          [chatId, faceId, 0]
        );
        db.run('UPDATE faces SET sold = 1 WHERE id = ?', [faceId]);

        bot.sendMessage(
          chatId,
          '🎁 Compra liberada com seus créditos! Enviando a foto completa...'
        ).catch(() => {});
        const photoPath = path.join(__dirname, '..', 'painel', 'faces', face.photo);
        if (fs.existsSync(photoPath)) {
          await bot.sendPhoto(chatId, photoPath, {
            caption:
              unlockCaption(face) +
              `\n\n💰 Saldo restante: R$ ${novoSaldo.toFixed(2).replace('.', ',')}`
          });
        } else {
          await bot.sendMessage(chatId, unlockCaption(face));
        }
        return;
      }

      try {
        await generatePixUnlock(chatId, face);
      } catch (err2) {
        console.error('Erro ao gerar unlock:', err2.message);
        bot.sendMessage(chatId, 'Erro ao gerar o pagamento. Tente novamente.');
      }
  });
  });
});

function unlockCaption(face) {
  let c = `✅ Compra liberada!\n\nID: ${face.id}\nNome: ${face.name}`;
  if (face.description && face.description.trim()) {
    c += `\n\n📋 FICHA DO BICO:\n${face.description.trim()}`;
  }
  return c;
}

async function deliverPaidUnlocks() {
  db.all(
    "SELECT * FROM unlocks WHERE status = 'pago' AND notified = 0",
    async (err, unlocks) => {
      if (err) return;
      for (const u of unlocks) {
        try {
          db.get('SELECT * FROM faces WHERE id = ?', [u.face_id], async (e, face) => {
            if (e || !face) return;
            const photoPath = path.join(__dirname, '..', 'painel', 'faces', face.photo);
            if (fs.existsSync(photoPath)) {
              await bot.sendPhoto(u.chat_id, photoPath, {
                caption: unlockCaption(face)
              });
            } else {
              await bot.sendMessage(u.chat_id, unlockCaption(face));
            }
            db.run("UPDATE unlocks SET notified = 1 WHERE id = ?", [u.id]);
          });
        } catch (err2) {
          console.error('Erro ao entregar unlock:', err2.message);
        }
      }
    }
  );
}

setInterval(deliverPaidUnlocks, 5000);

async function checkAsaasPayments() {
  if (!process.env.ASAAS_API_KEY) return;
  db.all(
    "SELECT * FROM unlocks WHERE status = 'pendente' AND asaas_id IS NOT NULL AND asaas_id != ''",
    async (err, unlocks) => {
      if (err) return;
      for (const u of unlocks) {
        try {
          const status = await asaas.getPaymentStatus(u.asaas_id);
          if (status === 'RECEIVED' || status === 'CONFIRMED') {
            db.run(
              "UPDATE unlocks SET status = 'pago', paid_at = datetime('now','localtime') WHERE id = ? AND status = 'pendente'",
              [u.id]
            );
            db.run('UPDATE faces SET sold = 1 WHERE id = ?', [u.face_id]);
            console.log(`Pagamento Asaas confirmado: unlock ${u.id} (${status})`);
          }
        } catch (e) {
          console.error(`Erro ao consultar pagamento Asaas ${u.asaas_id}:`, e.message);
        }
      }
    }
  );
}

setInterval(checkAsaasPayments, 5000);

async function checkAsaasRefills() {
  if (!process.env.ASAAS_API_KEY) return;
  db.all(
    "SELECT * FROM refills WHERE status = 'pendente' AND asaas_id IS NOT NULL AND asaas_id != ''",
    async (err, refills) => {
      if (err) return;
      for (const r of refills) {
        try {
          const status = await asaas.getPaymentStatus(r.asaas_id);
          if (status === 'RECEIVED' || status === 'CONFIRMED') {
            db.run(
              "UPDATE refills SET status = 'pago', paid_at = datetime('now','localtime') WHERE id = ? AND status = 'pendente'",
              [r.id]
            );
            db.run(
              `INSERT INTO balances (chat_id, credits, updated_at)
               VALUES (?, ?, datetime('now','localtime'))
               ON CONFLICT(chat_id) DO UPDATE SET
                 credits = credits + excluded.credits,
                 updated_at = datetime('now','localtime')`,
              [r.chat_id, r.amount]
            );
            referrals.creditReferralForRefill(r.chat_id);
            console.log(`Recarga confirmada: refill ${r.id} (${status})`);
          }
        } catch (e) {
          console.error(`Erro ao consultar recarga Asaas ${r.asaas_id}:`, e.message);
        }
      }
    }
  );
}

setInterval(checkAsaasRefills, 5000);

async function notifyPaidRefills() {
  db.all(
    "SELECT * FROM refills WHERE status = 'pago' AND notified = 0",
    async (err, refills) => {
      if (err) return;
      for (const r of refills) {
        try {
          db.get('SELECT COALESCE(SUM(credits), 0) AS total FROM balances WHERE chat_id = ?', [r.chat_id], (e, row) => {
            if (e) return;
            bot.sendMessage(
              r.chat_id,
              `✅ Depósito confirmado!\n\n` +
              `Valor: R$ ${r.amount.toFixed(2).replace('.', ',')}\n` +
              `Créditos adicionados à sua conta.\n\n` +
              `💰 Seu saldo atual: R$ ${(row.total || 0).toFixed(2).replace('.', ',')}`
            ).catch(() => {});
            db.run("UPDATE refills SET notified = 1 WHERE id = ?", [r.id]);
          });
        } catch (err2) {
          console.error('Erro ao notificar recarga:', err2.message);
        }
      }
    }
  );
}

setInterval(notifyPaidRefills, 5000);

async function notifyReferralRewards() {
  db.all(
    "SELECT * FROM referrals WHERE status = 'pago' AND notified = 0",
    async (err, refs) => {
      if (err) return;
      for (const ref of refs) {
        try {
          await bot.sendMessage(
            ref.referrer_chat_id,
            `🎉 <b>Indicação premiada!</b>\n\n` +
            `Um amigo que você indicou acabou de fazer o primeiro depósito.\n` +
            `Você ganhou <b>R$ ${Number(ref.reward || 0).toFixed(2).replace('.', ',')}</b> na sua carteira!`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
          db.run("UPDATE referrals SET notified = 1 WHERE id = ?", [ref.id]);
        } catch (err2) {
          console.error('Erro ao notificar indicação:', err2.message);
        }
      }
    }
  );
}

setInterval(notifyReferralRewards, 5000);

module.exports = { bot };
