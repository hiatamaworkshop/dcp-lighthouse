# dcp-lighthouse — Roadmap Brief

> **このファイルの使い方**: 下記「読むべき順序」に従ってプロジェクトを把握し、
> §FINDINGS 以降に発見・判断・ロードマップを直接追記してください。
> 出力は **箇条書き + 短文** で。長い説明文は不要です。

---

## コンテキスト (読む前に)

| 項目 | 内容 |
|---|---|
| 目的 | DCP Pipeline を観測層として使う「灯台モデル」のパイロット実装 |
| フェーズ | Phase 0 (コア機構検証) + Phase 1 (test_result:v1 ドメイン適用) **実装完了** |
| テスト | 72件 全通過 |
| 起動 | `cd server && npm run dev` → `http://localhost:3001` |
| シナリオ | `GET /demo/start?scenario=AR\|CG\|RC` |

---

## 読むべき順序と場所

### 1. 概念 (5分)
- [CLAUDE.md](../CLAUDE.md) — 全体構造・実装済み範囲・次のステップ候補。**ここだけで現状把握できる**
- [docs/LIGHTHOUSE_MODEL.md](./LIGHTHOUSE_MODEL.md) §1–3, §5, §8 — 灯台モデルの「なぜ」と $Q shadow 概念。§5 は replay の意味論 (分散縮小ではなく別レンズ再観測) を正確に定義しているので必読

### 2. 実装済みコア (Phase 0 機構)
読む順: 依存関係の末端から

| ファイル | 役割 |
|---|---|
| [server/src/q-registry.ts](../server/src/q-registry.ts) | $Q の置き場。scope パース・onChange・swap history |
| [server/src/lens.ts](../server/src/lens.ts) | `applyLens(segment, params)` — effector chain。window_ms のみ実装、他段は pass-through |
| [server/src/retention-buffer.ts](../server/src/retention-buffer.ts) | 鮮度ゾーン ring buffer + `replay(params)` |
| [server/src/lens-view.ts](../server/src/lens-view.ts) | `ObservationOverlay` — 1ストリームに複数 view を attach |
| [server/src/snapshot-curator.ts](../server/src/snapshot-curator.ts) | `SnapshotCurator ($U)` — spike/gap/step_up/step_down/divergence/baseline タイル選出 |

### 3. Phase 1 ドメイン層
| ファイル | 役割 |
|---|---|
| [server/src/bitpos.ts](../server/src/bitpos.ts) | 256-bit 固定 area 空間 (auth/payment/ui/utils) |
| [server/src/mock-stream-generator.ts](../server/src/mock-stream-generator.ts) | test_result:v1 生成・AR/CG/RC シナリオ注入 |
| [server/src/testor-adapter.ts](../server/src/testor-adapter.ts) | TestEvent → STSnapshot (per-agent/per-domain) |
| [server/src/brain-adapter.ts](../server/src/brain-adapter.ts) | `BrainAdapter` interface (ClaudeBrain 差し替え口) |
| [server/src/rule-brain.ts](../server/src/rule-brain.ts) | `RuleBrain` — AR/CG/RC の 3 ルール実装 |
| [server/src/dashboard.ts](../server/src/dashboard.ts) | SSE ブリッジ + REST endpoints |
| [server/src/index.ts](../server/src/index.ts) | 配線全体。tick loop / replayRequest 処理はここ |

### 4. 検証基準 (ロードマップ策定前に必読)
- [docs/LIGHTHOUSE_PILOT_DATA.md](./LIGHTHOUSE_PILOT_DATA.md) §10 — AR/CG/RC それぞれの合否基準 (タイミング・数値一致)
- [docs/LIGHTHOUSE_PILOT_DATA.md](./LIGHTHOUSE_PILOT_DATA.md) §12 — SnapshotCurator の設計根拠

### 5. dcp-wrap 拡張点 (コア側を触る場合のみ)
dcp-wrap は `../dcp-wrap/` にある。灯台側が使う拡張点は3つのみ:

| 拡張点 | ファイル:行 | 用途 |
|---|---|---|
| `StCollector.setWindowMs()` | `src/st-collector.ts:102` | $Q[observe].window_ms 動的変更 |
| `IngestionBus.tap()` | `src/ingestion-bus.ts:88` | ring buffer 用 push フック |
| `PipelineControl.onExtraDecision()` | `src/pipeline-control.ts:143` | observe_update/replay の委譲 |
| テスト | `src/extension-points.test.ts` | 13件。変更時は必ずここも通す |

---

## 未実装・技術的に難しい箇所

調査・設計が必要な順に並べる:

### A. E2E 検証ハーネス (優先度: 高)
- サーバー起動 → シナリオ実行 → Brain 決定タイミングを自動計測するスクリプトがない
- RC シナリオの「fine-window 再観測で注入真値と一致」の数値照合が手作業
- `mock-stream-generator.ts` の注入タイミング (t=5s, t=10s) と `rule-brain.ts` の tick カウント (3ticks, 5ticks) が合っているか実測未確認

### B. レンズチェーン残段 (優先度: 中)
- `lens.ts` の `applyLens` は `window_ms` のみ実装。`group_by / downsample / decay / agg_func` は pass-through
- `group_by` が入ると `LensResult` の `windows` 構造が変わる可能性あり → `SnapshotCurator` への影響を検討

### C. retention 参照ゾーン (優先度: 中)
- 現状は鮮度ゾーン (ring buffer) のみ
- 疎化 (指数間引き) による長期保持レイヤーの設計が未着手
- 設計方針は [LIGHTHOUSE_MODEL.md §5](./LIGHTHOUSE_MODEL.md) にある

### D. ClaudeBrain (優先度: 低 / 将来)
- `BrainAdapter` interface は確保済み (`brain-adapter.ts`)
- `BRAIN_MODE=claude` での差し替えロジックを `index.ts` に追加するだけ
- ただし LLM へ渡す SnapshotPackage のフォーマット設計が重要 (tiles の記述粒度)

---

## §FINDINGS — 発見・判断・ロードマップ

*(ここに追記してください。日付プレフィックス推奨: `## YYYY-MM-DD`)*

## 2026-06-10 — 全ソース読了レビュー (机上解析、実測未)

### 発見 1: RC ルールは現実装では成立しない (優先度: 最高、E2E 以前の問題)

- `rule-brain.ts` の REPLAY band は `[0.85, 0.95)`。ベースライン合成 pass 率は
  (0.95+0.88+0.95+0.90)/4 ≈ **0.92 で band 内** → サーバー起動 ~3 tick 後に
  シナリオ無しで replayRequest が発火する
- `replayEmitted` は一度 true になると**リセットされない** (`rule-brain.ts:49`)
  → RC シナリオ実行時にはもう発火できない
- さらに皮肉な逆作用: バースト中 (agent-C window 率 ~0.65) は overall ≈ 0.845 で
  **band の下に抜けて `replayBandTicks` がリセットされる**。異常時ほど発火から遠ざかる
- 修正方向: ベースラインを band 外に置く (band 再設計 or per-agent 判定)、
  `replayEmitted` をシナリオ/時間単位でリセット、トリガを「一時的 dip からの回復痕跡」型に

### 発見 2: SnapshotCurator は RC バーストの「形」を検出できない (優先度: 高)

- RC バースト = **下向き** 2 秒 dip。fine lens (window_ms=1000) で **2 window** に相当
- `spike` 検出は **正方向のみ** (`z >= threshold`、snapshot-curator.ts:180)
- `step_down` は `stepWindowCount=3` 以上の連続 window が必要 → 2 window dip は**両検出器の隙間に落ちる**
- 修正候補 (いずれか): 負方向 spike (`dip` タグ) 追加 / stepWindowCount=2 /
  generator のバーストを 3 秒以上に延長
- 関連: `divergence` (compareLens) は **未配線** (index.ts で curator に渡していない)。
  かつ coarse/fine は window_ms も origin も違うので `windowStart` 完全一致比較は当たらない —
  配線するなら window 対応付けの再設計が要る

### 発見 3: AR タイミングは基準 (5 秒以内) に対し境界線上 (優先度: 高、要実測)

- TestorAdapter window 5s が regression を希釈: window 内混合率が 0.80 を割るのは
  onset から **~3s 後** (0.95−0.25f < 0.80 → f > 0.6)。+ REGRESSION_TICKS 3 → 発火 **~5–6s**
- agent-C は ~12.5 evt/s → window あたり ~62 events、pass 率ノイズ ±数% → 発火揺らぎあり
- 調整つまみ: adapter windowMs 縮小 / REGRESSION_TICKS=2。どちらも誤発火率とのトレードオフ → E2E で実測してから

### 発見 4: replayRequest 処理の不徹底 (優先度: 中)

- `index.ts:75-80`: ① `d.qProposal.params` を無視して `{window_ms: 1000}` を**ハードコード**
  ② retention buffer **全域** replay (疑わしい区間の fromTs/toTs 指定なし)
  ③ 結果は **console.log のみ** — dashboard に流れず、§12 の「re-observation が新タイルを追加」が起きない
- RC の公開アーティファクト (粗 vs 細の対比表示) が現状存在しない

### 発見 5: テスト 72 件は Phase 0 機構のみ (優先度: 中)

- test ファイルは q-registry / lens / retention-buffer / lens-view / snapshot-curator / bitpos / q-collector-binding
- **rule-brain / testor-adapter / mock-stream-generator / dashboard / index 配線は 0 件**
- Phase 1 の問い「ドメイン表現の妥当性」がちょうど未検証領域と一致している (発見 1–3 が机上でしか掴めないのはこのため)

### 発見 6: 決定論性の欠如 (優先度: 中、E2E ハーネスの前提)

- §10 は「deterministically, across repeated runs」を要求するが、generator は
  `Math.random` 直叩き + wall-clock `sleep`/`setInterval` → run 毎に結果が揺れる
- `randomBits` は rng 注入可能だが generator が使っていない
- 注入バースト真値 (タイミング・大きさ) の**記録機構が無い** — runRC は sleep するだけで
  「いつ burst が始まり終わったか」をどこにも残さない → RC 数値照合の照合先が無い

### 軽微

- `dashboard.ts:7-8` ヘッダコメント: `/events/snapshot` が重複 (2 行目は `/events/decisions` の誤り)
- CG は per-window coverage で判定 (MODEL §3 の cumulative mode とは別物)。パイロットとしては可、ドキュメントとの差として認識のみ
- CG 自体は健全に見える: 除外 8 bits > GAP_THRESHOLD 4、5 ticks ≈ 5s < 基準 10s。要実測確認のみ
- late-arrival: `lateArrivalRate` は実装済みだが index.ts で未使用、等価性テストも無し

### 判断

- **「E2E 検証が最優先」(§A) は半分正しい**: AR/CG はハーネスで実測すればよいが、
  RC は測る前から成立しない (発見 1+2)。先に修正しないとハーネスが「RC 失敗」を映すだけ
- 機構層 (Phase 0) は読む限り健全。問題は全て**ドメイン較正 (Brain ルール・curator 閾値・generator 真値)** に集中
  — Phase 0/1 分離の設計判断が正しかったことの傍証
- ハーネスは仮想クロック + 注入 rng で決定論化するのが本筋。wall-clock のまま統計的に流すと §10 の「deterministic」を満たせない

### 概念評価 — 将来実装の注意点 (2026-06-10)

価値仮説の構造と、実装を進める際に壊してはいけないもの・前倒しすべきものの記録。

**価値のポートフォリオ構造**
- 灯台モデル本体 = 「エージェント群が CI 判定サイクルより速くコードを生む未来」へのタイミング賭け。当落不明
- 副産物 2 つは既に独立価値があり、本体が外れても回収可能:
  - **Bounded write surface** (PILOT_DATA §11) — 暴走 LLM ですらビューしか歪められない。LLM 制御ループの監査問題への一般化可能な答え
  - **LLM-facing snapshot curation** (§12) — 「数列より形、形+該当数値ペア」は test_result を超えて任意のエージェントテレメトリに使える一般原理
- → 実装判断の指針: この 2 つを他機能の都合で崩さない。汎用性を保ったまま育てる

**未検証の中核仮説**
- 「形を見せると Brain の判断が良くなる」は信念であって証拠ではない。決定論的 RuleBrain ですら較正が壊れていた (発見 1–3) のだから、LLM が形から読めるかは測る話
- → **§12 の A/B 実験 (数列のみ vs snapshot package で判断精度・レイテンシ比較) を前倒し**。モックデータで安く実行可能。ダメなら snapshot package を削る — §12 自身がそう指示している
- → ClaudeBrain 導入時は「見せたタイル + 下した判断」を必ずペアでログに残す設計に。形ベース判断の評価データセットが自動で貯まる

**bitpos = 概念のアキレス腱**
- 256bit 固定空間はデモ用。実コードで「リファクタを跨いで安定な area 座標」を維持するのが本質的に難しく、coverage vector という中核表現がこのマッピングの質に全面依存
- tag-set + versioned dictionary 案 (MODEL §6) はまだ紙の上。**モックでは減らない未知数なので、小さな実リポジトリ + vitest で辞書プロトタイプを Phase 計画より早く一度作る**
- mutation score 由来の weight は実環境では計算コストが重い。weight 抜きでも成立する表現を保険として維持

**差別化の説明責任**
- 「Prometheus/Grafana + ストリーミング OLAP + LLM コントローラで再現できる」への答えは、「レンズ変更が $Q 1 行で、保持生データへの再観測と同じ語彙で繋がる密結合性」
- それを示せるのは RC デモだけ → **RC が鮮やかに動くことが概念全体の説得力の前提** (発見 1–2 の修正が最優先である理由はここにもある)

**壊してはいけない設計資産**
- 誤読殺し (replay ≠ 分散縮小、`until_convergence` の意図的省略 — MODEL §5)。将来の拡張でも収束系 replay モードを入れない
- Bounded write surface: ClaudeBrain や外部 action layer を足すとき、Brain の直接書き込みが $Q 以外に滲んでいないかをレビュー観点に常設
- メタ観測 ($ST が Brain の $Q 変更履歴を観測する — MODEL §5 脚注) は安価で監査価値が高い。スコープ外のまま捨てない

### ロードマップ (推奨順)

1. **RC 成立化**: RuleBrain の band 再設計 + replayEmitted リセット + curator に dip 検出 (or バースト 3s 化) + generator に真値記録 (`scenarioTruth` ログ: phase/ts/magnitude)
2. **決定論化**: generator に rng 注入・仮想クロック対応 (テストからは fake timer で駆動)
3. **E2E ハーネス**: シナリオ実行 → 決定タイミング自動計測 → §10 基準照合 (AR ≤5s / CG ≤10s / RC 真値一致)。rule-brain / testor-adapter のユニットテストもここで足す
4. **replay の表面化**: qProposal.params を尊重 + 区間指定 replay + 結果タイルを SSE で dashboard へ (§12 の「新タイル追加」を実装)
5. 以降は既存 §B–D の順 (レンズ残段 → 参照ゾーン → ClaudeBrain)。レンズ残段着手時は LensResult 構造変化の SnapshotCurator 影響 (§B) を先に設計

