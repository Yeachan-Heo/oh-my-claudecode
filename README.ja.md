[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | 日本語 | [Español](README.es.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)

**Claude Code のためのマルチエージェント・オーケストレーション。学習コストゼロ。**

*Claude Code を学ぶ必要はありません。OMC を使うだけ。*

[はじめる](#クイックスタート) • [ドキュメント](https://yeachan-heo.github.io/oh-my-claudecode-website) • [移行ガイド](docs/MIGRATION.md)

---

## クイックスタート

**ステップ 1: インストール**
```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**ステップ 2: セットアップ**
```bash
/oh-my-claudecode:omc-setup
```

**ステップ 3: 何か作ってみる**
```
autopilot: build a REST API for managing tasks
```

以上です。あとは自動で進みます。

<h1 align="center">あなたの Claude がステロイド級にパワーアップ。</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## なぜ oh-my-claudecode なのか?

- **設定不要** - 賢いデフォルト設定ですぐに使える
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

| モード | スピード | 用途 |
|------|-------|------|
| **Autopilot** | 高速 | 完全自律ワークフロー |
| **Ultrawork** | 並列 | あらゆるタスクの最大並列化 |
| **Ralph** | 粘り強い | 必ず完遂すべきタスク |
| **Ultrapilot** | 3〜5倍速 | 複数コンポーネントシステム |
| **Ecomode** | 高速 + 30〜50%節約 | 予算重視プロジェクト |
| **Swarm** | 協調 | 並列独立タスク |
| **Pipeline** | 逐次 | 多段階処理 |

### インテリジェント・オーケストレーション

- **32の専門エージェント** - アーキテクチャ、リサーチ、デザイン、テスト、データサイエンス対応
- **スマートモデルルーティング** - シンプルなタスクは Haiku、複雑な推論は Opus
- **自動委譲** - 常に適材適所

### 開発者体験

- **マジックキーワード** - `ralph`、`ulw`、`eco`、`plan` で明示的制御
- **HUD ステータスライン** - ステータスバーでリアルタイムのオーケストレーション指標を表示
- **スキル学習** - セッションから再利用可能なパターンを抽出
- **分析とコスト追跡** - 全セッションのトークン使用状況を把握

[全機能リスト →](docs/REFERENCE.md)

---

## マジックキーワード

パワーユーザー向けのオプション・ショートカット。自然言語でも問題なく動作します。

| キーワード | 効果 | 例 |
|---------|-----|-----|
| `autopilot` | 完全自律実行 | `autopilot: build a todo app` |
| `ralph` | 粘り強いモード | `ralph: refactor auth` |
| `ulw` | 最大並列化 | `ulw fix all errors` |
| `eco` | トークン効率実行 | `eco: migrate database` |
| `plan` | 計画インタビュー | `plan the API` |
| `ralplan` | 反復的計画合意形成 | `ralplan this feature` |

**ralph は ultrawork を含む:** ralph モードを有効にすると、ultrawork の並列実行が自動的に含まれます。キーワードを組み合わせる必要はありません。

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

---

## ドキュメント

- **[完全リファレンス](docs/REFERENCE.md)** - 全機能の詳細ドキュメント
- **[パフォーマンス監視](docs/PERFORMANCE-MONITORING.md)** - エージェント追跡、デバッグ、最適化
- **[ウェブサイト](https://yeachan-heo.github.io/oh-my-claudecode-website)** - インタラクティブガイドと例
- **[移行ガイド](docs/MIGRATION.md)** - v2.x からのアップグレード
- **[アーキテクチャ](docs/ARCHITECTURE.md)** - 内部の仕組み

---

## 動作環境

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Claude Max/Pro サブスクリプション または Anthropic API キー

---

## ライセンス

MIT

---

<div align="center">

**インスピレーション元:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/NexTechFusion/Superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code)

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
