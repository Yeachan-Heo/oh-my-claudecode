[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | 日本語 | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)
[![Discord](https://img.shields.io/discord/1466022107199574193?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/qRJw62Gvh7)

> **Codex ユーザーの方へ:** [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) をチェックしてください — OpenAI Codex CLI 向けの同じオーケストレーション体験を提供します。

**Claude Code のためのマルチエージェント・オーケストレーション。学習コストゼロ。**

*Claude Code を学ぶ必要はありません。OMC を使うだけ。*

[はじめる](#クイックスタート) • [ドキュメント](https://yeachan-heo.github.io/oh-my-claudecode-website) • [CLI リファレンス](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#cli-reference) • [ワークフロー](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#workflows) • [移行ガイド](docs/MIGRATION.md)

---

## クイックスタート

**ステップ 1: インストール**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**ステップ 2: セットアップ**
```bash
/omc-setup
```

**ステップ 3: 何か作ってみる**
```
autopilot: build a REST API for managing tasks
```

以上です。あとは自動で進みます。

### 何から始めればいいかわからない？

要件が不明確だったり、漠然としたアイデアしかなかったり、設計を細かくコントロールしたい場合:

```
/deep-interview "I want to build a task management app"
```

ディープインタビューはソクラテス式質問法を使い、コードを書く前に思考を明確にします。隠れた前提を明らかにし、加重次元で明確さを測定することで、実行開始前に何を構築すべきかを正確に把握できます。

## Team モード（推奨）

**v4.1.7** から **Team** が OMC の標準オーケストレーション方式です。**swarm** や **ultrapilot** などのレガシーエントリポイントは引き続きサポートされていますが、**内部的に Team にルーティング**されます。

```bash
/team 3:executor "fix all TypeScript errors"
```

Team はステージ型パイプラインで実行されます:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

`~/.claude/settings.json` で Claude Code ネイティブチームを有効化:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> チームが無効の場合、OMC は警告を表示し、可能な場合は Team なしの実行にフォールバックします。

### tmux CLI ワーカー — Codex & Gemini (v4.4.0+)

**v4.4.0 で Codex/Gemini MCP サーバー**（`x`、`g` プロバイダー）が**削除されます**。代わりに `/omc-teams` を使って tmux 分割ペインで実際の CLI プロセスを起動してください:

```bash
/omc-teams 2:codex   "review auth module for security issues"
/omc-teams 2:gemini  "redesign UI components for accessibility"
/omc-teams 1:claude  "implement the payment flow"
```

Codex + Gemini を一つのコマンドで使うには **`/ccg`** スキルを使います:

```bash
/ccg Review this PR — architecture (Codex) and UI components (Gemini)
```

| スキル | ワーカー | 最適用途 |
|-------|---------|----------|
| `/omc-teams N:codex` | N 個の Codex CLI ペイン | コードレビュー、セキュリティ解析、アーキテクチャ |
| `/omc-teams N:gemini` | N 個の Gemini CLI ペイン | UI/UX デザイン、ドキュメント、大規模コンテキスト |
| `/omc-teams N:claude` | N 個の Claude CLI ペイン | tmux で Claude CLI を使う汎用タスク |
| `/ccg` | Codex 1 個 + Gemini 1 個 | 並列トライモデルオーケストレーション |

ワーカーはオンデマンドで起動し、タスク完了後に終了します — アイドルリソースの無駄なし。`codex` / `gemini` CLI のインストールとアクティブな tmux セッションが必要です。

> **注意: パッケージ名について** — プロジェクトのブランド名は **oh-my-claudecode**（リポジトリ、プラグイン、コマンド）ですが、npmパッケージは [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus) として公開されています。npm/bunでCLIツールをインストールする場合は `npm install -g oh-my-claude-sisyphus` を使用してください。

### アップデート

```bash
# 1. マーケットプレイスクローンを更新
/plugin marketplace update omc

# 2. セットアップを再実行して設定を更新
/omc-setup
```

> **注意:** マーケットプレイスの自動更新が有効になっていない場合は、セットアップ実行前に `/plugin marketplace update omc` を手動で実行して最新バージョンを同期する必要があります。

更新後に問題が発生した場合は、古いプラグインキャッシュをクリアしてください：

```bash
/omc-doctor
```

<h1 align="center">あなたの Claude がステロイド級にパワーアップ。</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## なぜ oh-my-claudecode なのか?

- **設定不要** - 賢いデフォルト設定ですぐに使える
- **Team ファースト・オーケストレーション** - Team が標準マルチエージェントサーフェス（swarm/ultrapilot は互換性ファサード）
- **自然言語インターフェース** - コマンドを覚える必要なし、やりたいことを話すだけ
- **自動並列化** - 複雑なタスクを専門エージェントに自動分散
- **粘り強い実行** - 検証完了まで諦めない
- **コスト最適化** - スマートなモデルルーティングでトークンを30〜50%節約
- **経験から学習** - 問題解決パターンを自動抽出して再利用
- **リアルタイム可視化** - HUD ステータスラインで裏側の動きが見える

---

## 機能

### 実行モード
用途に応じた複数の戦略 - 完全自律ビルドからトークン効率の良いリファクタリングまで。[詳しくはこちら →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#execution-modes)

| モード | 特徴 | 用途 |
|------|---------|------|
| **Team（推奨）** | ステージ型パイプライン | 共有タスクリストで協力する Claude エージェント |
| **omc-teams** | tmux CLI ワーカー | Codex/Gemini CLI タスク; オンデマンド起動、完了後終了 |
| **ccg** | トライモデル並列 | Codex（分析）+ Gemini（デザイン）、Claude が統合 |
| **Autopilot** | 自律実行 | 最小限のセレモニーで end-to-end 機能開発 |
| **Ultrawork** | 最大並列 | Team 不要な並列修正/リファクタリング |
| **Ralph** | 粘り強いモード | 完全に完了させるべきタスク |
| **Pipeline** | 逐次処理 | 厳密な順序が必要な多段階変換 |
| **Swarm / Ultrapilot（レガシー）** | Team へルーティング | 既存ワークフローと古いドキュメント |

### インテリジェント・オーケストレーション

- **32の専門エージェント** - アーキテクチャ、リサーチ、デザイン、テスト、データサイエンス対応
- **スマートモデルルーティング** - シンプルなタスクは Haiku、複雑な推論は Opus
- **自動委譲** - 常に適材適所

### 開発者体験

- **マジックキーワード** - `ralph`、`ulw`、`plan` で明示的制御
- **HUD ステータスライン** - ステータスバーでリアルタイムのオーケストレーション指標を表示
- **スキル学習** - セッションから再利用可能なパターンを抽出
- **分析とコスト追跡** - 全セッションのトークン使用状況を把握

### カスタムスキル

一度学んだことを永遠に再利用。OMC はデバッグで得た実践的な知識をポータブルなスキルファイルに抽出し、関連する場面で自動的に注入します。

| | プロジェクトスコープ | ユーザースコープ |
|---|---|---|
| **パス** | `.omc/skills/` | `~/.omc/skills/` |
| **共有先** | チーム（バージョン管理対象） | すべてのプロジェクトで利用可能 |
| **優先度** | 高（ユーザースコープを上書き） | 低（フォールバック） |

```yaml
# .omc/skills/fix-proxy-crash.md
---
name: Fix Proxy Crash
description: aiohttp proxy crashes on ClientDisconnectedError
triggers: ["proxy", "aiohttp", "disconnected"]
source: extracted
---
server.py:42 のハンドラーを try/except ClientDisconnectedError で囲んでください...
```

**スキル管理：** `/skill list | add | remove | edit | search`
**自動学習：** `/learner` が厳格な品質基準で再利用可能なパターンを抽出します
**自動注入：** マッチするスキルが自動的にコンテキストに読み込まれます — 手動呼び出し不要

[全機能リスト →](docs/REFERENCE.md)

---

## マジックキーワード

パワーユーザー向けのオプション・ショートカット。自然言語でも問題なく動作します。

| キーワード | 効果 | 例 |
|---------|-----|-----|
| `team` | 標準 Team オーケストレーション | `/team 3:executor "fix all TypeScript errors"` |
| `omc-teams` | tmux CLI ワーカー (codex/gemini/claude) | `/omc-teams 2:codex "security review"` |
| `ccg` | トライモデル Codex+Gemini オーケストレーション | `/ccg review this PR` |
| `autopilot` | 完全自律実行 | `autopilot: build a todo app` |
| `ralph` | 粘り強いモード | `ralph: refactor auth` |
| `ulw` | 最大並列化 | `ulw fix all errors` |
| `plan` | 計画インタビュー | `plan the API` |
| `ralplan` | 反復的計画合意形成 | `ralplan this feature` |
| `deep-interview` | ソクラテス式の要件明確化 | `deep-interview "vague idea"` |
| `swarm` | **非推奨** — 代わりに `team` を使用 | `swarm 5 agents: fix lint errors` |
| `ultrapilot` | **非推奨** — 代わりに `team` を使用 | `ultrapilot: build a fullstack app` |

**注意:**
- **ralph は ultrawork を含む:** ralph モードを有効にすると、ultrawork の並列実行が自動的に含まれます。キーワードを組み合わせる必要はありません。
- `swarm N agents` 構文はエージェント数抽出のために引き続き認識されますが、v4.1.7+ ではランタイムは Team ベースです。

---

## ユーティリティ

### レート制限待機

レート制限がリセットされたら Claude Code セッションを自動再開。

```bash
omc wait          # ステータス確認とガイダンス取得
omc wait --start  # 自動再開デーモンを有効化
omc wait --stop   # デーモンを無効化
```

**必要なもの:** tmux (セッション検出用)

### 通知タグ設定 (Telegram/Discord/Slack)

stop コールバックがセッション要約を送るときに、誰をタグ付けするか設定できます。

```bash
# タグ一覧を設定/置換
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"
omc config-stop-callback slack --enable --webhook <url> --tag-list "<!here>,<@U1234567890>"

# 追加・削除・クリア
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

タグの挙動:
- Telegram: `alice` は `@alice` に正規化
- Discord: `@here`、`@everyone`、数値ユーザーID、`role:<id>` をサポート
- Slack: `<@MEMBER_ID>`、`<!channel>`、`<!here>`、`<!everyone>`、`<!subteam^GROUP_ID>` をサポート
- `file` コールバックはタグオプションを無視

### OpenClaw 連携

Claude Code セッションイベントを [OpenClaw](https://openclaw.ai/) ゲートウェイに転送し、OpenClaw エージェントを通じた自動応答とワークフローを実現します。

**クイックセットアップ（推奨）:**

```bash
/oh-my-claudecode:configure-notifications
# → プロンプトで "openclaw" と入力 → "OpenClaw Gateway" を選択
```

**手動セットアップ:** `~/.claude/omc_config.openclaw.json` を作成します：

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

**環境変数:**

| 変数 | 説明 |
|------|------|
| `OMC_OPENCLAW=1` | OpenClaw を有効化 |
| `OMC_OPENCLAW_DEBUG=1` | デバッグログを有効化 |
| `OMC_OPENCLAW_CONFIG=/path/to/config.json` | 設定ファイルパスを変更 |

**サポートされるフックイベント（bridge.ts で 6 つがアクティブ）:**

| イベント | トリガー | 主要テンプレート変数 |
|---------|---------|-------------------|
| `session-start` | セッション開始時 | `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}` |
| `stop` | Claude のレスポンス完了時 | `{{sessionId}}`, `{{projectName}}` |
| `keyword-detector` | プロンプト送信ごと | `{{prompt}}`, `{{sessionId}}` |
| `ask-user-question` | Claude がユーザー入力を要求した時 | `{{question}}`, `{{sessionId}}` |
| `pre-tool-use` | ツール呼び出し前（高頻度） | `{{toolName}}`, `{{sessionId}}` |
| `post-tool-use` | ツール呼び出し後（高頻度） | `{{toolName}}`, `{{sessionId}}` |

**Reply Channel 環境変数:**

| 変数 | 説明 |
|------|------|
| `OPENCLAW_REPLY_CHANNEL` | 応答チャンネル（例: `discord`） |
| `OPENCLAW_REPLY_TARGET` | チャンネル ID |
| `OPENCLAW_REPLY_THREAD` | スレッド ID |

OpenClaw ペイロードを ClawdBot 経由で Discord にリレーするリファレンスゲートウェイについては `scripts/openclaw-gateway-demo.mjs` を参照してください。

---

## ドキュメント

- **[完全リファレンス](docs/REFERENCE.md)** - 全機能の詳細ドキュメント
- **[CLI リファレンス](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#cli-reference)** - すべての `omc` コマンド、フラグ、ツール
- **[通知ガイド](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#notifications)** - Discord、Telegram、Slack、webhook のセットアップ
- **[推奨ワークフロー](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#workflows)** - 一般的なタスクのための実績あるスキルチェーン
- **[リリースノート](https://yeachan-heo.github.io/oh-my-claudecode-website/docs.html#release-notes)** - 各バージョンの新機能
- **[ウェブサイト](https://yeachan-heo.github.io/oh-my-claudecode-website)** - インタラクティブガイドと例
- **[移行ガイド](docs/MIGRATION.md)** - v2.x からのアップグレード
- **[アーキテクチャ](docs/ARCHITECTURE.md)** - 内部の仕組み
- **[パフォーマンス監視](docs/PERFORMANCE-MONITORING.md)** - エージェント追跡、デバッグ、最適化

---

## 動作環境

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Claude Max/Pro サブスクリプション または Anthropic API キー

### オプション：マルチ AI オーケストレーション

OMC はクロスバリデーションとデザイン一貫性のために、外部 AI プロバイダーをオプションで活用できます。**必須ではありません** — これらがなくても OMC は完全に動作します。

| プロバイダー | インストール | 機能 |
|-------------|-------------|------|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | デザインレビュー、UI 一貫性（1M トークンコンテキスト）|
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` | アーキテクチャ検証、コードレビュークロスチェック |

**コスト：** 3つの Pro プラン（Claude + Gemini + ChatGPT）で月額約 $60 ですべてをカバーできます。

---

## ライセンス

MIT

---

<div align="center">

**インスピレーション元:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/obra/superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code) • [Ouroboros](https://github.com/Q00/ouroboros)

**学習コストゼロ。最大パワー。**

</div>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)

## 💖 このプロジェクトを支援

Oh-My-ClaudeCode があなたのワークフローに役立っているなら、スポンサーをご検討ください:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/Yeachan-Heo)

### スポンサーになる理由は?

- 開発を活発に保つ
- スポンサー向け優先サポート
- ロードマップと機能に影響力
- 無料オープンソースの維持を支援

### その他の協力方法

- ⭐ リポジトリにスター
- 🐛 バグ報告
- 💡 機能提案
- 📝 コード貢献
