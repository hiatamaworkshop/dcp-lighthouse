# dcp-lighthouse

灯台モデル (Lighthouse Model) のパイロット実装。
DCP Pipeline を観測層として、マルチエージェント開発時代のテスト/コード品質ストリームを扱う。

## 位置づけ

- 親プロジェクト: **dcp-wrap** (DCP Pipeline コア) — 非公開
- 姉妹プロジェクト: **dcp-minecraft** (高頻度ストリーム処理の実証) — 非公開

dcp-minecraft が「DCP Stream を止めずに観測層を被せられる」ことを示したのを受け、
本プロジェクトでは同じ仕組みをコード生成検証ドメインに応用する。
本リポジトリは単体で動く (親プロジェクトはビルドに不要)。ドキュメント中でこれらの
名前が出てきた場合、参照先のソースは公開されていない。

## ドキュメント

**設計仕様**

- [docs/LIGHTHOUSE_MODEL.md](docs/LIGHTHOUSE_MODEL.md) — 灯台モデルの概念・$Q shadow・stream replay
- [docs/LIGHTHOUSE_PILOT_DATA.md](docs/LIGHTHOUSE_PILOT_DATA.md) — モックデータ要件・シナリオ・検証基準
- [CLAUDE.md](CLAUDE.md) — 引継ぎコンテキスト (実装順序・現在地)

**開発ログ** — 仕様ではなく時系列の作業記録。過去の節には後に撤回された結論もそのまま残る

- [docs/devlog/ROADMAP_BRIEF.md](docs/devlog/ROADMAP_BRIEF.md)

## 構成

```
dcp-lighthouse/
  docs/        設計仕様
    devlog/    時系列の開発ログ
  server/      Node.js / TypeScript (MockStreamGenerator, TestorAdapter, RuleBrain, dashboard SSE)
  dashboard/   ブラウザ UI (shape-oriented panels)
```

## 開発

```sh
cd server
npm install
npm run dev    # tsc && node dist/index.js
npm test       # tsc && node --test dist/
```

**§12 A/B 対策B (上位モデルでの再測定)** — `ANTHROPIC_API_KEY` が必要な実課金スクリプト。
`npm test` には含まれない (node の test glob は `*.test.js` のみを拾う)。

```sh
npm run build
ANTHROPIC_API_KEY=sk-... node dist/run-ab-strategy-b.js claude-sonnet-5 claude-opus-5

# 失敗した trial だけ再実行 (バッチ全体を再サンプリングしない)
ANTHROPIC_API_KEY=sk-... node dist/run-ab-strategy-b.js --seeds=36,89 claude-opus-5

# 多重比較の文脈を足したアームの検証 (偽陰性ガード込み)
ANTHROPIC_API_KEY=sk-... node dist/run-ab-strategy-b.js --arm=curated_context --fixtures=fp,rc,ar claude-opus-5
```

1 trial 1 行の JSON を stdout に、進捗 (`stop_reason` / output token 数を含む) と
集計を stderr に出す。`--fixtures` の `fp` は偽陽性 (正解=棄却)、`rc`/`ar` は真陽性
(正解=追認) で**正解の向きが逆**なので、集計は真値に対する正誤で報告される。
アームの優劣は「fp が改善し、かつ rc/ar が悪化しない」場合にのみ主張できる。

## ステータス

Phase 0 + Phase 1 実装完了。以後の工程は L1–L5 に再編済み — 詳細は
[docs/devlog/ROADMAP_BRIEF.md](docs/devlog/ROADMAP_BRIEF.md) の「本体ロードマップ再編」節、
実装順序の全体像は [CLAUDE.md](CLAUDE.md) を参照。

**Phase 0 — コア機構検証 (Minecraft ベースライン + 自作異常)**

- [x] scaffold (server / dashboard / docs)
- [x] $Q レジストリ — `server/src/q-registry.ts` (scope パース・レイヤー別 read・swap history・onChange)
- [x] Step 1: $Q[observe] → StCollector window 動的 bind — `server/src/q-collector-binding.ts` (実 collector を実行中に reshape)
- [x] Step 2: retention + 遡及的再観測 — `server/src/retention-buffer.ts` (鮮度ゾーン ring on IngestionBus.tap) + `server/src/lens.ts` (`applyLens` チェーン型)。粗窓で消えるバーストを細窓 replay で注入真値通り復元
- [x] Step 3: 並行 $ST オーバーレイ・チューニング割り込み・動的データ追加 — `server/src/lens-view.ts` (LensView / ObservationOverlay)。1ストリームを複数レンズで同時観測、$Q 変更で live 再構成、後付け view を backfill
- [x] Step 3b: Brain 向け観測 UI (スナップショット・パッケージ) — `server/src/snapshot-curator.ts` (SnapshotCurator / $U)。spike/gap/step_up/step_down/divergence/baseline タイルを機械的選出、注入真値で z-score 照合