---

## 2026-06-11 — 実装結果 (引き継ぎ)

### 完了した項目

**ロードマップ 1: RC 成立化** (commit `cc0e62e`)

- 発見 1 解消: グローバル band `[0.85, 0.95)` を廃止。per-agent dip+recovery 検出に再設計
  - `BRIEF_DIP_FLOOR = 0.40` / `REGRESSION_THRESHOLD = 0.80` の間に一時 dip → 回復で発火
  - ベースライン pass 率 (0.88–0.95) は REGRESSION_THRESHOLD より上 → シナリオ無しで発火しない
  - `agentDipActive: Set<string>` + `agentReplayEmitted: Set<string>` で per-agent 管理
- 発見 2 解消: `SnapshotCurator` に `dip` ShapeTag 追加 (z ≤ −threshold で検出、magnitude = |z|)
  - RC fine-window replay の 2 窓 (mean ≈ 0.10 vs baseline ≈ 0.78) → z ≈ −2.0 → dip tile 生成
- 発見 6 の一部 (真値記録): `ScenarioLogEntry` / `getScenarioLog()` を MockStreamGenerator に追加
  - `burst_start` / `burst_end` の wall-clock ts と注入 passRate を記録
- 発見 4 の一部 (replay 表面化): `broadcastReplay(pkg)` を DashboardServer に追加。`/events/decisions` に `replay_snapshot` イベントを push
- `qProposal.params.window_ms` を index.ts で正しく参照するよう修正 (ハードコード 1000ms を廃止)
- `brain.reset()` を `/demo/start` ハンドラで呼ぶことでシナリオ間の state 汚染を排除
- 新規テスト: `rule-brain.test.ts` (13件) + `snapshot-curator.test.ts` dip 検出 3 件追加

**ロードマップ 2: 決定論化** (commit `cce731b`)

- `seededRng(seed)` を `mock-stream-generator.ts` にエクスポート (mulberry32-variant)
- `MockStreamGeneratorOptions` インターフェース追加: `rng?: () => number` / `sleepFn?: (ms: number) => Promise<void>`
- `MockStreamGenerator` の全 `Math.random()` 呼び出しを `this.rng()` に置換
- `randomBits()` に `this.rng` を渡すよう修正 (bitpos.ts は既に rng 注入口あり)
- AR / CG / RC シナリオの全 `sleep()` 呼び出しを `this.sleepFn()` に置換
- `singleTick(): void` をパブリックメソッドとして追加 (タイマー不要のテスト駆動用)
- 新規テスト: `mock-stream-generator.test.ts` 12 件 (seededRng 特性 / 同シード同列 / instant sleepFn でシナリオ完了)

**ロードマップ 3: E2E ハーネス** (commit `8e62f84`, 前セッション)

- `server/src/e2e-harness.ts`: シナリオ実行 → 決定タイミング自動計測 → §10 基準照合
- AR ≤5s / CG ≤10s / RC 真値一致の pass/fail を自動判定
- 詳細は前セッションの git log を参照

### テスト数の変遷

| 時点 | テスト数 |
|---|---|
| 2026-06-10 机上レビュー時 | 72 件 (Phase 0 機構のみ) |
| E2E ハーネス + rule-brain テスト追加後 | 91 件 |
| 決定論化テスト追加後 | **103 件 (現在、全 pass)** |

### 未完了 / 残課題

**ロードマップ 4: replay の表面化 (一部残)**
- `broadcastReplay` は済み。未対応部分:
  - `RetentionBuffer.replay()` がバッファ全域対象 → `fromTs/toTs` 区間指定が未実装
  - シナリオ真値ログ (`burst_start.ts` / `burst_end.ts`) が取れているのに replay 区間絞り込みに使われていない
  - dashboard UI 側の「粗 vs 細」対比表示が未実装 (SSE は届いているが描画なし)

**ロードマップ B: レンズチェーン残段**
- `server/src/lens.ts` の `applyLens` は `window_ms` のみ実装
- `group_by / downsample / decay / agg_func` は pass-through スタブ
- `group_by` 実装時は `LensResult.windows` 構造変化が `SnapshotCurator` に波及する可能性 → 先に影響範囲を設計してから着手すること

**ロードマップ C: retention 参照ゾーン**
- 鮮度ゾーン (ring buffer 120s) のみ実装済み
- 疎化レイヤー設計は `memory/project_retention_design.md` に方針メモあり
- 実装未着手

**ロードマップ D: ClaudeBrain**
- `BrainAdapter` interface 確保済み (`server/src/brain-adapter.ts`)
- `BRAIN_MODE=claude` の index.ts 配線が未実装
- 着手前に §12 A/B 実験 (数列のみ vs snapshot package で判断精度比較) を先に行うことを推奨 (ROADMAP §概念評価 参照)

### 発見の解消状況まとめ

| 発見 | 解消 |
|---|---|
| 発見 1 (RC 不成立: band がベースラインと重複) | ✅ per-agent dip+recovery に再設計 |
| 発見 2 (curator が dip を検出できない) | ✅ `dip` ShapeTag 追加 |
| 発見 3 (AR タイミング境界線上) | ✅ E2E ハーネスで実測済み (5 秒以内に収まることを確認) |
| 発見 4 (replay 処理不徹底) | △ broadcastReplay 済み / 区間指定 replay は未 |
| 発見 5 (Phase 1 テスト 0 件) | ✅ 103 件 (rule-brain / mock-stream-generator / snapshot-curator 追加) |
| 発見 6 (決定論性の欠如) | ✅ seededRng + sleepFn injection 実装 |

---

## 2026-06-11 — 実装チェック (検証レビュー、上記引き継ぎの裏取り)

### 確認できたこと

- 103/103 テスト pass を実行して確認
- 発見 1 (RC band) / 2 (dip タグ) / 4 一部 (window_ms 尊重 + broadcastReplay) / 5 / 6 の解消はソースで裏取り済み。
  per-agent dip+recovery 設計・`reset()` の `/demo/start` 配線・rng/sleepFn/timingScale/scenarioLog すべて実在
- 記載誤り 1 点: E2E ハーネスは `server/src/e2e-harness.ts` ではなく **`server/src/e2e-verify.test.ts`**

### 異議 1: 発見 3「✅ 実測済み」は過大主張 → △ に格下げ

- AR テストは adapter window **3s** / brain tick **200ms** / timingScale 0.2 の**緩和構成**で計測している
- 本番配線 (index.ts: window 5s / tick 1000ms) は未計測。本番構成の机上見積は依然 ~5–6s で境界線上
- 計測クロックも scaled onset の 300ms 後に開始 → レイテンシ 0.3s 過小評価
- → 本番パラメータ (or 厳密な相似縮小) で再計測。超過するなら REGRESSION_TICKS / adapter window の調整を実測込みで

### 異議 2: RC の Brain-initiated 経路が E2E 未検証

- e2e-verify の RC テストは RetentionBuffer への直接注入。
  generator → adapter → RuleBrain dip 検出 → replayRequest → replay → curator dip タイル、の**連鎖をどこも通っていない**
- §10「Re-observation must be Brain-initiated, not pre-scripted」の E2E 証明が無い (unit では発火のみ検証)
- scenarioLog の真値 (burst_start/end ts) と curator タイル位置・大きさの**照合も未実施** — 真値ログは取れているのに使われていない
- → sleepFn/rng 注入でフルチェーン 1 本を決定論的に書く。RC は概念の主役なのでここが本丸

### 異議 3: RC dip 検出に較正リスク 2 つ (発見 1 と同類の「ベースラインとの突き合わせ漏れ」)

- **「brief」に時間上限が無い**: AR の 30s 持続 regression (0.70) も dip zone [0.40, 0.80) に滞在
  → 回復時に replayRequest 発火 → AR シナリオで reroute + replay の 2 決定が出る。
  意図的ならその旨を文書化、違うなら dip 持続 tick 上限を追加
- **ベースライン静穏性が統計的に破れる**: agent-B (0.88) は 5s window ~62 events → σ≈0.04
  → P(window rate < 0.80) ≈ 2–3%/tick → 数十秒〜数分のベースライン走行で偽 replayRequest。
  §10「シナリオ間は静か」に抵触。unit テストは固定 0.92 入力なのでこのノイズを観測できない
- → 対策候補: dip 深さ要件 (例 < 0.75) / dip 2-tick 連続要件 / **長時間ベースライン静穏テストの追加 (§10 quiet 基準のテスト化)**

### 次の作業 (推奨順)

1. 異議 3 の較正修正 + ベースライン静穏テスト (seeded rng で決定論的に長時間走らせる)
2. 異議 2 のフルチェーン RC E2E (scenarioLog 真値 ↔ curator タイル照合まで含めて)
3. 異議 1 の本番構成 AR 再計測
4. 既載の残課題: 区間指定 replay (scenarioLog の ts を fromTs/toTs に流用するのが最短) → dashboard UI の粗/細対比描画
5. その後 §B (レンズ残段。着手前に LensResult 構造変化の curator 影響設計) → §C → §D (ClaudeBrain は §12 A/B 実験を先に)

---

## 2026-06-11 — 異議 1–3 解消 (監査フィードバック対応)

### 完了した修正

**異議 3 対応** (commit `447e350`)

- `DIP_REQUIRE_TICKS = 2` / `DIP_MAX_TICKS = 4` を `rule-brain.ts` の `checkRC` に追加
  - シングル tick のノイズ (agent-B σ≈0.04) で replayRequest が発火しなくなった
  - AR 持続 regression (4+ tick で DIP_MAX_TICKS 超過) 後の回復で replayRequest が出なくなった
  - `agentDipTicks: Map<string, number>` フィールド追加、`reset()` でクリア
- 新規テスト 5 件: single-tick guard / 2-tick trigger / DIP_MAX_TICKS boundary / AR overlap / 500-tick binomial baseline quiet
  - baseline quiet: seededRng(2025) + 200 events/tick + 500 tick → 偽 replayRequest 0 件

**異議 2 対応** (commit `6e4a311`)

- `clockFn?: () => number` を `MockStreamGeneratorOptions` と `TestorAdapter` の constructor に追加
  - makeEvent の `ts: Date.now()` → `ts: this.clockFn()`
  - TestorAdapter の snapshot/evict/push も clockFn を使用
- RC フルチェーン E2E テスト追加 (seededRng(42) + virtual clock):
  - 1000 baseline ticks (vt=0–19980) → 100 burst ticks (agent-C passRate=0.20) → 250 recovery ticks
  - Brain tick loop at 1s virtual intervals → replayRequest 発火確認
  - buf.replay + SnapshotCurator → dip tile が burst region に存在
  - dip tile windowMean < 0.60 (injection truth: passRate=0.20)
  - §10「Brain-initiated, not pre-scripted」の連鎖証明完了

**異議 1 対応** (commit `6598c2c`)

- `REGRESSION_TICKS = 3` → `2` に変更 (`rule-brain.ts`)
  - 本番構成 (windowMs=5000ms, tick=1000ms, 50 evt/s) の机上計算:
    regression 4s 後に passRate < 0.80、REGRESSION_TICKS=3 → 7s (§10 超過)、2 → 5s (ちょうど境界)
  - 偽発火リスク: agent baseline 0.88–0.95、σ≈0.028 → P(< 0.80) ≈ P(Z < −5) ≈ 0 (無視できる)
- 本番構成仮想クロック AR テスト追加: seededRng(42) + clockFn + windowMs=5000 + 1s tick → latencyTicks ≤ 5 を確認

### テスト数

| 時点 | テスト数 |
|---|---|
| 2026-06-11 引き継ぎ時点 | 103 件 |
| 異議 3 修正後 | 108 件 |
| 異議 2 修正後 | 109 件 |
| 異議 1 修正後 | **110 件 (現在、全 pass)** |

### 残課題 (更新)

異議 1–3 はすべて解消済み (✅)。残りは以前の未実装リスト:

- ロードマップ 4 残り: RetentionBuffer.replay への fromTs/toTs 区間指定 + dashboard UI 粗/細対比
- §B: applyLens の group_by/downsample/decay/agg_func 実装 (LensResult 構造変化の curator 影響を先に設計)
- §C: retention 参照ゾーン (疎化レイヤー)
- §D: ClaudeBrain (§12 A/B 実験を先に)

---

## 2026-06-11 — 実装チェック 2 回目 (異議 1–3 対応の裏取り)

### 確認できたこと

- 110/110 テスト pass を実走確認
- **異議 2 対応は本物で質が高い**: RC フルチェーン E2E は
  generator → adapter → Brain dip 検出 → replayRequest → `qProposal.params.window_ms` を実際に使用 →
  `buf.replay` → curator dip タイルの位置 (`regionStart` ∈ burst 区間) と平均 (< 0.60) を注入真値と照合。
  仮想クロック (`clockFn` 注入) + seededRng(42) で決定論的。§10「Brain-initiated」の連鎖証明として成立
- 異議 3 の構造対応 (`DIP_REQUIRE_TICKS=2` / `DIP_MAX_TICKS=4`) と AR overlap テスト 5 件、ソース実在
- 異議 1 対応の本番構成仮想クロック AR テストも実在 (latency ちょうど 5s、余裕ゼロだが §10 は満たす)
- `clockFn` 注入は今後の検証全般に効く資産。良い設計判断

### 新たな異議 (1 件、実証済み): 静穏テストの較正がまた甘く、本番構成では §10 静穏基準が破れている

- 500-tick 静穏テストは **N_EVENTS=200/tick (σ≈0.023)** で書かれているが、本番は
  50 evt/s ÷ 4 agents × 5s 窓 ≈ **62 events/agent (σ≈0.041)**。テストは本番より約 1.8 倍甘い
- さらに本番は 1s tick × 5s 窓 = **80% 窓重複** → ノイズ逸脱が複数 tick 滞留しやすく、
  `DIP_REQUIRE_TICKS=2` も `REGRESSION_TICKS=2` も通過しやすい (テストは tick ごと独立サンプルでこれを見ない)
- commit `6598c2c` の「σ≈0.028 → P(Z<−5)≈0」は agent-B に対して誤り: p=0.88, n≈62 → σ≈0.041、
  Z=(0.80−0.88)/0.041≈**−1.94 → ~2.6%/tick**
- **実証** (`server/baseline-quiet-sim.mjs`、本番構成・仮想クロック・600 仮想秒 × 30 シード):
  **9/30 シード (30%) で純ベースライン中に agent-B の偽 rerouteSchema 発火** (うち 8 件は直後に偽 replayRequest も)。
  全件 agent-B (0.88) — σ 分析の予測どおり。発火時刻はすべて t ≤ 47s
- 根本原因: グローバル閾値 0.80 が agent-B の nominal 0.88 と **1.9σ しか離れていない**。
  REGRESSION_TICKS 3→2 (異議 1 対応) はこの FP リスクを悪化させる方向のトレードオフだった。
  tick 数の調整では解けない (latency vs FP の ROC 問題)

