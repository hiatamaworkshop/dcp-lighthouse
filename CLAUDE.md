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
| ステータス | 動作確認済 (Phase B 完了) | Phase 0+1 完了・L1-L2 完了 + L4 前段 + L3-1 dry-run (テスト140件) |

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
**`docs/ROADMAP_BRIEF.md` の「2026-07-03 — 本体ロードマップ再編」を正とする**。要約:

- **L1 ✅ (2026-07-03)** 足場固め — field findings の core 還元 (ts≤now クロック方針 / count 窓・有効性 / baseline ゲート+床)。テスト 113→121 件
- **L2 ✅ (2026-07-03)** Brain write surface + replay 表面化 — $Q[schema] baseline_delta 昇格・区間指定 replay (fromTs/toTs)・dashboard 粗/細対比 UI。テスト 121→124 件。ブラウザ実地確認も完了 (2026-07-25)
- **L3** **ClaudeBrain (本丸)** — §12 A/B 実験 → `BRAIN_MODE=claude` shadow 併走。LLM 起点の $Q 操作が核心。
  **前段 dry-run 完了 (2026-07-28)**: A/B fixture (RC/AR + QUIET 陰性対照、シード付き、`ab-fixture.ts`) +
  ハーネス dry-run 層 (`ab-harness.ts` — prompt 2 アーム/パーサ/採点器、`askFn` 注入シームで API 接触ゼロ)。
  テスト 132→140 件。**実行にはモデル・試行数 N・鍵/予算の判断が必要** (ROADMAP_BRIEF 07-28 残課題)
- **L4** レンズチェーン残段 (group_by 他)。**前段の「参照レンズ設計」は実装済み** (2026-07-25) —
  curator を `curate(observation, reference = observation)` の二項演算に変更、SE は
  **参照分散のみ**から `sqrt(var_ref × (1/n_w + 1/n_ref))`。テスト 124→132件。
  ROADMAP_BRIEF.md「参照レンズ設計 実装完了」+「自己レビューで実装バグ 2 件」参照
  (観測窓自身の分散を分母に使うと有界データで定数の誤警報になる / 参照が空の時の盲目は明示する)。
  次は group_by 本体 (混合ストリームが比較器の単一分布前提を破るため、比較演算子の後で正しい)
- **L5** retention 参照ゾーン (疎化)
- 常設: traders 還元フィルタ — 「機構を行使/変更する or ドメイン非依存知見を生む」もののみ灯台の実証に数える


---

## Cairn 投稿・検索（H7 測定期間: 2026-07-10〜約2週間）

<!-- 原本: CAIRN_HOME\snippets\cairn.md（Phase 0-1 検証用・絶対パス適応版）。Phase 4 で実 API 版に差し替える -->

Cairn = AI が作った機能の概要と gotcha を投稿・検索する公開ショーケース DB（検証中）。
- **CAIRN_HOME** = `C:\Users\kazuh\Desktop\Various\programming\DockerFiles\cairn`
- CLI は CAIRN_HOME をカレントディレクトリにして実行する。事前に Qdrant 起動が必要（CAIRN_HOME で `docker compose up -d`）。
- **検索の起動形式（重要）**：以下で `cairn-search ...` と書いたら、実際には CAIRN_HOME で
  `npx tsx src/cli/cairn-search.ts "<クエリ>" --lang <x> --trigger <t>` を実行せよ。
  **`npm run` を経由するな** — npm 11 は `--` 以降のフラグを握り潰して値だけを位置引数に
  混ぜ込むため、facet フィルタが黙って無効化されクエリが汚染される（2026-07-26 実測）。

### 1. 書き手側：完成検知 → 投稿提案

機能をひとつ完成させたら（ユーザが「ありがとう」「これで OK」「動いた」等の満足・終了を示したら）:

1. **投稿価値を判断せよ**：新規機能 かつ ハマりどころ（gotcha）が 1 個以上あるか。
   typo 修正・軽微な調整では提案しない。
