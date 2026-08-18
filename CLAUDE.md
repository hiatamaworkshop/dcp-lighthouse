# dcp-lighthouse — 引継ぎコンテキスト

## プロジェクト概要

灯台モデル (Lighthouse Model) のパイロット実装
DCP Pipeline を観測層として、マルチエージェント開発時代のテスト/コード品質ストリームを扱う

**親プロジェクト**: dcp-wrap (DCP Pipeline コア) — 非公開
**姉妹プロジェクト**: dcp-minecraft (高頻度ストリーム処理の実証) — 非公開
> 非公開プロジェクトはローカルに並べて置く前提。参照は名前で行い、パス表記はしない。

**設計仕様ドキュメント**:
- `docs/LIGHTHOUSE_MODEL.md` — 灯台モデルの概念・$Q shadow・stream replay・コード応用展望
- `docs/LIGHTHOUSE_PILOT_DATA.md` — モックデータ要件・シナリオ・検証基準
- `docs/devlog/ROADMAP_BRIEF.md` — 時系列の開発ログ (追記式。仕様ではない)

---

## 立ち位置

| | dcp-minecraft | dcp-lighthouse |
|---|---|---|
| 証明する性質 | 高頻度ストリーム処理 | 観測層と Brain 制御 |
| データ源 | Bukkit Plugin / 実 Minecraft | モックストリーム生成器 |
| Brain の役割 | ルート変更・throttle・$V 更新 | 観測パラメータ操作・reroute・target schema 更新 |
| ステータス | 動作確認済 (Phase B 完了) | Phase 0+1 完了・L1/L2/L3/L4 完了 (agg_func のみ保留)・L5 未着手 (テスト336件) |

灯台モデルは dcp-minecraft で得た知見 (DCP Stream は止めずに観測層を被せられる) を、コード生成検証ドメインに応用するもの。データ源とドメイン語彙が変わるだけで、DCP コアの仕組みは同じ。

---

## 実装順序

`docs/LIGHTHOUSE_MODEL.md` §8 / `LIGHTHOUSE_PILOT_DATA.md` §1.5 に従う。
2 フェーズに分ける: Phase 0 でドメイン非依存のコア機構を「真値が既知のストリーム」で検証し、Phase 1 でコードテストドメインに適用する。テストドメインは機構バグとドメインモデリングの妥当性が混線するため分離する。

