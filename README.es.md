[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | Español

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)

**Orquestación multi-agente para Claude Code. Curva de aprendizaje cero.**

*No aprendas Claude Code. Solo usa OMC.*

[Comenzar](#inicio-rápido) • [Documentación](https://yeachan-heo.github.io/oh-my-claudecode-website) • [Guía de Migración](docs/MIGRATION.md)

---

## Inicio Rápido

**Paso 1: Instalar**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Paso 2: Configurar**
```bash
/oh-my-claudecode:omc-setup
```

**Paso 3: Construye algo**
```
autopilot: build a REST API for managing tasks
```

Eso es todo. Todo lo demás es automático.

<h1 align="center">Tu Claude acaba de recibir esteroides.</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## ¿Por qué oh-my-claudecode?

- **Cero configuración requerida** - Funciona inmediatamente con valores predeterminados inteligentes
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

| Modo | Velocidad | Usar Para |
|------|-------|---------|
| **Autopilot** | Rápido | Flujos de trabajo completamente autónomos |
| **Ultrawork** | Paralelo | Máximo paralelismo para cualquier tarea |
| **Ralph** | Persistente | Tareas que deben completarse totalmente |
| **Ultrapilot** | 3-5x más rápido | Sistemas multi-componente |
| **Ecomode** | Rápido + 30-50% más barato | Proyectos conscientes del presupuesto |
| **Swarm** | Coordinado | Tareas independientes en paralelo |
| **Pipeline** | Secuencial | Procesamiento multi-etapa |

### Orquestación Inteligente

- **32 agentes especializados** para arquitectura, investigación, diseño, pruebas, ciencia de datos
- **Enrutamiento inteligente de modelos** - Haiku para tareas simples, Opus para razonamiento complejo
- **Delegación automática** - El agente correcto para el trabajo, siempre

### Experiencia de Desarrollo

- **Palabras clave mágicas** - `ralph`, `ulw`, `eco`, `plan` para control explícito
- **Barra de estado HUD** - Métricas de orquestación en tiempo real en tu barra de estado
- **Aprendizaje de habilidades** - Extrae patrones reutilizables de tus sesiones
- **Análisis y seguimiento de costos** - Comprende el uso de tokens en todas las sesiones

[Lista completa de características →](docs/REFERENCE.md)

---

## Palabras Clave Mágicas

Atajos opcionales para usuarios avanzados. El lenguaje natural funciona bien sin ellas.

| Palabra Clave | Efecto | Ejemplo |
|---------|--------|---------|
| `autopilot` | Ejecución completamente autónoma | `autopilot: build a todo app` |
| `ralph` | Modo persistencia | `ralph: refactor auth` |
| `ulw` | Máximo paralelismo | `ulw fix all errors` |
| `eco` | Ejecución eficiente en tokens | `eco: migrate database` |
| `plan` | Entrevista de planificación | `plan the API` |
| `ralplan` | Consenso de planificación iterativa | `ralplan this feature` |

**ralph incluye ultrawork:** Cuando activas el modo ralph, automáticamente incluye la ejecución paralela de ultrawork. No es necesario combinar palabras clave.

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

---

## Documentación

- **[Referencia Completa](docs/REFERENCE.md)** - Documentación completa de características
- **[Monitoreo de Rendimiento](docs/PERFORMANCE-MONITORING.md)** - Seguimiento de agentes, depuración y optimización
- **[Sitio Web](https://yeachan-heo.github.io/oh-my-claudecode-website)** - Guías interactivas y ejemplos
- **[Guía de Migración](docs/MIGRATION.md)** - Actualización desde v2.x
- **[Arquitectura](docs/ARCHITECTURE.md)** - Cómo funciona internamente

---

## Requisitos

- CLI de [Claude Code](https://docs.anthropic.com/claude-code)
- Suscripción Claude Max/Pro O clave API de Anthropic

---

## Licencia

MIT

---

<div align="center">

**Inspirado por:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/NexTechFusion/Superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code)

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