2. 価値があれば、**テンプレを書く前に** この機能の実装区間だけ `git log --oneline`
   （直近 20〜30 件程度）を軽く俯瞰せよ。**diff は開くな**（詳細が要るときだけ該当 commit を 1 件 `git show`）。
   fix / revert が続く箇所、同じ対象を何度も触っている箇所が「詰まった現場」だ。
   そこから最も伝えたい困難を解釈し、実際に踏んだ罠と躱し方を再現条件（バージョン・環境）込みで書け。
   会話の記憶だけに頼るな。モデルが既に知っていそうな定石は書くな。
   **git を使っていないプロジェクトでは**、エラーと修正の往復が多かった箇所を
   会話履歴・変更したファイル群から同様に俯瞰して代用せよ。
3. `CAIRN_HOME\docs\template.md` 準拠のテンプレを記入せよ。**テンプレの全フィールドは英語で書く**
   （embedding 品質と公開 DB のグローバル共有のため。template.md の言語ポリシー参照）。
   ユーザには「Cairn に push しておきますか？例えば↓」と英語テンプレ全文を提示し、
   **ユーザの言語で要旨（何を記録するか）を 1〜2 行添えよ**。
4. 承認されたら CAIRN_HOME で `npm run cairn-post <記入済みテンプレの絶対パス>` を実行せよ。
   拒否・修正指示があれば従い、再提案するか中止せよ。**完全自動投稿はしない**。

### 2. 読み手側：5 つの動線（2026-07-26 多重化）

検索には性質の異なる 5 つの発火タイミングがある。**①②④⑤は decisive anchor（実装依頼・機能追加依頼・
ユーザ明示要求・環境フックという決定論的な事象）で撃つ。曖昧な自己判断で撃つのは③だけ**。

#### ①需要照会（trigger: `demand`）— 実装依頼を受けたら

1. `cairn-search "<これから作る機能の一文説明>" --trigger demand` を引き、top hit の
   `clusterCount` を読め。
2. `clusterCount` が 0（世界初回）なら**一行で退け**（「Cairn には類似実装なし、世界初回のようです」）。
   在庫が無い時に長々と飾るな — それはミニチュア版の需要捏造。
3. `clusterCount` が 1 以上なら、ユーザに一言提案せよ：「Cairn には類似実装が n 件あります。
   内訳や動向を見ますか？」→ **あとは会話の流れに任せる**（強制しない、能動的な実装勧誘はしない）。
4. **需要を捏造しない**：①は実作業の増幅器であって作業のドライバーではない。
   「誰も作ってないから作りに行こう」という勧誘は禁止。①はむしろ needless work を冷ます側であり続ける。

#### ②実装課題照会（trigger: `plan`）— 機能追加依頼を受けたら

1. `cairn-search "<機能の一文説明>" --lang <自スタック> --trigger plan` を引き、
   hit した gotcha を計画立案の材料にせよ（ユーザに見せる前提ではない。エージェント自身の
   実装計画に反映する）。
2. ヒットが薄ければ facet フィルタを外して再検索。ヒット 0 なら黙って通常の実装に進め。

#### ③救難照会（trigger: `stuck`）— エラーで 2 回以上詰まったら

1. `cairn-search "<エラーメッセージ・意図文>" --lang <自スタック> --trigger stuck` を引け。
   **クエリは英語で書く**（レコードは英語で保存されている。エラーメッセージは大抵そのまま使える）。
2. ヒットが薄ければ facet フィルタ（`--lang` 等）を外して再検索せよ。
   言語非依存の gotcha が他スタックの記録に埋まっていることがある。
3. ヒットした記録の gotcha を読み、自分の状況に当てはまるか判断してから適用せよ。
   盲信するな — 記録は他者の環境固有の情報を含む。
   当てはめの説明をユーザに見せる時は**ユーザの言語**で行え（保存＝英語、会話＝ユーザの言語）。

#### ④先行照会（trigger: `ask`）— ユーザが先行事例・前例・既存実装の有無を尋ねたら

1. **キーワード一致で拾うな**。「先行／前例／事例／調べろ」等の語彙一致は言い換え・多言語・否定で
   必ず壊れる。**intent レベルで判断せよ**：「今作っている対象について、先行実装・前例・落とし穴が
   あるか知りたがっている」という意図が読めたら発火する常設命令として扱え（言い換え・多言語はお前が
   一般化しろ）。スコープは**今の作業対象の先行事例に限定**（「npm で調べて」等の別対象要求は対象外）。
