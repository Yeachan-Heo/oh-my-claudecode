[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md) | [Русский](README.ru.md) | [Türkçe](README.tr.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | Italiano

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)

**Orchestrazione multi-agente per Claude Code. Zero curva di apprendimento.**

_Non imparare Claude Code. Usa semplicemente OMC._

[Inizia](#avvio-rapido) • [Documentazione](https://yeachan-heo.github.io/oh-my-claudecode-website) • [Guida alla migrazione](docs/MIGRATION.md)

---

## Avvio rapido

**Passo 1: Installazione**

```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Passo 2: Configurazione**

```bash
/oh-my-claudecode:omc-setup
```

**Passo 3: Costruisci qualcosa**

```
autopilot: build a REST API for managing tasks
```

Tutto qui. Il resto è automatico.

## Team Mode (Consigliato)

A partire dalla **v4.1.7**, **Team** è la superficie di orchestrazione canonica in OMC. I punti di ingresso legacy come **swarm** e **ultrapilot** sono ancora supportati, ma ora **vengono instradati a Team dietro le quinte**.

```bash
/oh-my-claudecode:team 3:executor "fix all TypeScript errors"
```

Team funziona come una pipeline a stadi:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Abilita i team nativi di Claude Code in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> Se i team sono disabilitati, OMC ti avviserà e passerà all'esecuzione senza Team quando possibile.

> **Nota: Nome del pacchetto** — Il progetto utilizza il brand **oh-my-claudecode** (repo, plugin, comandi), ma il pacchetto npm è pubblicato come [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus). Se installi gli strumenti CLI tramite npm/bun, usa `npm install -g oh-my-claude-sisyphus`.

### Aggiornamento

```bash
# 1. Aggiorna il plugin
/plugin install oh-my-claudecode

# 2. Riesegui il setup per aggiornare la configurazione
/oh-my-claudecode:omc-setup
```

Se riscontri problemi dopo l'aggiornamento, svuota la vecchia cache del plugin:

```bash
/oh-my-claudecode:omc-doctor
```

<h1 align="center">Il tuo Claude ha appena ricevuto dei superpoteri.</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## Perché oh-my-claudecode?

- **Nessuna configurazione richiesta** — Funziona immediatamente con impostazioni predefinite intelligenti
- **Orchestrazione team-first** — Team è la superficie multi-agente canonica (swarm/ultrapilot sono facciate di compatibilità)
- **Interfaccia in linguaggio naturale** — Nessun comando da memorizzare, descrivi semplicemente ciò che vuoi
- **Parallelizzazione automatica** — Le attività complesse vengono distribuite tra agenti specializzati
- **Esecuzione persistente** — Non si arrende finché il lavoro non è verificato e completato
- **Ottimizzazione dei costi** — Il routing intelligente dei modelli risparmia dal 30 al 50% sui token
- **Apprendimento dall'esperienza** — Estrae e riutilizza automaticamente i pattern di risoluzione dei problemi
- **Visibilità in tempo reale** — La HUD statusline mostra cosa succede dietro le quinte

---

## Funzionalità

### Modalità di orchestrazione

Strategie multiple per diversi casi d'uso — dall'orchestrazione basata su Team al refactoring efficiente in termini di token. [Scopri di più →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#execution-modes)

| Modalità                        | Descrizione                                                                             | Utilizzo                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Team (consigliato)**          | Pipeline canonica a stadi (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Agenti coordinati che lavorano su una lista di attività condivisa                        |
| **Autopilot**                   | Esecuzione autonoma (singolo agente leader)                                             | Sviluppo di funzionalità end-to-end con cerimonia minima                                 |
| **Ultrawork**                   | Parallelismo massimo (senza Team)                                                       | Correzioni/refactoring paralleli in burst quando Team non è necessario                   |
| **Ralph**                       | Modalità persistente con cicli verify/fix                                               | Attività che devono essere completate interamente (nessun risultato parziale silenzioso) |
| **Ecomode**                     | Routing efficiente in termini di token                                                  | Iterazione attenta al budget                                                             |
| **Pipeline**                    | Elaborazione sequenziale a stadi                                                        | Trasformazioni multi-step con ordine rigoroso                                            |
| **Swarm / Ultrapilot (legacy)** | Facciate di compatibilità che instradano a **Team**                                     | Workflow esistenti e documentazione precedente                                           |

### Orchestrazione intelligente

- **32 agenti specializzati** per architettura, ricerca, design, test, data science
- **Routing intelligente dei modelli** — Haiku per attività semplici, Opus per ragionamento complesso
- **Delega automatica** — L'agente giusto per il lavoro giusto, ogni volta

### Esperienza sviluppatore

- **Parole chiave magiche** — `ralph`, `ulw`, `eco`, `plan` per un controllo esplicito
- **HUD statusline** — Metriche di orchestrazione in tempo reale nella barra di stato
- **Apprendimento delle competenze** — Estrazione di pattern riutilizzabili dalle sessioni
- **Analisi e tracciamento dei costi** — Comprensione dell'utilizzo dei token su tutte le sessioni

[Lista completa delle funzionalità →](docs/REFERENCE.md)

---

## Parole chiave magiche

Scorciatoie opzionali per utenti avanzati. Il linguaggio naturale funziona bene anche senza di esse.

| Parola chiave | Effetto                                   | Esempio                                                         |
| ------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `team`        | Orchestrazione Team canonica              | `/oh-my-claudecode:team 3:executor "fix all TypeScript errors"` |
| `autopilot`   | Esecuzione completamente autonoma         | `autopilot: build a todo app`                                   |
| `ralph`       | Modalità persistente                      | `ralph: refactor auth`                                          |
| `ulw`         | Parallelismo massimo                      | `ulw fix all errors`                                            |
| `eco`         | Esecuzione efficiente in termini di token | `eco: migrate database`                                         |
| `plan`        | Intervista di pianificazione              | `plan the API`                                                  |
| `ralplan`     | Consenso di pianificazione iterativo      | `ralplan this feature`                                          |
| `swarm`       | Parola chiave legacy (instrada a Team)    | `swarm 5 agents: fix lint errors`                               |
| `ultrapilot`  | Parola chiave legacy (instrada a Team)    | `ultrapilot: build a fullstack app`                             |

**Note:**

- **ralph include ultrawork**: quando attivi la modalità ralph, include automaticamente l'esecuzione parallela di ultrawork.
- La sintassi `swarm N agents` è ancora riconosciuta per l'estrazione del numero di agenti, ma il runtime è basato su Team nella v4.1.7+.

## Utilità

### Attesa rate limit

Riprendi automaticamente le sessioni Claude Code quando i rate limit vengono ripristinati.

```bash
omc wait          # Controlla lo stato, ottieni indicazioni
omc wait --start  # Abilita il daemon di ripristino automatico
omc wait --stop   # Disabilita il daemon
```

**Requisiti:** tmux (per il rilevamento della sessione)

### Tag di notifica (Telegram/Discord)

Puoi configurare chi viene taggato quando i callback di stop inviano i riepiloghi della sessione.

```bash
# Imposta/sostituisci la lista dei tag
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"

# Aggiornamenti incrementali
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

Comportamento dei tag:

- Telegram: `alice` viene normalizzato in `@alice`
- Discord: supporta `@here`, `@everyone`, ID utente numerici e `role:<id>`
- I callback di tipo `file` ignorano le opzioni dei tag

---

## Documentazione

- **[Riferimento completo](docs/REFERENCE.md)** — Documentazione completa delle funzionalità
- **[Monitoraggio delle prestazioni](docs/PERFORMANCE-MONITORING.md)** — Tracciamento degli agenti, debugging e ottimizzazione
- **[Sito web](https://yeachan-heo.github.io/oh-my-claudecode-website)** — Guide interattive ed esempi
- **[Guida alla migrazione](docs/MIGRATION.md)** — Aggiornamento dalla v2.x
- **[Architettura](docs/ARCHITECTURE.md)** — Come funziona dietro le quinte

---

## Requisiti

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Abbonamento Claude Max/Pro OPPURE chiave API Anthropic

### Opzionale: Orchestrazione Multi-AI

OMC può opzionalmente orchestrare provider AI esterni per la validazione incrociata e la coerenza del design. Non sono **richiesti** — OMC funziona completamente senza di essi.

| Provider                                                  | Installazione                       | Cosa abilita                                                         |
| --------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Revisione del design, coerenza UI (contesto di 1M token)             |
| [Codex CLI](https://github.com/openai/codex)              | `npm install -g @openai/codex`      | Validazione dell'architettura, verifica incrociata della code review |

**Costo:** 3 piani Pro (Claude + Gemini + ChatGPT) coprono tutto per circa $60/mese.

---

## Licenza

MIT

---

<div align="center">

**Ispirato da:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/NexTechFusion/Superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code)

**Zero curva di apprendimento. Potenza massima.**

</div>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)

## 💖 Supporta questo progetto

Se Oh-My-ClaudeCode migliora il tuo workflow, considera di diventare sponsor:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/Yeachan-Heo)

### Perché sponsorizzare?

- Mantenere lo sviluppo attivo
- Supporto prioritario per gli sponsor
- Influenzare la roadmap e le funzionalità
- Contribuire a mantenere il software libero e open source

### Altri modi per aiutare

- ⭐ Metti una stella al repository
- 🐛 Segnala bug
- 💡 Suggerisci funzionalità
- 📝 Contribuisci al codice
