/* ============================================================
   Loja Telegram Mini App — app.js
   Consome a API do painel (/miniapp/api) autenticando via
   Telegram WebApp initData (ID do Telegram). Sem tela de login.
   ============================================================ */

'use strict';

/* ---------- Telegram WebApp ---------- */
const tg = window.Telegram?.WebApp || null;

function getInitData() {
  return (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) || '';
}

function getTgUser() {
  return (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user) || {};
}

function showAuthWarn() {
  const box = document.getElementById('authWarn');
  if (!box) return;
  const sdkOk = !!(window.Telegram && window.Telegram.WebApp);
  const len = getInitData().length;
  const dbg = document.getElementById('authWarnDbg');
  if (dbg) dbg.textContent = `sdk=${sdkOk ? 'ok' : 'ausente'} | initData len=${len}`;
  box.classList.remove('hidden');
  box.classList.add('flex');
}

function waitForInitData(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (getInitData()) {
        clearInterval(timer);
        return resolve(getInitData());
      }
      if (Date.now() - start > (timeoutMs || 3000)) {
        clearInterval(timer);
        resolve('');
      }
    }, 120);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('authWarnClose');
  if (el) el.addEventListener('click', () => {
    const box = document.getElementById('authWarn');
    if (box) { box.classList.add('hidden'); box.classList.remove('flex'); }
  });
});

if (tg) {
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor && tg.setHeaderColor('#07070d');
    tg.setBackgroundColor && tg.setBackgroundColor('#07070d');
    tg.disableVerticalSwipes && tg.disableVerticalSwipes();
  } catch (e) { console.warn('Telegram UI:', e.message); }
}

/* ---------- Estado ---------- */
const state = {
  user: {
    id: getTgUser().id || null,
    first_name: getTgUser().first_name || '',
    username: getTgUser().username || '',
    photo_url: getTgUser().photo_url || ''
  },
  balance: 0,
  products: [],
  orders: [],
  statement: [],
  activeCategory: 'todos',
  pixPollTimer: null,
  pixRefillId: null,
  photoBase64: null,
  searchResults: []
};

/* ---------- Utilidades ---------- */
const money = (v) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;

function toast(msg, ok = true) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `fixed left-1/2 -translate-x-1/2 bottom-24 z-50 glass-strong rounded-2xl px-5 py-3 text-sm font-semibold ${ok ? 'text-emerald-300' : 'text-rose-300'} animate-pop`;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.classList.add('hidden'); }, 2600);
}

function avatarInitial(name) {
  const c = document.createElement('canvas');
  c.width = c.height = 80;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1c2040';
  ctx.fillRect(0, 0, 80, 80);
  ctx.fillStyle = '#cbe5ff';
  ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((name || '?').trim().charAt(0).toUpperCase(), 40, 44);
  return c.toDataURL();
}