2. `cairn-search "<作業対象の一文説明>" --lang <自スタック> --trigger ask` を引き、
   `clusterCount` と gotcha の両方をユーザへの直接応答に使え。
3. ④はユーザが自分で明示した要求なので、これは「Cairn を想起すれば役立つ」ことの疎通確認であり、
   自律性の証明ではない（易しい母集団）。ログでは③と必ず分離する（下記）。

#### ⑤フック起動照会（trigger: `hook`）— 環境フックに促されたら

1. PostToolUse フック（user-level に配置済み・全プロジェクトで発火する）が「同じエラーが
   繰り返している」と検知すると、`[cairn]` で始まる想起メッセージが注入される。
   **これを見たら③と同じ手順で検索せよ**（ただし `--trigger hook`）。
2. ただし**ログの `trigger` は必ず `"hook"`**。③（自己判断で気づいて撃った）とは母集団が違う——
   ⑤は環境が気づかせた外発的な発火であり、④よりさらに自律性の証明から遠い。
   混ぜると③の成果を過大申告し、**フック導入前後の `stuck` が同じバケツに入って
   どちらの機構の成果か判別できなくなる**。
3. ③と⑤が同時に成立した場合（フックに促される前に自分で気づいていた場合）は `"stuck"` を選べ。
   フックの注入を読んでから動いたなら `"hook"` だ。迷ったら `"hook"`（過大申告より過小申告を選ぶ）。

### 3. 測定ログ v2（H7 検証期間のみ・配布版では削除）

上記 1（post）・2（①②③④⑤の search）が発火するたびに、`CAIRN_HOME\logs\h7-log.jsonl` に
**1 イベント 1 行の JSON** を追記せよ：

```json
{"ts": "<ISO8601>", "type": "post|search", "trigger": "demand|plan|stuck|ask|hook|null", "hit": true|false|null, "attribution": "<レコードID引用 or 'unused'>|null", "turns_to_resolve": <int|null>}
```

**`cairn-search` は記入済みの 1 行を stderr に吐く**（`--trigger` を渡していれば `trigger` も
埋まる）。それをコピーし、`attribution` と `turns_to_resolve` を埋めて追記するのが正規の手順。
記憶からスキーマを再構成するな——CLI の出力を使え。`cairn-post` 側は手書きのまま。

- **①発火**：`type` に `post`（投稿発火）または `search`（検索発火）を記録。
  `post` イベントでは `trigger` を含め残り全て `null` にせよ（投稿の成功や自レコード ID を入れない）。
- **②trigger 分類（v2 新規）**：`search` イベントは発火した動線に応じて `trigger` を
  `"demand"`（①）/ `"plan"`（②）/ `"stuck"`（③）/ `"ask"`（④）/ `"hook"`（⑤）のいずれかにせよ。
  **④（ask）・⑤（hook）と③（stuck）は必ず別母集団として記録する**——④はユーザ要求由来、
  ⑤は環境フック由来の易しい母集団なので、混ぜると自律性を過大申告する。
  GATE の合否母数は③のみ。
- **③ヒット有無**：`search` の場合、top-k に関連 gotcha（または①なら関連クラスタ）があったかを
  `hit` に記録。①で `clusterCount` が 0 なら `hit: false`。
- **④帰属申告**：②③④⑤で詰まり・計画・要求が解決/反映された後、以下の問いに答えて記録せよ
  （評価ではなく帰属を聞く。追従バイアス対策）：

  > 解決に至った今、フェッチ結果のうち**実際にお前の行動を変えた行があれば引用しろ**。
  > レコード ID 付きで。**「どれも使わなかった」が正当な回答である。**

  実際に行動（コード・アプローチ）を変えた記録があれば `attribution` にそのレコード ID を、
  無ければ `"unused"` を入れよ。「役に立ったか」を聞かれても忖度で答えるな。
  ①（demand）は行動変更ではなく提示なので `attribution` は常に `null` で良い。
- **⑤解決ターン数**：search 発火から実際に詰まり/計画/要求が解消するまでの会話ターン数を
  `turns_to_resolve` に記録せよ（フェッチ無しで解決した場合は `null`）。①は常に `null`。
