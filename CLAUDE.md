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
| ステータス | 動作確認済 (Phase B 完了) | Phase 0+1 完了・L1-L2 完了 + L4 前段 + L3 A/B実行+対策A実装 (テスト164件) |

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

```
dcp-lighthouse/
  CLAUDE.md              ← このファイル
  docs/
    LIGHTHOUSE_MODEL.md          ← 概念設計
    LIGHTHOUSE_PILOT_DATA.md     ← モック要件
  server/                ← Node.js / TypeScript
    package.json
    tsconfig.json
    src/
      index.ts
      mock-stream-generator.ts   ← MockStreamGenerator
      testor-adapter.ts          ← test_result:v1 への正規化
      rule-brain.ts              ← BrainAdapter 実装 (rule-based)
      brain-adapter.ts           ← interface 定義
      dashboard.ts               ← SSE bridge
      bitpos.ts                  ← 固定仮想 area space
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

E2E 検証は完了済み (テスト 113 件、§10 基準を実測)。以後の工程は
**`docs/devlog/ROADMAP_BRIEF.md` の「2026-07-03 — 本体ロードマップ再編」を正とする**。要約:

- **L1 ✅ (2026-07-03)** 足場固め — field findings の core 還元 (ts≤now クロック方針 / count 窓・有効性 / baseline ゲート+床)。テスト 113→121 件
- **L2 ✅ (2026-07-03)** Brain write surface + replay 表面化 — $Q[schema] baseline_delta 昇格・区間指定 replay (fromTs/toTs)・dashboard 粗/細対比 UI。テスト 121→124 件。ブラウザ実地確認も完了 (2026-07-25)
- **L3** **ClaudeBrain (本丸)** — §12 A/B 実験 → `BRAIN_MODE=claude` shadow 併走。LLM 起点の $Q 操作が核心。
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
    テスト 279→291件。詳細は ROADMAP_BRIEF.md 2026-08-17 (続々)
  - 残るチェーン段: **`agg_func`** (下記の理由で本質的に重い)
  - **`agg_func` の本質的な難しさ (2026-08-17 に判明)**: z 検定のガウス仮定が変わることだけが
    問題なのではない。median/percentile は**十分統計量からプールできない** (2 窓の median を
    マージしても merged median にならない)。`downsample` と参照レンズのプーリングは
    どちらもこの分解可能性に依存しているので、`agg_func: median` と `downsample_factor` の
    組み合わせは現設計では**数学的に整合しない**。実装するなら生値保持か sketch (t-digest 等) が要る
- **L5** retention 参照ゾーン (疎化)
- 常設: 実データ派生 (非公開の姉妹プロジェクト) からの還元フィルタ — 「機構を行使/変更する or ドメイン非依存知見を生む」もののみ灯台の実証に数える

---

## ローカル運用メモ

個人環境固有の手順 (絶対パス・ローカル CLI/DB の起動・進行中の測定など) は
**このファイルに書かない**。`CLAUDE.local.md` (untracked) に置く。
本ファイルは公開リポジトリの一部なので、パスは常にリポジトリ相対で書くこと。

@CLAUDE.local.md