```
=== Phase 0: コア機構検証 (Minecraft ベースライン + 自作異常) ===
参考データ = 既存 Minecraft デモのイベント (自然な分布、ingestion〜$ST 配線済み)
異常 = 手作りで注入し真値を握る (例: source-C の平均を t=10s から 0.5→0.3)
検証するコア4要素: 遡及的再観測 (retroactive re-observation) / 動的データセット追加 /
                   観測チューニング割り込み / Brain用観測UI
重要: replay は「分散を縮める/推定を良くする」ではない。
      保持した生データを別レンズ ($Q[observe]) で見直すこと。詳細は MODEL.md §5

Step 1: $Q[observe] パラメータ抽出
        — $ST collector が専用 $Q レジストリ経由で window/decay/group_by を読む
        — $Q は既存 FieldMapping (path 解決の単一責務) に相乗りさせない。別レジストリ
        — 現状 StCollector は windowMs をコンストラクタ固定・実行中変更不可。動的 read を足す
        — 既存 Minecraft デモの動作を壊さないこと

Step 2: $Q[pipeline] retention + replay 実装 (遡及的再観測)
        — IngestionBus に retention_window (生データ保持)
        — replay_mode = "n_rounds" のみ。保持セグメントを別 $Q[observe] で再集計
        — 正当性検証: 粗窓で平均化され消えた局所構造 (注入バースト) を
          細窓で再観測すると復元できること。注入真値が予測する
          「そのレンズでの集計値」と一致するかを照合 (分散縮小の検証ではない)
        — 検証ハーネスが注入真値 (分布+delta+タイミング) を必ず記録すること

Step 3: 並行 $ST オーバーレイ + チューニング割り込み + 動的データ追加
        — 1 ストリームに複数 StCollector が独自パラメータで attach 可能に
        — 実行中に $Q を変えて live view が再構成されること
        — 流れているストリームに新ソースを投入できること

Step 3b: Brain用観測UI = スナップショット・パッケージ (動的GIFではない)
        — 形 + ラベル + 該当数値 のタイル陳列 (LIGHTHOUSE_PILOT_DATA.md §12)
        — 特徴的/例外的な瞬間を $U が機械的に抽出して並べる
        — LLM はアニメをフレームサンプリングするので静止スナップショットで十分
        — 人間向けは別途ライブグラフ。AI向けの正本はスナップショット陳列
        — チューニング変更 / 異常 が「形」で視覚的に分離されることを照合

=== Phase 1: コードテストドメイン適用 ===
検証済み機構を test_result:v1 に皮を貼り替え
(sourceId→agentId, channel→area, value分布→pass/fail/flaky)
機構は信頼済みなので、ここではドメイン表現の妥当性だけを問う

Step 4: TestorAdapter (モック版)
        — MockStreamGenerator が test_result:v1 を生成

Step 5: bitpos (固定仮想 area 空間)
        — 256bit、auth/payment/ui/utils の 4 ドメイン

Step 6: RuleBrain (BrainAdapter 経由で差し替え可能)
        — 3 シナリオ (AR/CG/RC) に対する判断ルール

Step 7: ダッシュボード (公開アーティファクト)
        — 「世界が変わった」vs「観測を変えた」を視覚的に分離
```

Phase 0 (Step 1-3b) は Minecraft デモ上でコア機構を真値照合で検証してから、Phase 1 (Step 4-) で lighthouse 固有領域に入る。混ぜない。

---

## モックデータ仕様

詳細は `docs/LIGHTHOUSE_PILOT_DATA.md`。要点のみ:

### イベントスキーマ
```
["$S","test_result:v1",8,"ts","testId","agentId","areas","result","duration","weight","commitHash"]
```

### エージェント
4 体: agent-A (基準) / agent-B (広く浅い) / agent-C (regression 候補) / agent-D (flaky 出力)

### area 空間 (256 bit 固定仮想)
```
bit 0-31:    auth      critical
bit 32-63:   payment   critical
bit 64-127:  ui        normal
bit 128-255: utils     low
```

### シナリオ (3 つ)
- **AR** Agent Regression — agent-C の pass 率が 95%→70% → Brain: rerouteSchema
- **CG** Coverage Gap — auth 領域に常時欠落 → Brain: schemaUpdate
- **RC** Retroactive re-observation — 粗窓で見えない局所バースト → Brain が保持セグメントを細窓で再観測して復元 (分散縮小ではなく「保持データを別レンズで見直す」こと)

### ベースライン
50 events/sec の定常背景 (シナリオ間も流れ続ける)

---

## ディレクトリ構成

各 `*.ts` に `*.test.ts` が隣接する (テストは実装の隣に置く)。

