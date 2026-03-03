[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md) | Русский | [Türkçe](README.tr.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Italiano](README.it.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)

**Мультиагентная оркестрация для Claude Code. Нулевой порог вхождения.**

_Не изучайте Claude Code. Просто используйте OMC._

[Начать](#быстрый-старт) • [Документация](https://yeachan-heo.github.io/oh-my-claudecode-website) • [Руководство по миграции](docs/MIGRATION.md)

---

## Быстрый старт

**Шаг 1: Установка**

```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Шаг 2: Настройка**

```bash
/oh-my-claudecode:omc-setup
```

**Шаг 3: Создайте что-нибудь**

```
autopilot: build a REST API for managing tasks
```

Вот и всё. Всё остальное происходит автоматически.

## Team Mode (Рекомендуется)

Начиная с **v4.1.7**, **Team** — это каноническая поверхность оркестрации в OMC. Устаревшие точки входа, такие как **swarm** и **ultrapilot**, по-прежнему поддерживаются, но теперь **направляются в Team под капотом**.

```bash
/oh-my-claudecode:team 3:executor "fix all TypeScript errors"
```

Team работает как поэтапный pipeline:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Включите нативные команды Claude Code в `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> Если teams отключены, OMC предупредит вас и переключится на выполнение без Team, если это возможно.

> **Примечание: Название пакета** — Проект использует бренд **oh-my-claudecode** (репозиторий, плагин, команды), но npm-пакет публикуется как [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus). Если вы устанавливаете CLI-инструменты через npm/bun, используйте `npm install -g oh-my-claude-sisyphus`.

### Обновление

```bash
# 1. Обновите плагин
/plugin install oh-my-claudecode

# 2. Перезапустите setup для обновления конфигурации
/oh-my-claudecode:omc-setup
```

Если после обновления возникли проблемы, очистите старый кэш плагина:

```bash
/oh-my-claudecode:omc-doctor
```

<h1 align="center">Ваш Claude только что получил суперсилу.</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## Почему oh-my-claudecode?

- **Настройка не требуется** — Работает сразу из коробки с умными значениями по умолчанию
- **Team-first оркестрация** — Team является каноническим мультиагентным интерфейсом (swarm/ultrapilot — фасады совместимости)
- **Интерфейс на естественном языке** — Не нужно запоминать команды, просто описывайте, что вам нужно
- **Автоматическая параллелизация** — Сложные задачи распределяются между специализированными агентами
- **Настойчивое выполнение** — Не сдаётся, пока работа не будет проверена и завершена
- **Оптимизация затрат** — Умная маршрутизация моделей экономит 30-50% токенов
- **Обучение на опыте** — Автоматически извлекает и переиспользует паттерны решения задач
- **Видимость в реальном времени** — HUD statusline показывает, что происходит под капотом

---

## Возможности

### Режимы оркестрации

Множество стратегий для разных сценариев — от оркестрации через Team до рефакторинга с экономией токенов. [Подробнее →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#execution-modes)

| Режим                               | Описание                                                                                      | Применение                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Team (рекомендуется)**            | Канонический поэтапный pipeline (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Координированные агенты, работающие над общим списком задач                       |
| **Autopilot**                       | Автономное выполнение (один ведущий агент)                                                    | Сквозная разработка фич с минимальной церемонией                                  |
| **Ultrawork**                       | Максимальный параллелизм (без Team)                                                           | Параллельные исправления/рефакторинг, когда Team не нужен                         |
| **Ralph**                           | Режим настойчивости с циклами verify/fix                                                      | Задачи, которые должны быть полностью завершены (без тихих частичных результатов) |
| **Ecomode**                         | Токен-эффективная маршрутизация                                                               | Бюджетно-ориентированная итерация                                                 |
| **Pipeline**                        | Последовательная поэтапная обработка                                                          | Многоступенчатые трансформации со строгим порядком                                |
| **Swarm / Ultrapilot (устаревшие)** | Фасады совместимости, направляющие в **Team**                                                 | Существующие рабочие процессы и старая документация                               |

### Интеллектуальная оркестрация

- **32 специализированных агента** для архитектуры, исследований, дизайна, тестирования, data science
- **Умная маршрутизация моделей** — Haiku для простых задач, Opus для сложных рассуждений
- **Автоматическое делегирование** — Правильный агент для правильной задачи, каждый раз

### Опыт разработчика

- **Магические ключевые слова** — `ralph`, `ulw`, `eco`, `plan` для явного управления
- **HUD statusline** — Метрики оркестрации в реальном времени в строке состояния
- **Обучение навыкам** — Извлечение переиспользуемых паттернов из сессий
- **Аналитика и отслеживание затрат** — Понимание использования токенов по всем сессиям

[Полный список возможностей →](docs/REFERENCE.md)

---

## Магические ключевые слова

Опциональные ярлыки для опытных пользователей. Естественный язык работает без них.

| Ключевое слово | Эффект                                          | Пример                                                          |
| -------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| `team`         | Каноническая Team-оркестрация                   | `/oh-my-claudecode:team 3:executor "fix all TypeScript errors"` |
| `autopilot`    | Полностью автономное выполнение                 | `autopilot: build a todo app`                                   |
| `ralph`        | Режим настойчивости                             | `ralph: refactor auth`                                          |
| `ulw`          | Максимальный параллелизм                        | `ulw fix all errors`                                            |
| `eco`          | Токен-эффективное выполнение                    | `eco: migrate database`                                         |
| `plan`         | Интервью для планирования                       | `plan the API`                                                  |
| `ralplan`      | Итеративный консенсус планирования              | `ralplan this feature`                                          |
| `swarm`        | Устаревшее ключевое слово (направляется в Team) | `swarm 5 agents: fix lint errors`                               |
| `ultrapilot`   | Устаревшее ключевое слово (направляется в Team) | `ultrapilot: build a fullstack app`                             |

**Примечания:**

- **ralph включает ultrawork**: при активации ralph mode автоматически включается параллельное выполнение ultrawork.
- Синтаксис `swarm N agents` по-прежнему распознаётся для определения количества агентов, но в v4.1.7+ среда выполнения основана на Team.

## Утилиты

### Ожидание Rate Limit

Автоматическое возобновление сессий Claude Code при сбросе rate limit.

```bash
omc wait          # Проверить статус, получить рекомендации
omc wait --start  # Включить демон автовозобновления
omc wait --stop   # Отключить демон
```

**Требуется:** tmux (для обнаружения сессии)

### Теги уведомлений (Telegram/Discord)

Вы можете настроить, кого отмечать, когда stop-коллбэки отправляют сводку сессии.

```bash
# Установить/заменить список тегов
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"

# Инкрементальные обновления
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

Поведение тегов:

- Telegram: `alice` нормализуется в `@alice`
- Discord: поддерживает `@here`, `@everyone`, числовые ID пользователей и `role:<id>`
- Коллбэки типа `file` игнорируют параметры тегов

---

## Документация

- **[Полный справочник](docs/REFERENCE.md)** — Полная документация по функциям
- **[Мониторинг производительности](docs/PERFORMANCE-MONITORING.md)** — Отслеживание агентов, отладка и оптимизация
- **[Веб-сайт](https://yeachan-heo.github.io/oh-my-claudecode-website)** — Интерактивные руководства и примеры
- **[Руководство по миграции](docs/MIGRATION.md)** — Обновление с v2.x
- **[Архитектура](docs/ARCHITECTURE.md)** — Как это работает под капотом

---

## Требования

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Подписка Claude Max/Pro ИЛИ API-ключ Anthropic

### Опционально: Мульти-AI оркестрация

OMC может опционально использовать внешних AI-провайдеров для перекрёстной валидации и единообразия дизайна. Они **не обязательны** — OMC полностью работает без них.

| Провайдер                                                 | Установка                           | Что даёт                                                 |
| --------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Ревью дизайна, единообразие UI (контекст 1M токенов)     |
| [Codex CLI](https://github.com/openai/codex)              | `npm install -g @openai/codex`      | Валидация архитектуры, перекрёстная проверка code review |

**Стоимость:** 3 плана Pro (Claude + Gemini + ChatGPT) покрывают всё за ~$60/месяц.

---

## Лицензия

MIT

---

<div align="center">

**Вдохновлено:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/NexTechFusion/Superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code)

**Нулевой порог вхождения. Максимальная мощность.**

</div>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)

## 💖 Поддержите этот проект

Если Oh-My-ClaudeCode помогает вашему рабочему процессу, рассмотрите спонсорство:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/Yeachan-Heo)

### Зачем спонсировать?

- Поддержание активной разработки
- Приоритетная поддержка для спонсоров
- Влияние на дорожную карту и функции
- Помощь в поддержании свободного и открытого исходного кода

### Другие способы помочь

- ⭐ Поставьте звезду репозиторию
- 🐛 Сообщайте об ошибках
- 💡 Предлагайте функции
- 📝 Вносите вклад в код