**Phase 1 — test_result:v1 ドメイン適用**

- [x] Step 4: MockStreamGenerator + TestorAdapter — `server/src/mock-stream-generator.ts`, `server/src/testor-adapter.ts`。test_result:v1 生成・正規化、per-agent/per-domain STSnapshot
- [x] Step 5: bitpos — `server/src/bitpos.ts`。256-bit 固定仮想 area space (auth/payment/ui/utils)、coverageGaps、randomBits
- [x] Step 6: BrainAdapter + RuleBrain — `server/src/brain-adapter.ts`, `server/src/rule-brain.ts`。AR/CG/RC の 3 ルール、rerouteSchema/schemaUpdate/replayRequest 提案
- [x] Step 7: DashboardServer + UI — `server/src/dashboard.ts`, `dashboard/index.html`, `dashboard/app.js`。SSE ブリッジ + per-agent バー・domain ヒートマップ・スナップショットタイル・Brain decision log

灯台モデルのコアはドメイン非依存。Phase 0 は真値が既知のストリーム
(Minecraft イベント + 自作異常) で機構を検証し、Phase 1 でコードテスト
ドメイン (`test_result:v1`) に皮を貼る。詳細は
[docs/LIGHTHOUSE_PILOT_DATA.md](docs/LIGHTHOUSE_PILOT_DATA.md) §1.5。

**本体ロードマップ (L1–L5、実データ派生との並走から生まれた再編)**