```
dcp-lighthouse/
  CLAUDE.md              ← このファイル
  docs/
    LIGHTHOUSE_MODEL.md          ← 概念設計
    LIGHTHOUSE_PILOT_DATA.md     ← モック要件
    devlog/ROADMAP_BRIEF.md      ← 時系列の開発ログ (追記式)
  server/src/            ← Node.js / TypeScript
    ── 観測層コア (Phase 0 / L4) ──
      q-registry.ts              ← $Q レジストリ (observe/pipeline/schema、書込時バリデート)
      lens.ts                    ← applyLens = レンズチェーン本体 (window/origin/group_by/downsample/decay)
      lens-view.ts               ← LensView / ObservationOverlay (1ストリーム複数レンズ)
      retention-buffer.ts        ← 鮮度ゾーン ring (IngestionBus.tap の上)
      snapshot-curator.ts        ← $U。タイル選出と統計判定 (Šidák・連続性補正・isScorable)
      calibration.ts             ← 誤警報率/検出力の測定器 (レンズを引数に取る)
      q-collector-binding.ts     ← $Q[observe] → StCollector 動的 bind
      q-retention-binding.ts     ← $Q[pipeline] → retention 窓
    ── ドメイン適用 (Phase 1) ──
      mock-stream-generator.ts   ← MockStreamGenerator
      testor-adapter.ts          ← test_result:v1 への正規化
      brain-adapter.ts           ← interface 定義 (BrainAdapter / ResettableBrain)
      rule-brain.ts              ← BrainAdapter 実装 (rule-based)。既定の primary
      claude-brain.ts            ← BrainAdapter 実装 (LLM)。審議を tick から切り離す・提案の関所
      shadow-brain.ts            ← primary/shadow 併走。shadow の決定は decide() から返さない
      bitpos.ts                  ← 固定仮想 area space
      dashboard.ts / index.ts    ← SSE bridge / 起動
    ── §12 A/B 実験 (L3 前段) ──
      ab-fixture.ts / ab-harness.ts / ab-strategy-b.ts / run-ab-strategy-b.ts / anthropic-ask.ts
  dashboard/             ← ブラウザ UI (HTML + JS)
    index.html
    app.js
```

---

## Brain の差し替え方針

```typescript
interface BrainAdapter {
  observe(snapshot: STSnapshot): void
  decide(): BrainDecision[]
  describe(): string
}
```

パイロットは `RuleBrain implements BrainAdapter`。
将来 `ClaudeBrain implements BrainAdapter` を `BRAIN_MODE=claude` で差し替え可能に。
Minecraft で検証済みのパターン。

---

## 検証基準

`docs/LIGHTHOUSE_PILOT_DATA.md` §10:

1. **AR**: agent-C reroute 決定が regression 開始から 5 秒以内に発火、per-agent パネルで視覚的に分離
2. **CG**: ヒートマップに穴が 10 秒以内に表示、閾値を超えて持続したら target-update 決定
3. **RC**: 粗窓で平均化され見えない注入バーストが、保持セグメントを細窓で再観測すると既知の位置・大きさで復元される (注入真値との照合)。Brain が自発的に再観測を起動。分散縮小の主張ではない

ベースライン: シナリオ間は静かであること。late-arrival テスト: ts 駆動集計が in-order と数値一致。

---

## 注意事項

- **dcp-wrap には汎用拡張点のみ整備済み (2026-05-28)。$Q ロジック本体は灯台側に置く** — コアは $Q を名指ししない素のフックだけ持ち、配線は灯台側で行う方針 (user 指示)。コアに足した3つ (デフォルト挙動不変、テスト57件パス):
  - `StCollector.getWindowMs() / setWindowMs()` — `windowMs` を mutable 化、running 中は timer 再起動。$Q[observe] の window 動的変更を灯台側が呼ぶ口
  - `IngestionBus.tap(observer): () => void` — push を覗く read-only フック。retention buffer 本体はコアに無し → 灯台側が tap で ring buffer を実装 (Step 2)
  - `PipelineControl.onExtraDecision(type, handler): () => void` — 未知 outbound type を登録ハンドラへ委譲。灯台側が `observe_update`/`replay` を登録。PostBox/OutboundType は未変更
  - テストは `dcp-wrap/src/extension-points.test.ts` (13件)
- **まだコアに無い = 灯台側で埋める範囲**:
  - $Q レジストリ本体 (置き場所も含め灯台側設計)。`FieldMapping` は path 解決専用なので相乗りさせない
  - StCollector の group_by 集計 (現状 pass/fail カウントのみ)
  - tap の上に載せる ring buffer / retroactive re-observation ロジック (一番アーキ的に重い)
  - `observe_update`/`replay` の OutboundMessage 定義と発行・適用ロジック (onExtraDecision で受ける側)
