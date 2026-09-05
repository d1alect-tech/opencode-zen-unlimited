> **SUPERSEDED — archived 2026-09-05. Do not follow this guide.**
>
> Stale: `convertSubUrl` temp-script flow writing `singbox.json` + `relay_upstreams.json`, provider via nonexistent `opencode/oc-provider.example.jsonc`.
> Current: `zen add-sub <url>` merges subscription into `sing-box/config.json` (+`.bak`) with pool rewire (+`.env`); provider block via `docs/agents/configure-oc-provider.md` (inline block).
>
> Original body preserved below for history.
>
> ---

# Установка через ИИ-агента (для пользователя)

Вся установка строится так: ты копируешь **один текст** ниже и отправляешь
его любому ИИ-агенту с доступом к твоей машине (OpenCode, Claude Code,
Cursor и т.п.). Агент сам всё поставит и проверит. От тебя нужны только
три вещи: Windows, твоя VPN-подписка (ссылка) и 5 минут.

## Что сделать тебе (3 шага)

1. Склонируй репозиторий и поставь Bun:
   ```powershell
   gh repo clone d1alect-tech/opencode-zen-unlimited
   cd opencode-zen-unlimited
   # Bun >= 1.3.14: https://bun.sh (или попроси агента в промпте ниже)
   bun install
   ```
2. Скопируй **весь текст из раздела «Промпт для агента»** ниже, вставь
   свою ссылку вместо `<ВСТАВЬ_ССЫЛКУ>` и путь к папке вместо
   `<ПУТЬ_К_РЕПО>`, отправь агенту.
3. Дождись отчёта агента: `health 200`, `models 200 dual ids`,
   `responses 200`. Про ссылку: никому не пересылай, в чат с агентом
   она попадает только как секрет сессии (агент обязан держать её в
   env и не коммитить — это прописано в промпте).

Без egress безлимита нет: egress — обязательный шаг, это и есть суть
проекта. Без нод стек работает напрямую (direct) с обычным лимитом.

Подробности для любопытных: `README.md` (архитектура), агентский ранбук
`docs/sub-link-to-egress.md`, проверки `scripts/verify-*.ps1`.

---

## Промпт для агента (копировать целиком, от черты до черты)

```text
Ты разворачиваешь opencode-zen-unlimited — локальный прокси для
безлимитных бесплатных моделей OpenCode Zen. Binding-контракт:
провайдер "oc" (keyless, без API-ключей), модель
"oc/muse-spark-1.3-contributor-free". Без egress безлимита нет —
egress обязателен.

Моя VPN-подписка: <ВСТАВЬ_ССЫЛКУ>. Считай её секретом: держи только
в env текущего процесса, не пиши в файлы репозитория, не логируй,
не показывай в выводе целиком.

Репозиторий: <ПУТЬ_К_РЕПО> (если не склонирован — склонируй
d1alect-tech/opencode-zen-unlimited и работай в нём).
Целевая архитектура:
OpenCode → gateway 127.0.0.1:20128 → relay 127.0.0.1:1090 →
sing-box egress → https://opencode.ai/zen.

Порядок действий:

0. Окружение (Windows). Проверь: bun >= 1.3.14 (нет — поставь с
   bun.sh), node >= 22 как fallback, sing-box >= 1.14.0 (нет —
   скачай с github.com/SagerNet/sing-box/releases). xhttp/splithttp
   в sing-box не существует — не ищи и не прописывай.

1. Зависимости и env. В корне репо: `bun install`. Скопируй
   `.env.example` в `.env` (он в gitignore). Подписку положи ТОЛЬКО
   в env (`$env:EGRESS_SUB_URL="<ссылка>"`), пароль hy2 — в
   `HY2_PASSWORD`. Реальные секреты — никогда в коммит.

2. Подписка → egress (детали: docs/sub-link-to-egress.md, код:
   src/sub-converter/). Через ВРЕМЕННЫЙ скрипт-файл (не `bun -e`
   со вложенными кавычками — в PowerShell это ломается) вызови
   `convertSubUrl`, запиши `singbox.json` + `relay_upstreams.json`.
   Проверь `sing-box check -c singbox.json`. Плейсхолдеры `YOUR_*`
   подставляй из env в рантайме. Сгенерированный файл с секретами
   не коммить.

3. Старт строго по порядку: sing-box (`sing-box run -c singbox.json`)
   → relay (`node src/relay/rr-socks.mjs`, env `RR_ATTR_LOG`,
   `RR_WATCH_TOKEN`) → gateway (`bun run src/index.ts`, `PORT=20128`,
   bind только 127.0.0.1). `.env` читается один раз при старте —
   после правок перезапускай процессы.

4. Провайдер OpenCode. Добавь блок `oc` из
   `opencode/oc-provider.example.jsonc` в `opencode.json`/`opencode.jsonc`
   (baseURL `http://localhost:20128/v1`, keyless), модель
   `oc/muse-spark-1.3-contributor-free`. Полностью выйди из OpenCode
   и запусти заново (конфиг читается один раз при старте).

5. Проверка (скрипты `scripts/`): `verify-health.ps1` (жди 200
   `{"ok":true}`), `verify-relay.ps1` (жди ≥2 distinct egress IP),
   `verify-spark-e2e.ps1` — СТРОГО ОДИН раз, он тратит живую квоту.
   `GET /v1/models` должен вернуть 200 с dual ids `oc/<id>` + `<id>`.

6. Автозапуск: `scripts/install-scheduler.ps1` (задачи sing-box →
   relay → gateway с задержками 1/2/3 мин, перезапуск при падении).

Правила: бинды только на loopback; серверы для QA поднимай только
через временный файл + `Start-Process` в фоне + `curl.exe` + kill по
PID — НИКОГДА `bun -e ... serve(...)` в foreground (виснет);
чужие занятые порты не трогай. После каждого шага показывай мне
команду и её вывод.

Типичные грабли: bare model id без префикса `oc/` → 401;
spark через `/chat/completions` → 500 (ему нужен только `/responses`,
gateway это уже учитывает); свежий 429 → автоматическая ротация
egress; если исчерпаны ВСЕ egress — верни пользователю понятный
ответ (добавить VPN-подписки или подождать обновления лимитов)
и ничего не крути вхолостую.
```
