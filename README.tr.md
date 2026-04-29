[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Tiếng Việt](README.vi.md) | [Português](README.pt.md) | [Русский](README.ru.md) | Türkçe | [Deutsch](README.de.md) | [Français](README.fr.md) | [Italiano](README.it.md)

# oh-my-claudecode

[![npm version](https://img.shields.io/npm/v/oh-my-claude-sisyphus?color=cb3837)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![npm downloads](https://img.shields.io/npm/dm/oh-my-claude-sisyphus?color=blue)](https://www.npmjs.com/package/oh-my-claude-sisyphus)
[![GitHub stars](https://img.shields.io/github/stars/Yeachan-Heo/oh-my-claudecode?style=flat&color=yellow)](https://github.com/Yeachan-Heo/oh-my-claudecode/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=flat&logo=github)](https://github.com/sponsors/Yeachan-Heo)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

**Claude Code için çoklu ajan orkestrasyonu. Sıfır öğrenme eğrisi.**

_Claude Code'u öğrenmeyin. Sadece OMC kullanın._

[Başlangıç](#hızlı-başlangıç) • [Dokümantasyon](https://yeachan-heo.github.io/oh-my-claudecode-website) • [Geçiş Rehberi](docs/MIGRATION.md) • [Discord](https://discord.gg/PUwSMR9XNk)

---

## Hızlı Başlangıç

**Adım 1: Kurulum**

```bash
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
```

**Adım 2: Yapılandırma**

```bash
/oh-my-claudecode:omc-setup
```

OMC'yi `omc --plugin-dir <path>` veya `claude --plugin-dir <path>` aracılığıyla çalıştırıyorsanız, `omc setup`'a `--plugin-dir-mode` ekleyin (veya `OMC_PLUGIN_ROOT`'u önceden dışa aktarın) böylece plugin zaten çalışma zamanında sağlayan beceri/ajanları duplike etmez. Tam karar matrisi ve mevcut tüm bayraklar için [REFERENCE.md'deki Plugin directory flags bölümüne](./docs/REFERENCE.md#plugin-directory-flags) bakın.

<!-- TODO(i18n): verify translation -->

**Adım 3: Bir şey oluşturun**

```
autopilot: build a REST API for managing tasks
```

Bu kadar. Geri kalan her şey otomatik.

## Team Mode (Önerilen)

**v4.1.7** sürümünden itibaren, **Team** OMC'deki kanonik orkestrasyon yüzeyidir. **swarm** ve **ultrapilot** gibi eski giriş noktaları hâlâ desteklenmektedir, ancak artık **arka planda Team'e yönlendirilmektedir**.

```bash
/oh-my-claudecode:team 3:executor "fix all TypeScript errors"
```

Team aşamalı bir pipeline olarak çalışır:

`team-plan → team-prd → team-exec → team-verify → team-fix (loop)`

Claude Code native teams'i `~/.claude/settings.json` dosyasında etkinleştirin:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

> Teams devre dışıysa, OMC sizi uyaracak ve mümkün olduğunda Team olmadan çalışmaya geçecektir.

> **Not: Paket adlandırması** — Proje **oh-my-claudecode** markasını kullanır (repo, plugin, komutlar), ancak npm paketi [`oh-my-claude-sisyphus`](https://www.npmjs.com/package/oh-my-claude-sisyphus) olarak yayınlanmaktadır. CLI araçlarını npm/bun ile kuruyorsanız, `npm install -g oh-my-claude-sisyphus` kullanın.

### Güncelleme

```bash
# 1. Plugin'i güncelleyin
/plugin install oh-my-claudecode

# 2. Yapılandırmayı yenilemek için setup'ı tekrar çalıştırın
/oh-my-claudecode:omc-setup
```

Güncellemeden sonra sorun yaşarsanız, eski plugin önbelleğini temizleyin:

```bash
/oh-my-claudecode:omc-doctor
```

<h1 align="center">Claude'unuz süper güçlere kavuştu.</h1>

<p align="center">
  <img src="assets/omc-character.jpg" alt="oh-my-claudecode" width="400" />
</p>

---

## Neden oh-my-claudecode?

- **Sıfır yapılandırma** — Akıllı varsayılanlarla kutudan çıktığı gibi çalışır
- **Team-first orkestrasyon** — Team, kanonik çoklu ajan yüzeyidir (swarm/ultrapilot uyumluluk cephesidir)
- **Doğal dil arayüzü** — Ezberlenecek komut yok, sadece ne istediğinizi tarif edin
- **Otomatik paralelleştirme** — Karmaşık görevler uzmanlaşmış ajanlara dağıtılır
- **Kalıcı yürütme** — İş doğrulanıp tamamlanana kadar vazgeçmez
- **Maliyet optimizasyonu** — Akıllı model yönlendirme, tokenlarda %30-50 tasarruf sağlar
- **Deneyimden öğrenme** — Problem çözme kalıplarını otomatik olarak çıkarır ve yeniden kullanır
- **Gerçek zamanlı görünürlük** — HUD statusline, arka planda neler olduğunu gösterir

---

## Özellikler

### Orkestrasyon Modları

Farklı kullanım senaryoları için birden fazla strateji — Team destekli orkestrasyondan token-verimli yeniden düzenlemeye. [Daha fazla bilgi →](https://yeachan-heo.github.io/oh-my-claudecode-website/docs/#execution-modes)

| Mod                           | Nedir                                                                                  | Kullanım Alanı                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Team (önerilen)**           | Kanonik aşamalı pipeline (`team-plan → team-prd → team-exec → team-verify → team-fix`) | Paylaşılan görev listesinde çalışan koordineli ajanlar            |
| **Autopilot**                 | Otonom yürütme (tek lider ajan)                                                        | Minimum törenle uçtan uca özellik geliştirme                      |
| **Ultrawork**                 | Maksimum paralellik (Team olmadan)                                                     | Team gerekli olmadığında paralel düzeltme/yeniden düzenleme       |
| **Ralph**                     | Verify/fix döngüleriyle kalıcı mod                                                     | Tamamen tamamlanması gereken görevler (sessiz kısmi sonuçlar yok) |
| **Ecomode**                   | Token-verimli yönlendirme                                                              | Bütçe odaklı iterasyon                                            |
| **Pipeline**                  | Sıralı, aşamalı işleme                                                                 | Sıkı sıralama ile çok adımlı dönüşümler                           |
| **Swarm / Ultrapilot (eski)** | **Team**'e yönlendiren uyumluluk cepheleri                                             | Mevcut iş akışları ve eski belgeler                               |

### Akıllı Orkestrasyon

- **32 uzmanlaşmış ajan** — mimari, araştırma, tasarım, test, veri bilimi
- **Akıllı model yönlendirme** — Basit görevler için Haiku, karmaşık muhakeme için Opus
- **Otomatik delegasyon** — Her zaman doğru iş için doğru ajan

### Geliştirici Deneyimi

- **Sihirli anahtar kelimeler** — Açık kontrol için `ralph`, `ulw`, `eco`, `plan`
- **HUD statusline** — Durum çubuğunuzda gerçek zamanlı orkestrasyon metrikleri
  - Claude Code'u doğrudan `claude --plugin-dir <path>` ile başlatıyorsanız (`omc` shim'i atlayarak), shell'de `OMC_PLUGIN_ROOT=<path>` dışa aktarın, böylece HUD paketi plugin yükleyici ile aynı checkout'a çözülür. Ayrıntılar için [REFERENCE.md'deki Plugin directory flags bölümüne](./docs/REFERENCE.md#plugin-directory-flags) bakın.

  <!-- TODO(i18n): verify translation -->
- **Beceri öğrenimi** — Oturumlarınızdan yeniden kullanılabilir kalıplar çıkarın
- **Analitik ve maliyet takibi** — Tüm oturumlardaki token kullanımını anlayın

### Katkıda Bulunma

OMC'ye katkıda bulunmak ister misiniz? Fork etme, yerel checkout kurma, etkin eklenti olarak bağlama, testleri çalıştırma ve PR gönderme dahil olmak üzere tam geliştirici kılavuzu için [CONTRIBUTING.md](./CONTRIBUTING.md)'ye bakın.

<!-- TODO(i18n): verify translation -->

### Özel Beceriler

Bir kez öğrenin, sonsuza kadar yeniden kullanın. OMC, hata ayıklama sürecinde kazanılan değerli bilgiyi taşınabilir beceri dosyalarına çıkarır ve ilgili durumlarda otomatik olarak enjekte eder.

| | Proje Kapsamı | Kullanıcı Kapsamı |
|---|---|---|
| **Yol** | `.omc/skills/` | `~/.omc/skills/` |
| **Paylaşım** | Takım (sürüm kontrollü) | Tüm projeleriniz |
| **Öncelik** | Yüksek (kullanıcı kapsamını geçersiz kılar) | Düşük (yedek) |

```yaml
# .omc/skills/fix-proxy-crash.md
---
name: Fix Proxy Crash
description: aiohttp proxy crashes on ClientDisconnectedError
triggers: ["proxy", "aiohttp", "disconnected"]
source: extracted
---
server.py:42'deki handler'ı try/except ClientDisconnectedError ile sarın...
```

**Beceri yönetimi:** `/skill list | add | remove | edit | search`
**Otomatik öğrenme:** `/skillify` katı kalite standartlarıyla yeniden kullanılabilir kalıplar çıkarır
**Otomatik enjeksiyon:** Eşleşen beceriler otomatik olarak bağlama yüklenir — manuel çağrı gerekmez

[Tam özellik listesi →](docs/REFERENCE.md)

---

## Sihirli Anahtar Kelimeler

İleri düzey kullanıcılar için isteğe bağlı kısayollar. Doğal dil onlarsız da iyi çalışır.

| Anahtar Kelime | Etki                                     | Örnek                                                           |
| -------------- | ---------------------------------------- | --------------------------------------------------------------- |
| `team`         | Kanonik Team orkestrasyonu               | `/oh-my-claudecode:team 3:executor "fix all TypeScript errors"` |
| `autopilot`    | Tam otonom yürütme                       | `autopilot: build a todo app`                                   |
| `ralph`        | Kalıcılık modu                           | `ralph: refactor auth`                                          |
| `ulw`          | Maksimum paralellik                      | `ulw fix all errors`                                            |
| `eco`          | Token-verimli yürütme                    | `eco: migrate database`                                         |
| `plan`         | Planlama mülakatı                        | `plan the API`                                                  |
| `ralplan`      | Yinelemeli planlama uzlaşısı             | `ralplan this feature`                                          |
| `swarm`        | Eski anahtar kelime (Team'e yönlendirir) | `swarm 5 agents: fix lint errors`                               |
| `ultrapilot`   | Eski anahtar kelime (Team'e yönlendirir) | `ultrapilot: build a fullstack app`                             |

**Notlar:**

- **ralph, ultrawork'ü içerir**: ralph modunu etkinleştirdiğinizde, ultrawork'ün paralel yürütmesini otomatik olarak içerir.
- `swarm N agents` sözdizimi hâlâ ajan sayısı çıkarımı için tanınmaktadır, ancak çalışma zamanı v4.1.7+'da Team tabanlıdır.

## Yardımcı Araçlar

### Rate Limit Bekleme

Rate limitler sıfırlandığında Claude Code oturumlarını otomatik olarak devam ettirir.

```bash
omc wait          # Durumu kontrol et, rehberlik al
omc wait --start  # Otomatik devam daemon'ını etkinleştir
omc wait --stop   # Daemon'ı devre dışı bırak
```

**Gereklidir:** tmux (oturum algılama için)

### Bildirim Etiketleri (Telegram/Discord)

Stop callback'leri oturum özetlerini gönderdiğinde kimin etiketleneceğini yapılandırabilirsiniz.

```bash
# Etiket listesini ayarla/değiştir
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"

# Artımlı güncellemeler
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags
```

Etiket davranışı:

- Telegram: `alice`, `@alice` olarak normalleştirilir
- Discord: `@here`, `@everyone`, sayısal kullanıcı kimlikleri ve `role:<id>` desteklenir
- `file` callback'leri etiket seçeneklerini yok sayar

### OpenClaw Entegrasyonu

Claude Code oturum olaylarını bir [OpenClaw](https://openclaw.ai/) ağ geçidine ileterek OpenClaw ajanınız aracılığıyla otomatik yanıtlar ve iş akışları oluşturun.

**Hızlı kurulum (önerilen):**

```bash
/oh-my-claudecode:configure-notifications
# → İstendiğinde "openclaw" yazın → "OpenClaw Gateway" seçin
```

**Manuel kurulum:** `~/.claude/omc_config.openclaw.json` dosyasını oluşturun:

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

**Ortam değişkenleri:**

| Değişken | Açıklama |
|----------|----------|
| `OMC_OPENCLAW=1` | OpenClaw'ı etkinleştir |
| `OMC_OPENCLAW_DEBUG=1` | Hata ayıklama günlüklemesini etkinleştir |
| `OMC_OPENCLAW_CONFIG=/path/to/config.json` | Yapılandırma dosyası yolunu değiştir |

**Desteklenen hook olayları (bridge.ts'de 6 aktif):**

| Olay | Tetikleyici | Ana şablon değişkenleri |
|------|------------|------------------------|
| `session-start` | Oturum başladığında | `{{sessionId}}`, `{{projectName}}`, `{{projectPath}}` |
| `stop` | Claude yanıtı tamamlandığında | `{{sessionId}}`, `{{projectName}}` |
| `keyword-detector` | Her prompt gönderiminde | `{{prompt}}`, `{{sessionId}}` |
| `ask-user-question` | Claude kullanıcı girişi istediğinde | `{{question}}`, `{{sessionId}}` |
| `pre-tool-use` | Araç çağrısından önce (yüksek sıklık) | `{{toolName}}`, `{{sessionId}}` |
| `post-tool-use` | Araç çağrısından sonra (yüksek sıklık) | `{{toolName}}`, `{{sessionId}}` |

**Yanıt kanalı ortam değişkenleri:**

| Değişken | Açıklama |
|----------|----------|
| `OPENCLAW_REPLY_CHANNEL` | Yanıt kanalı (ör. `discord`) |
| `OPENCLAW_REPLY_TARGET` | Kanal ID'si |
| `OPENCLAW_REPLY_THREAD` | Thread ID'si |

OpenClaw yüklerini ClawdBot aracılığıyla Discord'a ileten bir referans gateway için `scripts/openclaw-gateway-demo.mjs` dosyasına bakın.

---

## Dokümantasyon

- **[Tam Referans](docs/REFERENCE.md)** — Kapsamlı özellik dokümantasyonu
- **[Performans İzleme](docs/PERFORMANCE-MONITORING.md)** — Ajan takibi, hata ayıklama ve optimizasyon
- **[Web Sitesi](https://yeachan-heo.github.io/oh-my-claudecode-website)** — İnteraktif rehberler ve örnekler
- **[Geçiş Rehberi](docs/MIGRATION.md)** — v2.x'den yükseltme
- **[Mimari](docs/ARCHITECTURE.md)** — Arka planda nasıl çalıştığı

---

## Gereksinimler

- [Claude Code](https://docs.anthropic.com/claude-code) CLI
- Claude Max/Pro aboneliği VEYA Anthropic API anahtarı

### İsteğe Bağlı: Çoklu AI Orkestrasyonu

OMC, çapraz doğrulama ve tasarım tutarlılığı için isteğe bağlı olarak harici AI sağlayıcılarını kullanabilir. Bunlar **zorunlu değildir** — OMC onlarsız da tam olarak çalışır.

| Sağlayıcı                                                 | Kurulum                             | Ne sağlar                                            |
| --------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Tasarım incelemesi, UI tutarlılığı (1M token bağlam) |
| [Codex CLI](https://github.com/openai/codex)              | `npm install -g @openai/codex`      | Mimari doğrulama, kod incelemesi çapraz kontrolü     |

**Maliyet:** 3 Pro plan (Claude + Gemini + ChatGPT) her şeyi aylık ~$60'a karşılar.

---

## Lisans

MIT

---

<div align="center">

**İlham kaynakları:** [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) • [claude-hud](https://github.com/ryanjoachim/claude-hud) • [Superpowers](https://github.com/NexTechFusion/Superpowers) • [everything-claude-code](https://github.com/affaan-m/everything-claude-code)

**Sıfır öğrenme eğrisi. Maksimum güç.**

</div>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-claudecode&type=date&legend=top-left)

## 💖 Bu Projeyi Destekleyin

Oh-My-ClaudeCode iş akışınıza yardımcı oluyorsa, sponsorluk yapmayı düşünün:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/Yeachan-Heo)

### Neden sponsor olmalı?

- Aktif geliştirmeyi sürdürmek
- Sponsorlar için öncelikli destek
- Yol haritası ve özellikleri etkilemek
- Ücretsiz ve açık kaynak olarak sürdürmeye yardım

### Yardım etmenin diğer yolları

- ⭐ Repoya yıldız verin
- 🐛 Hata bildirin
- 💡 Özellik önerin
- 📝 Koda katkıda bulunun