- Phase 0 の dcp-wrap 拡張点変更は Minecraft デモで動作確認済み (既存44テストを壊さない)。今後さらにコアを触る場合も両プロジェクトで確認
- Minecraft デモを壊さない: Phase 0 (Step 1-3b) の dcp-wrap 変更は両プロジェクトで動作確認
- 本番 AST 解析・mutation score・実テストランナー統合はすべて将来。パイロットは観測層の証明に集中
- Brain は rule-based 固定。Claude 差し替えはインターフェース確保のみで実装は将来

---

## 現在の状態

Phase 0 + Phase 1 実装完了 (詳細・ファイル対応は [README.md](README.md) のステータス表参照)。
起動: `cd server && npm run dev` → `http://localhost:3001`。シナリオ: `/demo/start?scenario=AR|CG|RC`。

## 次のステップ (工程 L1–L5)

E2E 検証は完了済み (当時テスト 113 件、§10 基準を実測)。以後の工程は
**`docs/devlog/ROADMAP_BRIEF.md` の「2026-07-03 — 本体ロードマップ再編」を正とする**。要約:

- **L1 ✅ (2026-07-03)** 足場固め — field findings の core 還元 (ts≤now クロック方針 / count 窓・有効性 / baseline ゲート+床)。テスト 113→121 件
- **L2 ✅ (2026-07-03)** Brain write surface + replay 表面化 — $Q[schema] baseline_delta 昇格・区間指定 replay (fromTs/toTs)・dashboard 粗/細対比 UI。テスト 121→124 件。ブラウザ実地確認も完了 (2026-07-25)
- **L3 ✅ (2026-08-18)** **ClaudeBrain (本丸)** — `claude-brain.ts` + `shadow-brain.ts`。
  `BRAIN_MODE=claude` で RuleBrain と shadow 併走。テスト 292→336 件。設計判断 4 つ:
  - **審議を tick から切り離した** — `BrainAdapter.decide()` は同期、tick は 1s、モデルはどちらでもない。
    インターフェースを非同期化すると RuleBrain/dashboard/E2E が巻き添えなので、`observe()` が
    審議を開始しうる (in-flight ラッチ + `minIntervalMs` の床 = 支出ガード 2 枚)、`decide()` は
    到着済みを drain する。決定は誘発した snapshot の数 tick 後に出るので **`meta.snapshotTs` が
    「何時のデータを考えていたか」を名乗る** (drain した tick ではない)
  - **提案の関所を Brain 側に置いた** — `validateObserveParams` を通らないレンズは
    BrainDecision に**ならない**。index.ts の `registry.set` catch は最後の砦であって関門ではなく、
    決定ログには実際に取れる行動だけが並ぶべき。棄却は `stats.rejectedProposals` に数える
    (不正提案を続けるモデルはノイズではなく findings)。同じ答えの中の他の決定は巻き添えにしない
  - **shadow は per-tick 一致率を出さない** — ClaudeBrain は `minIntervalMs` ごとに 1 回しか
    聞かれず答えも遅れる。RuleBrain は毎 tick。tick 単位の差分は**cadence の差**を測ってしまい、
    「聞かれてすらいない tick で不一致」と採点する。2 本のストリームを記録し種別/対象で要約するに留める
    (それ以上は未検証の照合規則を計測器に焼き込むこと = §12 再分析で 1 度踏んだ穴)
  - **プロンプトがレンズの語彙を教える** — L3 の核心は「LLM が dip を分類できる」ではなく
    「LLM が $Q を操作する」。`replayRequest` に `window_ms`/`group_by`/`downsample_factor`/`decay` を載せさせる
  - 配線確認は **Messages API のスタブ** (`ANTHROPIC_BASE_URL` 差し替え) で課金ゼロで実施
  - **実走測定済 (2026-08-18、Sonnet 5、$0.49)** — **中核主張は実証**: replayRequest は全て
    `window_ms:1000`+`group_by:["agentId"]` を載せ、理由文も機序を言い当てた。
    **ただし識別は不可**: RC バーストは捉えるが無事象の agent にも同率で撃つ
    (agent-C 2/17 vs 別対象 5/17、QUIET 27 審議中 10 回提案)。
    **「どう操作するか」は正しく「いつ・何に」がノイズから選ばれている** — §12 A/B と同型の構図。
    **primary 昇格は見送り**。次は生系列でなく curator の snapshot package (σ付き) を渡す = curated アーム
  - **判断規律の 2×2×2 実測 (2026-08-18、$1.41)** — 「性格か問い方か」を切り分けた。
    QUIET (陰性) / AR (断定チャネルの陽性) / RC (観測チャネルの陽性) × base / placebo / disciplined
    × Sonnet 5 / Sonnet 4.6、計 12 セル。ハーネスは scratchpad (`askFn` ラップで注入、
    `claude-brain.ts` は不変 = base 腕は記録済み実走とバイト同一)
    - **枠組みが支配的**。長さを揃えた placebo では**何も動かない** (p=1.0) が、
      内容を入れると提案率が 14/22→3/25 (p=0.0003)。モデル軸は 4 比較すべて有意差なし
      (p=0.235〜0.667、ただし n=22〜26 で検出力不足 = 「無い」ではなく「枠組みより小さい」)
    - **しかし散文で入るのは「全体の保守性ノブ 1 個」** — 規律ブロックは
      「断定を上げ観測変更は据え置く」と明記したのに、**各モデルが最も多用していた
      チャネルだけが削られた**。Sonnet 5 は断定が無反応で RC の replayRequest が 0/21
      (中核主張のチャネルが消えた)、4.6 は断定が 9→2 に効いた代わりに AR の
      agent-C 名指しが 6→2・lag が 7.2s→14.3s。**どちらの腕も出荷できない**
    - **上の②を下方修正**: 断定的な誤警報だけなら **4.5% = curator の設計値 4.55% と同水準**。
      59% を膨らませていたのは可逆な `replayRequest`。一方**識別はプロンプトで全く動かない**
    - **結論**: ゲートはコード側 (curator) に置き、LLM には**レンズ選択**だけを渡す。
      §12 の転写の罠も踏まない (LLM が写せる判定が存在しない)。**未実装**
  - **Opus 5 はこのプロンプトを拒否する (2026-08-18)** — `stop_reason:"refusal"`、出力 0 tok、
    11/11 再現。最小プロンプトには正常応答するのでアクセス問題ではない。引き金は
    プレアンブル冒頭 2 行の**組**(単独では通る)。かつては `onMeta` 未配線で refusal が
    `stats.unparseable` に化けた (=「モデルが JSON を書けない」と誤読) が、**2026-08-18 のレビューで修正**
    (下記)。付随: **Haiku 4.5 は `output_config.effort` を 400 で拒否**する
  - **レビューで出た欠陥 3 件 (2026-08-18、同日修正。テスト 328→336 件)**:
    - **`ClaudeBrain.reset()` が in-flight の審議を切り離していなかった** — `/demo/start` は
      審議中 (5〜10s 対 15s 床) に来るのが常態。前シナリオの決定が新シナリオに drain され、
      さらに reset がラッチを開けるので**同時 2 本**になっていた (支出ガード 2 枚の 1 枚が無効)。
      `generation` カウンタで解決: reset は世代を上げるだけで**ラッチは開けない**。
      走っている呼び出しがラッチの持ち主なので `finally` は無条件に返す (条件付きにすると
      reset 後に閉じたまま固着する)。捨てた答えは `stats.discarded` に数える (課金は発生済み)
    - **shadow の証拠に読み手がいなかった** — `getSummary`/`getStats` はテスト以外に呼び出し元ゼロ。
      「これらのログの証拠で昇格を判断する」と書いてあるのに出口が無い状態だった。
      **`GET /brain`** を新設 (dashboard は `brainDiagnostics?: () => unknown` を受けるだけで
      ClaudeBrain/ShadowBrain を知らないまま)。`onMeta` 配線もここで閉じた
    - **`ShadowSummary` が保持ログを数えていた** — `maxEntries` を超えると古い決定が静かに
      counts から消え、**長時間走行ほど「不一致が少ない」方向に過小報告**する。
      record() 時点の累積タリーに変更、`recorded`/`retained` を併記
  - **実課金の罠 (先回りして潰した)**: Sonnet 5/Opus 5 は thinking が既定オンで `max_tokens` は
    思考+本文の合計上限。`anthropic-ask.ts` に `effort` を optional 追加し Brain 側で
    `maxTokens:2048, effort:"low"` を明示。**既定は不変** = 対策B のリクエストはバイト同一のまま
  - 前段の §12 A/B 実験 (以下) は当初の仮説が検証できなかった件も含めそのまま記録:
  **前段 dry-run 完了 (2026-07-28)**: A/B fixture (RC/AR + QUIET 陰性対照、シード付き、`ab-fixture.ts`) +
  ハーネス dry-run 層 (`ab-harness.ts` — prompt 2 アーム/パーサ/採点器、`askFn` 注入シームで API 接触ゼロ)。
  テスト 132→140 件。
  **A/B 実行済 (2026-07-28、haiku 66 trial)**。ただし**再分析で当初結論を下方修正** —
  §12 仮説「提示形式が判断を助ける」は**検証できていない**。curated アームでは LLM が
  curator の閾値判定を転記しているだけ (タイル生成と 9/9 完全一致)。測れたのは
  「curator の 2σ 判定 > haiku の目算」であって presentation の効果ではない。
  **本命の発見は curator の package 単位誤警報率 29%** (出荷中の較正欠陥)。
  **対策A実装済 (2026-07-28)**: `snapshot-curator.ts` に Šidák 補正 (spike/dip
  判定ゲートのみ、`spikeZThreshold` は「窓ごと」から「package全体の誤警報予算」に
  再定義)。同じ31 seedで再検証: package単位誤警報率 29%→6.5%。RC(35σ)/AR(21〜23σ)は
  無傷。テスト 140→145件。残る対策 B〜E は未着手。
  詳細は ROADMAP_BRIEF.md 「再分析 (Opus 5 レビュー)」「今後の対策」「対策A 実装完了」参照
  - **較正の追い込み (2026-08-17)**: 残っていた 6.85% を**連続性補正**で 4.40% (設計値 4.55%) に。
    真因は歪度ではなく**格子の粗さ + 構造的に到達不能な上側の裾**で、Cornish-Fisher が
    失敗したのは「モデル化しようとした誤差が滑らかでなかった」から。格子は仮定せず
    `sumSq/count` の恒等式で**検出**する (連続データでは自分で切れ、実測ビット同一)。
    Fisher 正確検定 (設計値を一度も超えない) と「到達可能な裾への alpha 配分」(12.60% に悪化) は
    どちらも**測って却下**。副作用として **A/B の fp シード集合が変わった** (旧 9 件中 5 件が
    誤警報しなくなった) ので、今後の対策B 実行は記録済み 18 trial と比較不能。テスト 276→279件
