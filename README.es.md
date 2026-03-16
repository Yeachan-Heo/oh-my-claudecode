[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | Español | [Tiếng Việt](README.vi.md) | [Português](README.pt.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)
[![Discord](https://img.shields.io/discord/1466022107199574193?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/qRJw62Gvh7)

> **Para usuarios de Codex:** Consulta [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) — la misma experiencia de orquestación para OpenAI Codex CLI.

**Orquestación multi-agente para Claude Code. Curva de aprendizaje cero.**

*No aprendas Claude Code. Solo usa OMC.*

[Comenzar](#inicio-rápido) • [Documentación](https://yeachan-heo.github.io/oh-my-claudecode-website) • [Referencia CLI](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#cli-reference) • [Flujos de Trabajo](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#workflows) • [Guía de Migración](docs/MIGRATION.md)

---

## Inicio Rápido

**Paso 1: Instalar**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Paso 2: Configurar**
```bash
/omc-setup
```

**Paso 3: Construye algo**
```
autopilot: build a REST API for managing tasks
```

Eso es todo. Todo lo demás es automático.

### ¿No sabes por dónde empezar?

Si no tienes claros los requisitos, tienes una idea vaga, o quieres microgestionar el diseño:

```
/deep-interview "I want to build a task management app"
```

La entrevista profunda usa preguntas socráticas para clarificar tu pensamiento antes de escribir cualquier código. Expone suposiciones ocultas y mide la claridad a través de dimensiones ponderadas, asegurando que sepas exactamente qué construir antes de que comience la ejecución.

## Modo Team (Recomendado)

A partir de **v4.1.7**, **Team** es la superficie canónica de orquestación en OMC. Los puntos de entrada legados como **swarm** y **ultrapilot** siguen siendo compatibles, pero ahora **enrutan a Team internamente**.

```bash
/team 3:executor "fix all TypeScript errors"
```

Team se ejecuta como un pipeline por etapas:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Habilita los equipos nativos de Claude Code en `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> Si los equipos están desactivados, OMC te avisará y hará fallback a ejecución sin Team cuando sea posible.

### Trabajadores CLI tmux — Codex & Gemini (v4.4.0+)

**v4.4.0 elimina los servidores MCP de Codex/Gemini** (proveedores `x`, `g`). Usa `/omc-teams` para lanzar procesos CLI reales en paneles divididos de tmux:

```bash
/omc-teams 2:codex   "review auth module for security issues"
/omc-teams 2:gemini  "redesign UI components for accessibility"
/omc-teams 1:claude  "implement the payment flow"
```

Para trabajo mixto de Codex + Gemini en un solo comando, usa la habilidad **`/ccg`**:

```bash
/ccg Review this PR — architecture (Codex) and UI components (Gemini)
```

| Habilidad | Trabajadores | Mejor Para |
|-------|---------|----------|
| `/omc-teams N:codex` | N paneles Codex CLI | Revisión de código, análisis de seguridad, arquitectura |
| `/omc-teams N:gemini` | N paneles Gemini CLI | Diseño UI/UX, docs, tareas de gran contexto |
| `/omc-teams N:claude` | N paneles Claude CLI | Tareas generales via Claude CLI en tmux |
| `/ccg` | 1 Codex + 1 Gemini | Orquestación tri-modelo en paralelo |

Los trabajadores se inician bajo demanda y terminan cuando su tarea se completa — sin uso de recursos en espera. Requiere las CLIs `codex` / `gemini` instaladas y una sesión tmux activa.

> **Nota: Nombre del paquete** — El proyecto usa la marca **oh-my-claudecode** (repositorio, plugin, comandos), pero el paquete npm se publica como [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus). Si instalas las herramientas CLI via npm/bun, usa `npm install -g oh-my-claude-sisyphus`.

### Actualizar

```bash
# 1. Actualizar el clon del marketplace
/plugin marketplace update omc

# 2. Volver a ejecutar el setup para actualizar la configuracion
/omc-setup
```

> **Nota:** Si la actualizacion automatica del marketplace no esta activada, debes ejecutar manualmente `/plugin marketplace update omc` para sincronizar la ultima version antes de ejecutar el setup.

Si experimentas problemas despues de actualizar, limpia la cache antigua del plugin:

```bash
/omc-doctor
```

<h1 align="center">Tu Claude acaba de recibir esteroides.</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## ¿Por qué oh-my-claudecode?

- **Cero configuración requerida** - Funciona inmediatamente con valores predeterminados inteligentes
- **Orquestación Team-first** - Team es la superficie canónica multiagente (swarm/ultrapilot son fachadas de compatibilidad)
- **Interfaz de lenguaje natural** - Sin comandos que memorizar, solo describe lo que quieres
- **Paralelización automática** - Tareas complejas distribuidas entre agentes especializados
- **Ejecución persistente** - No se rendirá hasta que el trabajo esté verificado y completo
- **Optimización de costos** - Enrutamiento inteligente de modelos ahorra 30-50% en tokens
- **Aprende de la experiencia** - Extrae y reutiliza automáticamente patrones de resolución de problemas
- **Visibilidad en tiempo real** - Barra de estado HUD muestra lo que está sucediendo internamente

---

## Características

### Modos de Ejecución
Múltiples estrategias para diferentes casos de uso - desde construcciones completamente autónomas hasta refactorización eficiente en tokens. [Aprende más →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#execution-modes)

| Modo | Característica | Usar Para |
|------|---------|---------|
| **Team (recomendado)** | Pipeline por etapas | Agentes Claude coordinados en una lista de tareas compartida |
| **omc-teams** | Trabajadores CLI tmux | Tareas Codex/Gemini CLI; se inician bajo demanda, terminan al completar |
| **ccg** | Tri-modelo en paralelo | Codex (analítico) + Gemini (diseño), Claude sintetiza |
| **Autopilot** | Ejecución autónoma | Trabajo de feature end-to-end con mínima ceremonia |
| **Ultrawork** | Máximo paralelismo | Correcciones/refactorizaciones en ráfaga cuando Team no es necesario |
| **Ralph** | Modo persistente | Tareas que deben completarse totalmente |
| **Pipeline** | Procesamiento secuencial | Transformaciones multi-etapa con ordenación estricta |
| **Swarm / Ultrapilot (legado)** | Enrutan a Team | Flujos de trabajo existentes y documentación antigua |

### Orquestación Inteligente

- **32 agentes especializados** para arquitectura, investigación, diseño, pruebas, ciencia de datos
- **Enrutamiento inteligente de modelos** - Haiku para tareas simples, Opus para razonamiento complejo
- **Delegación automática** - El agente correcto para el trabajo, siempre

### Experiencia de Desarrollo

- **Palabras clave mágicas** - `ralph`, `ulw`, `plan` para control explícito
- **Barra de estado HUD** - Métricas de orquestación en tiempo real en tu barra de estado
- **Aprendizaje de habilidades** - Extrae patrones reutilizables de tus sesiones
- **Análisis y seguimiento de costos** - Comprende el uso de tokens en todas las sesiones

### Habilidades Personalizadas

Aprende una vez, reutiliza para siempre. OMC extrae conocimiento valioso de depuración en archivos de habilidades portátiles que se inyectan automáticamente cuando son relevantes.

| | Alcance de Proyecto | Alcance de Usuario |
|---|---|---|
| **Ruta** | `.omc/skills/` | `~/.omc/skills/` |
| **Compartido con** | Equipo (controlado por versiones) | Todos tus proyectos |
| **Prioridad** | Mayor (anula el alcance de usuario) | Menor (respaldo) |

```yaml
# .omc/skills/fix-proxy-crash.md
---
name: Fix Proxy Crash
description: aiohttp proxy crashes on ClientDisconnectedError
triggers: ["proxy", "aiohttp", "disconnected"]
source: extracted
---
Envuelve el handler en server.py:42 con try/except ClientDisconnectedError...
```

**Gestión de habilidades:** `/skill list | add | remove | edit | search`
**Auto-aprendizaje:** `/learner` extrae patrones reutilizables con estrictos criterios de calidad
**Auto-inyección:** Las habilidades coincidentes se cargan en el contexto automáticamente — sin necesidad de invocación manual

[Lista completa de características →](docs/REFERENCE.md)

---

## Palabras Clave Mágicas

Atajos opcionales para usuarios avanzados. El lenguaje natural funciona bien sin ellas.

| Palabra Clave | Efecto | Ejemplo |
|---------|--------|---------|
| `team` | Orquestación canónica con Team | `/team 3:executor "fix all TypeScript errors"` |
| `omc-teams` | Trabajadores CLI tmux (codex/gemini/claude) | `/omc-teams 2:codex "security review"` |
| `ccg` | Orquestación tri-modelo Codex+Gemini | `/ccg review this PR` |
| `autopilot` | Ejecución completamente autónoma | `autopilot: build a todo app` |
| `ralph` | Modo persistencia | `ralph: refactor auth` |
| `ulw` | Máximo paralelismo | `ulw fix all errors` |
| `plan` | Entrevista de planificación | `plan the API` |
| `ralplan` | Consenso de planificación iterativa | `ralplan this feature` |
| `deep-interview` | Clarificación socrática de requisitos | `deep-interview "vague idea"` |
| `swarm` | **Obsoleto** — usa `team` en su lugar | `swarm 5 agents: fix lint errors` |
| `ultrapilot` | **Obsoleto** — usa `team` en su lugar | `ultrapilot: build a fullstack app` |

**Notas:**
- **ralph incluye ultrawork:** Cuando activas el modo ralph, automáticamente incluye la ejecución paralela de ultrawork. No es necesario combinar palabras clave.
- La sintaxis `swarm N agents` aún se reconoce para extraer el recuento de agentes, pero el runtime está respaldado por Team en v4.1.7+.

---

## Utilidades

### Espera de Límite de Tasa

Reanuda automáticamente sesiones de Claude Code cuando se reinician los límites de tasa.

```bash
omc wait          # Verificar estado, obtener orientación
omc wait --start  # Habilitar demonio de reanudación automática
omc wait --stop   # Deshabilitar demonio
```

**Requiere:** tmux (para detección de sesión)

### Etiquetas de notificación (Telegram/Discord/Slack)

Puedes configurar a quién etiquetar cuando los callbacks de stop envían el resumen de sesión.

```bash
# Definir/reemplazar lista de etiquetas
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"
omc config-stop-callback slack --enable --webhook <url> --tag-list "<!here>,<@U1234567890>"

# Actualizaciones incrementales
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

Comportamiento de etiquetas:
- Telegram: `alice` se normaliza a `@alice`
- Discord: soporta `@here`, `@everyone`, IDs numéricos de usuario y `role:<id>`
- Slack: soporta `<@MEMBER_ID>`, `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^GROUP_ID>`
- El callback `file` ignora las opciones de etiquetas

### Integración con OpenClaw

Reenvía eventos de sesión de Claude Code a un gateway de [OpenClaw](https://openclaw.ai/) para habilitar respuestas automatizadas y flujos de trabajo a través de tu agente OpenClaw.

**Configuración rápida (recomendado):**

```bash
/oh-my-claudecode:configure-notifications
# → Escribe "openclaw" cuando se te solicite → elige "OpenClaw Gateway"
```

**Configuración manual:** crea `~/.claude/omc_config.openclaw.json`:

```json
{
  "enabled": true,
  "gateways": {
    "my-gateway": {
      "url": "https://your-gateway.example.com/wake",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" },
      "method": "POST",
      "timeout": 10000
    }
  },
  "hooks": {
    "session-start": { "gateway": "my-gateway", "instruction": "Session started for {{projectName}}", "enabled": true },
    "stop":          { "gateway": "my-gateway", "instruction": "Session stopping for {{projectName}}", "enabled": true }
  }
}
```

**Variables de entorno:**

| Variable | Descripción |
|----------|-------------|
| `OMC_OPENCLAW=1` | Habilitar OpenClaw |
| `OMC_OPENCLAW_DEBUG=1` | Habilitar registro de depuración |
| `OMC_OPENCLAW_CONFIG=/path/to/config.json` | Ruta alternativa del archivo de configuración |

**Eventos de hook soportados (6 activos en bridge.ts):**

| Evento | Disparador | Variables de plantilla principales |
|--------|-----------|-----------------------------------|
| `session-start` | La sesión comienza | `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}` |
| `stop` | La respuesta de Claude se completa | `{{sessionId}}`, `{{projectName}}` |
| `keyword-detector` | Cada envío de prompt | `{{prompt}}`, `{{sessionId}}` |
| `ask-user-question` | Claude solicita entrada del usuario | `{{question}}`, `{{sessionId}}` |
| `pre-tool-use` | Antes de la invocación de herramienta (alta frecuencia) | `{{toolName}}`, `{{sessionId}}` |
| `post-tool-use` | Después de la invocación de herramienta (alta frecuencia) | `{{toolName}}`, `{{sessionId}}` |

**Variables de entorno del canal de respuesta:**

| Variable | Descripción |
|----------|-------------|
| `OPENCLAW_REPLY_CHANNEL` | Canal de respuesta (ej. `discord`) |
| `OPENCLAW_REPLY_TARGET` | ID del canal |
| `OPENCLAW_REPLY_THREAD` | ID del hilo |

Consulta `scripts/openclaw-gateway-demo.mjs` para un gateway de referencia que retransmite payloads de OpenClaw a Discord a través de ClawdBot.

---

## Documentación

- **[Referencia Completa](docs/REFERENCE.md)** - Documentación completa de características
- **[Referencia CLI](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#cli-reference)** - Todos los comandos, flags y herramientas de `omc`
- **[Guía de Notificaciones](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#notifications)** - Configuración de Discord, Telegram, Slack y webhooks
- **[Flujos de Trabajo Recomendados](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#workflows)** - Cadenas de habilidades probadas para tareas comunes
- **[Notas de Versión](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#release-notes)** - Novedades en cada versión
- **[Sitio Web](https://yeachan-heo.github.io/oh-my-claudecode-website)** - Guías interactivas y ejemplos
- **[Guía de Migración](docs/MIGRATION.md)** - Actualización desde v2.x
- **[Arquitectura](docs/ARCHITECTURE.md)** - Cómo funciona internamente
- **[Monitoreo de Rendimiento](docs/PERFORMANCE-MONITORING.md)** - Seguimiento de agentes, depuración y optimización

---

## Requisitos

- CLI de [Claude Code](https://docs.anthropic.com/claude-code)
- Suscripción Claude Max/Pro O clave API de Anthropic

### Opcional: Orquestación Multi-IA

OMC puede opcionalmente orquestar proveedores de IA externos para validación cruzada y consistencia de diseño. **No son necesarios** — OMC funciona completamente sin ellos.

| Proveedor | Instalación | Qué habilita |
|-----------|-------------|--------------|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Revisión de diseño, consistencia UI (contexto de 1M tokens) |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` | Validación de arquitectura, verificación cruzada de código |

**Costo:** 3 planes Pro (Claude + Gemini + ChatGPT) cubren todo por ~$60/mes.

---

## Licencia

MIT

---

<div align="center">

**Inspirado por:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code) • [Ouroboros](https://github.com/Q00/ouroboros)

**Curva de aprendizaje cero. Poder máximo.**

</div>

## Historial de Estrellas

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)

## 💖 Apoya Este Proyecto

Si Oh-My-ClaudeCode ayuda a tu flujo de trabajo, considera patrocinar:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/Yeachan-Heo)

### ¿Por qué patrocinar?

- Mantener el desarrollo activo
- Soporte prioritario para patrocinadores
- Influir en la hoja de ruta y características
- Ayudar a mantener el software gratuito y de código abierto

### Otras formas de ayudar

- ⭐ Dale una estrella al repositorio
- 🐛 Reporta errores
- 💡 Sugiere características
- 📝 Contribuye código
