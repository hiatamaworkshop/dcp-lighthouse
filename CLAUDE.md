# dcp-lighthouse — 引継ぎコンテキスト

## プロジェクト概要

灯台モデル (Lighthouse Model) のパイロット実装
DCP Pipeline を観測層として、マルチエージェント開発時代のテスト/コード品質ストリームを扱う

**親プロジェクト**: `../dcp-wrap` (DCP Pipeline コア)
**姉妹プロジェクト**: `../dcp-minecraft` (高頻度ストリーム処理の実証)
**設計仕様ドキュメント**:
- `docs/LIGHTHOUSE_MODEL.md` — 灯台モデルの概念・$Q shadow・stream replay・コード応用展望
- `docs/LIGHTHOUSE_PILOT_DATA.md` — モックデータ要件・シナリオ・検証基準

---

## 立ち位置

| | dcp-minecraft | dcp-lighthouse |
|---|---|---|
| 証明する性質 | 高頻度ストリーム処理 | 観測層と Brain 制御 |
| データ源 | Bukkit Plugin / 実 Minecraft | モックストリーム生成器 |
| Brain の役割 | ルート変更・throttle・$V 更新 | 観測パラメータ操作・reroute・target schema 更新 |
| ステータス | 動作確認済 (Phase B 完了) | 未実装 |

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

## 次のステップ

scaffold (package.json, tsconfig.json, .gitignore, README.md) は配置済み。設計ドキュメントは stabilized。次は実装フェーズ:

1. **Phase 0 着手**: `dcp-wrap` 側で $Q[observe] パラメータ抽出 (Step 1) を実装し、Minecraft デモで動作確認 (既存44テストを壊さない)
2. Step 2 (遡及的再観測) で真値照合の検証ハーネスを作り、別レンズ再観測で隠れた構造が復元できることを数値確認
3. Step 3 / 3b でチューニング割り込み・動的追加・観測UIを積む
4. Phase 0 が真値で検証できたら Phase 1 (Step 4-) で test_result:v1 に皮を貼る