- **L4 ✅ (2026-08-12)** レンズチェーン — 前段の「参照レンズ設計」(2026-07-25、curator を
  `curate(observation, reference)` の二項演算化、SE は `sqrt(var_ref × (1/n_w + 1/n_ref))`) に続き、
  **格子 (`origin`/`align`) と `group_by` を実装**。テスト 164→194件。
  - `align:"epoch"` で窓境界がレンズの性質になる (従来は渡されたセグメントの性質だった)。
    格子の読み手 (`liveSpans` / `applyLens`) は `floorToWindow` を共有する
  - `group_by` は**加算的** — `LensResult.windows` の混合ビューは残り、`groups` が増える。
    全グループが**共通 origin** を使うので窓が対応付く (これが格子を先にやる理由)
  - curator は 1 グループ = 1 比較単位、参照は**同じグループ**と対応付け。対応が無いものは
    スコアせず `unscoredGroups` で申告 (盲目と沈黙の区別のグループ版)。
    **Šidák の family は package のまま** (グループごとの予算にすると対策A の膨張が戻る)
  - RuleBrain の RC 提案が `group_by:["agentId"]` を載せる = Brain がレンズ 2 段を操作する
  - **実測**: 混合 1.77σ (出ない) → grouped 3.51σ (出る)。実走 replay は 2.48σ → 6.5σ
  - **代償** (仕様として記録): grouping は family を N→N×G にするので感度が下がる。
    細窓×grouping は 1 窓の n を薄くする。詳細は ROADMAP_BRIEF.md 2026-08-12
  - **`downsample_factor` 実装済 (2026-08-16)** — 十分統計量 (count/sum/sumSq) の厳密プーリングで
    N 窓を 1 窓にマージ。curator の統計モデルは無変更で済む。`LensResult.window_ms` を
    `window_ms * factor` にスケールして `windowEnd - windowStart === window_ms` を維持。
    dashboard の `/control/coarse-downsample?factor=N` から live coarse view に書ける (2026-08-17)
  - **`decay` 実装済 (2026-08-17、step 形のみ)** — `step(cutoff=now-60s)` は純粋なイベント
    フィルタなので統計モデルに触れない。**`decay_anchor`** (`"segment_end"` 既定 / `"now"`) を
    `align` と同じ思想で新設 — 壁時計アンカーだと過去セグメントの再観測 (MODEL.md §5) が
    毎回違う答えになる (anchor-slide の decay 版)。decay は**イベント段**で効かせる
    (MODEL.md §137 の並びは window の後だが、§229 の「1分より古いものを捨てる」自体が
    イベントの操作であり、窓単位で落とすと境界窓の扱いが不定になる)。
    `exp(τ=...)` は**パースするが throw** — 黙って無視すると「適用していないレンズ」の数値を
    報告することになるため
  - **`decay` の exp 形 実装済 (2026-08-17)** — `applyDecay` が「フィルタ **または**
    重み関数」を返す段になり、`aggregate` が加重十分統計量 (`Σw·v` / `Σw·v²` / `sumW` / `sumW2`)
    を出す。無加重レンズは `weights` を emit しないのでバイト同一。
    **較正を測り直して判明したこと**: 加重窓で格子検出を諦める実装 (加重和は格子上に無い、
    という一見もっともな理由) は**測って誤り** — 誤警報が 7.1% = 補正導入前の値に戻った。
    加重が gate にしていたのは「連続性補正を切ること」だけだった。二値性の恒等式は
    count を**総重み**に置き換えれば加重でも成立するので一般化し 4.5% (設計値 4.55%) に復帰。
    `gateZ` の除数も `count` → `effectiveN` (無加重では厳密同値、加重では保守側)。
    **Kish はスケール不変なので窓自身の精度はほぼ落ちない** — decay が効くのは pool の
    取り分であって観測窓の SE ではない。無加重の数値・A/B fixture・fp シード集合は全て不変。
    テスト 279→292件。詳細は ROADMAP_BRIEF.md 2026-08-17 (続々)
  - **レビューで出た欠陥 (同日修正)**: 約 414τ より古い窓は**重みの二乗が underflow** して
    `effectiveN` が 0 に潰れる (`ΣW² === 0` かつ `ΣW > 0`)。標準誤差が Infinity なので
    **絶対発火しない**のに、scorability 判定が `count` だけだったため **Šidák family には
    数えられ**、他の窓の閾値を 2.00σ→2.27σ に上げていた。`isScorable` を新設し、
    family サイズ・採点ループ・到達不能裾の**3 箇所が同一述語を呼ぶ**ようにした
    (コピーが 3 つあったのが温床)。述語は `count >= MIN_VALID_COUNT && effectiveN > 0` —
    `effectiveN >= MIN_VALID_COUNT` にすると健全な 3 事象窓が n_eff 2.999998 で落ちる。
    **標本サイズの判定は `count` の仕事、`effectiveN` に問うのは「標準誤差が存在するか」だけ**
  - 残るチェーン段: **`agg_func`** (下記の理由で本質的に重い)
  - **`agg_func` の本質的な難しさ (2026-08-17 に判明)**: z 検定のガウス仮定が変わることだけが
    問題なのではない。median/percentile は**十分統計量からプールできない** (2 窓の median を
    マージしても merged median にならない)。`downsample` と参照レンズのプーリングは
    どちらもこの分解可能性に依存しているので、`agg_func: median` と `downsample_factor` の
    組み合わせは現設計では**数学的に整合しない**。実装するなら生値保持か sketch (t-digest 等) が要る。
    **着手順序**: median より先に「整合しない組み合わせを throw する」方を入れる
    (`decay: exp(τ)` で作った前例と同じ。逆順だと動くケースと壊れるケースが黙って混在する期間ができる)。
    curator 側は 0 を返さず `unscoredGroups` と同形で「採点できない」と申告する。詳細は
    ROADMAP_BRIEF.md 2026-08-18 (5) §C