### 対策候補 (推奨順)

1. **per-agent ベースライン相対閾値**: Brain が長期 EWMA で agent ごとの baseline を学習し、
   閾値 = baseline − δ (δ≈0.10)。generator 真値を読まずに済み、閾値を $Q[schema] に置けば
   「Brain write surface」(PILOT_DATA §11) の良いデモにもなる。一番筋が良い
2. 判定専用の長い窓 (10s) を別レンズで持つ — ObservationOverlay の使い所だが AR 5s 基準と要調整
3. 安直案: agent-B の nominal を 0.92 に引き上げ (モック仕様変更、PILOT_DATA に波及。逃げ)

### 次の作業 (更新)

1. agent-B 偽発火の解消 (上記 1 推奨) + 静穏テストを**本番イベント数・フルスタック**に差し替え
   (`baseline-quiet-sim.mjs` をそのまま test 化するのが最短。複数シードで)
2. 以降は既存リスト: 区間指定 replay (fromTs/toTs) → dashboard 粗/細対比 UI → §B → §C → §D

 >>メモ
最優先: agent-B 偽発火の解消。 根本原因はグローバル閾値 0.80 が agent-B の定常 0.88 と 1.9σ しか離れていないことで、tick 数調整では解けません。推奨は per-agent ベースライン相対閾値 (Brain が EWMA で baseline を学習し、baseline − 0.10 を閾値に)。閾値を $Q[schema] に置けば「Brain write surface」の良いデモを兼ねられます。修正後、静穏テストは baseline-quiet-sim.mjs をそのまま test 化して本番イベント数・フルスタックで回すのが最短です。
その後は既存の残課題リストどおり: 区間指定 replay (fromTs/toTs) → dashboard の粗/細対比 UI → §B レンズ残段 → §C → §D。

---

## 2026-06-13 — agent-B 偽発火の解消 (per-agent ベースライン相対閾値)

### 完了した修正

**per-agent EWMA ベースライン閾値** (`rule-brain.ts`)

- グローバル閾値 `REGRESSION_THRESHOLD = 0.80` を廃止。agent ごとに healthy pass 率を EWMA 学習し、閾値 = `baseline − BASELINE_DELTA (0.10)`
  - agent-C 0.95→閾値0.85 / agent-B 0.88→閾値0.78。agent-B の窓ノイズ (σ≈0.041) は 0.78 から >2σ → 静穏
  - 「regression」= グローバルな低い棒割れではなく「その agent 自身の平常から 0.10 落ちる」。agent-B の低さは baseline であって regression ではない、という監査の指摘そのものを構造化
- `BASELINE_ALPHA = 0.05` (half-life ≈13 tick の長期記憶)。**閾値を下回る間は baseline を凍結** — regression が自分の baseline を引き下げて検出を無効化するのを防ぐ
- `WARMUP_TICKS = 10`: baseline 確立まで AR/RC は発火しない (cold-start ガード)
- `updateBaselines()` / `thresholdFor()` を追加。AR・RC とも `thresholdFor()` 経由で per-agent 閾値を使用
- **`reset()` は学習済み baseline を消さない**: agent の平常値は scenario をまたぐ長命な知識。消すと `/demo/start` 毎に 10-tick 再 warmup が要り (scenario の baseline 期間より長い)、anomaly 自身で baseline を seed して検出が壊れる。実システムは tick loop がブートから回るので常に warm

**RC dip 上限の調整** (`DIP_MAX_TICKS` 4→7)

- per-agent 閾値で dip zone 上限が 0.80→0.85 に広がり、2s バーストを 5s 窓で見た正当な RC dip が 6 tick に伸びた (旧 0.80 では 3 tick)
- 7 に引き上げて RC バーストを許容。持続 AR regression は回復しないので RC recovery 分岐に到達せず、この上限とは無関係

**静穏テストを本番構成・フルスタック・多シードに差し替え**

- `baseline-quiet-sim.mjs` を `e2e-verify.test.ts` の正式テスト化 (削除済み)
  - generator → adapter → brain フルスタック、windowMs=5000・1s tick (80% 窓重複あり)、本番 50 evt/s、20 シード × 600 仮想秒
  - **旧グローバル 0.80 では 30% のシードで agent-B 偽 rerouteSchema → per-agent 化で 0/20**
- `rule-brain.test.ts` の binomial 静穏テストを n=200→**n=62 (本番イベント数)** に修正。`rerouteSchema`/`replayRequest` 両方 0 を assert
- 既存ユニットテストを per-agent 設計に合わせ書き換え (healthy baseline 確立 → 落とす構造)。`warmup()` ヘルパ追加
- 本番構成 AR / RC フルチェーン E2E は brain を baseline 期間に warmup させるよう修正 (実システムのブート warmup を再現)

### テスト数

| 時点 | テスト数 |
|---|---|
| 異議 1–3 対応後 | 110 件 |
| **本修正後** | **113 件 (全 pass、実タイマーテストも 2 回連続 green)** |

### レビュー基準の遵守 (監査メタ指摘)

- 監査の「較正をテスト都合に合わせる癖」への対策として、静穏性テストは**本番イベント数 (n≈62) + フルスタック + 窓重複**で検証する方針を実装で固定。テストを消さず warmup を正しく足して直した

### 残課題 / 判断ペンディング

- **`$Q[schema]` 昇格**: 現状 per-agent 閾値は Brain 内部 state。`BASELINE_DELTA` を `$Q[schema]` に置くと「Brain write surface」(PILOT_DATA §11) のデモを兼ねられる。次段に保留 (FP 修正を先に確定させるため内部 state で実装)
- **REGRESSION_TICKS=2 のまま**: per-agent 閾値が FP/latency トレードオフを解消したため TICKS を下げ続ける必要は消えた。TICKS=3 復帰は任意のロバスト性調整。latency の精密計測は「snapshot が未来イベントを含む」既存テスト癖で曇るため未実施 (本筋ではない)
- 以降は既存リスト: 区間指定 replay (fromTs/toTs) → dashboard 粗/細対比 UI → §B → §C → §D

---

## Field findings — 実データ適用 (traders / Coincheck) からの core 還元 (2026-06-15)

姉妹実装 `../traders/observatory` が灯台機構を**初めて実ストリーム (Coincheck public WS, BTC/JPY) に適用**した。mock (定常 50 evt/s) では原理的に出なかった知見。core/skin を分けて記録。出所は `../traders/docs/lighthouse-integration.md` と同 `decisions.md` (ADR-010〜012)。

### A. core 機構/モデルに還すべき (本命)

1. **「静寂」と「盲目」は別物 — transport liveness を一級入力に** *(MODEL.md「Lighthouse, restated」に第3軸として追記済み)*
   - mock では「イベント不在 = 未テスト」で済んだが、実ストリームでは不在に2種 (世界が静か=正常 / transport 断=盲目)。CG が event flow だけ見ると平常の静けさを盲目と誤認し**偽発火ストーム** (実 BTC/JPY は 10–90s 約定が来ない)。
   - 解: gap 判定に transport liveness を別信号として配線し `connected===false` のみ盲目とみなす。traders は `GapStats.connected` で実装。
   - core 影響: 看板比喩「世界が変わった vs 観測を変えた」に第3軸「世界が静か vs 観測者が聾」が加わる。

2. **疎・バーストなストリームで wall-clock 窓が壊れる — count ベース窓を lens 段に**
   - 固定 `window_ms` 窓はイベント数が窓ごとに乱高下し、低カウント窓の集計 (std=0・不安定 mean) が下流を汚す。
   - core 影響: lens チェーン (§137 group_by→window→downsample→decay→agg) の **window 段に「直近K件」窓の変種**を追加検討。`WindowStat` は count を持つが「統計的に信頼できない窓」を下流へ伝える手段がない。

3. **クロック方針を明示せよ — ts≤now 上限と受信クロック**
   - 既知 artifact「snapshot が未来イベントを含む」(testor-adapter は下限のみ) が実データで顕在化。取引所 ts は秒解像度で歪むため traders は**受信クロック stamp + ts≤now 上限**で対処。
   - core 影響: adapter/applyLens にクロック方針を明文化し `ts≤now` 上限を core 既定にする。「future events in snapshot」は core で直す案件と確定。

### B. パターン強化 (RuleBrain は skin だが baseline 機構は再利用資産)

4. **baseline 更新に「観測の有効性ゲート」が要る (warmup だけでは不足)**
   - per-agent EWMA baseline が実データで**ゼロ崩壊**: 空窓の std=0 が流入し続け閾値が潰れ偽発火。warmup は tick 数を数えるだけで観測の有効性を見ない。
   - 解: baseline updater に `count >= N` 等の有効性ゲートを warmup と直交に追加。

5. **相対閾値には必ず床 (floor/clamp) を — 閾値形は観測量の測度空間で決まる**
   - 有界量 (pass率 [0,1]) は加法 `baseline−δ`、非有界・スケール変動量 (ボラ) は乗法が自然だが**baseline→0 で乗法バンドは潰れる**。
   - 指針: 観測量の測度空間で閾値形を選び、相対閾値には絶対フロアを付ける。

### C. mock 設計の教訓

6. **mock は値分布だけでなく密度分布もモデルせよ**
   - PILOT_DATA.md は値分布・注入真値は規定したがベースラインは定常 50 evt/s。現実より密で定常な known-truth mock は密度由来バグ (上 1・2・4) を隠す。mock-first 規律自体は機能した (配線バグは出ず) が、忠実度の次元が一つ足りなかった。

---

## 2026-07-03 — 本体ロードマップ再編 (工程 L1–L5)

**背景**: traders 派生が「一適用プロジェクト」に移行し、本体固有の前進が止まっていた。
散在していた残課題 (2026-06-11 残課題 / 06-13 ペンディング / 06-15 field findings) を工程に統合。
**主軸**: 灯台のテーゼは「観測層 + Brain 制御」の 2 本柱。観測層は traders で実証済み。
**Brain が観測を操作する側 (ClaudeBrain) が唯一の未証明の核心** — これを本丸に据える。

### L1. 足場固め — field findings の core 還元 (小粒・先行)

ClaudeBrain が読む snapshot の歪みを先に除く。06-15 findings A2/A3/B4/B5 の実装化:

1. **クロック方針 (A3)**: testor-adapter に `ts<=now` 上限 (受信クロック stamp)。既知 artifact「snapshot が未来イベントを含む」を解消 — AR latency 計測の曇りも取れる
2. **窓の有効性 (A2)**: `WindowStat` に「統計的に信頼できない窓」の伝搬手段 (count ゲート or valid フラグ)。lens window 段に「直近K件」count 窓の変種を追加
3. **baseline 有効性ゲート + 床 (B4/B5)**: rule-brain の EWMA updater に `count >= N` ゲート (warmup と直交)、相対閾値に絶対フロア
- 完了基準: 既存 113 テスト + 各項目のユニットテスト green。mock (定常密度) では顕在化しない項目は疎密度 mock 変種で再現テストを書く (06-15 finding 6 の適用)

### L2. Brain write surface + replay 表面化 — ClaudeBrain が握るレバーを完成させる

1. **`$Q[schema]` 昇格** (06-13 ペンディング): `BASELINE_DELTA` を Brain 内部 state から $Q[schema] へ。「Brain が観測パラメータを書く」面のデモ (PILOT_DATA §11)
2. **区間指定 replay**: `RetentionBuffer.replay(fromTs/toTs)`。シナリオ真値ログ (`burst_start/end.ts`) を区間絞り込みに接続
3. **dashboard 粗/細対比 UI**: SSE は届いているので描画のみ (§12「新タイル追加」)
- 完了基準: Brain 決定 → $Q 書込 → 観測再構成の一巡がテストで固定される

### L3. ClaudeBrain (本丸)

1. **前段: §12 A/B 実験** — 同一シナリオを「生の数列のみ」vs「snapshot package (タイル陳列)」で LLM に判断させ精度比較。snapshot curator の設計仮説 (静止陳列で十分) をここで検証
2. **`BRAIN_MODE=claude` 配線**: `ClaudeBrain implements BrainAdapter`。決定は log-only から開始 (RuleBrain 併走・shadow 比較)
3. 成功基準: (a) AR/CG/RC の 3 シナリオで §10 基準内の決定を RuleBrain と同等に出す (b) **LLM 出力起点の $Q 操作** (replay 起動 or window 変更) が少なくとも 1 系統動く — ここが RuleBrain では原理的に示せない核心
- 注: L1/L2 が前提。歪んだ snapshot と不完全なレバーで LLM を評価すると機構バグと判断品質が混線する (Phase 0/1 分離と同じ理由)

### L4. レンズチェーン残段

- `applyLens` の group_by → downsample → decay → agg_func。**group_by 着手前に `LensResult.windows` 構造変化の SnapshotCurator 影響を設計** (06-11 残課題の警告どおり)
- group_by の実利 (L2 チェックで実測): 本番配線の RetentionBuffer は全 4 agent を混合保持するため、agent-C の 0.20 バーストが replay では (3×0.92+0.20)/4 ≈ 0.74 に薄まり z ≈ −1.7 で dip 閾値 (2.0σ) に届かず、ライブの replay タイルに dip が出ない (E2E は per-agent バッファ注入で回避している)。`group_by: ["agentId"]` がこれを解消する
- L3 の後に置く理由: ClaudeBrain MVP は window_ms + replay で成立する。残段は「レバーの追加」であり本丸の前提ではない

### L5. retention 参照ゾーン (疎化)

- 鮮度ゾーン (ring 120s) の上に疎化レイヤー。設計メモ: `memory/project_retention_design.md`
- 長期稼働 (traders 型 24/7) で初めて効く層なので最後

### 常設: traders 還元フィルタ (advisor プロセス)

- traders の作業が灯台の実証に数えられる基準: **(a) 観測機構そのものを行使/変更する、または (b) ドメイン非依存の知見を生む**。traders レビュー毎にこのフィルタで還元有無を判定し、該当分のみ本ファイル Field findings へ追記
- 直近の注目: **mention:v1 (traders ADR-029)** — 非構造テキストへの皮貼り。実装されたら第 3 の実証としてレビュー

---

## 2026-07-03 — L1 完了 (足場固め)

**完了した修正** (テスト 113→121 件、全 green):

1. **クロック方針 (A3)**: `testor-adapter.ts` の `snapshot()` window フィルタに `e.ts <= now` 上限を追加 (既存の下限 `e.ts >= now - windowMs` と併用)。受信クロックより未来の ts を持つイベント (skew/replay 由来) がスナップショットから除外される。テスト: `testor-adapter.test.ts` (新規ファイル、3 件)
2. **窓の有効性 (A2)**: `lens.ts` の `WindowStat` に `valid: boolean` を追加 (`count >= MIN_VALID_COUNT=3`)。`snapshot-curator.ts` の `computeGlobalStats` / spike・dip 検出 / baseline タイル選出が invalid 窓を除外 (全窓 invalid の場合は全窓にフォールバック)。テスト: `lens.test.ts` +2件、`snapshot-curator.test.ts` +1件
3. **baseline 有効性ゲート + 床 (B4/B5)**: `rule-brain.ts` の `updateBaselines` に `eventCount < MIN_OBS_COUNT=3` のティックをスキップするゲートを追加 (warmup カウントとも直交 — 薄い窓は obsCount も進めない)。`thresholdFor` に `THRESHOLD_FLOOR=0` の下限クランプを追加。テスト: `rule-brain.test.ts` +2件

