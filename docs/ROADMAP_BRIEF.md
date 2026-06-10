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
