[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | Português

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)
[![Discord](https://img.shields.io/discord/1466022107199574193?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/qRJw62Gvh7)

> **Para usuários do Codex:** Confira [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) — a mesma experiência de orquestração para o OpenAI Codex CLI.

**Orquestração multiagente para Claude Code. Curva de aprendizado zero.**

*Não aprenda Claude Code. Só use OMC.*

[Começar Rápido](#início-rápido) • [Documentação](https://yeachan-heo.github.io/oh-my-claudecode-website) • [Referência CLI](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#cli-reference) • [Workflows](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#workflows) • [Guia de Migração](docs/MIGRATION.md)

---

## Início Rápido

**Passo 1: Instale**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Passo 2: Configure**
```bash
/omc-setup
```

**Passo 3: Crie algo**
```
autopilot: build a REST API for managing tasks
```

É isso. Todo o resto é automático.

### Não sabe por onde começar?

Se você não tem certeza sobre os requisitos, tem uma ideia vaga, ou quer microgerenciar o design:

```
/deep-interview "I want to build a task management app"
```

A entrevista profunda usa questionamento socrático para esclarecer seu pensamento antes de escrever qualquer código. Ela expõe suposições ocultas e mede a clareza por dimensões ponderadas, garantindo que você saiba exatamente o que construir antes da execução começar.

## Modo Team (Recomendado)

A partir da **v4.1.7**, o **Team** é a superfície canônica de orquestração no OMC. Entrypoints legados como **swarm** e **ultrapilot** continuam com suporte, mas agora **roteiam para Team por baixo dos panos**.

```bash
/team 3:executor "fix all TypeScript errors"
```

O Team roda como um pipeline em estágios:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Ative os times nativos do Claude Code em `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> Se os times estiverem desativados, o OMC vai avisar você e fazer fallback para execução sem Team quando possível.

### Trabalhadores CLI tmux — Codex & Gemini (v4.4.0+)

**v4.4.0 remove os servidores MCP de Codex/Gemini** (provedores `x`, `g`). Use `/omc-teams` para lançar processos CLI reais em painéis divididos do tmux:

```bash
/omc-teams 2:codex   "review auth module for security issues"
/omc-teams 2:gemini  "redesign UI components for accessibility"
/omc-teams 1:claude  "implement the payment flow"
```

Para trabalho misto de Codex + Gemini em um único comando, use a skill **`/ccg`**:

```bash
/ccg Review this PR — architecture (Codex) and UI components (Gemini)
```

| Skill | Trabalhadores | Melhor Para |
|-------|---------|----------|
| `/omc-teams N:codex` | N painéis Codex CLI | Revisão de código, análise de segurança, arquitetura |
| `/omc-teams N:gemini` | N painéis Gemini CLI | Design UI/UX, docs, tarefas de grande contexto |
| `/omc-teams N:claude` | N painéis Claude CLI | Tarefas gerais via Claude CLI no tmux |
| `/ccg` | 1 Codex + 1 Gemini | Orquestração tri-modelo em paralelo |

Trabalhadores são iniciados sob demanda e encerrados quando a tarefa é concluída — sem uso ocioso de recursos. Requer as CLIs `codex` / `gemini` instaladas e uma sessão tmux ativa.

> **Observação: Nome do pacote** — O projeto usa a marca **oh-my-claudecode** (repo, plugin, comandos), mas o pacote npm é publicado como [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus). Se você instalar as ferramentas de CLI via npm/bun, use `npm install -g oh-my-claude-sisyphus`.

### Atualizando

```bash
# 1. Atualize o clone do marketplace
/plugin marketplace update omc

# 2. Execute o setup novamente para atualizar a configuração
/omc-setup
```

> **Observação:** Se a atualização automática do marketplace não estiver habilitada, você precisa executar manualmente `/plugin marketplace update omc` para sincronizar a versão mais recente antes de executar o setup.

Se você tiver problemas depois de atualizar, limpe o cache antigo do plugin:

```bash
/omc-doctor
```

<h1 align="center">Seu Claude acabou de tomar esteroides.</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## Por que oh-my-claudecode?

- **Configuração zero** - Funciona de cara com padrões inteligentes
- **Orquestração team-first** - Team é a superfície canônica multiagente (swarm/ultrapilot são fachadas de compatibilidade)
- **Interface em linguagem natural** - Sem comandos para decorar, é só descrever o que você quer
- **Paralelização automática** - Tarefas complexas distribuídas entre agentes especializados
- **Execução persistente** - Não desiste até o trabalho ser verificado como concluído
- **Otimização de custo** - Roteamento inteligente de modelos economiza de 30% a 50% em tokens
- **Aprende com a experiência** - Extrai e reutiliza automaticamente padrões de resolução de problemas
- **Visibilidade em tempo real** - A HUD statusline mostra o que está acontecendo por baixo dos panos

---

## Recursos

### Modos de Orquestração
Múltiplas estratégias para diferentes casos de uso — da orquestração com Team até refatoração com eficiência de tokens. [Saiba mais →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#execution-modes)

| Modo | O que é | Usar para |
|------|---------|-----------|
| **Team (recommended)** | Pipeline canônico em estágios (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Agentes coordenados trabalhando em uma lista de tarefas compartilhada |
| **omc-teams** | Trabalhadores CLI tmux — processos reais `claude`/`codex`/`gemini` em painéis divididos | Tarefas Codex/Gemini CLI; criados sob demanda, encerrados ao terminar |
| **ccg** | Tri-modelo: Codex (analítico) + Gemini (design) em paralelo, Claude sintetiza | Trabalho misto de backend+UI que precisa de Codex e Gemini |
| **Autopilot** | Execução autônoma (um único agente líder) | Trabalho de feature ponta a ponta com cerimônia mínima |
| **Ultrawork** | Paralelismo máximo (sem Team) | Rajadas de correções/refatorações paralelas quando Team não é necessário |
| **Ralph** | Modo persistente com loops de verify/fix | Tarefas que precisam ser concluídas por completo (sem parciais silenciosos) |
| **Pipeline** | Processamento sequencial por estágios | Transformações em múltiplas etapas com ordenação rigorosa |
| **Swarm / Ultrapilot (legacy)** | Fachadas de compatibilidade que roteiam para **Team** | Workflows existentes e documentação antiga |

### Orquestração Inteligente

- **32 agentes especializados** para arquitetura, pesquisa, design, testes e ciência de dados
- **Roteamento inteligente de modelos** - Haiku para tarefas simples, Opus para raciocínio complexo
- **Delegação automática** - O agente certo para o trabalho, sempre

### Experiência do Desenvolvedor

- **Magic keywords** - `ralph`, `ulw`, `plan` para controle explícito
- **HUD statusline** - Métricas de orquestração em tempo real na sua barra de status
- **Aprendizado de skills** - Extraia padrões reutilizáveis das suas sessões
- **Analytics e rastreamento de custos** - Entenda o uso de tokens em todas as sessões

### Skills Personalizadas

Aprenda uma vez, reutilize para sempre. O OMC extrai conhecimento valioso de depuração em arquivos de skills portáteis que são auto-injetados quando relevantes.

| | Escopo de Projeto | Escopo de Usuário |
|---|---|---|
| **Caminho** | `.omc/skills/` | `~/.omc/skills/` |
| **Compartilhado com** | Equipe (versionado) | Todos os seus projetos |
| **Prioridade** | Maior (sobrescreve escopo de usuário) | Menor (fallback) |

```yaml
# .omc/skills/fix-proxy-crash.md
---
name: Fix Proxy Crash
description: aiohttp proxy crashes on ClientDisconnectedError
triggers: ["proxy", "aiohttp", "disconnected"]
source: extracted
---
Envolva o handler em server.py:42 com try/except ClientDisconnectedError...
```

**Gerenciamento de skills:** `/skill list | add | remove | edit | search`
**Auto-aprendizado:** `/learner` extrai padrões reutilizáveis com critérios de qualidade rigorosos
**Auto-injeção:** Skills correspondentes são carregadas no contexto automaticamente — sem necessidade de chamada manual

[Lista completa de recursos →](docs/REFERENCE.md)

---

## Magic Keywords

Atalhos opcionais para usuários avançados. Linguagem natural funciona bem sem eles.

| Palavra-chave | Efeito | Exemplo |
|---------------|--------|---------|
| `team` | Orquestração canônica com Team | `/team 3:executor "fix all TypeScript errors"` |
| `omc-teams` | Trabalhadores CLI tmux (codex/gemini/claude) | `/omc-teams 2:codex "security review"` |
| `ccg` | Orquestação tri-modelo Codex+Gemini | `/ccg review this PR` |
| `autopilot` | Execução autônoma completa | `autopilot: build a todo app` |
| `ralph` | Modo persistente | `ralph: refactor auth` |
| `ulw` | Paralelismo máximo | `ulw fix all errors` |
| `plan` | Entrevista de planejamento | `plan the API` |
| `ralplan` | Consenso de planejamento iterativo | `ralplan this feature` |
| `deep-interview` | Esclarecimento socrático de requisitos | `deep-interview "vague idea"` |
| `swarm` | **Descontinuado** — use `team` em vez disso | `swarm 5 agents: fix lint errors` |
| `ultrapilot` | **Descontinuado** — use `team` em vez disso | `ultrapilot: build a fullstack app` |

**Notas:**
- **ralph inclui ultrawork**: quando você ativa o modo ralph, ele inclui automaticamente a execução paralela do ultrawork.
- A sintaxe `swarm N agents` ainda é reconhecida para extração da contagem de agentes, mas o runtime é baseado em Team na v4.1.7+.

## Utilitários

### Espera de Rate Limit

Retoma automaticamente sessões do Claude Code quando os rate limits são resetados.

```bash
omc wait          # Check status, get guidance
omc wait --start  # Enable auto-resume daemon
omc wait --stop   # Disable daemon
```

**Requer:** tmux (para detecção de sessão)

### Tags de Notificação (Telegram/Discord/Slack)

Você pode configurar quem recebe tag quando callbacks de parada enviam resumos de sessão.

```bash
# Set/replace tag list
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"
omc config-stop-callback slack --enable --webhook <url> --tag-list "<!here>,<@U1234567890>"

# Incremental updates
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

Comportamento das tags:
- Telegram: `alice` vira `@alice`
- Discord: suporta `@here`, `@everyone`, IDs numéricos de usuário e `role:<id>`
- Slack: suporta `<@MEMBER_ID>`, `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^GROUP_ID>`
- callbacks de `file` ignoram opções de tag

### Integração com OpenClaw

Encaminhe eventos de sessão do Claude Code para um gateway do [OpenClaw](https://openclaw.ai/) para habilitar respostas automatizadas e workflows através do seu agente OpenClaw.

**Configuração rápida (recomendado):**

```bash
/oh-my-claudecode:configure-notifications
# → Digite "openclaw" quando solicitado → escolha "OpenClaw Gateway"
```

**Configuração manual:** crie `~/.claude/omc_config.openclaw.json`:

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

**Variáveis de ambiente:**

| Variável | Descrição |
|----------|-----------|
| `OMC_OPENCLAW=1` | Habilitar OpenClaw |
| `OMC_OPENCLAW_DEBUG=1` | Habilitar logs de depuração |
| `OMC_OPENCLAW_CONFIG=/path/to/config.json` | Caminho alternativo do arquivo de configuração |

**Eventos de hook suportados (6 ativos em bridge.ts):**

| Evento | Gatilho | Variáveis de template principais |
|--------|---------|----------------------------------|
| `session-start` | Sessão inicia | `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}` |
| `stop` | Resposta do Claude concluída | `{{sessionId}}`, `{{projectName}}` |
| `keyword-detector` | A cada envio de prompt | `{{prompt}}`, `{{sessionId}}` |
| `ask-user-question` | Claude solicita input do usuário | `{{question}}`, `{{sessionId}}` |
| `pre-tool-use` | Antes da invocação de ferramenta (alta frequência) | `{{toolName}}`, `{{sessionId}}` |
| `post-tool-use` | Após a invocação de ferramenta (alta frequência) | `{{toolName}}`, `{{sessionId}}` |

**Variáveis de ambiente do canal de resposta:**

| Variável | Descrição |
|----------|-----------|
| `OPENCLAW_REPLY_CHANNEL` | Canal de resposta (ex. `discord`) |
| `OPENCLAW_REPLY_TARGET` | ID do canal |
| `OPENCLAW_REPLY_THREAD` | ID da thread |

Veja `scripts/openclaw-gateway-demo.mjs` para um gateway de referência que retransmite payloads OpenClaw para o Discord via ClawdBot.

---

## Documentação

- **[Referência Completa](docs/REFERENCE.md)** - Documentação completa de recursos
- **[Referência CLI](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#cli-reference)** - Todos os comandos, flags e ferramentas do `omc`
- **[Guia de Notificações](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#notifications)** - Configuração de Discord, Telegram, Slack e webhooks
- **[Workflows Recomendados](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#workflows)** - Cadeias de skills testadas em batalha para tarefas comuns
- **[Notas de Lançamento](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#release-notes)** - Novidades em cada versão
- **[Website](https://yeachan-heo.github.io/oh-my-claudecode-website)** - Guias interativos e exemplos
- **[Guia de Migração](docs/MIGRATION.md)** - Upgrade a partir da v2.x
- **[Arquitetura](docs/ARCHITECTURE.md)** - Como funciona por baixo dos panos
- **[Monitoramento de Performance](docs/PERFORMANCE-MONITORING.md)** - Rastreamento de agentes, debugging e otimização

---

## Requisitos

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Assinatura Claude Max/Pro OU chave de API da Anthropic

### Opcional: Orquestração Multi-AI

O OMC pode opcionalmente orquestrar provedores externos de IA para validação cruzada e consistência de design. Eles **não são obrigatórios** — o OMC funciona completamente sem eles.

| Provedor | Instalação | O que habilita |
|----------|------------|----------------|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Revisão de design, consistência de UI (contexto de 1M tokens) |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` | Validação de arquitetura, checagem cruzada de code review |

**Custo:** 3 planos Pro (Claude + Gemini + ChatGPT) cobrem tudo por cerca de US$60/mês.

---

## Licença

MIT

---

<div align="center">

**Inspirado por:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code) • [Ouroboros](https://github.com/Q00/ouroboros)

**Curva de aprendizado zero. Poder máximo.**

</div>

## Histórico de Stars

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)

## 💖 Apoie Este Projeto

Se o Oh-My-ClaudeCode ajuda no seu fluxo de trabalho, considere patrocinar:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/Yeachan-Heo)

### Por que patrocinar?

- Manter o desenvolvimento ativo
- Suporte prioritário para patrocinadores
- Influenciar o roadmap e os recursos
- Ajudar a manter o projeto livre e de código aberto

### Outras formas de ajudar

- ⭐ Dar star no repositório
- 🐛 Reportar bugs
- 💡 Sugerir recursos
- 📝 Contribuir com código
