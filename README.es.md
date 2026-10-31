[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | Español | [Tiếng Việt](README.vi.md) | [Português](README.pt.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

> **Para usuarios de Codex:** Consulta [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) — la misma experiencia de orquestación para OpenAI Codex CLI.

> **¿Te gustó OmC pero te parece un poco excesivo? Prueba [gajae-code](https://github.com/Yeachan-Heo/gajae-code).**
> Mantiene el OAuth de Claude tal cual, siendo más rápido, más barato, más simple y más potente — con una vía de integración basada en SDK pensada para OpenClaw, Hermes, Grokbot y entornos de agentes similares.

**Orquestación multi-agente para Claude Code. Curva de aprendizaje cero.**

*No aprendas Claude Code. Solo usa OMC.*

[Comenzar](#inicio-rápido) • [Documentación](https://yeachan-heo.github.io/oh-my-claudecode-website) • [Referencia CLI](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#cli-reference) • [Flujos de Trabajo](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#workflows) • [Guía de Migración](docs/MIGRATION.md) • [Discord](https://discord.gg/wSyUQYfhAw)

---

## Mantenedores principales

| Rol               | Nombre      | GitHub                                          |
| ----------------- | ----------- | ----------------------------------------------- |
| Creador y líder   | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo)  |

## Embajadores

| Nombre     | GitHub                                           |
| ---------- | ------------------------------------------------ |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Especialistas en documentación

| Nombre  | GitHub                                 |
| ------- | -------------------------------------- |
| devswha | [@devswha](https://github.com/devswha) |

## Principales colaboradores

| Nombre         | GitHub                                         | Commits |
| -------------- | ---------------------------------------------- | ------- |
| JunghwanNA     | [@shaun0927](https://github.com/shaun0927)     | 65      |
| riftzen-bit    | [@riftzen-bit](https://github.com/riftzen-bit) | 52      |
| Seunggwan Song | [@Nathan-Song](https://github.com/Nathan-Song) | 20      |
| BLUE           | [@blue-int](https://github.com/blue-int)       | 20      |
| Junho Yeo      | [@junhoyeo](https://github.com/junhoyeo)       | 15      |

## Inicio Rápido

**Paso 1: Instalar**

Instalación como marketplace/plugin (recomendada para la mayoría de usuarios de Claude Code).
Son comandos slash de Claude Code: escríbelos **uno por uno** (pegar ambas líneas a la vez fallará):

```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
```

Después:

```bash
/plugin install oh-my-claudecode
```

Si prefieres la vía CLI/runtime de npm en lugar del flujo del marketplace:

```bash
npm i -g oh-my-claude-sisyphus@latest
```

> **Advertencia conocida de npm:** npm puede mostrar `deprecated prebuild-install@7.1.3` durante la instalación del CLI.
> Actualmente proviene de la dependencia nativa `better-sqlite3` (`better-sqlite3 -> prebuild-install`);
> `prebuild-install@7.1.3` sigue siendo la última versión publicada, así que todavía no hay una actualización
> ni un override seguro dentro del repositorio para eliminar la advertencia. Está registrada en
> [#2913](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/2913) y por sí sola no significa que la
> instalación del CLI de OMC haya fallado.

**Paso 2: Configurar**

```bash
# Dentro de una sesión de Claude Code / OMC
/omc-setup

# Desde tu terminal
omc setup
```

Si ejecutas OMC mediante `omc --plugin-dir <path>` o `claude --plugin-dir <path>`, añade `--plugin-dir-mode` a `omc setup` (o exporta `OMC_PLUGIN_ROOT` antes de ejecutarlo) para que el instalador no duplique las habilidades/agentes que el plugin ya proporciona en tiempo de ejecución. Consulta la [sección Plugin directory flags en REFERENCE.md](./docs/REFERENCE.md#plugin-directory-flags) para una matriz de decisión completa y todos los indicadores disponibles.

**Paso 3: Construye algo**

```bash
# Dentro de una sesión de Claude Code / OMC
/autopilot "build a REST API for managing tasks"

# Atajo en lenguaje natural dentro de la sesión
autopilot: build a REST API for managing tasks
```

#### Perfiles de etapas de autopilot con nombre (v1)

Selecciona un perfil de etapas configurado únicamente con `/autopilot --workflow <name> <task>`:

```text
/autopilot --workflow plan-build-qa "build a REST API for managing tasks"
```

Los perfiles se configuran en `autopilot.workflows` dentro de `.claude/omc.jsonc` (proyecto) o `~/.config/claude-omc/config.jsonc` (usuario). Un perfil v1 contiene solo `version: 1` y `stages`:

```jsonc
{
  "autopilot": {
    "workflows": {
      "plan-build-qa": {
        "version": 1,
        "stages": ["ralplan", "execution", "qa"]
      }
    }
  }
}
```

Las secuencias admitidas son `[ralplan, execution]`, `[ralplan, execution, ralph]`, `[ralplan, execution, qa]` y `[ralplan, execution, ralph, qa]`. Un perfil de proyecto con el mismo nombre reemplaza por completo al perfil de usuario; los nombres distintos conviven. Las variables de entorno no pueden definir perfiles. Los perfiles permanecen dentro del ciclo de vida existente de autopilot (estado, cancelación, reanudación, Stop y HUD); las invocaciones heredadas sin `--workflow` siguen siendo compatibles.

Por ahora, los perfiles con nombre requieren Linux con la utilidad `flock`, porque su frontera de evidencia de transcripciones usa recorrido de descriptores de archivo sin seguir enlaces (no-follow) propio de Linux, y su bloqueo de mutación recuperable usa bloqueo consultivo del kernel. Los entornos no compatibles rechazan la invocación explícita de `--workflow` antes de crear o modificar el estado de autopilot; el autopilot heredado sigue disponible.

V1 excluye intencionadamente los campos o el enrutamiento de modelos (`stageModels`), la ejecución en línea, los comandos/modos/estado dinámicos, las etapas o plugins arbitrarios y la discrepancia del analizador del frontmatter de habilidades personalizadas. Consulta el [ADR de perfiles de etapas de autopilot con nombre](docs/adr/03487-named-autopilot-stage-profiles.md) y la [Referencia](docs/REFERENCE.md#named-autopilot-stage-profiles-v1).

Eso es todo. Todo lo demás es automático.

### Comandos CLI vs. habilidades en sesión

OMC expone dos superficies distintas:

- **Comandos CLI de terminal**: ejecuta `omc ...` desde tu shell tras instalar la vía npm/runtime (`npm i -g oh-my-claude-sisyphus@latest`) o desde un checkout local.
- **Habilidades en sesión**: ejecuta `/...` dentro de una sesión de Claude Code tras instalar el plugin / flujo de setup.

| Característica                                 | CLI de terminal                               | Habilidad en sesión                                                     | Notas                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Setup                                          | `omc setup`                                   | `/omc-setup`                                                            | Ambos son puntos de entrada reales.                                                                                                   |
| Consultar proveedores                          | `omc ask codex "review this patch"`           | `/ask codex "review this patch"`                                        | Ambos usan el mismo flujo de asesor. Proveedores: `claude`, `codex`, `gemini`, `antigravity`, `grok`, `cursor`, `muse`.               |
| Orquestación Team                              | `omc team 2:codex "review auth flow"`         | `/team 3:executor "fix all TypeScript errors"`                          | Existen ambos, pero son runtimes distintos: `omc team` lanza trabajadores CLI en tmux; `/team` ejecuta el flujo de equipo nativo en sesión. |
| Escaneo previo de peligros                     | `omc lookout scan --brief "..." [--json] [--strict]` | —                                                                | Solo informativo: analiza el briefing de la tarea y el espacio de trabajo antes de una ejecución desatendida e informa de hallazgos de peligro (contrato de hallazgos/severidad). Códigos de salida: 0 para escaneos correctos no estrictos (y estrictos sin señales de alto riesgo), 1 con `--strict` y señales de alto riesgo, 2 por error de uso/escaneo. |
| Autopilot / Ralph / Execute / Deep Interview   | —                                             | `/autopilot ...`, `/ralph ...`, `/execute ...`, `/deep-interview ...`   | Son habilidades en sesión. En este repositorio no existe un subcomando CLI `omc autopilot` / `omc ralph` / `omc execute`.              |
| Autoresearch                                   | `omc autoresearch` (**shim obsoleto**)        | `/deep-interview --autoresearch ...` + `/oh-my-claudecode:autoresearch` | La configuración se queda en deep-interview; la ejecución ahora pertenece a la habilidad con estado.                                  |

### VS Code, Agent SDK y alcance de la automatización

- **Extensión de VS Code / IDE**: OMC no incluye una extensión de VS Code ni documenta flujos de instalación o automatización específicos de extensiones. Usa las superficies de plugin de Claude Code o de CLI de terminal indicadas arriba; las integraciones con IDE son solo una forma opcional de acceder a Claude Code.
- **Agent SDK / uso programático**: el paquete npm exporta utilidades TypeScript como `createOmcSession()` y herramientas de expansión de prompts para programas Node.js locales que usan `@anthropic-ai/claude-agent-sdk`. Es una superficie de biblioteca, no un reemplazo de la interfaz del plugin de Claude Code.
- **CI/CD y automatización sin interfaz**: prefiere comandos de terminal deterministas (`omc setup`, `omc ask`, `omc session search`, scripts del repositorio como `npm run sync-metadata:verify`) y define `ANTHROPIC_API_KEY` o la autenticación CLI específica del proveedor en el entorno del runner. No dependas de comandos slash interactivos (`/autopilot`, `/ralph`, `/execute`, `/team`) en CI; requieren una sesión activa de Claude Code.

### ¿No sabes por dónde empezar?

Si no tienes claros los requisitos, tienes una idea vaga, o quieres microgestionar el diseño:

```
/deep-interview "I want to build a task management app"
```

La entrevista profunda usa preguntas socráticas para clarificar tu pensamiento antes de escribir cualquier código. Expone suposiciones ocultas y mide la claridad a través de dimensiones ponderadas, asegurando que sepas exactamente qué construir antes de que comience la ejecución.

## Modo Team (Recomendado)

A partir de **v4.1.7**, **Team** es la superficie canónica de orquestación en OMC. La palabra clave/habilidad heredada `swarm` se ha eliminado; usa `team` directamente.

```bash
/team 3:executor "fix all TypeScript errors"
```

Usa `/team ...` cuando quieras el flujo de equipo nativo de Claude Code dentro de la sesión. Usa `omc team ...` cuando quieras trabajadores CLI en tmux lanzados desde la terminal (paneles `claude` / `codex` / `gemini`).

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

### Trabajadores CLI tmux — Codex, Gemini y Antigravity (v4.4.0+)

**v4.4.0 elimina los servidores MCP de Codex/Gemini** (proveedores `x`, `g`). Usa el runtime Team orientado a CLI (`omc team ...`) para lanzar procesos reales en paneles de tmux:

```bash
omc team 2:codex "review auth module for security issues"
omc team 2:gemini "redesign UI components for accessibility"
omc team 2:antigravity "redesign UI components for accessibility"
omc team 1:claude "implement the payment flow"
omc team 1:cursor "implement the payment flow"
omc team status auth-review
omc team shutdown auth-review
```

Para trabajo mixto de Codex + Antigravity en un solo comando, ejecuta `/ask codex` y `/ask antigravity` y deja que Claude sintetice los resultados (Gemini sigue disponible como alternativa empresarial / con clave de API):

```bash
/ask codex "Review this PR — architecture"
/ask antigravity "Review this PR — UI components"
```

| Superficie                        | Trabajadores                  | Mejor para                                                         |
| --------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `omc team N:codex "..."`          | N paneles Codex CLI           | Revisión de código, análisis de seguridad, arquitectura            |
| `omc team N:gemini "..."`         | N paneles Gemini CLI          | Diseño UI/UX, docs, tareas de gran contexto (empresarial / clave de API) |
| `omc team N:antigravity "..."`    | N paneles Antigravity (`agy`) | Diseño UI/UX, docs, tareas de gran contexto                        |
| `omc team N:grok "..."`           | N paneles Grok Build CLI      | Revisión de código, verificación cruzada de análisis               |
| `omc team N:cursor "..."`         | N paneles de agente Cursor    | Tareas de implementación y de estilo revisor                       |
| `omc team N:claude "..."`         | N paneles Claude CLI          | Tareas generales vía Claude CLI en tmux                            |
| `/ask codex` + `/ask antigravity` | Síntesis de asesores tri-modelo | Revisión mixta Codex + Antigravity en una sola pasada            |

Los trabajadores se inician bajo demanda y terminan cuando su tarea se completa — sin uso de recursos en espera. Requiere la CLI seleccionada (`codex`, `gemini`, `agy` (antigravity), `grok` o `cursor-agent`) instalada y autenticada, y una sesión tmux activa.

Autopilot puede preferir trabajadores ejecutores de Cursor durante la ejecución de Team mediante `.claude/omc.jsonc`:

```jsonc
{
  "autopilot": {
    "execution": "team",
    "team": { "agentTypes": ["cursor"] }
  }
}
```

Esta configuración hace que la etapa de ejecución de autopilot use `omc team 1:cursor "..."` o `/team 1:cursor "..."` para el trabajo de implementación. Cursor también admite roles de estilo revisor (`critic`, `code-reviewer`, `security-reviewer`, `test-engineer`): esos trabajadores emiten el archivo de veredicto estructurado que consume el líder del equipo para hacer avanzar la tarea, y la aprobación final sigue siendo responsabilidad de la sesión líder. Cursor requiere un `cursor-agent` instalado y autenticado.

Fija un modelo de Cursor con la variable de entorno `OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL`, o por rol con `team.roleRouting.<role>.model`. `externalModels.defaults.cursorModel` se aplica a los trabajadores enrutados mediante `team.roleRouting`. Los ids salen de `cursor-agent --list-models`, por ejemplo `cursor-grok-4.6-high` o `composer-2.5`. Si no se define, `cursor-agent` elige su propio modelo.

Los worktrees de los trabajadores de Team nativo se están añadiendo detrás de una opción/configuración opt-in. Consulta [Native Team Worktree Mode](docs/TEAM-WORKTREE-MODE.md) para el contrato del espacio de trabajo, las reglas canónicas de la raíz de estado, la política de preservación de worktrees sucios y la lista de verificación.

> **Nota: Nombre del paquete** — El proyecto usa la marca **oh-my-claudecode** (repositorio, plugin, comandos), pero el paquete npm se publica como [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus). Si instalas o actualizas las herramientas CLI vía npm/bun, usa `npm i -g oh-my-claude-sisyphus@latest`; el paquete instala tanto `oh-my-claudecode` como los alias cortos del comando `omc`.

### Actualizar

Si instalaste OMC mediante npm, actualiza con el nombre del paquete publicado:

```bash
npm i -g oh-my-claude-sisyphus@latest
```

> **Nota sobre el nombre del paquete:** el repositorio, el plugin y los comandos usan la marca **oh-my-claudecode**, pero el nombre del paquete npm publicado sigue siendo `oh-my-claude-sisyphus`. Las instalaciones con npm exponen tanto `oh-my-claudecode` como `omc`; los ejemplos prefieren `omc` por brevedad.

Si instalaste OMC mediante el flujo de marketplace/plugin de Claude Code, actualiza con:

```bash
# 1. Actualizar el clon del marketplace
/plugin marketplace update omc

# 2. Volver a ejecutar el setup para actualizar la configuración
/omc-setup
```

Si desarrollas desde un checkout local o un worktree de git, actualiza primero el checkout y luego vuelve a ejecutar el setup desde ese worktree para que el runtime activo coincida con el código que estás probando.

> **Nota:** Si la actualización automática del marketplace no está activada, debes ejecutar manualmente `/plugin marketplace update omc` para sincronizar la última versión antes de ejecutar el setup.

Si experimentas problemas después de actualizar, limpia la caché antigua del plugin:

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
- **Orquestación Team-first** - Team es la superficie multiagente canónica
- **Interfaz de lenguaje natural** - Sin comandos que memorizar, solo describe lo que quieres
- **Paralelización automática** - Tareas complejas distribuidas entre agentes especializados
- **Ejecución persistente** - No se rendirá hasta que el trabajo esté verificado y completo
- **Optimización de costos** - Enrutamiento inteligente de modelos ahorra 30-50% en tokens
- **Aprende de la experiencia** - Extrae y reutiliza automáticamente patrones de resolución de problemas
- **Visibilidad en tiempo real** - Barra de estado HUD muestra lo que está sucediendo internamente

---

## Características

### Modos de Orquestación

Múltiples estrategias para diferentes casos de uso — desde la orquestación respaldada por Team hasta la refactorización eficiente en tokens. [Aprende más →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#execution-modes)

| Modo                        | Qué es                                                                                  | Usar para                                                               |
| --------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Team (recomendado)**      | Pipeline canónico por etapas (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Agentes Claude coordinados en una lista de tareas compartida         |
| **omc team (CLI)**          | Trabajadores CLI en tmux — procesos reales `claude`/`codex`/`gemini`/`antigravity`/`grok`/`cursor-agent` en paneles divididos | Tareas con Codex/Gemini/Antigravity/Grok/Cursor CLI; se inician bajo demanda, terminan al completar |
| **Asesor tri-modelo (`/ask codex` + `/ask antigravity`)** | Claude sintetiza la salida de ambos asesores                | Trabajo mixto de backend + UI que necesita Codex y Antigravity          |
| **Autopilot**               | Ejecución autónoma (un único agente líder)                                              | Trabajo de feature end-to-end con mínima ceremonia                      |
| **Execute**                 | Ejecución persistente con bucles de verificación/corrección, del plan al código funcionando | Tareas que deben completarse totalmente (sin parciales silenciosos)  |
| **Verify**                  | Comprobaciones de finalización basadas en evidencia hasta que pasen los objetivos de tests/build/lint/typecheck | Puertas de calidad que requieren ciclos repetidos de diagnóstico/corrección |
| **Claude Code `/goal`**     | Bucle nativo de objetivos entre turnos de Claude Code                                   | Una condición de finalización medible por sesión; no es un registro de evidencia de OMC |
| **Ultragoal solo con artefactos** | Artefactos duraderos de objetivo/checkpoint/evidencia sin iniciar un bucle        | Traspasos, auditorías o runtimes de bucle no disponibles o en conflicto |

### Guía del flujo de objetivos

Usa solo una autoridad de bucle principal por sesión. `/goal` de Claude Code es útil para una condición de finalización nativa entre turnos, mientras que Execute se encarga de la finalización verificada con un solo agente, Team de la ejecución paralela por etapas y Verify del ciclo repetido de puertas de calidad. Ultragoal solo con artefactos es la alternativa segura cuando necesitas artefactos de objetivo y evidencia duraderos sin iniciar otro bucle.

Para el comportamiento de `/goal`, apóyate en fuentes de Claude Code/Anthropic: la [documentación de `/goal` de Claude Code](https://code.claude.com/docs/en/goal) y el [changelog de Claude Code de Anthropic](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md). **No** afirmes que el evaluador de `/goal` ejecuta comandos o lee archivos por su cuenta; muestra la salida de los tests, los diffs y la evidencia de revisión en la conversación antes de dar un objetivo por demostrado.

### Orquestación Inteligente

- **19 agentes especializados** (con variantes por nivel) para arquitectura, investigación, diseño, pruebas y análisis de datos
- **Enrutamiento inteligente de modelos** - Haiku para tareas simples, Opus para razonamiento complejo
- **Delegación automática** - El agente correcto para el trabajo, siempre
- **[Matriz de compatibilidad Modelo × Agente](docs/agents/model-compatibility.md)** - Qué modelo combinar con cada agente, con presets premium/balanceado/económico

### Experiencia de Desarrollo

- **Disparadores de prompt** - `ralph`, `ralplan`; Team sigue siendo explícito mediante `/team`
- **Barra de estado HUD** - Métricas de orquestación en tiempo real en tu barra de estado
  - Si lanzas Claude Code directamente con `claude --plugin-dir <path>` (sin pasar por el shim `omc`), exporta `OMC_PLUGIN_ROOT=<path>` en tu shell para que el bundle del HUD se resuelva en el mismo checkout que el cargador del plugin. Consulta la [sección Plugin directory flags en REFERENCE.md](./docs/REFERENCE.md#plugin-directory-flags) para más detalles.
- **Aprendizaje de habilidades** - Extrae patrones reutilizables de tus sesiones
- **Análisis y seguimiento de costos** - Comprende el uso de tokens en todas las sesiones

### Contribuir

¿Quieres contribuir a OMC? Consulta [CONTRIBUTING.md](./CONTRIBUTING.md) para la guía completa para desarrolladores, que incluye cómo hacer un fork, preparar un checkout local, enlazarlo como tu plugin activo, ejecutar los tests y enviar PRs.

### Habilidades Personalizadas

Aprende una vez, reutiliza para siempre. OMC extrae conocimiento valioso de depuración en archivos de habilidades portátiles que se inyectan automáticamente cuando son relevantes.

|                      | Alcance de Proyecto                                                      | Alcance de Usuario             |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| **Ruta**             | `.omc/skills/`                                                           | `~/.omc/skills/`               |
| **Compartido con**   | Equipo (haz commit del archivo de habilidad para conservarlo entre worktrees) | Todos tus proyectos       |
| **Prioridad**        | Mayor (anula el alcance de usuario)                                      | Menor (respaldo)               |

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
**Auto-aprendizaje:** `/skillify` extrae patrones reutilizables con estrictos criterios de calidad
**Auto-inyección:** Las habilidades coincidentes se cargan en el contexto automáticamente — sin necesidad de invocación manual

Las habilidades con alcance de proyecto creadas por OMC se guardan en `.omc/skills/` y están pensadas para hacerles commit cuando quieras compartirlas. Durante la ejecución de slash/habilidades, OMC también lee las habilidades del espacio de trabajo de Claude Code en `.claude/skills/` y las habilidades de compatibilidad en `.agents/skills/`, de modo que los paquetes `SKILL.md` locales del espacio de trabajo siguen siendo invocables sin copiarlos a las habilidades globales del usuario. Si creas habilidades locales al proyecto dentro de un worktree de git enlazado y no les haces commit, desaparecen cuando se elimina ese worktree.

### Estado de `.omc/` y git

OMC escribe por defecto el estado de ejecución, los datos de sesión, los planes, los logs, los traspasos, las notas de investigación y los artefactos locales dentro de `.omc/`. El `.gitignore` del repositorio mantiene esos datos de ejecución en local con una excepción intencionada: `.omc/skills/**` sigue siendo apto para commit, para las habilidades de proyecto que quieras compartir con el equipo. Trata todo lo demás bajo `.omc/` como estado operativo local que puede contener prompts, transcripciones o rutas específicas de tu máquina.

En los worktrees de git enlazados, el directorio `.omc/` por defecto vive dentro de ese worktree, por lo que al eliminar el worktree se elimina su estado local de OMC. Define `OMC_STATE_DIR` si quieres que el estado sobreviva a la eliminación del worktree, o añade un marcador `.omc-workspace` cuando varios repositorios independientes deban compartir una raíz de estado a nivel de directorio padre. Consulta el [contrato de estado, gitignore, worktrees y espacios de trabajo de OMC](docs/REFERENCE.md#omc-state-gitignore-worktree-and-workspace-contract).

Fuera de un repositorio git, OMC usa una única raíz de estado segura y canónica en `~/.omc/` (o `$OMC_STATE_DIR/non-git` cuando se configura un estado centralizado); no crea una nueva raíz de estado para cada cwd ni escribe estado en directorios sensibles como `~/.ssh`, `~/Downloads` o descendientes de la raíz temporal del sistema. El estado local al cwd heredado no se toca hasta que se migre explícitamente con `state_migrate_non_git`. Las herramientas MCP de estado respetan un `workingDirectory` explícito y mantienen las comprobaciones de límite de repositorio para sesiones respaldadas por git.

[Lista completa de características →](docs/REFERENCE.md)

### Espacios de trabajo con varios repositorios

Cuando varios repositorios git independientes comparten un directorio padre, coloca un marcador `.omc-workspace` en el padre para que todos los subrepositorios compartan una única raíz de estado `.omc/`:

```bash
cd /path/to/parent-dir-with-many-repos
echo '{"id":"my-workspace"}' > .omc-workspace
# Las sesiones dentro de cualquier subrepositorio ahora comparten /path/.omc/
# Para ejecuciones ultragoal en paralelo:
cd repo-A && omc ultragoal create-goals --auto-plan-id --brief "..."
cd ../repo-B && omc ultragoal create-goals --auto-plan-id --brief "..."
```

Consulta [Multi-repo workspaces en REFERENCE.md](docs/REFERENCE.md#multi-repo-workspaces-with-omc-workspace) para el orden de resolución, `OMC_STATE_DIR` y las opciones de identificador del espacio de trabajo.

---

## Atajos en sesión

Estos atajos se ejecutan **dentro de una sesión de Claude Code / OMC**, no como comandos CLI de terminal. Para comandos de shell, usa las formas `omc ...` mostradas arriba. El modo Team es explícito: usa `/team ...` en sesión u `omc team ...` desde tu shell en lugar de esperar un disparador con la palabra clave `team` suelta.

| Forma en sesión            | Tipo                         | Efecto                                          | Ejemplo                                        |
| -------------------------- | ---------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `/team`                    | Habilidad slash              | Orquestación Team canónica                      | `/team 3:executor "fix all TypeScript errors"` |
| `/autopilot` / `autopilot` | Habilidad / disparador de prompt | Ejecución completamente autónoma            | `/autopilot "build a todo app"`                |
| `/execute`                 | Habilidad slash              | Lleva una tarea aprobada hasta código verificado | `/execute "refactor auth"`                    |
| `/ralph` / `ralph`         | Habilidad / disparador de prompt | Modo persistencia                           | `/ralph "refactor auth"`                       |
| `/ralplan` / `ralplan`     | Habilidad / disparador de prompt | Consenso de planificación iterativa         | `/ralplan "plan this feature"`                 |
| `/deep-interview`          | Habilidad slash              | Clarificación socrática de requisitos           | `/deep-interview "vague idea"`                 |
| `deepsearch`               | Disparador de prompt         | Enrutamiento de búsqueda centrado en el código  | `deepsearch for auth middleware`               |
| `ultrathink`               | Disparador de prompt         | Modo de razonamiento profundo                   | `ultrathink about this architecture`           |
| `cancelomc`, `stopomc`     | Disparador de prompt         | Detiene los modos activos de OMC                | `stopomc`                                      |

**Notas:**

- **El trabajo en paralelo usa Team o la delegación a ejecutores**: elige `/team` para carriles coordinados o delega las tareas de implementación a ejecutores; usa Ralph cuando la prioridad sea la persistencia hasta la finalización verificada.
- El alias de compatibilidad `swarm` se ha eliminado; migra los prompts existentes a la sintaxis de `/team`.
- Los disparadores de palabra clave `plan this` / `plan the` se eliminaron; usa `ralplan` o `/oh-my-claudecode:plan` de forma explícita.

## Utilidades

### Asesor de proveedores (`omc ask` / `/ask`)

Ejecuta las CLIs locales de los proveedores y guarda un artefacto markdown en `.omc/artifacts/ask/`.

```bash
# CLI de terminal
omc ask claude "review this migration plan"
omc ask codex --prompt "identify architecture risks"
omc ask gemini --prompt "propose UI polish ideas"
omc ask antigravity --prompt "propose UI polish ideas"
omc ask grok --prompt "cross-check this code review"
omc ask cursor --prompt "apply this implementation plan"
omc ask muse --agent-prompt critic --prompt "review this plan"
omc ask claude --agent-prompt executor --prompt "draft implementation steps"

# Dentro de una sesión de Claude Code / OMC
/ask claude "review this migration plan"
/ask codex "identify architecture risks"
/ask antigravity "propose UI polish ideas"
/ask cursor "apply this implementation plan"
/ask muse --agent-prompt critic "review this plan"
```

Variables de entorno canónicas:

- `OMC_ASK_ADVISOR_SCRIPT`
- `OMC_ASK_ORIGINAL_TASK`

Los alias de la fase 1 `OMX_ASK_ADVISOR_SCRIPT` y `OMX_ASK_ORIGINAL_TASK` se aceptan con avisos de obsolescencia.

### Autoresearch (habilidad con estado)

`omc autoresearch` es ahora un **shim obsoleto de forma estricta**. El flujo autorizado es:

```bash
/deep-interview --autoresearch improve startup performance
/oh-my-claudecode:autoresearch
```

- `deep-interview --autoresearch` genera/define la misión y el evaluador
- `autoresearch` ejecuta el bucle acotado con estado de una sola misión
- cada iteración registra el JSON de evaluación y los logs de decisión en markdown
- las iteraciones que no pasan continúan
- la parada estricta se controla con un tope explícito de tiempo máximo de ejecución

### Espera de Límite de Tasa

Reanuda automáticamente sesiones de Claude Code cuando se reinician los límites de tasa.

```bash
omc wait          # Verificar estado, obtener orientación
omc wait --start  # Habilitar demonio de reanudación automática
omc wait --stop   # Deshabilitar demonio
```

**Requiere:** tmux (para detección de sesión)

### Monitorización y observabilidad

Usa el HUD para la observabilidad en vivo y los artefactos de sesión/replay actuales para la inspección posterior a la sesión:

- Preset del HUD: `/oh-my-claudecode:hud setup` y luego usa un preset compatible como `"omcHud": { "preset": "focused" }`
- Resúmenes de sesión: `.omc/sessions/*.json`
- Logs de replay: `.omc/state/agent-replay-*.jsonl`
- Renderizado del HUD en vivo: `omc hud`
- Informes locales de fricción: `omc session friction report --since 24h` resume las señales de saturación de contexto y de fricción del operador a partir de los artefactos de sesión locales sin imprimir los prompts ni la salida de herramientas en bruto; añade `--json` para automatización.

### Configuración de Jev Judgment

**Jev** aporta toma de decisiones calibrada a la orquestación de OMC. Actívalo con variables de entorno:

```bash
export TYPESAFE_API_KEY="sk-..."              # Clave de API de Jev (obligatoria)
export OMC_JEV="all:active"                    # Todos los puntos de juicio activos
export OMC_JEV_TIMEOUT_MS="2000"               # Timeout por llamada (por defecto: 2000ms)
```

**Modos:**
- `shadow` (por defecto): se consulta a Jev pero deciden las heurísticas; las respuestas se registran para análisis
- `active`: la respuesta de Jev anula a la heurística; añade latencia (acotada por `OMC_JEV_TIMEOUT_MS`)
- `off`: no se envían consultas a Jev (cero salida de datos)

Jev decide el disparo de habilidades, el enrutamiento de modelos, la continuación de bucles, la poda de contexto, el dimensionamiento de tareas y los veredictos de finalización. Ante un timeout, un error HTTP o un fallo de análisis, el modo activo degrada a la heurística sin bloquear. Por defecto no sale ningún dato: sin configuración, no se envía nada a la API. Consulta **[Jev Judgment Points](docs/HOOKS.md#jev-judgment-points)** en HOOKS.md para la referencia completa de configuración y el registro de puntos.

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
    "session-start": {
      "gateway": "my-gateway",
      "instruction": "Session started for {{projectName}}",
      "enabled": true
    },
    "stop": {
      "gateway": "my-gateway",
      "instruction": "Session stopping for {{projectName}}",
      "enabled": true
    }
  }
}
```

**Variables de entorno:**

| Variable                                   | Descripción                                   |
| ------------------------------------------ | --------------------------------------------- |
| `OMC_OPENCLAW=1`                           | Habilitar OpenClaw                            |
| `OMC_OPENCLAW_DEBUG=1`                     | Habilitar registro de depuración              |
| `OMC_OPENCLAW_CONFIG=/path/to/config.json` | Ruta alternativa del archivo de configuración |

**Eventos de hook soportados (6 activos en bridge.ts):**

| Evento              | Disparador                                              | Variables de plantilla principales                    |
| ------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `session-start`     | La sesión comienza                                      | `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}` |
| `stop`              | La respuesta de Claude se completa                      | `{{sessionId}}`, `{{projectName}}`                    |
| `keyword-detector`  | Cada envío de prompt                                    | `{{prompt}}`, `{{sessionId}}`                         |
| `ask-user-question` | Claude solicita entrada del usuario                     | `{{question}}`, `{{sessionId}}`                       |
| `pre-tool-use`      | Antes de la invocación de herramienta (alta frecuencia) | `{{toolName}}`, `{{sessionId}}`                       |
| `post-tool-use`     | Después de la invocación de herramienta (alta frecuencia) | `{{toolName}}`, `{{sessionId}}`                     |

**Variables de entorno del canal de respuesta:**

| Variable                 | Descripción                     |
| ------------------------ | ------------------------------- |
| `OPENCLAW_REPLY_CHANNEL` | Canal de respuesta (ej. `discord`) |
| `OPENCLAW_REPLY_TARGET`  | ID del canal                    |
| `OPENCLAW_REPLY_THREAD`  | ID del hilo                     |

Consulta `scripts/openclaw-gateway-demo.mjs` para un gateway de referencia que retransmite payloads de OpenClaw a un endpoint de automatización HTTPS personalizado.

---

## Documentación

- **[Referencia Completa](docs/REFERENCE.md)** - Documentación completa de características
- **[Referencia CLI](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#cli-reference)** - Todos los comandos, flags y herramientas de `omc`
- **[Guía de Notificaciones](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#notifications)** - Configuración de Discord, Telegram, Slack y webhooks
- **[Flujos de Trabajo Recomendados](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#workflows)** - Cadenas de habilidades probadas para tareas comunes
- **[Notas de Versión](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#release-notes)** - Novedades en cada versión
- **[Sitio Web](https://yeachan-heo.github.io/oh-my-claudecode-website)** - Guías interactivas y ejemplos
- **[Guía de Migración](docs/MIGRATION.md)** - Actualización desde v2.x
- **[Arquitectura](docs/ARCHITECTURE.md)** - Cómo funciona internamente
- **[Monitoreo de Rendimiento](docs/PERFORMANCE-MONITORING.md)** - Seguimiento de agentes, depuración y optimización
- **[Matriz de compatibilidad Modelo × Agente](docs/agents/model-compatibility.md)** - Qué modelo combinar con cada agente (presets premium / balanceado / económico)
- **[Guía de Seguridad](SECURITY.md)** - Despliegue empresarial y endurecimiento

---

## Requisitos

- CLI de [Claude Code](https://docs.anthropic.com/claude-code)
- Suscripción Claude Max/Pro O clave API de Anthropic

### Plataforma y tmux

Características de OMC como `omc team` y la detección de límites de tasa requieren **tmux**:

| Plataforma     | Proveedor de tmux                                     | Instalación             |
| -------------- | ----------------------------------------------------- | ----------------------- |
| macOS          | [tmux](https://github.com/tmux/tmux)                  | `brew install tmux`     |
| Ubuntu/Debian  | tmux                                                  | `sudo apt install tmux` |
| Fedora         | tmux                                                  | `sudo dnf install tmux` |
| Arch           | tmux                                                  | `sudo pacman -S tmux`   |
| Windows        | [psmux](https://github.com/marlocarlo/psmux) (nativo) | `winget install psmux`  |
| Windows (WSL2) | tmux (dentro de WSL)                                  | `sudo apt install tmux` |

> **Usuarios de Windows:** [psmux](https://github.com/marlocarlo/psmux) ofrece un binario `tmux` nativo para Windows con 76 comandos compatibles con tmux. No requiere WSL.

### Opcional: Orquestación Multi-IA

OMC puede opcionalmente orquestar proveedores de IA externos para validación cruzada y consistencia de diseño. **No son necesarios** — OMC funciona completamente sin ellos.

| Proveedor                                                               | Instalación                                                  | Qué habilita                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [Antigravity CLI](https://antigravity.google) (`agy`)                   | Instala según las [instrucciones oficiales](https://antigravity.google) (proporciona el binario `agy`) | Revisión de diseño, consistencia UI — sucesor de Google del Gemini CLI |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli)               | `npm install -g @google/gemini-cli`                          | Revisión de diseño, consistencia UI (contexto de 1M tokens) — el acceso empresarial / con clave de API no se ve afectado |
| [Codex CLI](https://github.com/openai/codex)                            | `npm install -g @openai/codex`                               | Validación de arquitectura, verificación cruzada de código                |
| [Grok Build](https://build.grok.com)                                    | Descarga desde build.grok.com (`grok` en `~/.grok/bin/grok`) | Revisión de código, verificación cruzada de análisis                      |

> **Migrando desde Gemini CLI:** Según el anuncio de Google, el Gemini CLI está siendo sustituido por el Antigravity CLI (`agy`); consulta la [documentación oficial de Antigravity](https://antigravity.google). Usa `omc team N:antigravity` y `omc ask antigravity` donde antes usabas `gemini`. El soporte sin interfaz de `agy` en Windows es desconocido/no probado — informa de los problemas en el repositorio original.

**Costo:** 3 planes Pro (Claude + Antigravity/Gemini + ChatGPT) cubren todo por ~$60/mes.

---

## Licencia

MIT

---

<div align="center">

**Inspirado por:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code) • [Ouroboros](https://github.com/Q00/ouroboros)

**Curva de aprendizaje cero. Poder máximo.**

</div>

<!-- OMC:FEATURED-CONTRIBUTORS:START -->
## Destacado por los colaboradores de OmC

Principales repositorios personales (no forks ni archivados) de colaboradores históricos de OMC (más de 100 estrellas en GitHub).

- [@Yeachan-Heo](https://github.com/Yeachan-Heo) — [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) (⭐ 40k)
- [@junhoyeo](https://github.com/junhoyeo) — [tokscale](https://github.com/junhoyeo/tokscale) (⭐ 5.8k)
- [@psmux](https://github.com/psmux) — [psmux](https://github.com/psmux/psmux) (⭐ 3.8k)
- [@devswha](https://github.com/devswha) — [ovis](https://github.com/devswha/ovis) (⭐ 1.6k)
- [@MeroZemory](https://github.com/MeroZemory) — [ida-multi-mcp](https://github.com/MeroZemory/ida-multi-mcp) (⭐ 467)
- [@GeiserX](https://github.com/GeiserX) — [awesome-spain](https://github.com/GeiserX/awesome-spain) (⭐ 362)
- [@BowTiedSwan](https://github.com/BowTiedSwan) — [buildflow](https://github.com/BowTiedSwan/buildflow) (⭐ 296)
- [@J-Pster](https://github.com/J-Pster) — [Psters_AI_Workflow](https://github.com/J-Pster/Psters_AI_Workflow) (⭐ 289)
- [@alohays](https://github.com/alohays) — [awesome-visual-representation-learning-with-transformers](https://github.com/alohays/awesome-visual-representation-learning-with-transformers) (⭐ 271)
- [@HaD0Yun](https://github.com/HaD0Yun) — [Doyunha-Gopeak](https://github.com/HaD0Yun/Doyunha-Gopeak) (⭐ 270)
- [@changeroa](https://github.com/changeroa) — [StyleGallery](https://github.com/changeroa/StyleGallery) (⭐ 265)
- [@jcwleo](https://github.com/jcwleo) — [random-network-distillation-pytorch](https://github.com/jcwleo/random-network-distillation-pytorch) (⭐ 264)
- [@HwangTaehyun](https://github.com/HwangTaehyun) — [github-repository-contribution-stats](https://github.com/HwangTaehyun/github-repository-contribution-stats) (⭐ 241)
- [@shaun0927](https://github.com/shaun0927) — [openchrome](https://github.com/shaun0927/openchrome) (⭐ 235)
- [@emgeee](https://github.com/emgeee) — [mean-tutorial](https://github.com/emgeee/mean-tutorial) (⭐ 199)
- [@anduinnn](https://github.com/anduinnn) — [HiFiNi-Auto-CheckIn](https://github.com/anduinnn/HiFiNi-Auto-CheckIn) (⭐ 172)
- [@Znuff](https://github.com/Znuff) — [consolas-powerline](https://github.com/Znuff/consolas-powerline) (⭐ 146)

<!-- OMC:FEATURED-CONTRIBUTORS:END -->

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

## Benchmark de visibilidad GEO

OmC incluye una especificación de producto [`geobench`](https://github.com/NomaDamas/geobench) para medir la tasa de aciertos en LLM, MRR, cuota de voz y citas.

- Especificación: [`geobench/oh-my-claudecode.yaml`](geobench/oh-my-claudecode.yaml)
- Guía de ejecución (runbook): [`docs/geobench.md`](docs/geobench.md)