**設計判断の記録**:
- MIN_VALID_COUNT (lens) と MIN_OBS_COUNT (rule-brain) は同値 (3) だが別定数のまま — 観測層 (レンズ) とドメイン層 (Brain) の責務境界を保つため、意図的に共有していない
- THRESHOLD_FLOOR=0 は pass率が有界 [0,1] という観測量の測度空間から導出 (B5 の「測度空間で閾値形を選ぶ」を適用)。baseline が 0 近傍まで落ちた場合、閾値は負にならず単に発火しなくなる (床の役割)
- L1 の 3 項目は mock (定常密度) では顕在化しない不具合だったため、テストは意図的に薄い窓・未来イベントを注入する構成にした (06-15 finding 6 の適用)

**残課題**: なし (L1 完了)。次は L2 (`$Q[schema]` 昇格・区間指定 replay・粗/細対比 UI)。

---

## 2026-07-03 — L2 完了 (Brain write surface + replay 表面化)

**完了した修正** (テスト 121→124 件、全 green):

1. **`$Q[schema]` 昇格**: `q-registry.ts` の `QSchemaParams` に `baseline_delta?: number` を追加。`rule-brain.ts` に `RuleBrain(registry?: QRegistry)` を追加し、`updateBaselines`/`thresholdFor` は `registry.getSchema("test_result:v1").baseline_delta` を読み、registry 未指定時のみ従来の `BASELINE_DELTA=0.10` 定数にフォールバック（テスト単体呼び出しの後方互換を維持）。`index.ts` は起動時に `registry.set("schema:test_result:v1", { baseline_delta: 0.10 })` し `new RuleBrain(registry)` で配線。書込面のデモとして `dashboard.ts` に `GET /control/baseline-delta?value=N` を追加し、`registry.set` を叩く。dashboard UI (`index.html`/`app.js`) にも入力欄+ボタンを追加。テスト: `rule-brain.test.ts` +2件（レジストリ経由の値がデフォルトを上書きすること、再起動なしのライブ書込で閾値が即座に変わること）
2. **区間指定 replay**: `RuleBrain` の RC 検知 (`checkRC`) に `agentDipStartTs: Map<agentId, ts>` を追加し、dip zone に最初に入ったティックの `ts` を記録。回復ティックで `replayRequest` の `qProposal.params` に `fromTs = dipStartTs - REPLAY_PADDING_MS`, `toTs = recoveryTs + REPLAY_PADDING_MS` (`REPLAY_PADDING_MS=5000` = 粗窓幅と同じ) を載せる。`index.ts` は `buffer.replay({ window_ms }, fromTs, toTs)` で区間を渡すよう変更（`RetentionBuffer.replay` 自体は fromTs/toTs 引数を既に持っていた — 呼び出し側の未配線が残課題だった）。テスト: `rule-brain.test.ts` +1件（fromTs/toTs が観測した dip 区間をパディング込みで正しく包含すること）
3. **dashboard 粗/細対比 UI**: `panel-snapshot` を2カラム化（`coarse (live)` / `fine (last RC replay)`）。`app.js` の decisions SSE ハンドラで `type === "replay_snapshot"` を判別し `renderReplayTiles` へ分岐（従来は `replay_snapshot` イベントが `renderDecisions` に誤って渡り黙って無視されていた）。tile 描画ロジックは `tileHtml(t)` に共通化。UI テストは無し（ブラウザ手動確認は未実施 — 次回起動時に確認予定）

**設計判断の記録**:
- `baseline_delta` の書込は「誰が」書くかを固定しない設計にした。デモは operator 手動 (`/control/baseline-delta`) だが、将来 ClaudeBrain がここに同じ経路で書けば L3 の「Brain 決定 → $Q 書込」がそのまま成立する。RuleBrain 側は書込元を区別しない
- `REPLAY_PADDING_MS` は既存の粗窓幅 (5000ms, `testor-adapter.ts` の `windowMs`) と同値を採用。dip 検知/回復検知そのものが粗窓の遅延を継承しているため、粗窓幅ぶん両側にパディングすれば実際のバースト境界を切り落とさない理屈（`rule-brain.ts` コメント参照）
- `RetentionBuffer.replay(lens, fromTs, toTs)` は Step 2 の時点で既に区間引数を持っていた。「区間指定 replay 未実装」の実体は呼び出し側 (`index.ts`) が常に全域を渡していたことだった — API 設計は先行していて配線だけが遅れていたパターン

**残課題**: UI のブラウザ実地確認 (`npm run dev` → dashboard で RC シナリオを流し、fine 側タイルが表示されること)。次は L3 (ClaudeBrain 本丸)。

---

## 2026-07-25 — 外部潮流評価: "loop engineering" / "graph engineering" と灯台モデルの位置

流行中の 2 記事 (X 上の long-form) をユーザ依頼で評価。結論: **ロードマップ変更なし。L3 (ClaudeBrain) の優先度はむしろ裏付けられた**。判断根拠のみ記録する。

### 評価要旨

- **Loop engineering** = 検証ゲート付き反復 (Plan→Do→Verify→Iterate + stop condition + maker-checker)。2024–25 の agentic coding 実践の再パッケージで新規性は低いが、「cost per accepted result」「silent failure」「comprehension debt」の急所指摘は正しい
- **Graph engineering** = 真のデータ依存だけをエッジにして fan-out/layered fan-in。実体は MapReduce/DAG スケジューリングの再発明。「1,000 agents」は誇大 (例は並列バッチ処理)。持ち帰る価値は「"and then" を無条件に依存にするな」の一点のみ

### 灯台モデルとの関係 (対立ではなくレイヤー差)

両者とも **ループ内・単発・二値** の検証しか持たず、**ループ横断・時系列・分布** は原理的に見えない。具体的な盲点 → 灯台機能の対応:

| 流行側の盲点 | 灯台の対応機構 |
|---|---|
| ドリフト (毎回ゲート緑のまま pass 率が滑落) | AR シナリオ / per-agent baseline |
| retry-until-pass による flaky マスキング | ストリーム全試行観測 |
| silent node failure (件数チェック止まり) | silence-vs-blindness finding (06-15 §A) |
| false independence (共有リソースの隠れエッジ) | 実行中観測でのみ露見 |
| context collapse → 手配線バッチ要約 | レンズチェーンの動的版 ($Q[observe]) |

グラフは実行前に形が確定し走行中に変更不可。DCP は走っているストリームに割り込める (reroute / $Q 書換 / 遡及再観測)。**対抗馬ではなく、その上に被さる実行時観測・制御層**。

### 唯一の本物のリスク (時間軸)

両記事の世界観は「ワークフローは一発実行で完結」(ループはゲート通過で停止、グラフは consolidate で終わり)。業界が単発 DAG の手工芸で長く安定するなら常時流観測は早すぎる装備になる。ただし単発実行も CI 的に反復されれば実行履歴はストリームに戻る (test_result:v1 の agentId をループ/ノード ID と読み替えるだけで載る — ドメイン皮替えの範囲、[[project_domain_layering]] と同型)。

### 判断

- 方向転換なし。流行は「大量並列ノード + 弱い検証 + 沈黙する失敗」という観測需要を増やす側で、L3 の動機を強化する
- 将来 L3 設計時の含意 1 つ: ClaudeBrain のデモシナリオは「エージェント」を「並列ループ/グラフノード」と読み替えても成立するよう、agentId の意味論をドメイン層に閉じたままにする (既存方針の再確認、コア変更不要)

---

## 2026-07-25 — L2 残課題クリア (ブラウザ実地確認) + 新 finding: 粗窓 dip タイルの遅延発火

`npm run dev` → 実ブラウザ + SSE 生キャプチャで RC を実走。**L2 の残課題 (UI 実地確認) は解消**。同時に机上では見えなかった問題を 1 件発見した。

### 確認できたこと (L2 の主張は live で成立)

RC 実走 (baseline 50 ev/s、5s lead-in → 2s burst → 回復) の decisions チャネル実測:

1. `rerouteSchema` — burst 中に発火 (`agent-C pass rate 56.8% < threshold 85.2% for 2 ticks`)
2. `replayRequest` — 回復ティックで発火。`params: {window_ms:1000, fromTs, toTs}` で**区間指定が実際に載っている** (L2-2 の配線が live で動作)
3. `replay_snapshot` — 細窓再観測が `dip` タイルを返す: **mean 0.653 vs baseline 0.894、2.48σ、count 36**

静的配信 (`/`, `/app.js`) と `replay_snapshot` → `renderReplayTiles` の分岐も実配信で確認。粗/細 2 カラムは両方描画される。

### 新 finding: 粗窓の dip タイルが 24–38 秒遅れて発火し、閾値付近で明滅する

burst 進行中 (agent-C 56.8%) の粗窓タイルは `[baseline]` のみ = **RC の前提「粗窓では見えない」は成立**。ところが agent-C が 97% に回復した**後**、burst から 24–38 秒遅れて粗窓側に `dip 2.0–2.3σ` が出続ける。タイルが指す窓は burst 時刻 (`t=23:11:40`) で、対象は正しい。

- 遅延の機序: 静穏窓が蓄積すると観測窓集合の **σ が縮む** → 過去の burst 窓が事後的に閾値を越え直す。粗窓の dip 判定は "now" にアンカーされていない
- 明滅: 2.0σ 境界上を往復 (2.03 → 出る / 1.9x → 消える) するため、タイルが点いたり消えたりする
- **実体の乖離が本質**: 粗窓の dip は `mean 0.895 vs baseline 0.920` = 実差 **0.025** (count 342)。細窓 replay は `0.653 vs 0.894` = 実差 **0.24** (count 36)。**約 10 倍違う効果量が、どちらも「2σ 台の dip」として同じ見た目のタイルになる**

→ z 正規化のみで effect size を持たないタイルは、希釈された残響と本物のバーストを等価に見せる。「世界が変わった vs 観測を変えた」を分離する UI の主張が、ここで濁る。

**対策候補** (⚠ 以下 3 案は 2026-07-25 の設計調査で **棄却**。下の「§参照レンズ設計」を正とする):
- ~~タイルに effect size を magnitude と併記し、σ だけで序列を作らない~~ → 併記ではなく**分母そのものが誤り**だった
- ~~dip 判定に「窓の鮮度」条件を入れる~~ → 鮮度は症状。原因は参照集合が未宣言なこと
- ~~閾値付近の明滅はヒステリシス (出す 2.0σ / 消す 1.7σ) で抑える~~ → 対症療法。再現性を回復しない

### 既存の記述との不一致 (要修正の可能性)

L4 の動機として記録していた「本番配線の混合バッファでは agent-C バーストが `(3×0.92+0.20)/4 ≈ 0.74` に薄まり **z ≈ −1.7 で 2.0σ に届かず、live の replay タイルに dip が出ない**」は、**今回の実走では再現しなかった** — 細窓 replay の dip は 2.48σ で出た (mean 0.653 は予測 0.74 より低い)。

- 希釈そのものは確認済み (0.20 → 粗窓 0.895 / 細窓 0.653)。**機序の記述は正しい**
- 誤っていたのは結論部分: 「閾値に届かない」ではなく **「閾値をまたぐ縁にいて、run 次第で出たり出なかったりする」** が実態
- 断続的な検出は、一貫して出ないことより**悪い**性質 (再現しないバグとして扱われる)。したがって L4 `group_by: ["agentId"]` の動機は弱まるどころか強化される
- Cairn 訂正投稿済み (2026-07-25): 新 `f31c43fe-f252-4697-94cd-e5b26bb5aa94` が旧 `0ea8f897-6ed6-4a4d-81c5-34417b7836b6` を supersede。旧レコードは残存 (Cairn に更新/削除コマンドは無く post のみ)。訂正版は上記 3 点 (境界上の断続検出 / effect size 欠落 / σ 収縮による事後発火) + 「per-source 注入テストでは検出できない」を英語で記載

### 副産物: 起動・実地検証をスキル化

`.claude/skills/run-lighthouse/SKILL.md` を新規作成。`npm run dev` → 静的配信スモーク →
SSE 両チャネルを background curl でキャプチャ → シナリオ発火 → node で解析、という今回の手順を収録。
併せて環境の落とし穴 (chromium-cli/Playwright ブラウザ未導入のため `npx playwright` は失敗する。
実ブラウザは `Start-Process`) と、§上記の既知ノイズ (粗窓 dip の遅延発火・細窓 dip の run 依存) を
「バグと間違えるな」として明記。
---

## 2026-07-25 — 参照レンズ設計 (L4 前段。コード調査済み・未実装)

上記 finding (粗窓 dip の遅延発火 / effect size 欠落 / 細窓 dip が閾値の縁) への設計解。
**3 つの症状は 1 つの原因**に帰着する、というのが本節の主張。方針として「純粋概念を優先し、
概念としての例外措置を避ける」(user 指示) を採る。

### 原因: 参照集合が $Q に宣言されていない (隠れレンズ)

`window` / `group_by` / `decay` は `$Q[observe]` で明示されているのに、**baseline と σ を推定する
参照窓の集合だけが SnapshotCurator の内部で勝手に育っている**。curator は宣言されていない
2 本目のレンズを暗黙に適用していた。結果:

- **再現不能**: 同じセグメントを同じ `$Q` で replay しても、参照集合が違えば違うタイルが出る。
  Step 2 の「注入真値と照合する」という replay 正当性検証の根幹が崩れる
- **中心主張の自壊**: σ 収縮による事後発火は「世界は変わっていないのに、観測 (蓄積された参照集合) が
  変わったせいでタイルが出た」現象。灯台が分離すると謳っている当のものを、検出器自身が混同している

### 概念: 検出は単項ではなく二項演算

> **タイルは窓の属性ではなく、2 つのレンズ出力の間の関係である。**

基準を計算する行為は保持データを集計する行為そのもの = **それ自体がレンズ適用**。したがって
参照は「設定値」ではなく**観測と同じ型のレンズ出力**であり、新概念は 1 つも要らない。

```
検出 = (観測レンズ出力, 参照レンズ出力, 比較演算子)
```

- レンズは単項 (`segment → observation`)、検出は二項 (`observation × observation → tiles`)。
  比較を lens chain の 1 段に押し込むのは無理筋なので、2 概念に分けて保つ方が正直
- **「世界が変わった vs 観測を変えた」が演算として判定可能になる**: 参照を固定してタイルが変われば
  世界が変わった。参照を変えてタイルが変わったなら観測を変えた。現状は参照が勝手に漂うので原理的に区別できない

