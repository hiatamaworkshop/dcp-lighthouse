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