- **L5** retention 参照ゾーン (疎化) — **疎化は「加重」であって新しい統計ではない**。
  exp decay で実装・較正済みの `weights{sumW,sumW2}` / `effectiveN` (Kish) / 加重 `poolStats` を
  そのまま使う (並行の統計パスを新設しない)。踏んではいけないのは **`count` に代表数を入れること** —
  `count` は実保持事象数のままでないと `isScorable` の標本サイズ判定が
  「持っていない証拠を持っている」と信じる。格子検出は加重で一般化済みなので疎化しても
  連続性補正は切れない (この罠は閉じ済み)。**前提条件**: `referenceUsable` の判定は
  `effectiveN >= 2` = 「分散が存在するか」の床でしかなく、疎化は**事象数を減らさないまま
  有効標本だけ落とす**ので減衰より見えにくい。L5 の前に締め直すのが順序として正しい。
  詳細は ROADMAP_BRIEF.md 2026-08-18 (5) §B
- **分業アーキテクチャ (未実装)** — 判定は curator に既にある。足りないのは配線で、
  ゲートは Brain の中ではなく**決定が返ってきた後**に置く (`meta.snapshotTs` が照合先の
  package を既に名乗っている)。`renderBrainPrompt` に σ / タイル判定を**入れないこと**は
  維持すべき不変条件 (§12 の転写の罠)。`stats.rejectedProposals` は
  「形式が不正」と「断定の裏が取れない」で割る (性質の違う findings)。
  詳細は ROADMAP_BRIEF.md 2026-08-18 (5) §A
- 常設: 実データ派生 (非公開の姉妹プロジェクト) からの還元フィルタ — 「機構を行使/変更する or ドメイン非依存知見を生む」もののみ灯台の実証に数える

---

## ローカル運用メモ

個人環境固有の手順 (絶対パス・ローカル CLI/DB の起動・進行中の測定など) は
**このファイルに書かない**。`CLAUDE.local.md` (untracked) に置く。
本ファイルは公開リポジトリの一部なので、パスは常にリポジトリ相対で書くこと。

@CLAUDE.local.md