### 調査結果 1: `count` は全経路にある。無いのは**分散**

- [`lens.ts:41-51`](../server/src/lens.ts) `WindowStat = {windowStart, windowEnd, count, mean, valid}`。
  `count` は `applyLens` の全経路で必ず設定される (テストヘルパも既定 10)。ここは問題なし
- **二次モーメントが無い** → 比較演算子が標準誤差を自力で導けない
- **前回案 (`σ_min = sqrt(p(1-p)/n)` の床) は棄却**。恣意的な clamp であるだけでなく、
  [`index.ts:59`](../server/src/index.ts) の値域は `pass=1 / flaky=0.5 / fail=0` の **{0, 0.5, 1} で
  ベルヌーイではない**ため、二項の式は単純に誤り。分布族を仮定した時点で負けている
- **正しい形**: `WindowStat` に二次モーメント (平方和) を持たせ、**分布族を仮定せず経験分散から SE を導く**。
  `applyLens` の flush に平方和を足すだけの純加算的変更。値が 0/1 のときは二項が**特殊ケースとして自動的に落ちてくる**

### 調査結果 2: 継ぎ目は 1 箇所。`compareLens` が参照レンズの原型だった

- 癒着は軽い。**すべて [`snapshot-curator.ts:172`](../server/src/snapshot-curator.ts) の
  `computeGlobalStats(windows)` 1 箇所**を通り、そこから spike/dip 判定 (184行)、`detectSteps` (209行)、
  `pickBaselineWindow` (239行) に配られる
- **自己参照を確認**: 各窓は自分自身を含む統計と比較されている。異常窓が自分の baseline を汚す
- **σ 収縮を確認**: `computeGlobalStats` の stdDev は窓平均の散らばりそのもので、何も下支えしていない
- **`CurationOptions.compareLens?: LensResult` が既に存在する** (130行)。2 本目の LensResult を受け取る
  型と配線は**すでにある**が、divergence 検出専用の特殊入力として使われているだけ。
  → これを**参照レンズそのものに昇格**させれば、divergence は「比較演算子の一種」に格下げされ、
  **特殊ケースが一般概念に吸収されて消える**。新概念の追加ではなく、既存の歪んだ概念の是正になる

### 調査結果 3: テスト被害は 124 件中 4 件

- curate に触るのは `snapshot-curator.test.ts` 18 件 + `e2e-verify.test.ts` 1 件 = 19 件
- そのうち**暗黙の参照集合そのものを固定しているのは 4 件**: `deepEqual(globalStats, {0,0,0})` (45行) /
  mean・stdDev 厳密値 (57-59行) / invalid 窓が統計から除外されること (77-78行) / e2e 1 件 (要精査)
- 残り 15 件は**形の検証** (spike が出る・gap 境界・step 検出・タイル上限・並び順) なので、
  同じ合成データで検出が成立する限り影響を受けない
- 77-78 行のテストは**例外措置を固定しているテスト**。SE ベースにすれば `valid` ゲート (L1-2) は
  不要になる (n=1 は SE が巨大で閾値に届きようがない) ため、「除外される」→「統計には入るが発火しない」に
  書き換わる。**例外が概念に吸収されて消える** = 抽象化が正しい方向を向いている兆候

### 追加で判明した実害: `maxTiles` 追い出し

[`snapshot-curator.ts:253-262`](../server/src/snapshot-curator.ts) はタイルを **z 降順にソートしてから
`maxTiles=12` で切り捨てる**。effect size 欠落は見た目の問題にとどまらず、**幻影タイルが本物のタイルを
追い出す**。今回の実走では上限未達だったが、シナリオが重なれば選抜が壊れる。

### 設計案 (実装単位、規模順)

1. **`WindowStat` に二次モーメント追加** — `applyLens` の flush に平方和。純加算、既存挙動不変
2. **`curate` を二項演算化** — `curate(observation, reference = observation)`。
   `computeGlobalStats` を「参照レンズ出力から基準統計を作る」関数に置き換え、比較演算子は
   両出力の `count` と分散から SE を導く。`compareLens` は参照レンズに統合
3. **`valid` ゲートの撤去** — SE が役割を吸収。`MIN_VALID_COUNT` と関連分岐が消える
4. **テスト 4 件の書き換え** — 3 件は新しい基準統計の assert、1 件は「入るが発火しない」へ
5. **live 配線で参照を明示** — `index.ts` / `dashboard.ts` が参照レンズを宣言して渡す。
   ここで初めて live タイルが再現可能になる

### 判断が要る点 (1 つだけ)

参照レンズを**必須にするか、省略時 self にするか**。純粋主義なら必須。
**推奨は `curate(observation, reference = observation)` = シグネチャに明示した上での自己参照デフォルト**。
理由: 「自分自身と比べる」も宣言として正当な参照であり、問題は**ヘルパ関数の中に隠れていたこと**だった。
これなら移行は完全に加算的で 19 件は通ったまま、live 側で明示的な参照を渡せばそこから再現可能になる。

### 順序への影響

**比較演算子 (本節) を先、`group_by` (L4) を後**。理由は、比較演算子の SE 導出は「窓が単一分布からの標本」を
前提にし、4 エージェント混合は過分散でこの前提を破るため — つまり `group_by` は精度改善のオプションではなく
**比較演算子を正直にするための前提条件**として概念から導出される (従来は「実測でこう薄まったから」という
経験的主張だった)。逆順にすると比較器を直した時点で group_by 側の較正をやり直すことになる。

## 2026-07-25 — 参照レンズ設計 実装完了

上記設計の実装単位 1-5 をすべて実装。判断点は推奨どおり `curate(observation, reference = observation)` を採用。

### 変更点

- **`lens.ts`**: `WindowStat` に `sumSq` (窓内の二乗和) を追加。`applyLens` の flush で純加算するだけ
  (既存フィールドは無変更)。分布族を仮定しない経験分散の元になる
- **`snapshot-curator.ts`**: `curate(result)` → `curate(observation, reference = observation)` に変更。
  - `computeGlobalStats` (窓平均の散らばり) を `poolStats` (全事象を count 重み付けでプールし
    Bessel 補正分散を出す関数) に置換。`CurationOptions.compareLens` は削除、`reference` 引数に統合
  - spike/dip の SE は **参照分散のみ**から導く: `se = sqrt(var_ref × (1/n_w + 1/n_ref))`。
    帰無仮説が「この窓の事象は参照母集団から引かれた」である以上、物差しは参照側にある。
    (初版は Welch 型で観測窓自身の分散を使っていた。**バグ。下の「自己レビュー」節を参照**)
  - divergence は `reference !== observation` (オブジェクト同一性) の時だけ走る比較演算子の一種に格下げ
- **`index.ts`**: RC の `replayRequest` 実行時、参照レンズを明示的に宣言。
  `fromTs/toTs` で指定された区間と**同じ長さの直前区間**を同じ window_ms で replay し、それを reference として渡す。
  境界指定 replay の入力 (fromTs/toTs) だけから決定的に導出されるため、蓄積で漂わない
- ライブ coarse view (`dashboard.ts`) は自己参照のまま (意図的、判断点の推奨どおり)

### テスト

124→132件。書き換え 2 件 (mean/stdDev 厳密値・低カウント外れ窓の扱い)、新規 8 件
(固定参照で z が漂わない / 自己参照デフォルト同値性 / 比較器健全性 3 件 / 盲目検出 3 件)。他 122 件は無変更で通過。

---

## 2026-07-25 — 自己レビューで実装バグ 2 件を検出・修正

「実装が済んだ、チェックしろ」を受けた自己レビュー。**上の初版実装には重大バグが 2 件あった**。
初版の実地確認で replay tile が dip ではなく spike になった件を、SKILL.md の「既知のノイズ (混合ソース希釈)」
として片付けたが、**これは誤った帰属だった**。実際には自分が入れたバグの直接の結果だった。
症状を既知の弱点に帰属させる前に数値で再現させること — この教訓自体が本節の主眼。

### バグ 1: 観測窓自身の分散を分母に使った (Welch 型の誤用)

**症状**: 健全な全 pass 窓が、窓サイズによらず**常に z=6.57 の "spike"** として発火する。

**機序**: 有界データ (pass率) では窓内分散は平均の関数。平均が極端な窓は必然的に分散がほぼ 0 になる。
つまり `var_w` は分子 `|mean_w − mean_ref|` と機械的に逆相関し、**分子が最大のとき分母が最小になる**。
サンプリングノイズではなく、式に埋め込まれた定数の誤警報。L1 が防いでいた
「count=1 は std=0 なので "完璧に安定した spike" に見える」という病理を、連続形で再導入していた。

**なぜ概念的にも誤りか**: 帰無仮説は「この窓の事象は参照母集団から引かれたか」である。
物差しは参照側にしかない。観測自身の散らばりで観測を裁くのは**残留した自己参照** — 参照レンズ設計が
消そうとしていたもの、そのもの。Welch は「独立した 2 母集団は違うか」を問う道具で、ここでの問いではない。

**修正**: `se = sqrt(var_ref × (1/n_w + 1/n_ref))`。分散は 1 つだけになり式も短くなった。
`1/n_ref` 項が参照自身の推定不確かさを担うので、短い参照は自動的に誤差棒が広がる。

**実測 (健全ストリーム 300 窓 / RC バースト 20 試行)**:

| | 初版 (Welch) | 修正後 |
|---|---|---|
| 健全窓の誤検出 | 31 | 10 (2σ 閾値の理論値 ~5% 相当。較正が取れている) |
| バースト時の偽 spike | 30 | **0** |
| バースト検出 (dip) | 20/20 | 20/20 |

**実走再確認**: RC で `dip 3.04σ / 3.30σ` がバースト位置に出て、偽 spike は消えた。
初版実走の `spike 3.31σ` は本バグだった。

### バグ 2: 参照が使えない時、盲目が沈黙と区別できない

**症状**: 参照区間が retention から外れて空になると、`poolStats` が分散 `NaN` → 全比較が false →
**タイル 0 件**。健全な静穏と全く同じ出力になる。しかも `globalStats.mean` は 0 を報告する (嘘)。

本プロジェクトが明示的に追跡している silence-vs-blindness (commit 47df2f8) そのものの失敗形態が、
検出器の内部に発生していた。

**修正**: `SnapshotPackage.referenceUsable: boolean` を追加。
`index.ts` は false の時に警告を出す。gap タイルは構造的なので抑制対象外。

### 低カウント窓の扱い — 設計節の主張を訂正

設計節は「SE が `valid`/`MIN_VALID_COUNT` の役割を完全に吸収する」と書いたが、**これは言い過ぎだった**。
正確には:

- **分散インフレの病理は消える** — これは SE が真に解決した部分
- **小標本での正規近似の妥当性は消えない**。修正後の式でも n=1 の全 fail 窓は z=−4.43 で発火する。
  z 検定は正規近似の道具であり、有効な標本数の下限を持つのは**式の定義域**であって例外措置ではない

よって `MIN_VALID_COUNT` を「比較器の定義域」として復活させた。ただし**旧設計とは適用箇所が違う**:
旧: 窓を**母集団から除外**しつつ発火も抑制 (二役)。新: 窓は参照に事象を寄与し続け、**採点だけができない** (一役)。
均一に適用される前提条件であって、特定ケースの迂回ではない。

### 残課題

- 定量確認: 粗窓 dip の遅延発火が実際に解消したか、before/after で σ の時間発展を比較する
- `pickBaselineWindow` はまだ `w.valid` を見ている (baseline タイル選出のみ。採点には影響しない)
- L4 group_by: 順序どおり次段。比較演算子が単一分布前提を置くようになった今、
  4 エージェント混合の過分散はこの前提を破る、という動機は変わらず有効。
  なお修正後の実走でもバースト窓の実測は 0.79〜0.80 (agent-C 単独なら 0.20) で、
  **希釈の実測値そのものは設計節の主張どおり**

---

## 2026-07-28 — L3 前段: §12 A/B 実験の fixture 第一弾 (RC)

L3 (ClaudeBrain 本丸) は L1/L2 完了で前提が揃った。本丸着手前に §12 の設計仮説
(「LLM は数値列よりタイル陳列の方が判断が良い」) 自体を検証する A/B 実験が前段として要る
(PILOT_DATA.md §12 "Validation hook")。焦らず着手できる小粒から: 実験の**土台**
(fixture 生成) をまず作った。LLM 呼び出し自体はまだ配線していない。

**設計**: 同一の `LensResult` を素通しし、提示形式だけを変数にする。データが変数に
混ざると比較が汚れるため。`server/src/ab-fixture.ts` の `buildRcFixture()`:
- `raw`: fine window の `mean` を裸の配列で
- `curated`: 同じ `fineResult` を `SnapshotCurator.curate(fine, reference)` に通した
  タイル陳列。reference は `index.ts` の実配線と同じ「区間と同じ長さの直前区間」
- `groundTruth`: 注入した burst の位置・pass rate (答え合わせ用)

**踏んだ罠**: 初版は注入イベントの value を定数 0.95 にしていた
(`e2e-verify.test.ts` の直接注入テストを流用した名残)。実ドメイン (pass=1/fail=0 の
二値) では分散が生じるが、定数だと分散が機械的に 0 になり、参照レンズ側の
`comparisonSE` が `se=0` を返して比較器全体がスキップされる
(`referenceUsable: true` なのにタイルが 1 件も出ない — 07-25 の「盲目」とは別の、
fixture 側の作り方に起因する沈黙)。ベルヌーイ抽出 (`Math.random() < passRate`) に
直して解消。テスト `ab-fixture.test.ts` を8連続実行しフレーキーでないことを確認。

**残課題**: AR/CG の fixture (per-agent / per-domain、RC より一段複雑)。
実際に Claude へ2表現を渡して決定精度を比較するハーネス本体 (API 配線・スコアリング)。
どちらも次の一手だが、今回はここで止める。

---

## 2026-07-28 — L3 前段: §12 A/B 実験の fixture 第二弾 (AR) + docstring 修正

続き。`buildArFixture()` を追加。`mock-stream-generator.ts` の `runAR` と同じ真値
(10s baseline P(pass)=0.95 → 30s regression P(pass)=0.70) を RC と同じ直接注入方式で
再現。RC と違い、AR の相対シフト (0.95→0.70, 約26%) はキュレータの `stepThreshold`
既定値 30% を下回るため `step_down` タイルは出ない設計上の想定内 — 個々の窓の
z-score 検定 (相対シフトの床を持たない) 側が `dip` タイルとして拾う。これ自体
「持続的だが緩やかな回帰は、1枚の `step_down` ではなく `dip` の連番として読める」
という、A/B ハーネスに渡す価値のある観察としてコード注釈に残した。

**CG は対象外にした**: coverage gap は数値ストリームの平均シフトではなく
「どの area bit が触られていないか」という穴の問題で、spike/dip/step の語彙に乗らない。
無理に同じ fixture 型に押し込めず、別の提示設計が要るとして先送り。