- [x] **L1** 足場固め — 実運用ストリームからの field findings を core に還元 (ts≤now クロック方針・count 窓の有効性フラグ・baseline 有効性ゲート+閾値フロア)
- [x] **L2** Brain write surface + replay 表面化 — `$Q[schema].baseline_delta` 昇格 (RuleBrain がレジストリ経由で読み、dashboard から書ける)・RC replayRequest の区間指定 (fromTs/toTs)・dashboard 粗(live)/細(replay) 対比 UI
- [x] **L3 (本丸)** ClaudeBrain — `server/src/claude-brain.ts` + `server/src/shadow-brain.ts`。
      `BRAIN_MODE=claude` で RuleBrain と shadow 併走 (RuleBrain がハンドルを握ったまま、
      LLM の提案は記録のみ)。プロンプトが**レンズの語彙を教える**ので `replayRequest` に
      `window_ms`/`group_by`/`downsample_factor`/`decay` を載せられる = LLM 起点の $Q 操作。
      同期 `decide()` に非同期の審議を載せるため**審議を tick から切り離した** —
      決定は誘発した snapshot の数 tick 後に出て、`meta.snapshotTs` がどの時点を
      考えていたかを名乗る。`validateObserveParams` を通らないレンズは**決定になる前に棄却**
      (index.ts の catch は最後の砦であって関門ではない)。詳細は ROADMAP_BRIEF.md 2026-08-18。
      **実走測定済 (2026-08-18、Sonnet 5、実課金 $0.49、$0.0045/審議)**:
      LLM は確かに $Q を操作する — 出た replayRequest は**全て** `window_ms:1000` +
      `group_by:["agentId"]` を載せ (RuleBrain が RC 用にハードコードしているレンズと同じ)、
      理由文も機序 (「4 エージェント混合の粗窓が短く深い dip を隠す」) を言い当てていた。
      **ただし識別ができていない** — RC のバースト自体は捉えるが、何も起きていない agent にも
      同程度の頻度で撃つ (agent-C 名指し 2/17 に対し別対象 5/17、QUIET でも 27 審議中 10 回提案)。
      **「どう操作するか」は正しく「いつ・何に対して」がノイズから選ばれている。**
      よって **primary 昇格は見送り**。次の一手は生の系列ではなく curator の
      snapshot package (σ 付き) を渡すこと = 下の §12 curated アームそのもの。
      **追測定 (2026-08-18、2×2×2、$1.41)** — 「これはモデルの性格か、問い方か」を切り分けた。
      QUIET (陰性) / AR (断定チャネルの陽性) / RC (観測チャネルの陽性) ×
      base / placebo (長さ対照) / disciplined × Sonnet 5 / Sonnet 4.6 の 12 セル。
      **枠組みが支配的** — 長さを揃えた placebo では何も動かず (p=1.0)、内容を入れると
      提案率が 14/22→3/25 (p=0.0003)。モデル軸は 4 比較すべて有意差なし (n 不足)。
      **ただし散文で入るのは「全体の保守性ノブ 1 個」で、チャネル別の証拠バーにはならない** —
      「断定を上げ観測変更は据え置く」と明記したのに、各モデルが**最も多用していた
      チャネルだけ**が削られた (Sonnet 5 は RC の replayRequest が 0/21 = 中核主張のチャネルが消失、
      4.6 は断定 9→2 と引き換えに AR 検出 lag が 7.2s→14.3s)。**どちらの腕も出荷できない。**
      なお断定的な誤警報だけなら Sonnet 5 は **4.5% = curator の設計値 4.55% と同水準**で、
      上の「27 審議中 10 回」はほぼ可逆な `replayRequest` だった。
      **識別 (誰を名指すか) はプロンプトでは全く動かない。**
      → 設計方針: **ゲートはコード側 (curator) に置き、LLM にはレンズ選択を渡す**。未実装。

      前段の §12 A/B 実験 (数列のみ vs snapshot package) は実行済みだが、
      **当初の仮説「提示形式が判断を助ける」は検証できていない** (再分析で下方修正)。
      副産物として curator の較正欠陥を検出し、Šidák 補正 (対策A) で package 単位の誤警報率 29%→6.85%、
      さらに**連続性補正 (2026-08-17) で 6.85%→4.40%** = 設計値 4.55% に着地させた。
      補正は格子を仮定せず十分統計量から**検出**するので、連続データでは自分で切れる (実測ビット同一)。
      なお補正で curator が発火しにくくなった結果 **fp シード集合が変わっており、
      今後の対策B 実行は記録済み 18 trial と比較不能**。
      **対策 E (reason フィールド) 実装済み** — 回答 JSON に verdict の根拠を書かせ、
      「タイルを読んだだけ」か「吟味したか」を区別できるようにした。
      **対策 B 実行済み (2026-08-17、Sonnet 5 / Opus 5 × 9 seed)** — `server/src/anthropic-ask.ts`
      (直 SDK askFn)・`server/src/ab-strategy-b.ts` (false-positive QUIET seed 選定)・
      `server/src/run-ab-strategy-b.ts` で実行。パース成功 16/18 trial は全て verdict:"anomaly"
      (curator の誤検知タイルをそのまま追認、reject 0 件) — haiku と同じ結果で、
      「上位モデルなら curator の誤検知を却下できる」という仮説はこの回では支持されず。
      Opus 2 trial のパース不能は**原因特定済み** — Opus 5 が既定で出す thinking ブロックが
      `max_tokens` 予算を食っていた (再実行で解消、両方 anomaly)。
      なお `reason` フィールドを見るとモデルは σ 値・近傍窓・形状まで吟味した上で追認しており、
      プロンプトが「N 窓中の 1 本」という多重比較の文脈を伝えていないことが効いている可能性がある。
      これを検証する第3アーム `curated_context` と、その前提となる `SnapshotPackage.selection`
      (package が自分の family size と閾値を自己記述する) を整備済み — **実行は未着手**。
      詳細は ROADMAP_BRIEF.md 2026-08-17 参照
- [x] **L4** レンズチェーン — 参照レンズ (検出を二項演算に)・窓格子 (`origin`/`align` で格子をレンズの性質にする)・
      `group_by` (比較器を単一分布の前提に戻す)・`downsample_factor` (十分統計量の厳密プーリングで窓を間引く)
      を実装。混合ストリームで 1.77σ にしか見えない単一エージェントの dip が、グループ内では 3.51σ になる。
      `downsample_factor` は dashboard の `/control/coarse-downsample?factor=N` から live coarse view に
      書き込めるよう配線済み (ライブ配信側のスパン計算に潜んでいた乗算漏れも合わせて修正)。
      `decay` は step / exp の両形を実装済 (2026-08-17) — `decay_anchor` を `align` と同じ思想で
      新設し、再現可能な `segment_end` を既定にした (壁時計アンカーだと過去セグメントの再観測が壊れる)。
      exp 形は窓を**加重**にするので較正を測り直した結果、**加重レンズが連続性補正を黙って
      切っていた**ことが判明 (誤警報 7.1% = 補正導入前の値に逆戻り)。二値性の恒等式は
      count を総重みに置き換えれば加重でも成立するので、格子検出を一般化して 4.5% に復帰。
      無加重の数値は 1 つも動いていない。`agg_func` は throw ガードのみ実装済 (2026-08-18) —
      `validateObserveParams` が `"mean"`(既定と同じ) 以外の値を RangeError で拒否する。
      `"mean"` は `WindowStat` が既に `{mean, count, sumSq}` そのものなので別コードパスは不要。
      **median/percentile 本体は未実装** — 十分統計量からプールできず、downsample・参照レンズが
      依存する分解可能性と噛み合わないため、`WindowStat` の構造変更 (生値保持 or sketch) が要る。
      着手前に ROADMAP_BRIEF.md 2026-08-18 (5) §C を読むこと
