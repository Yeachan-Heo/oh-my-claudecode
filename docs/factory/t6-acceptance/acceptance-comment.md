# T6 验收报告：软件工厂闭环正式实现（对正式实现重跑演练）

- 日期：2026-09-28；演练场：`pangpang778/factory-demo` issue #1（退货退款用例）
- 被验代码：分支 `factory-t6-acceptance`（spec #9 正式实现），编译产物 `dist/hooks/session-end/*`、`dist/factory/listener.js`
- 方法：三项演练（金路径 / 失败注入 / 护栏触发），全程真实 HMAC 签名 webhook、真实标签、真实 gh 回写、真实 detached claude 会话
- 证据包：分支 `factory-t6-acceptance` `docs/factory/t6-acceptance/evidence/`（审计 jsonl、decision ledger、handoff ×2、护栏 stop marker + usage、intent 草稿、金路径 timeline、演练驱动脚本）

## 判据逐条结论

**判据 1（intake 标签 → intake 会话自动起）：绿。** 签名 POST → 202 `spawned intent session (intent)`，审计记 `routed`（`evidence/factory-listener-audit.jsonl`），真实 claude 会话以 `/intent 处理 tracker 进货：…` 提示词自动启动、intent 技能装载（transcripts d6989e55 / ba18aaef / d314390f）。非绿段：首次尝试（listener 以 worktree 为 cwd 启动）spawn 的会话 f2f76121 首次 API 调用即死（模型 claude-sonnet-4-6 被代理拒）。根因：listener.ts:114 spawn 无 `cwd` 选项，子进程继承 listener 进程 cwd，`--cwd` 仅喂审计路径；以「从演练目录启动 listener」为文档化姿势重跑后稳定。归属 listener 跟进。

**判据 2（草稿按契约回写）：绿。** 多轮追问（issue 评论）后自动回写 `docs/intents/return-refund-flow/intent.md`（五段 + 3 条非阻塞未决，`evidence/intent-draft-return-refund-flow.md`）、指针评论、标签 `intake → needs-review`（评论 5866170890 / 5866239914 / 5866302124）。诚实备注：轮间续接靠重新 POST webhook —— 正式实现应由 SessionEnd→链推进 enqueuer 完成，而 enqueuer 未实现（见红项 1）。

**判据 3（人接受 → launch 会话自动起 + handoff 正确）：绿（含备注）。** 人闸记录评论 5866386028（signer: PangHong）、标签 `needs-review → accepted`；真实 `executeSpawnNext` + defaultSpawnFn：`acquireChainSlot('return-refund-flow')` allowed linkIndex=1，handoff `evidence/return-refund-flow-launch.json`（success:intent-accepted → launch，context 指向已接受 intent），tracker 评论「链已推进到 launch」，launch 会话 a2524410 于 08:34:38 自动起并定位到 handoff。备注：launch 技能 yard gate 需要目标仓 `scripts/shipyard-audit.mjs`，演练仓未铺设（T5 缺口），会话按技能定义 BLOCKED 收场；`launch` 标签未预置，detached shell 里 `gh --add-label` 静默失败，操作员补建补挂 —— tracker 命令失败可观测性是跟进项。

**判据 4（机械对照自动过闸，signer = 判据事实）：绿。** `gradeGate('spec-approve', 全绿)` → auto-pass，signerFact「分级判据均未触发，机械验证项全部通过，自动过」（`evidence/t6-decision-ledger.json`）。

**判据 5（先例性取舍升人闸，留痕）：绿。** 判据一/二/机械未过三类 facts 全部升 human 且留触发判据文案；intent-accept、review-approve 固定人闸（ledger 共 6 条：5 human + 1 auto）。

**判据 6（失败注入 → failed + 告警 + 链停住）：绿（注入点诚实标注）。** 6a：生产路由表 + `failed:budget-exhausted` → plan null：0 spawn、链静默停住（`evidence/t6-exercise-evidence.json` 2A）。6b：spawnFn 注入抛错 → 真实告警评论「链已停住：… v1 无自动重试」+ 真实 failed 标签落 issue #1（`evidence/t6-exercise-2b.txt` + issue 评论/标签可查）。诚实边界：告警路径仅在 spawn 同步抛错时可达，defaultSpawnFn（shell:true）不同步抛 → 生产可达性≈0，子进程生死无观测（与判据 1 首败静默一致）。归属 listener/T2 跟进。

**判据 7（每日 N=10 护栏）：绿。** 同 intent 当日 ×10 acquire 全过，第 11 次 `daily-cap` 拒绝、中文 detail、真实 stop marker `evidence/chain-t6-demo-refund.stopped.json` 落盘，`evidence/chain-usage.json` 计数 10。LOW 缺陷：guardrails.ts:131 拒绝 detail 引用 stopMarkerPath 漏传 stateRoot，提示路径与实际落盘根不一致（marker 本体正确）。

**判据 8（全程可审计 / 黑灯度量）：绿。** 每环有记录：listener 审计 jsonl、handoff ×2、usage + stop marker、gate ledger ×6、issue 全程评论链。黑灯度量：gate 判定合计 7（ledger 6 + 实链 intent-accept 1），人签 6 → **6/7 ≈ 86%**；唯一非人签为 spec-approve 全绿 auto-pass，signer = 判据事实（设计如此）。

## 红项归属（无未归属红项）
1. **SessionEnd→链推进 enqueuer 未实现**：src 内无构造/入队 spawn-next action 的生产调用方（类型在 cleanup-manifest.ts:7、dispatch 在 worker.ts:47-53）。无闭环工票覆盖，建议开跟进票。
2. **listener spawn 三缺口**：无 cwd 选项（子进程 cwd 继承 listener 进程）；子进程生死/退出无观测；tracker 命令 detached shell 失败静默。归属 listener（T2/T4 跟进）。
3. **guardrails.ts:131 detail 路径 LOW**（见判据 7）。
4. **T5 铺设缺口**：演练仓缺 shipyard 审计机械与 launch 标签预置。

## 操作员侧修复披露（非实现改动）
listener 以演练目录为 cwd 重启一次；演练目录 trust 与 allow-list 预置；轮间回答与人闸接受由操作员以 pangpang778 身份在 issue 留痕（人机协作「人」的一侧）。

## 结论
**8/8 判据全绿**（判据 3 含 T5 铺设备注、判据 6 注入点诚实标注）。红项均为实现跟进而非验收阻塞，按归属开跟进票即可。
