# Hebrew → Russian Live Translator

Личный web-MVP: iPhone слушает речь на иврите, отправляет аудио через Cloudflare Worker в Gemini Live API, получает русский голос и проигрывает его в текущий аудиовыход iPhone — AirPods, Bluetooth-наушники или динамик.

## PowerShell запуск

```powershell
npm install
Copy-Item .env.example .env
New-Item -Path ".dev.vars" -ItemType File -Force
notepad .dev.vars
npm run dev:worker
```

Во втором PowerShell:

```powershell
npm run dev
```

Открой `http://localhost:5173`.

В `.dev.vars` должно быть:

```env
GEMINI_API_KEY=твой_ключ_из_Google_AI_Studio
```

## Cloudflare deploy

```powershell
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```

Для автодеплоя добавь в GitHub Actions secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Важно: `GEMINI_API_KEY` добавляется в Cloudflare Worker Secret, не в GitHub.

## Ограничения iOS web

- Страница должна быть открыта и активна.
- AirPods должны быть текущим аудиовыходом iPhone до старта.
- Для чужой речи чаще лучше микрофон iPhone, а не микрофон AirPods.
