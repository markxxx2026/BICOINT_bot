# Bot Bico

Bot do Telegram de busca/comparação facial com pagamento PIX (Asaas), carteira de créditos, sistema de indicação, mescla de rostos e um Mini App (web) de loja.

## Estrutura

```
.
├── .env.example          # Modelo de variáveis de ambiente
├── render.yaml           # Config de deploy (Render free)
├── Procfile              # Comando de start (Heroku-style)
├── package.json          # Dependências (raiz)
├── stubs/                # Stub do @tensorflow/tfjs-node (usa backend WASM)
└── projeto/
    ├── bot/index.js      # Lógica do bot (busca, carteira, indicação, mescla)
    ├── painel/server.js  # Express: painel admin + Mini App + API + webhook Asaas
    ├── painel/miniapp-api.js # API do Mini App (auth Telegram, compra, recarga, busca)
    ├── miniapp/          # Frontend do Mini App (HTML/JS)
    ├── deploy.js         # Entrada única p/ nuvem (webhook + painel + bot)
    ├── start-all.js      # Supervisor local (roda bot + painel)
    ├── asaas.js, pix.js  # Integração PIX
    ├── face-service.js   # Reconhecimento facial (tfjs wasm + face-api)
    ├── mescla.js         # Fusão de rostos (morph)
    ├── referrals.js      # Sistema de indicação
    ├── blur.js           # Imagens borradas (pré-compra)
    └── models/           # Pesos do face-api (commitados)
```

## Rodando localmente

```bash
npm install
copy .env.example .env   # preencha com seus valores
node projeto/start-all.js
```

- Bot em modo **polling** (sem `TELEGRAM_WEBHOOK_URL`).
- Painel em `http://localhost:3000`.
- Para expor o Mini App publicamente, use um túnel (ex.: cloudflared) e aponte `WEBAPP_URL`.

## Publicando no GitHub

1. Instale o Git e/ou use o GitHub Desktop.
2. Crie um repositório no GitHub.
3. Suba o projeto (`.env` e dados pessoais estão no `.gitignore`).
4. Confira no repositório que `node_modules`, `.env`, `*.db`, fotos e logs NÃO foram enviados.

## Deploy grátis (Render)

Render roda o serviço direto do seu repositório GitHub. Free tier: 1 web service, ~750h/mês, com "sleep" após 15 min de inatividade (a 1ª mensagem após dormir demora alguns segundos a mais).

1. Crie uma conta em https://render.com → **New → Web Service** → conecte seu repositório.
2. Render detecta o `render.yaml`. Ou configure manualmente:
   - Build: `npm install`
   - Start: `node projeto/deploy.js`
   - Health: `/miniapp/`
3. Defina as variáveis de ambiente (ver tabela abaixo).
4. `TELEGRAM_WEBHOOK_URL` deve ser `https://SEU-APP.onrender.com/webhook/telegram` — o deploy.js registra o webhook sozinho no boot.
5. `WEBAPP_URL` deve ser `https://SEU-APP.onrender.com/miniapp/`.
6. Após o 1º deploy, re-cadastre as fotos/rostos pelo painel (`/login`) — os dados antigos ficaram no seu PC.

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | sim | Token do @BotFather |
| `TELEGRAM_WEBHOOK_URL` | nuvem | URL pública do webhook (vazio = polling local) |
| `ASAAS_API_KEY` | sim | Chave da API Asaas |
| `ASAAS_CUSTOMER_CPF` | sim | CPF/CNPJ fixo dos clientes Asaas |
| `PIX_KEY` | sim | Chave PIX do recebedor |
| `PIX_NAME` | sim | Nome do recebedor |
| `PIX_CITY` | sim | Cidade do recebedor |
| `PRICE_FULL_PHOTO` | não | Preço da foto completa (default 10) |
| `REFERRAL_REWARD` | não | Recompensa por indicação (default 10) |
| `WEBHOOK_TOKEN` | sim | Token do webhook de confirmação de pagamento |
| `WEBAPP_URL` | sim | URL pública do Mini App (botão Abrir Loja) |
| `ADMIN_USER` / `ADMIN_PASS` | não | Acesso ao painel admin |

## Limitações do plano grátis

- O armazenamento do Render free é **efêmero**: banco SQLite, fotos enviadas e compras são perdidos a cada novo deploy/reinício. Para persistência real, migre o banco para Postgres (ex.: Neon, free) ou adicione disco pago.
- O bot em nuvem usa **webhook** (Telegram chama seu domínio). Localmente continua funcionando com polling.