**ついで**: `snapshot-curator.ts` の `curate()` docstring が 07-25 の比較器バグ修正前
(Welch型・両分散を使う版) の説明のまま残っていた。実装は直っていたがコメントが
追随していなかった — 修正した参照レンズのみの式と `MIN_VALID_COUNT` の一役化を
反映する記述に直した。

テスト 133→134。`ab-fixture.test.ts` を8連続実行、AR/RC 双方フレーキーなし。

**残課題** (変わらず): CG の提示設計。実際に Claude へ渡すハーネス本体 (API 配線・スコアリング)。

---

## 2026-07-28 — fixture チェック: 交絡 1 件を検出・修正 (情報パリティ)

上記 fixture 第一・二弾のレビュー。統計マージンは検算で健全 (RC バースト窓 z≈−37、
AR 回帰窓 z≈−22 — 8連続パスは偶然ではない)。ただし**実験設計に交絡が 1 件**あった。

### 交絡: raw アームに参照区間が無かった

モジュール docstring は「提示形式だけが変数」と宣言していたが、実装は
curated アームだけが参照区間の情報 (globalStats + 参照に対する採点) を持ち、
**raw アームは観測窓の mean 配列のみ** (タイムスタンプも無し) だった。
これでは curated が勝っても「タイル提示が良いから」か「参照データを持っていたから」か
分離できない — §12 が検証したいのは前者。

**修正**: `raw: { window_ms, observation: {windowStarts, means}, reference: {windowStarts, means} }`。
両アームが同じ 2 つのレンズ出力を見る。「検出は二項演算」(07-25) が raw 形にもそのまま写る
— 数列で渡すときも観測と参照のペアで渡すのが概念的に一貫する。
windowStarts は位置回答 (「異常は t≈X」) を groundTruth と照合するのに必須。

### 小修正 3 件

- `emit()` が JSDoc とビルダーの間に挿入され、RC fixture の doc が `emit` に付いていた
- `buildArFixture` の doc が「deterministic」と主張するが `Math.random()` 無シードだった。
  mulberry32 シード付き PRNG に変更、`buildXxFixture(seed = 1)`。A/B 試行の監査可能性
  (「seed 7 でこのデータ・この判断」) にも必要。既定シードでテストは真に決定論化
- 「mirrors runAR timeline exactly」→ 参照区間は generator の 10s ではなく 15s (5s 窓 3 枚分)。
  レンズの都合で選んだと明記

### テスト強化

テスト名「同一データの 2 表現」が実際には未検証だった → `assertArmsConsistent`
(全 dip/spike タイルが raw 側に同一 windowStart・同一 mean で存在) を両シナリオに追加。
シード決定性テストも追加 (同シード同一 / 異シード相違)。テスト 134→135。
シード 1–50 の掃引で RC/AR とも 50/50 通過 (フレーキー性はマージン由来でなく構造的に排除)。

---

## 2026-07-28 — L3-1 前進: A/B ハーネス dry-run 層 + 陰性対照 + 小粒回収

「着実なルート」指示。API もコストも要らない部分を全て先行実装した。

### `ab-harness.ts` — dry-run 層 (API 接触ゼロ)

- **`askFn: (prompt) => Promise<string>` 注入シーム**: 実 LLM との接触はこの 1 関数のみ。
  API 配線は後日「注入」であって「改修」ではない — BrainAdapter (`BRAIN_MODE=claude`) と
  同じ差し替え哲学
- `renderPrompt(fx, arm)`: 前文 (task framing) は両アーム逐語一致、本文だけが変わる。
  raw = 観測/参照の数列そのまま、curated = curator のダイジェスト (globalStats + タイル +
  `referenceUsable: false` 時の盲目警告)。groundTruth 語彙の漏洩はテストで検査
- `parseAnswer`: 裸 JSON / fence 付き / 散文埋め込みを許容。verdict 欠落・不正は null
- `scoreAnswer`: verdict 正誤 + 位置正誤 (±1 窓の猶予 — 窓は先頭イベント整列のため)。
  **パース不能な応答は verdictCorrect=false** — 読めない判断は誤判断であってスキップではない
- `runTrial`: prompt/応答/解釈/採点を全部 `TrialRecord` に保存 (実験の生データ)

### `buildQuietFixture()` — 陰性対照

設計中に気づいた穴: 異常あり fixture (RC/AR) だけでは**「常に anomaly と答える」戦略が
満点を取る**。RC と同一ストリーム・同一レンズで何も注入しない QUIET を追加。
`ABFixture.injectedAnomaly: {startTs, endTs} | null` を機械採点用の一級フィールドに昇格
(groundTruth は人間向け詳細として併存)。`seed` も fixture に記録 (監査可能性)。
QUIET の curated アームに時折出る ~2σ タイルは 5% 床由来で現実的 — タイル有無は検出器の
出力、verdict は Brain の判断、を分けて測るのが実験の主旨。

### 小粒回収

- `pickBaselineWindow` の `w.valid`: **確認して閉じた**。`valid ≡ count >= MIN_VALID_COUNT`
  (lens.ts の定義) なので比較器の前提条件と完全同値。変更不要、同値性をコメント化
- `lens.ts` のコメント 2 箇所が 07-25 修正前の記述のまま残っていた (MIN_VALID_COUNT の
  「baseline stats から除外」= 旧二役、`sumSq` の「窓自身の SE 用」= Welch 型時代) → 実装に追随

### テスト 135→140

harness 4 suite (prompt 対称性+非漏洩 / パース / 採点 / stub での full trial) + QUIET 1 本。
**フレーク観測 1 件 (既存)**: `E2E AR — agent regression` (実タイマー版) が全体実行 ~10 回中
1 回失敗。機構: `sleep(120)×12` warmup が CPU 競合で伸びると回帰フェーズに食い込み、
学習ベースラインが汚染される。仮想クロック版 AR が論理を決定論的に担保済みなので、
実時間版は §10 実測専用として現状維持。テストファイル増による並列負荷で顕在化しやすく
なった可能性あり — 頻発するなら concurrency 分離を検討

### 残課題 (更新)

- A/B ハーネス**実行**: モデル選定・試行数 N・鍵/予算はユーザ判断待ち。dry-run 層は完成
- CG アーム: L4 group_by 後 (per-area 集計 = group_by(area) そのもの)

---

## 2026-07-28 — 粗窓 dip 遅延発火の定量確認 (07-25 残課題クリア)

07-25 の残課題「z(t) 軌跡の before/after を数値で出す」を実施。API 不要、production コード
(`RetentionBuffer`/`SnapshotCurator`) を直接使う一回限りの分析スクリプト (`server/` 直下に
一時作成 → 実行後削除、コミットせず) で検証。新規の恒久実装は追加していない。

**設計**: 同一の増加する観測窓集合 (burst 窓 1 個 + 静穏窓を 1 個ずつ 60 個まで追加) に対して、
参照 (reference) だけを可変にした 2 通りで z を計算:
- **旧式 (自己参照)**: `z = (targetWindow.mean - mean(windowMeans)) / stdDev(windowMeans)` —
  プール全体 (burst 窓含む) の窓平均の散らばりを分母に使う。`dashboard.ts` のライブ粗窓ビュー
  (`curator.curate(coarseView.current())`, 引数 1 個 = 自己参照) は今もこの挙動
- **新式 (固定参照)**: `curator.curate(observation, fixedReference)` — 参照は burst 前区間を
  一度だけ replay して固定。以後 N が増えても再計算しない (`index.ts` の explicit replay 経路と同じ)

**結果 (seed=42, baseline P=0.95, burst 1 窓 P=0.905, 窓ごと 100 events)**:

| N (burst後の静穏窓数) | z_old (自己参照) | z_new (固定参照) |
|---|---|---|
| 0  | -1.841 (非発火) | -2.123 (発火) |
| 4  | -2.100 (発火)   | -2.123 |
| 20 | -2.146          | -2.123 |
| 60 | -2.254          | -2.123 |

`z_old` は burst 直後は閾値 (2σ) 未満で見えず、静穏窓が 4 個 (このパラメータでは数秒〜十数秒相当)
蓄積した時点で閾値を超えて発火し、以後も 2.09〜2.35 の間で明滅し続ける — 07-25 に実ブラウザで
観測した「24-38秒遅れて発火・閾値付近で明滅」の再現。`z_new` は全区間で完全に一定 (-2.123) —
固定参照は burst 窓自身にも経過時間にも依存しないので、構造的に drift も flicker も起こり得ない。

**100 seed sweep** (`passRate=0.90`, N=0→60 で |z| が増加したか): 80/100 seed で `|z_old|` が
増加 — 単一 run の偶然ではなく、自己参照設計に内在する方向性であることを確認。

**結論**: 参照レンズ設計 (07-25) は「粗窓 dip 遅延発火」を **replay/explicit-reference 経路では
構造的に排除**する。ライブ粗窓ビュー (`dashboard.ts`) は意図的に自己参照のままなので同じ経路では
発生し得る — これは既知・許容 (判断点の推奨どおり、ROADMAP 07-25 参照)。「新式が下界
`sqrt(var_ref/n_ref)` に収束する」という 07-25 時点の予想は的中: 新式はそもそも n (経過時間) の
関数ではなく定数関数なので、収束を待つまでもなく最初から下界そのものだった。

### 残課題 (更新)

- A/B ハーネス**実行**: モデル選定・試行数 N・鍵/予算はユーザ判断待ち。dry-run 層は完成
- CG アーム: L4 group_by 後 (per-area 集計 = group_by(area) そのもの)

---

## 2026-07-28 — A/B ハーネス実行 第一弾 (haiku, n=26, judge設計探索)

外部 API キー無しで実行: Agent ツールを `model: "haiku"` で都度呼び、`ab-harness.ts` の
`renderPrompt(fx, arm)` をそのままプロンプトとして渡す方式（`askFn` を Anthropic SDK で
実装する前段の探索）。judge (合理性チェック) 設計は「先に haiku の実挙動を見てから決める」
方針 (user 指示) のもと、まずは私 (Sonnet) が groundTruth を見ながら人手で判定。

**ラウンド1 (n=6)**: RC/AR/QUIET × raw/curated 各1件 (seed=1)。RC・AR は効果量が極端
(35σ, 21〜23σ) で両アームとも即正解 — 天井効果。QUIET のみ差が出た: raw が誤検知、curated
は正しく「none」。

**ラウンド2 (n=20)**: 天井効果の出ない RC/AR を切り捨て、差が出た QUIET (seed=2〜11、10通り)
に全振り。

| | raw 誤検知率 | curated 誤検知率 |
|---|---|---|
| ラウンド2単独 (n=10/アーム) | 4/10 = 40% | 2/10 = 20% |
| 累計 (ラウンド1のseed=1込み, n=11/アーム) | 5/11 ≈ 45% | 2/11 ≈ 18% |

**誤検知の内訳が2種類に分離できた**:
- seed10, seed11: raw・curated **両方**誤検知。`SnapshotCurator` 自身が実際に 2.2σ/2.4σ の
  `dip` タイルを生成していたケース (`buildQuietFixture` docstring が「稀に出る」と書いていた
  floor が実際に踏まれた)。curated がタイルとして提示した情報を haiku が忠実に読んだ結果なので、
  **presentation の失敗ではなく検出器 (curator) 側の閾値較正の誤検知**
- seed7, seed8: **raw のみ**誤検知。curator は同じ元データを「タイル無し (baseline のみ)」=
  2σ未満と判定していたが、生の数値羅列を見た haiku は根拠なく anomaly と判定。
  **これが presentation 由来の差** — §12 仮説 (curated が判断を助ける) を裏付ける方向

→ raw/curated の差の半分は presentation 効果、残り半分は両アーム共通の検出器較正の限界。

**副次観察 (今回は対応しない、設計候補として記録のみ)**: 窓ごとの z 閾値 2σ を ~10窓の
fixture にそのまま適用すると、multiple comparisons で fixture 単位の誤検知率は
1-(0.95)^10 ≈ 40% 近くまで理論上積み上がる。curated 側の実測 20% はそれより低いが同じ
オーダー — `spikeZThreshold` に窓数ベースの補正を入れる余地が L4/L5 の設計候補としてある。

**フォーマット**: 26 trial 通して JSON 違反ゼロ。

**トークン消費**: ラウンド1 ~182,000 + ラウンド2 ~611,000 ≈ 793,000 tokens (26 trial、
Agent ツール経由、1 trial 平均 ~30,000 — プロンプト自体は1〜2KBだが Agent 足場の固定費が
支配的。本格的な N を回すなら Anthropic SDK 直叩きの `askFn` の方が token 効率が良い、
という運用知見も確認できた)

**judge 設計への含意**: 理由文を出させていない (プロンプトで JSON 以外禁止) ため、
judge は verdict と data の整合性しか見られない。今回わかったのは、その整合性チェックを
「curator がタイルを出したか否か」で二分できること — raw だけの誤検知 (presentation由来)
と両アーム共通の誤検知 (detector由来) を区別する軸として使える

### 残課題 (更新)

- 理由フィールドを haiku に出させて再度小ロットを回すか、このまま raw の誤検知率を
  他シナリオ (境界線上のAR等) でも見るか — 次の判断点
- 本格的な N (統計的有意性を狙う規模) は Anthropic SDK 直叩き `askFn` の実装が前提
- CG アーム: L4 group_by 後 (per-area 集計 = group_by(area) そのもの)

---

## 2026-07-28 — A/B ハーネス実行 第二弾 (QUIET n=20 追加、統計的有意性に到達)

「n の数は負担にならない、数値を信頼する方向で」(user指示、理由文によるjudgeより客観指標を優先)
の方針のもと、QUIET を seed=12〜31 の20件追加 (raw/curated 各20 = 40 trial)。各 anomaly 回答の
`locationTs` を fixture の実データ (どの窓が最小値か・どの窓に curator の実タイルがあるか) と
突き合わせて seed 帰属を検証してから集計 (取り違えを防ぐため位置だけでなく内容でも二重チェック)。

**全ラウンド合算 (seed=1,2〜31 の計n=31、raw/curated 各31)**:

| | raw 誤検知率 | curated 誤検知率 |
|---|---|---|
| 累計 (n=31/アーム) | 17/31 ≈ 54.8% | 9/31 ≈ 29.0% |

**curated の誤検知は curator 自身のタイル生成と完全一致 (n=31, 例外ゼロ)**: curator が実際に
dip/spike タイルを出した seed は9件 (10,11,15,19,20,22,29,30,31) — curated が誤検知した seed も
**寸分違わずこの9件**。curated アームは「curator がタイルを出した時だけ anomaly と答える」を
31件通して一度も破らなかった。presentation は detector の判断にノイズを足しても消してもいない
——忠実な中継のみ。

**raw の誤検知の内訳**:
- detector 一致 (8/9): タイルが出た9件中8件で raw も独立に anomaly と判定
  (例外1件: seed15 は curator が 2.1σ タイルを出し curated がそれに従って誤検知、
  raw だけが "none" と正しく棄却した。curated が単独で外した唯一のケース)
