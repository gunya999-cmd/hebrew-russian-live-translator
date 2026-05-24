# Hebrew → Russian Live Translator

Личный web-MVP: iPhone слушает речь на иврите, отправляет аудио через Cloudflare Worker в Gemini Live API, получает русский голос и проигрывает его в текущий аудиовыход iPhone — AirPods, Bluetooth-наушники или динамик.

## Что уже есть

- React + Vite frontend.
- Один Cloudflare Worker, который:
  - отдаёт собранный frontend из `dist`,
  - проксирует `/ws` в Gemini Live API,
  - хранит `GEMINI_API_KEY` только как Cloudflare Secret.
- Потоковый захват микрофона через `getUserMedia` + `AudioWorklet`.
- Конвертация входа в `audio/pcm;rate=16000`.
- Проигрывание PCM-аудио ответа Gemini, обычно `audio/pcm;rate=24000`.
- System prompt под сценарий: иврит → короткий разговорный русский перевод.

## Важные ограничения web-версии на iOS

- Страница должна быть открыта и активна.
- При блокировке экрана или полном уходе Safari/PWA в фон iOS может остановить микрофон или замедлить страницу.
- AirPods должны быть выбраны как текущий аудиовыход iPhone до старта сессии.
- Для чужой речи часто лучше использовать микрофон iPhone, а не микрофон AirPods. Положи iPhone ближе к говорящему.

## Быстрый локальный запуск в PowerShell

### 1. Установи зависимости

```powershell
npm install
```

### 2. Создай локальный `.env`

```powershell
Copy-Item .env.example .env
```

В `.env` должно быть:

```env
VITE_WS_URL=ws://localhost:8787/ws
```

### 3. Добавь локальный Gemini key для Worker

Для локального `wrangler dev` создай файл `.dev.vars`:

```powershell
New-Item -Path ".dev.vars" -ItemType File -Force
notepad .dev.vars
```

Вставь туда:

```env
GEMINI_API_KEY=твой_ключ_из_Google_AI_Studio
```

### 4. Запусти Worker

В первом окне PowerShell:

```powershell
npm run dev:worker
```

### 5. Запусти web frontend

Во втором окне PowerShell:

```powershell
npm run dev
```

Открой:

```text
http://localhost:5173
```

Для теста на iPhone в одной Wi‑Fi сети лучше использовать HTTPS/tunnel, потому что доступ к микрофону в браузере требует secure context. Локальный `localhost` работает на компьютере, но не как обычный LAN-адрес на iPhone.

## Деплой в Cloudflare через PowerShell

### 1. Залогинься в Cloudflare

```powershell
npx wrangler login
```

### 2. Добавь secret в Cloudflare

```powershell
npx wrangler secret put GEMINI_API_KEY
```

Вставь API key из Google AI Studio.

### 3. Задеплой вручную

```powershell
npm run deploy
```

После деплоя Cloudflare даст URL вида:

```text
https://hebrew-russian-live-translator.<your-subdomain>.workers.dev
```

Открой этот URL на iPhone, надень AirPods, нажми “Начать перевод”.

## Автодеплой через GitHub Actions

Файл уже добавлен: `.github/workflows/deploy.yml`.

В GitHub → Repository → Settings → Secrets and variables → Actions добавь:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

После этого каждый push в `main` будет деплоить проект в Cloudflare.

Важно: `GEMINI_API_KEY` нужно добавить именно в Cloudflare Worker Secret через `npx wrangler secret put GEMINI_API_KEY`, а не в GitHub Secrets. Так ключ Gemini не попадёт в браузер и не будет храниться в репозитории.

## Проверка перед деплоем

```powershell
npm run build
```

В этом коммите сборка уже проверена локально: TypeScript + Vite build проходят успешно.

## Где настраивается качество/задержка

В `src/App.tsx`:

```ts
silenceDurationMs: 650
```

Меньше значение — быстрее, но выше риск обрывков и ошибок.

Рекомендуемые варианты:

```text
450–550 ms  — быстрее, больше ошибок
650–800 ms  — баланс
900–1200 ms — точнее, но медленнее
```

Также можно менять голос Gemini:

```ts
voiceName: 'Kore'
```

## Минимальный план следующих улучшений

1. Добавить переключатель “быстрее / точнее”.
2. Добавить выбор голоса.
3. Добавить простую проверку задержки: время от входящего чанка до первого аудиоответа.
4. Добавить “режим кафе”: более агрессивное шумоподавление и более короткие переводы.
5. Позже сделать native iOS app, если понадобится работа при заблокированном экране.