- [x] **L5** retention 参照ゾーン — 鮮度ゾーンの上の疎化レイヤー (2026-08-22 完了)。
      形状は固定比率 (N個に1個、`LensEvent.weight = N`)。**疎化は「加重」であって新しい統計
      ではない** — exp decay で実装・較正済みの `weights`/`effectiveN`/加重 `poolStats` を
      そのまま使う (`aggregate()` で decay の重みと掛け算で合成)。`count` は無変更 (代表数を
      入れない)。`retention-buffer.ts` に参照ゾーンを新設し、`segment()` が鮮度+参照ゾーンを
      透過的に結合するので既存呼び出し元は無変更。デフォルトはオフ (opt-in)。
      **較正測定**: x2 (実効n≈500) は誤警報4.0%(設計4.55%近傍)で安全域、x5以降は実効n低下による
      既知の「薄い窓」残差に合流し悪化 (疎化固有の新規メカニズムは無し)。**本番配線**:
      `index.ts` に `REFERENCE_WINDOW_MS=鮮度ゾーン×10`・`REFERENCE_THINNING_RATIO=2`
      (較正で実測した安全域の値)。**初の実読み手 `GET /control/replay?fromTs=&toTs=&window_ms=`
      も実装済み** — 手動トリガーの制御エンドポイント。本番構成のまま起動した実サーバで
      120秒の鮮度ゾーンを超えた区間を実際に指定し、`referenceUsable:true` が返ることを
      実地確認済み (bespoke bufferでのユニットテストではなく、本番配線を通した検証)。
      `$Q` 経由の動的再設定は未着手 (setter未実装)。
      詳細は ROADMAP_BRIEF.md 2026-08-22 (2)〜(5)

現在テスト計 360 件、全 green。

## BRAIN_MODE

```sh
npm run dev                                  # BRAIN_MODE=rule (既定)。RuleBrain 単独
ANTHROPIC_API_KEY=sk-... BRAIN_MODE=claude npm run dev   # ClaudeBrain を shadow 併走
```

shadow モードでは **RuleBrain の決定だけが適用され**、ClaudeBrain の提案は
`[shadow] (not applied) ...` として記録されるだけ。走行中の集計は **`GET /brain`** で読める
(rule モードでは `{"mode":"rule"}`)。昇格判断の材料はここ:

```sh
curl -s http://localhost:3001/brain
# llm:    生涯カウンタ (deliberations / unparseable / refusals / truncated / discarded / rejectedProposals)
# tally:  primary と shadow の走行中の決定タリー (log の trim を受けない実数)
# recent: 直近 5 審議の stop_reason と決定型
```

環境変数:

| | 既定 | |
|---|---|---|
| `BRAIN_MODE` | `rule` | `rule` \| `claude` |
| `CLAUDE_BRAIN_MODEL` | `claude-sonnet-5` | 実測済みは `claude-sonnet-5` / `claude-sonnet-4-6` |
| `CLAUDE_BRAIN_INTERVAL_MS` | `15000` | 審議の下限間隔 (支出ガード) |

`BRAIN_MODE=claude` は**実課金**。キー未設定・不正な `BRAIN_MODE` は起動時に落ちる。

**モデル選択の落とし穴 (2026-08-18 実測)**:

- **`claude-opus-5` は現在このプロンプトを拒否する** — `stop_reason:"refusal"`、出力 0 トークン
  (11/11 再現)。最小プロンプトには正常応答するのでアクセス問題ではない。現状 opus を指定してはいけない。
  かつては refusal が `stats.unparseable` に化けて「モデルが JSON を書けない」と読めたが、
  **`onMeta` を配線したので `/brain` の `refusals` / `lastStopReason` で区別できる** (2026-08-18 修正)
- **`claude-haiku-4-5` は `output_config.effort` を 400 で拒否**する。指定するなら
  `index.ts` の `makeAnthropicAsk({ ..., effort: "low" })` から `effort` を外す必要がある