/* ---------- API ---------- */
async function api(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Init-Data': getInitData() }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/miniapp/api${path}`, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* corpo vazio */ }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `Erro ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/* ---------- Navegação ---------- */
const TABS = ['home', 'store', 'wallet', 'orders', 'profile'];
function switchTab(name) {
  document.querySelectorAll('.tab-page').forEach((el) => el.classList.add('hidden'));
  const page = document.getElementById(`tab-${name}`);
  if (page) page.classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach((b) => {
    const active = b.dataset.tab === name;
    b.classList.toggle('text-cyan-400', active);
    b.classList.toggle('text-white/55', !active);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'store') renderStore();
  if (name === 'wallet') loadStatement();
  if (name === 'orders') loadOrders();
  if (name === 'home') refreshHome();
  if (name === 'profile') renderProfile();
}

/* ---------- Render: usuário / saldo ---------- */
function renderUser() {
  const { user, balance } = state;
  const initials = avatarInitial(user.first_name);
  const setImg = (el, src) => { el.src = src || initials; };
  setImg(document.getElementById('avatar'), user.photo_url);
  setImg(document.getElementById('profileAvatar'), user.photo_url);
  document.getElementById('userName').textContent = user.first_name || 'Cliente';
  document.getElementById('userHandle').textContent = user.username ? `@${user.username}` : 'Telegram';
  document.getElementById('profileName').textContent = user.first_name || 'Cliente';
  document.getElementById('profileHandle').textContent = user.username ? `@${user.username}` : '—';
  document.getElementById('profileId').textContent = `ID: ${user.id || '—'}`;
  document.getElementById('homeBalance').textContent = money(balance);
  document.getElementById('walletBalance').textContent = money(balance);
  document.getElementById('statBalance').textContent = money(balance);
}

/* ---------- Render: categorias ---------- */
function renderCategories(containerId, withAll = true) {
  const cats = new Map();
  state.products.forEach((p) => {
    const c = p.category || 'geral';
    cats.set(c, (cats.get(c) || 0) + 1);
  });
  const wrap = document.getElementById(containerId);
  let html = '';
  if (withAll) {
    html += chip('todos', 'Todos', state.products.length, containerId === 'storeCategories');
  }
  cats.forEach((count, cat) => {
    html += chip(cat, cat, count, containerId === 'storeCategories');
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll('.cat-chip').forEach((el) => {
    el.addEventListener('click', () => {
      state.activeCategory = el.dataset.cat;
      if (containerId === 'storeCategories') {
        renderCategories(containerId, true);
        renderStoreGrid();
      } else {
        renderCategories('homeCategories', false);
        renderHomeProducts();
      }
    });
  });
}

function chip(cat, label, count, active) {
  const isActive = state.activeCategory === cat;
  const cls = isActive
    ? 'cat-chip bg-cyan-500 text-slate-900 font-bold'
    : 'cat-chip glass text-white/70';
  return `<button data-cat="${cat}" class="cat-chip ${cls} btn-press whitespace-nowrap rounded-xl px-4 py-2 text-sm">${label} <span class="opacity-60">(${count})</span></button>`;
}

/* ---------- Render: produtos ---------- */
function productCard(p) {
  const desc = (p.description || '').split('\n')[0] || '';
  return `
    <div class="glass rounded-3xl overflow-hidden shadow-glass animate-fade-up flex flex-col">
      <div class="aspect-square overflow-hidden bg-black/30 relative">
        <img src="/faces/${encodeURIComponent(p.photo)}" class="w-full h-full object-cover" loading="lazy" alt="${p.name}">
        <span class="absolute top-2 left-2 glass rounded-full px-2.5 py-1 text-[10px] text-white/80 capitalize">${p.category || 'Geral'}</span>
      </div>
      <div class="p-3 flex flex-col flex-1">
        <p class="font-bold text-sm leading-tight truncate">${p.name}</p>
        <p class="text-[11px] text-white/45 line-clamp-1 mt-0.5">${desc}</p>
        <div class="mt-3 flex items-center justify-between gap-2">
          <span class="text-cyan-400 font-extrabold">${money(p.price)}</span>
          <button data-buy="${p.id}" class="buy-btn btn-press bg-cyan-500 hover:bg-cyan-400 text-slate-900 font-bold rounded-xl px-3 py-2 text-xs">Comprar</button>
        </div>
      </div>
    </div>`;
}

function renderStoreGrid() {
  const list = state.products.filter((p) =>
    state.activeCategory === 'todos' || (p.category || 'geral') === state.activeCategory
  );
  const wrap = document.getElementById('storeProducts');
  wrap.innerHTML = list.map(productCard).join('') ||
    `<p class="col-span-2 text-center text-white/40 py-10">Nenhum produto nesta categoria.</p>`;
  bindBuyButtons();
}

function renderStore() {
  renderCategories('storeCategories', true);
  renderStoreGrid();
}

function renderHomeProducts() {
  const list = state.products.filter((p) =>
    state.activeCategory === 'todos' || (p.category || 'geral') === state.activeCategory
  ).slice(0, 4);
  document.getElementById('homeProducts').innerHTML = list.map(productCard).join('') ||
    `<p class="col-span-2 text-center text-white/40 py-8">Sem produtos ainda.</p>`;
  bindBuyButtons();
}

function bindBuyButtons() {
  document.querySelectorAll('.buy-btn').forEach((b) => {
    b.addEventListener('click', () => buyProduct(Number(b.dataset.buy)));
  });
}

/* ---------- Comprar ---------- */
async function performBuy(productId) {
  const res = await api('/buy', 'POST', { product_id: productId });
  state.balance = res.balance;
  state.products = state.products.filter((x) => x.id !== productId);
  state.searchResults = (state.searchResults || []).filter((x) => x.id !== productId);
  if (state.activeCategory !== 'todos' && !state.products.some((x) => (x.category || 'geral') === state.activeCategory)) {
    state.activeCategory = 'todos';
  }
  renderUser();
  renderStore();
  renderHomeProducts();
  renderCategories('homeCategories', false);
  renderSearchResults();
  toast(`🎉 Compra realizada! ${res.photo ? 'A foto e a ficha chegam no seu chat.' : ''}`);
  switchTab('orders');
}

async function buyProduct(productId) {
  const product = state.products.find((p) => p.id === productId);
  if (!product && !(state.searchResults || []).some((x) => x.id === productId)) {
    return toast('Produto não encontrado.', false);
  }
  try {
    await performBuy(productId);
  } catch (e) {
    if (String(e.message).toLowerCase().includes('saldo')) {
      toast('❌ Saldo insuficiente. Adicione saldo!');
      switchTab('wallet');
    } else {
      toast(`❌ ${e.message}`);
    }
  }
}

/* ---------- Puxada (busca por foto) ---------- */
function renderSearchResults() {
  const wrap = document.getElementById('puxadaResult');
  const results = state.searchResults || [];
  if (!results.length) {
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  wrap.innerHTML = results.map((r) => `
    <div class="flex items-center gap-3 glass rounded-2xl p-3 animate-fade-up">
      <div class="w-14 h-14 rounded-xl overflow-hidden bg-black/30 shrink-0 blur-[2px]">
        <img src="${r.blurred}" class="w-full h-full object-cover" alt="${r.name}">
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-bold truncate">${r.name}</p>
        <p class="text-[11px] text-white/45">ID ${r.id} • Similaridade ${r.similarity}%</p>
      </div>
      <button data-buy="${r.id}" class="buy-search btn-press bg-cyan-500 text-slate-900 font-bold rounded-xl px-3 py-2 text-xs">Comprar</button>
    </div>`).join('');
  wrap.querySelectorAll('.buy-search').forEach((b) => {
    b.addEventListener('click', () => buyProduct(Number(b.dataset.buy)));
  });
}

async function searchPhoto() {
  if (!state.photoBase64) return toast('Escolha uma foto primeiro.', false);
  const btn = document.getElementById('btnSearch');
  const loading = document.getElementById('puxadaLoading');
  btn.disabled = true;
  loading.classList.remove('hidden');
  try {
    const res = await api('/search', 'POST', { photo_base64: state.photoBase64 });
    if (res.message) {
      state.searchResults = [];
      renderSearchResults();
      toast(`❌ ${res.message}`);
      return;
    }
    state.searchResults = res.items || [];
    renderSearchResults();
    if (res.best) {
      toast(`🎯 ${res.best.similarity}% de similaridade encontrada!`);
    }
  } catch (e) {
    toast(`❌ ${e.message}`);
  } finally {
    loading.classList.add('hidden');
    btn.disabled = false;
  }
}

function selectPhoto(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    state.photoBase64 = ev.target.result;
    document.getElementById('puxadaThumb').src = ev.target.result;
    document.getElementById('puxadaIdle').classList.add('hidden');
    document.getElementById('puxadaPreview').classList.remove('hidden');
    document.getElementById('btnSearch').disabled = false;
  };
  reader.readAsDataURL(file);
}

/* ---------- Carteira / extrato ---------- */
async function loadStatement() {
  try {
    const res = await api('/statement');
    state.statement = res.items || [];
    renderStatement();
  } catch (e) { renderStatement(); }
}

function renderStatement() {
  const wrap = document.getElementById('statement');
  if (!state.statement.length) {
    wrap.innerHTML = `<p class="text-center text-white/40 text-sm py-6">Nenhuma movimentação ainda.</p>`;
    return;
  }
  wrap.innerHTML = state.statement.map((s) => `
    <div class="glass rounded-2xl p-3 flex items-center gap-3">
      <div class="w-9 h-9 rounded-xl flex items-center justify-center text-lg ${s.credits > 0 ? 'bg-emerald-500/15' : 'bg-rose-500/15'}">${s.credits > 0 ? '▲' : '▼'}</div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold truncate">${s.desc}</p>
        <p class="text-[11px] text-white/40">${s.created_at}</p>
      </div>
      <span class="${s.credits > 0 ? 'text-emerald-400' : 'text-rose-400'} font-bold text-sm">${s.credits > 0 ? '+' : ''}${money(Math.abs(s.credits))}</span>
    </div>`).join('');
}

/* ---------- Pedidos ---------- */
async function loadOrders() {
  try {
    const res = await api('/orders');
    state.orders = res.items || [];
  } catch (e) { state.orders = []; }
  renderOrders();
}

function renderOrders() {
  const wrap = document.getElementById('ordersList');
  const home = document.getElementById('homeOrders');
  if (!state.orders.length) {
    const empty = `<p class="text-center text-white/40 text-sm py-8">Você ainda não tem pedidos.</p>`;
    wrap.innerHTML = empty;
    home.innerHTML = `<div class="glass rounded-2xl p-4 text-center text-white/40 text-sm">Sem pedidos ainda.</div>`;
    return;
  }
  const cards = state.orders.map((o) => `
    <div class="glass rounded-2xl p-4 flex items-center gap-3">
      <div class="w-11 h-11 rounded-2xl overflow-hidden bg-black/30 shrink-0">
        <img src="/faces/${encodeURIComponent(o.photo)}" class="w-full h-full object-cover">
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-bold truncate">${o.name}</p>
        <p class="text-[11px] text-white/45">${o.created_at}</p>
      </div>
      <span class="text-[10px] glass rounded-full px-2 py-1 ${o.status === 'pago' ? 'text-emerald-300' : 'text-amber-300'}">${o.status === 'pago' ? 'Pago' : o.status}</span>
    </div>`).join('');
  wrap.innerHTML = cards;
  home.innerHTML = state.orders.slice(0, 3).map((o) => `
    <div class="glass rounded-2xl p-3 flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl overflow-hidden bg-black/30 shrink-0">
        <img src="/faces/${encodeURIComponent(o.photo)}" class="w-full h-full object-cover">
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-bold truncate">${o.name}</p>
        <p class="text-[11px] text-white/45">${o.created_at}</p>
      </div>
      <span class="text-[10px] text-emerald-300">✓</span>
    </div>`).join('');
  document.getElementById('statOrders').textContent = state.orders.length;
}

/* ---------- Perfil ---------- */
function renderProfile() {
  document.getElementById('statOrders').textContent = state.orders.length || 0;
  document.getElementById('statBalance').textContent = money(state.balance);
}

/* ---------- Adicionar saldo (PIX / Asaas) ---------- */
async function generatePix() {
  const raw = document.getElementById('amountInput').value.trim();
  const amount = parseFloat(String(raw).replace(',', '.'));
  if (!amount || amount < 5) return toast('Valor mínimo de R$ 5,00.', false);
  try {
    const btn = document.getElementById('btnAddBalance');
    btn.disabled = true;
    btn.textContent = 'Gerando...';
    const res = await api('/add-balance', 'POST', { amount });
    state.pixRefillId = res.refill_id;
    document.getElementById('pixAmount').textContent = money(amount);
    const qrImg = document.getElementById('pixQr');
    if (res.qr_base64) {
      qrImg.src = `data:image/png;base64,${res.qr_base64}`;
    } else {
      qrImg.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2ZmZiIvPjx0ZXh0IHg9IjEwMCIgeT0iMTA0IiBmb250LXNpemU9IjEyIiB0ZXh0LWFuY2hvcj0iMTJ" + "tYWxsIiBmaWxsPSIjMzMzIj5QRVIgVElQRVJBPC90ZXh0Pjwvc3ZnPg==';
    }
    window._pixPayload = res.payload || '';
    document.getElementById('pixModal').classList.remove('hidden');
    document.getElementById('pixModal').classList.add('flex');
    document.getElementById('pixStatus').textContent = 'Aguardando pagamento... o saldo atualiza automaticamente.';
    startPixPolling();
  } catch (e) {
    toast(`❌ ${e.message}`, false);
  } finally {
    const btn = document.getElementById('btnAddBalance');
    btn.disabled = false;
    btn.textContent = 'Gerar PIX';
  }
}

function startPixPolling() {
  clearInterval(state.pixPollTimer);
  state.pixPollTimer = setInterval(async () => {
    try {
      const res = await api('/me');
      state.balance = res.balance;
      renderUser();
      const pending = await api('/statement').then((r) => r.items || []).catch(() => []);
      const refill = pending.find((i) => i.id === state.pixRefillId && i.credits > 0);
      if (refill) {
        clearInterval(state.pixPollTimer);
        state.pixPollTimer = null;
        document.getElementById('pixStatus').textContent = '✅ Pagamento confirmado! Saldo atualizado.';
        setTimeout(() => {
          document.getElementById('pixModal').classList.add('hidden');
          document.getElementById('pixModal').classList.remove('flex');
          toast('💰 Saldo adicionado com sucesso!');
        }, 1200);
      }
    } catch (e) { /* continua tentando */ }
  }, 4000);
}

/* ---------- Início ---------- */
function refreshHome() {
  renderCategories('homeCategories', false);
  renderHomeProducts();
  renderOrders();
}

/* ---------- Carregamento inicial ---------- */
async function load() {
  renderUser();
  const initData = await waitForInitData();
  if (!initData) {
    showAuthWarn();
  }
  try {
    const [me, products] = await Promise.all([
      api('/me'),
      api('/products')
    ]);
    state.balance = me.balance;
    state.products = (products.items || []).filter((p) => !p.sold);
    state.user.id = me.id || state.user.id;
  } catch (e) {
    console.error('load:', e);
    toast('Falha ao carregar a loja.', false);
  }
  renderUser();
  refreshHome();
  switchTab('home');
}

/* ---------- Eventos ---------- */
document.querySelectorAll('[data-tab]').forEach((el) => {
  el.addEventListener('click', () => switchTab(el.dataset.tab));
});
document.getElementById('btnAddTop').addEventListener('click', () => switchTab('wallet'));
document.getElementById('btnAddBalance').addEventListener('click', generatePix);
document.querySelectorAll('.chip-amount').forEach((el) => {
  el.addEventListener('click', () => { document.getElementById('amountInput').value = el.dataset.amount; });
});
document.getElementById('pixClose').addEventListener('click', () => {
  document.getElementById('pixModal').classList.add('hidden');
  document.getElementById('pixModal').classList.remove('flex');
  clearInterval(state.pixPollTimer);
});
document.getElementById('pixBackdrop').addEventListener('click', () => {
  document.getElementById('pixModal').classList.add('hidden');
  document.getElementById('pixModal').classList.remove('flex');
  clearInterval(state.pixPollTimer);
});
document.getElementById('pixCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window._pixPayload || '');
    toast('📋 PIX copiado!');
  } catch (e) {
    toast('Não foi possível copiar.', false);
  }
});

/* ---------- Puxada: eventos ---------- */
document.getElementById('puxadaZone').addEventListener('click', () => {
  document.getElementById('puxadaInput').click();
});
document.getElementById('puxadaInput').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) selectPhoto(file);
});
document.getElementById('btnSearch').addEventListener('click', searchPhoto);

/* Botão principal do Telegram (fecha/flutua conforme necessidade) */
if (tg) {
  try { tg.setBottomBarVisible && tg.setBottomBarVisible(false); } catch (e) {}
}

load();
