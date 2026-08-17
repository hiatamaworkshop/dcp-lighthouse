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
```

1 trial 1 行の JSON を stdout に、進捗 (`stop_reason` / output token 数を含む) と
集計を stderr に出す。

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
- [ ] **L3 (本丸)** ClaudeBrain — §12 A/B 実験 (数列のみ vs snapshot package) → `BRAIN_MODE=claude` で RuleBrain と shadow 併走。LLM 起点の $Q 操作が核心。
      前段の A/B 実験は実行済みだが、**当初の仮説「提示形式が判断を助ける」は検証できていない** (再分析で下方修正)。
      副産物として curator の較正欠陥を検出し、Šidák 補正で package 単位の誤警報率 29%→6.5% に是正済み。
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
      詳細は ROADMAP_BRIEF.md 2026-08-17 参照
- [x] **L4** レンズチェーン — 参照レンズ (検出を二項演算に)・窓格子 (`origin`/`align` で格子をレンズの性質にする)・
      `group_by` (比較器を単一分布の前提に戻す)・`downsample_factor` (十分統計量の厳密プーリングで窓を間引く)
      を実装。混合ストリームで 1.77σ にしか見えない単一エージェントの dip が、グループ内では 3.51σ になる。
      `downsample_factor` は dashboard の `/control/coarse-downsample?factor=N` から live coarse view に
      書き込めるよう配線済み (ライブ配信側のスパン計算に潜んでいた乗算漏れも合わせて修正)。
      残るチェーン段は `decay` / `agg_func` (curator の統計モデルに触れるため未着手)
- [ ] **L5** retention 参照ゾーン — 鮮度ゾーンの上に疎化レイヤー (長期稼働で効く層)

現在テスト計 215 件、全 green。