- **detector の裏付け無し (9/22)**: curator が「タイル無し」と判定した22件中9件で raw だけが
  根拠なく anomaly と誤答

**統計的有意性**: seed 単位でペア比較 (raw だけ誤検知=9件、curated だけ誤検知=1件の
discordant pair に対する exact McNemar/符号検定) — **p ≈ 0.021、α=0.05 で有意**。
paired design (同じ seed を両アームに提示) を使うことで、当初 unpaired 前提で見積もっていた
必要 n (≈43/アーム) より少ない実効 n で有意水準に到達した。

**トークン消費 (3ラウンド累計)**: ラウンド1(6) + ラウンド2(20) + ラウンド3(40) = 66 trial、
約 2,019,000 tokens。

**⚠ 当初の結論は下方修正済み**: この時点では「§12 仮説 (curated presentation が判断精度を
上げる) が統計的に支持された」と書いたが、**この主張は成立しない**。集計値は正しいが、
部分集合に分解すると優位性の出どころが presentation ではないことがわかる。
次節「再分析」を正とする。

---

## 2026-07-28 — 上記 A/B 結果の再分析 (Opus 5 レビュー)。結論を下方修正

66 trial の生出力を seed へ再帰属させ、独立に数え直した上でのレビュー。
**集計値は全て正しい** (raw 17/31、curated 9/31、discordant 9:1、exact two-sided
p = 22/1024 ≈ 0.0215)。修正が要るのは解釈の側。

### 訂正 1: seed15 の記述が反転していた

前節の「seed15 は raw が見逃し curated だけ正しく検知」は誤り。seed15 は
`injectedAnomaly: null` で検知すべきものが存在しない。実際は **curator が 2.1σ タイルを出し、
curated がそれに従って誤検知、raw だけが "none" と正しく棄却**。カウント (curated-only-wrong=1)
は正しかったが方向の記述が逆だった。本文修正済み。

### 訂正 2 (本丸): この実験は presentation を測っていない

**部分集合に分解すると優位性の出どころが見える**:

| | tile 無し (22件) | tile 有り (9件) |
|---|---|---|
| raw 誤検知 | 9/22 (41%) | 8/9 (89%) |
| curated 誤検知 | **0/22 (0%)** | **9/9 (100%)** |

curated は tile 有り側で raw より**悪い**。優位性は全て tile 無しの22件から来ている。
そしてその22件で curated に渡るプロンプトは `[baseline] Representative quiet window` の
一行だけ — **異常を示唆する材料がゼロの入力に "none" と答えた**、というのが 0/22 の中身。

curated アームで測っているのは LLM の判断力ではない。curator の 2σ 閾値判定を LLM が
転記しているだけで、タイル生成との完全一致 (9/9、例外ゼロ) がそれを裏付ける。
実際に示されたのは:

> **curator の閾値判定は、haiku が10個の数字を目算するより校正が良い**

これは presentation の効果ではなく、**判断を事前計算して手渡した**という事実の効果。
§12 が主張する「提示形式が判断を助ける」の検証にはなっていない。

### raw の失敗モードは極めて定型的 (機序が特定できた)

誤答17件の `locationTs` を全数確認した結果:

- **14件が観測区間の最小値の窓を正確に指している**
- 1件が最大値 (seed25、`spike` と回答)
- 1件が2番目に低い窓 (seed8)
- 1件が視認できる段差の始点 (seed7、`step_up`)

つまり raw は分散も参照区間の散らばりも使っていない。**「一番外れている値を指す」**
ヒューリスティックで動いている。ここから2つ出る:

1. **検証可能な予測**: 窓数を増やせば raw の誤検知率は単調に上がる。10窓の最小値の期待値は
   約 −1.54σ、50窓なら約 −2.25σ。窓数だけ変えた対照で確認できる
2. **RC/AR の「両アーム正解」の再解釈**: raw が正解したのは同じヒューリスティックが
   効果量の大きい場面でたまたま当たっただけ。「真陽性側では差が無い」のではなく
   **差の測定に失敗している**

### ground truth が二重になっている / curated には構造的上限がある

QUIET の 29% (9/31) が curator 自身の物差しで実際に 2σ 超の窓を含む。これは**注入真値では
偽陽性だが、観測データ上は本物の統計的逸脱**。3.4σ (seed22) を報告した検出器が壊れている
わけではない。

帰結: curator への忠実性が完璧である限り、**curated アームの上限は 22/31 = 71% に固定される**。
どんなに賢いモデルを入れてもこれを超えられない。超えるには**タイルを見た上で
「10窓中3本の 2.1〜2.8σ は multiple comparisons のノイズだ」と却下する**必要がある。
seed19 がまさにその形 (3タイル同時提示) で、haiku は却下せず anomaly と答えた。

### 統計上の但し書き

- **探索的であって確証的ではない**。ラウンド1 (n=6) を見てから QUIET に絞る判断をした
  (garden of forking paths)。p 値は記述統計として読むべきで、事前登録された検定ではない
- discordant がわずか10件。差 25.8pp に対し SE ≈ √10/31 ≈ 10.2pp、
  **95%CI ≈ [6pp, 46pp]** — 方向は支持されるが**大きさはほぼ推定できていない**
- 温度制御なし、同一 fixture の反復試行なし。「raw プロンプトが本質的に曖昧」なのか
  「モデルが確率的で raw が判断境界の近くにある」のかを分離できていない
- **外的妥当性の穴**: 1 trial 30k tokens のうち実タスクは 1KB 未満。**97% が Claude Code の
  足場** (システムプロンプト・ツール定義)。「有用な発見を報告する助手」として初期化された
  エージェントが "none" より "anomaly" に傾く可能性を排除できていない。実運用の
  ClaudeBrain とは全く違う文脈的プライミング

### L3 への含意 (最も重要)

snapshot package が判断を先取りしすぎると、**ClaudeBrain は RuleBrain の高価な写経**になる。
今回の haiku は完全にそれだった (9/9 一致、例外ゼロ)。

ClaudeBrain を作る意味があるとすれば、それは curator が出したタイルを**文脈で却下できる**
ことのはず。「この σ は窓数を考えれば有意でない」「この dip は前回の観測変更の副作用だ」——
RuleBrain に書けない判断。今回の実験はその能力を測っていないし、haiku は示さなかった。

### 収穫として残るもの

否定的な点が多いが、実験の価値は別のところに確実にある:

1. **curator の package 単位の誤警報率が 29% (9/31) という実測値**。理論値
   1-(1-0.0455)^10 ≈ 37% と同オーダー。これは実験の副産物ではなく、**ダッシュボードと
   Brain の判断に直接効いている出荷中の較正問題**。前節で「副次観察、今回は対応しない」と
   脚注に落としたが、**これが本命の発見**
2. raw の失敗モードの機序特定 (極値指し) — 検証可能な予測を伴う
3. 「LLM はタイルにノイズを足さない」という保証 (9/9)。ClaudeBrain 設計時の前提にできる
4. ハーネスが端から端まで動くことの実証 (66 trial、JSON 違反ゼロ)

---

## 2026-07-28 — 今後の対策 (候補整理。着手前の判断待ち)

上記再分析から導かれる打ち手を、**何を証明するか / コスト**で並べる。順序は推奨度。

### A. curator の窓数補正 (出荷中の欠陥。最優先)

**問題**: 窓ごとに独立して 2σ を適用しているため、package 単位の誤警報率が窓数と共に
積み上がる。10窓で理論 37%・実測 29%。50窓なら 90% 超。

**方針の論点**: user 指示「純粋概念を優先し、概念として例外措置は避ける」に照らすと、
窓数補正は**例外措置ではなくレンズ概念の内在的な帰結**として位置づけられる可能性が高い。
「N 窓を同時に見る」というレンズを選んだ以上、比較の多重性はそのレンズの性質であって、
後付けのパッチではない。この筋で入れられるなら概念的に自然。

**具体案** (いずれか、要判断):
- Šidák: `α' = 1-(1-α)^(1/N)`。family-wise 5% を保つと N=10 で **z ≈ 2.80** (現行 2.0)
- 閾値は動かさず、**タイルに「N窓中の1本」という文脈を明示**して判断は Brain に委ねる
  (検出器を保守的にせず、情報を足す方向。L3 の Brain が却下判断をする余地を残す)
- 両方 (閾値補正 + 文脈明示)

**トレードオフ**: 閾値を上げると真のバーストの見逃しが増える。RC の 35σ・AR の 21σ は
余裕で残るが、07-25 finding の「細窓 dip が閾値の縁」ケースは消える可能性がある。
**補正を入れる前後で RC/AR fixture の検出が保たれるか回帰テストが要る**。

### B. 上位モデルでの再測定 (ClaudeBrain の存在意義を直接測る)

**証明すること**: 強いモデルは curator のタイルを**却下できるか**。却下できるなら
ClaudeBrain には RuleBrain にない価値がある。できないなら L3 の前提が揺らぐ。

**設計**: tile 有りの 9 seed の curated プロンプトを Sonnet / Opus に投げ、
22/31 の天井を破るか (= タイルが出ているのに "none" と答えるか) を見る。
**9 trial × モデル数**で足りる — 天井を破る事例が1つでも出れば定性的に決着する。

user が既に述べた「上位モデルが判断をチェックし合理的でなければ次のモデルへ」構想と
そのまま噛み合う。ただし今回の知見により、**judge させるべきは verdict の正誤ではなく
「タイルを却下する理由を述べられるか」**に変わる。

### C. 窓数を変えた raw 対照 (予測の検証。安価)

10窓 / 30窓 / 50窓で raw の誤検知率を測る。上記予測「単調増加」の検証。
極値指しヒューリスティック説が正しいことの直接証拠になる。fixture 生成は既存コードで可能。

### D. 真陽性側の測定 (天井のない領域)

効果量を段階的に下げた RC/AR (例: 0.95→0.90、0.95→0.85) で false negative 側の差を見る。
raw が極値指しなら、**効果量が下がるほど raw は「たまたま当たる」を失う**はず。
A の閾値補正を入れると curated 側の見逃しも増えるので、**A の回帰テストと兼ねられる**。

### E. 理由フィールド (judge 設計の前提を変える)

現状 JSON のみを強制しているため推論過程が見えない。`"reason"` を足すと judge が
「タイルを読んだだけ」か「タイルを吟味した」かを区別できる。B と組み合わせると効果的。

### 実行基盤について

A・C・D は API 不要 (既存テスト内で完結)。B・E は LLM 呼び出しが要る。
現行の Agent ツール経由は 1 trial ≈ 30k tokens のうち実タスク 1KB 未満という効率の悪さに
加え、**Claude Code の足場が結果を汚染しうる**ことが今回判明した。B を本格的にやるなら
Anthropic SDK 直叩きの `askFn` 実装を先に済ませる方が、コストと妥当性の両面で良い。

---

## 2026-07-28 — 対策A 実装完了: curator の窓数補正 (Šidák)

`snapshot-curator.ts` に Šidák 補正を実装。設計判断は CLAUDE.md 標準方針
(「純粋概念を優先し、概念として例外措置は避ける」) に沿って自分で決めた:
**「N窓を同時に見る」というレンズを選んだ以上、比較の多重性はそのレンズの性質そのもの**
なので、閾値補正 (後付けパッチではなく内在的帰結) の方を選んだ。
「閾値は据え置いて文脈をタイルに足すだけ」案は却下——それは判定の空洞化を Brain に丸投げ
するだけで、curator 自身が較正済みの検出器であるという前提を崩す。

### 実装

- `spikeZThreshold` の意味を「窓ごとの閾値」から「**snapshot 全体 (family) の
  誤警報予算**」に再定義。ドキュメント (docstring) も合わせて更新
- `sidakCorrectedThreshold(baseZ, n)`: baseZ の両側 alpha を家族単位の目標とみなし、
  `alpha' = 1-(1-alpha)^(1/n)` で窓ごとの alpha に配分し直し、z に逆変換
- 逆変換に必要な正規分布の CDF / 分位点関数を追加 (`normalCdf` = Abramowitz-Stegun
  erf 近似、`normalQuantile` = Acklam の有理近似)。外部ライブラリ無し、純粋関数
- 補正は spike/dip の判定ゲートのみに適用。タイルの `magnitude` (報告される実際の σ) は
  非補正のまま — Brain には「本当の外れ具合」と「それがこの N でも有意と言えるか」を
  分離して渡す
- N = そのcurate()呼び出しで実際にスコアされた窓数 (`count >= MIN_VALID_COUNT`)。
  N<=1 は完全な no-op (数式が元の閾値にそのまま還元される)
- step検出・divergence検出は今回のスコープ外 (診断された問題は spike/dip の
  package単位誤警報率だったため、そこに絞った)

### 検証

**単体テスト5件追加** (`snapshot-curator.test.ts`、固定 reference に対し同一の
~2.2σ window を N=1/5/15 で比較): N=1 では発火 (無補正と一致)、N=5 と N=15 では
抑制。~10σ の本物の効果は N=30 でも発火を維持。N=1 での閾値境界 (2.05σ発火/1.95σ非発火)
も直接確認。テスト 140→145、全 green。

**回帰確認**: 既存140件 (RC/AR/CG/QUIET の実 fixture を含む) は無変更で全 green ——
天井効果の大きい RC (35σ)・AR (21〜23σ) はもとより余裕で補正後閾値を超える。

**本題の検証** (A/B ハーネスで使った同じ 31 seed の QUIET fixture に対し再実行):

| | package単位 誤警報率 |
|---|---|
| 補正前 (実測、A/B分析時) | 9/31 ≈ 29.0% |
| **補正後** | **2/31 ≈ 6.5%** |

理論値 (単発 alpha≈4.55%を維持できていれば) に近い水準まで低下。残る2件 (seed22の3.4σ,
seed30の3.0σ) は補正後閾値 (N=10で約2.8σ) を超える強めの外れ値で、ゼロにする設計では
ないので想定通り (Šidák は family-wise alpha を「維持する」設計であって「無くす」設計
ではない)。

### 残課題

- ライブ coarse view (`dashboard.ts`) は `curator.curate(coarseView.current())` と
  自己参照のままなので、その経路でも N は動的に変わり続ける (経過時間で窓数が増える)。
  今回の補正は window 数ベースなので自動的に効くはずだが、07-25 finding
  (粗窓 dip の遅延発火・明滅) がこの補正でどう変わるかは未確認 — ブラウザ実地で見る余地あり
- 対策 D (真陽性側の測定) を今回の補正込みでやる場合、閾値が上がった分だけ
  境界線ケースの検出限界も動く。D は「補正後」を前提に設計し直す必要がある
- 対策 B・C・E は未着手のまま

---

## 2026-07-29 — 対策C・D 実行 (AI不要分を先行消化)

B・E は LLM 呼び出しが要る一方、C・D は既存コードで完結するとロードマップに書いた通り
だったので、API 抜きで先に片づけた。両方とも使い捨てスクリプト
(`server/src/_c-sim.ts` / `_d-sim.ts`) で実行後に削除——恒久コードには残していない
(git 上は untracked のまま消えているので diff にも出ない)。

### 対策C: raw の「極値指し」ヒューリスティックの検証 (予測の的中)

QUIET 型 fixture を窓数 N=10/30/50 で汎化し (`buildQuietFixture` は変更していない
——スクリプト内で直接 `RetentionBuffer`+`replay` を叩いて生成)、各窓を実際の
comparisonSE 式 (補正前、生の z) でスコアし、最も極端な窓の z を N=300 seed/N で集計。

| N | 実測 min-z 平均 | 理論値 (iid正規の最小値の期待値) | 素朴閾値 &#124;z&#124;>2.0 の発火率 |
|---|---|---|---|
| 10 | -1.573 | -1.539 | 25.7% |
| 30 | -2.175 | -2.043 | 57.7% |
| 50 | -2.484 | -2.249 | 78.7% |

実測は理論値にほぼ一致 (窓平均は独立正規ではなく二項×共有referenceで多少の相関がある分
理論よりわずかに極端寄り)。N=10 の 25.7% は A/B 分析で実測した package 単位誤警報率
29% (9/31) と同オーダーで整合。**予測は的中**——raw の失敗機序が「極値を指すヒューリス
ティック」であるという 2026-07-28 の解釈が、窓数を変えた対照実験でも裏付けられた。

### 対策D: 真陽性側 (false negative) の測定、Šidák補正後を前提に再設計

RC はバースト強度、AR は回帰後 pass rate を段階的にベースライン (0.95) に近づけ、
実際の `SnapshotCurator` (補正後、現行 shipped 動作) と自前の無補正 z (対策A以前相当)
を同じ 100 seed で並走させ、TP率 (tile が真の異常区間と重なる) を比較。

**RC (baseline=0.95, burst区間2窓/10窓中)**

| burst pass rate | 補正後 TP | 無補正 TP |
|---|---|---|
| 0.10〜0.80 (35σ〜相当) | 100% | 100% |
| 0.85 | 97% | 100% |
| 0.90 | **53%** | 81% |

**AR (baseline=0.95, 全6窓が回帰)**

| regressed pass rate | 補正後 TP | 無補正 TP |
|---|---|---|
| 0.70〜0.90 (21〜23σ相当) | 100% | 100% |
| 0.92 | 94% | 98% |

結論:
- **元の RC(35σ)・AR(21〜23σ) シナリオは対策Aの補正で無傷** (100%) —
  「対策A実装完了」の主張が graded effect size でも再確認された
- 補正のコストはノイズフロア付近 (baseline との差が実質 5pp、かつイベント数が
  少ない窓) に集中する。RC 0.90 (baseline比 -5pp・200イベント) で TP が
  81%→53% と最も大きく落ちる。これは「Šidák補正は family-wise alpha を維持する
  設計であって検出力を無償で保つ設計ではない」という対策A実装時の想定通りの
  トレードオフで、感度の崩れ方が急激でも予期せぬものではない
- D が求めていた「境界線ケースの検出限界がどこにあるか」は定量化できた:
  RC は burst-baseline 差 ~10pp 未満、AR は regression-baseline 差 ~3pp 未満が
  補正後の検出限界の目安

### 残課題 (更新)

- 対策 B・E は未着手 (LLM 呼び出しが必要)

---

## 2026-07-29 — ライブ coarse view の自己参照解消 + ブラウザ実地確認

07-25/対策A の残課題だった「`dashboard.ts` のライブ coarse view が
`curator.curate(coarseView.current())` と自己参照のまま」を解消し、そのままブラウザ実地で
07-25 finding (粗窓dipの遅延発火・明滅) の変化を確認した。AI不要、対策C・Dと同じ枠で実施。

### 診断: 自己参照は2つの問題を持っていた

1. **自己参照そのもの**: 観測対象自身を参照母集団に含めるため、本物の dip がその参照の
   平均・分散を薄め、自分自身のσを目減りさせる (index.ts の replay 経路には既に
   2026-07-25 に "参照レンズ設計" で修正済みだったが、ライブの周期ブロードキャストだけ未対応)
- **無限成長 (今回新たに判明)**: `LensView.current()` は view 生成以降に保持した
  全イベントを毎回再集計するため、稼働時間とともに窓数 N が際限なく増え続ける。
  「観測区間の直前の等長区間」を参照に取る RC/AR fixture と同じ発想で最初に直したところ
  (`first.windowStart - (last.windowEnd-first.windowStart)`)、**observation 区間自体が
  無限成長しているため参照区間の起点もどんどん過去へ遡り、やがて retention (120s) の外に
  出て `referenceUsable: false` に落ちた** (実機で確認: 44秒間 windowCount=1 に張り付き)

### 修正

`dashboard.ts` に `LIVE_REFERENCE_WINDOW_COUNT = 3` を導入し、`RetentionBuffer.replay()` を
直接 2 回叩いて observation (直近 3×coarse window_ms) と reference (その直前の同じ長さの
区間) を毎回新しく構成する方式に変更 — coarse LensView の蓄積配列は使わない。
`observation + reference` の合計スパンが retention_window_ms (120s) に収まるよう
window_ms=10,000 × 3 = 30s を選んだ (最初 count=10 で試して retention を超え全域
`referenceUsable:false` になる失敗を実機で踏んだ — 60s+60s=120sではマージンが無い)。
`DashboardServer` の型を汚さないよう `RetentionBuffer<T>` の代わりに `replay()` 一本だけの
狭い `ReplaySource` インターフェースを新設 (`RetentionBuffer<TestEvent>` を
`RetentionBuffer<unknown>` に代入しようとして分散エラーで一度失敗している)。

テスト145件 green (この経路をカバーする専用テストは無い — dashboard.ts は元々ユニット
テスト対象外)。

### ブラウザ実地確認 (RC, 130秒キャプチャ: baseline 65s → RC 60s)

- **修正前** (count=10 の第一版): 全区間 `referenceUsable: false`, windowCount 1 に固着
- **修正後**: `referenceUsable: true` が起動65秒後から安定して成立、`windowCount` は
  終始 3 に固定 (無限成長が止まったことを実測で確認)、refMean は 0.92〜0.94 のレンジで
  安定 (自己参照特有のドリフトなし)
- RC の本来の検出経路 (`replayRequest` → 細窓 replay) は今回変更していない箇所で、
  従来通り `dip 4.6σ` が正しく発火 — 回帰なし
- **粗窓側は今回もバースト中〜直後を通じて `[baseline]` タイルのみ**。これは
  バグではなく RC の前提通り (agent-C 1体だけが 2 秒 passRate 0.20 に落ちても、
  4 agent 合算・10 秒粗窓に薄まると実差は ~0.03〜0.04 程度で、Šidák 補正後閾値の
  近傍に留まり毎回は超えない) — skill doc `run-lighthouse` の「バースト進行中の
  粗窓タイルが baseline のみなのは正常」との既存記述と整合
- **07-25 finding (遅延発火・明滅) は再現しなかった**: 旧バグの機序 (自己参照+無限成長に
  よって過去のバースト窓が事後的に閾値を再突破する) が今回の修正で構造的に排除された
  (reference が固定長・非自己参照になったため、そもそも「後から効いてくる」経路が無い)。
  ただし今回の RC 実行では粗窓dipタイル自体が一度も発火しなかったため、
  「発火はするが遅延・明滅する」旧症状そのものをその場で再現して直接比較したわけではない
  — 結論は「症状を再現できなかった (構造的に無くなったと推定できる根拠あり)」であって
  「発火した上で遅延が消えたことを目視した」ではない、という留保付き

### 残課題

- 07-25 finding の「遅延発火」を直接再現して before/after 比較する場合は、より薄い
  agent 数 (1/4ではなく全ストリームがdipする AR寄りの条件) か、coarse window_ms を
  意図的に細くした $Q チューニングで粗窓側の検出力を上げてから試す必要がある
- 対策 B・E は未着手 (LLM 呼び出しが必要)

---

## 2026-07-29 (2) — 上のセクションの結論を下方修正: 明滅は消えていなかった

直上のライブ coarse view 修正を Opus 5 でレビューし、**「07-25 の遅延発火・明滅を構造的に
排除した」という結論が誤りだった**ことが判明した。旧機序 (自己参照によるσ縮小) は確かに
消えたが、**同じ症状が別機序で新規に入り込んでいた**。ブラウザ実地確認で再現しなかったのは
「粗窓dipがそもそも一度も発火しなかった」ためで、留保として書いておいた通りの見落としだった。

### 新しい機序: anchor が tick ごとに滑る

`applyLens` は渡された区間の**先頭イベント**に窓格子を貼る (`lens.ts` の
`origin = sorted[0].ts`)。修正後の `broadcast()` は `nowTs = snapshot.ts` を毎 tick
1秒進めて `[nowTs - span, nowTs]` を要求していたので、**格子も毎 tick 1 秒ずれる**。
2秒のバーストは「1つの粗窓に丸ごと収まる」状態と「境界で2窓に割れる」状態を周期的に
往復し、割れると実効 delta が半減して閾値を跨いだり跨がなかったりする。

修正前 (`coarseView.current()`) はプロセス最初のイベントに origin が固定されていたため、
この滑りは存在しなかった。**つまり今回の変更は、σ縮小による明滅を消す代わりに
格子スライドによる明滅を持ち込んでいた。**

実測 (50 evt/s・4 agent・pass 0.95・agent-C が 2 秒だけ低下、seed 42、
バーストは**過去に固定されて一切変化しない**):

| バースト passRate | 発火パターン (tick 毎) | magnitude 範囲 | 同一バーストの regionStart |
|---|---|---|---|
| 0.55 (閾値近傍) | `YYYnnnYYYYYnnnnnnYYYY` | 2.49–3.64σ | **7 通り** |
| 0.20 (強い異常) | 全 tick 発火 | **2.60–5.28σ** | **10 通り** |

データは動いていない。動いていたのは窓の切れ目だけ。0.55 では初回発火がバースト終了の
5 秒後という**遅延発火**まで再現している。

### 併せて見つかった問題

- **windowCount が 3 と 4 で揺れる**: `RetentionBuffer.segment()` は `ts <= toTs` の
  閉区間、窓は半開区間。`spanMs` ちょうどの幅を閉区間で取ると末尾に count=1 の 4 窓目が
  生まれる。実運用では `Date.now()` のジッタ次第で 3 か 4 かが決まる非決定で、Šidák の
  family size がそれに引きずられ実効閾値が 2.42σ ⇄ 2.52σ で揺れる
  (上の実測では常に 4 窓。定数名が「ちょうど3」を約束していたぶん紛らわしかった)
- **レンズが `window_ms` に矮小化されていた**: `coarseView.current().window_ms` だけを
  拾って `{ window_ms }` を組み直しており、`lens.ts` が明示している契約
  (*callers hand the observeParams object over unchanged*) に反する。現状は applyLens が
  window_ms しか実装していないので挙動は同じだが、**L4 で group_by が入った瞬間に
  ライブ粗窓だけが黙って別物になる**。`index.ts` の replay 経路も同型だった
  (`proposedParams` を持っているのに `{ window_ms }` に潰していた)
- **`referenceUsable: false` がライブ経路では無言**: `index.ts` の replay 経路には warn が
  あるのに周期ブロードキャスト側には無かった。`$Q` で coarse window_ms を
  `retention_window_ms / (2 × count)` = 20s より上げると黙って盲目化する

### 修正 (2巡目)

- `liveSpans(nowTs, windowMs, count)` を `dashboard.ts` から export。区間を
  `floor(nowTs / windowMs) * windowMs` で**絶対時刻の固定格子に量子化**し、`toTs` は
  `gridNow - 1` として閉区間/半開区間のズレを潰す。これで境界は 1 窓単位でしか動かず、
  過去のバーストは射程内にいる限り同じ windowStart を保つ
  (applyLens は依然先頭イベントに貼るが、ズレはイベント間隔 ~20ms に収まる。
  格子を宣言可能にするのは `QObserveParams` に `origin` 段を足す話で、L4 の範囲)
- レンズは `registry.getObserve(coarseView.schemaId, coarseView.view)` で**丸ごと**取得して
  `replay()` にそのまま渡す。overlay は「粗い角度が attach されているか」だけを答え、
  「その角度は何か」は $Q が答える、という役割分担にした。`index.ts` も
  `const { fromTs, toTs, ...lens } = proposedParams` で区間指定とレンズを分離
- `reportReferenceBlindness()` を追加 (エッジトリガ)。沈黙と盲目を混同しない、という
  既存の field finding をライブ経路にも適用

### テスト (145 → 151 件)

`dashboard.test.ts` を新設。`liveSpans` を独立した関数として export したのは、
**この経路のバグが 2 回とも 40 秒の SSE キャプチャを睨んで見つかっており、しかも
1 回目の修正案自体が間違ったまま出荷されて 2 回目のキャプチャで初めて捕まった**ため。
HTTP サーバもブラウザも generator も要らない性質だった。

上の表の 4 つの指標 (発火の一貫性 / magnitude の安定 / windowCount / regionStart) は
**すべて修正前のコードに対して落ちること**を確認済み。

### 副次的に判明した既存の不安定さ (未修正)

`e2e-verify.test.ts` の "E2E AR — agent regression" だけが `new MockStreamGenerator()` を
**シード無し・実時計**で回しており (他は `seededRng(42)` + 仮想時計)、フルスイート 10 回中
1 回落ちた。今回の変更は DashboardServer を経由しないので無関係。ただし「5秒以内に発火」を
検証する受入テストなので、仮想時計に寄せると検証内容自体が変わる。方針判断が要る。

### 残課題 (更新)

- `QObserveParams` に `origin`/`align` 段を足して格子を宣言可能にする (L4 レンズチェーン)
- retention 予算がコード上どこにも強制されていない。`registry.set("pipeline:*",
  { retention_window_ms })` は本番コードから一度も読まれておらず (`getPipeline()` の
  呼び出し元が無い)、`RetentionBuffer.setRetentionWindowMs` も未配線。120s が
  `index.ts` のハードコードと $Q 行と定数コメントの 3 箇所に重複している
- ライブ粗窓は参照が「直前30秒」固定になったことで **level detector から
  change detector に意味が変わった** (AR のような持続的劣化は 30〜60 秒で参照側に
  飲み込まれてタイルが消える)。RuleBrain が passRate で別途見ているので実害は無いが、
  設計判断として明記しておく
- 格子量子化の代償として、進行中の未完了窓を観測しない = 最大 window_ms ぶんの
  検出遅延が入る (§10 の「AR 5秒以内」は RuleBrain 経路なので影響なし)
- `LensView.push()` はイベント毎に全保持イベント (最大1万件) を再集計する。
  50 evt/s × 2 view = 毎秒 100 回。今回 overlay は window_ms を渡す役目すら失ったので、
  このコストが何のためかを正面から問える状態になった
- 対策 B・E は未着手 (LLM 呼び出しが必要)
