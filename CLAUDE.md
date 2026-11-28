# dcp-lighthouse — 引継ぎコンテキスト

灯台モデル (Lighthouse Model) のパイロット実装。DCP Pipeline を観測層として、マルチエージェント開発時代の
テスト/コード品質ストリームを扱う。灯台は DCP の「観測 → 予見 → 解釈 → 決定」のうち
**観測と予見を数理だけで、軽量に、較正つきで担う層** (2026-10-08 合意)。

**親**: dcp-core (DCP Pipeline コア・非公開) / **姉妹**: dcp-minecraft (高頻度ストリームの実証・非公開)
> 非公開プロジェクトはローカルに並べて置く前提。参照は名前で行い、パス表記はしない。

| 文書 | 役割 |
|---|---|
| `docs/LIGHTHOUSE_MODEL.md` | 概念設計 ($Q shadow・stream replay・コード応用) |
| `docs/LIGHTHOUSE_PILOT_DATA.md` | モックデータ要件・シナリオ・検証基準 (§10) |
| `docs/roadmap.md` | **作業の単位の台帳** (`### C<n>. 題`。agent-hub から依頼できる形) |
| `docs/devlog/ROADMAP_BRIEF.md` | 時系列の開発ログ (追記式・仕様ではない)。**過去の判定結果・数値・経緯の正本** |
| `README.md` | ステータス表・コマンド一覧 |

L1〜L5 は devlog 側の工程名で、台帳の C<n> とは別物。

---

## 現在地 (2026-11-28)

- **Phase 0 + Phase 1 完了**。L1〜L5 (足場・Brain write surface・ClaudeBrain・レンズチェーン・参照ゾーン) 完了。テスト 797 件
- **実データ較正期間 (Wikimedia / OTel、第 1〜5 段階) は完了**。収集は 2026-11-17 に停止 (タスク無効化・データ保持)。未使用の保留期間は無い
- **いまの実データは公開 CI の試験結果 (Kubernetes Prow、`data/prow/`)**。1 時間窓 × 参照 30 窓の構成 (`LIGHTHOUSE_PROFILE=test-stream`)・
  持続の名乗り (`/persistence`)・粗窓発火からのグループ別自動 replay まで本番配線済み (C12〜C28)。`mock` が既定で従来のまま
- **C25 (2026-11-27)**: 本物の回帰がある流れは **Mozilla Treeherder `autoland`** に決定 (人の分類 fixed by commit つき、2 日で回帰 26 塊。Prow の非ゲート定期ジョブは 7 日で回帰 0)。
  ジョブ単位・同じジョブ種は push の約 5% でしか走らない、という制約がある
- **C29 (2026-11-27)**: Treeherder 14 日の本物の回帰 156 件で本番の配線を測った (`data/treeherder/`、`run-treeherder-c29-report`)。ジョブ種の持続が 90% を拾い 3/4 は修正の push より先、ただし名乗りの 4 割は flaky。
  粗窓の下向きタイルは 37%、固定 10 件の同時多発はこの流れでは「忙しい時間」を拾うだけ、OS 系統での帰属は弱い
- **C35 (2026-11-27)**: 持続の名乗りに opt-in の flaky の履歴 (直近 10 回の失敗の割合) を添える。名乗りは落とさない。別の 14 日 (10-24〜11-06) で読む前に固定した 2 判定が成立 (札の差 31 ポイント・quiet の精度 60% 対 全体 48%)
- **C36 (2026-11-27)**: その履歴を本番の `/persistence`・SSE・dashboard に `LIGHTHOUSE_PERSIST_HISTORY=N` の opt-in で載せた (値は Treeherder で決めたもので Prow では未測定と応答が名乗る)
- **C34 (2026-11-28)**: 参照 30 窓の失敗数分布に対する相対的な同時多発検出 (`relativeFailureBurst`, opt-in)。上位 10% トリム平均 + 3×scale・最小 3 件・参照 8 窓未満は盲目。確認範囲 (Treeherder 10-24〜11-06 + Prow 89 日) で事前登録した 3 基準が 3/3 成立 (回帰なし失敗窓 4.6% 対 `fixed10` 61.1%、回帰窓との差 +16.9 pt、Prow 10/10・単発 0/379)
- **C30 (2026-11-28)**: 自前の試験結果・CI をリアルタイム投入する `POST /ingest/build` (`LIGHTHOUSE_SOURCE=ingest`, opt-in)。JSON と JUnit XML (`node --test --test-reporter=junit` 対応) を受け取り `RetentionBuffer`・`PersistenceDetector` (`/persistence`・SSE・任意 `LIGHTHOUSE_PERSIST_HISTORY=N`) へ供給
- **C37 (2026-11-28)**: 自前のプロジェクトの試験を `ingest` で常時流す。送り手 `server/scripts/lighthouse-test.mjs` (`npm test` が通る・`LIGHTHOUSE_INGEST_URL` 未設定なら素通し・送れなくても終了コードは不変)、
  受けたビルドを再起動をまたいで保つ `LIGHTHOUSE_INGEST_LOG` (opt-in)、窓を出さない常駐 `server/scripts/run-lighthouse-ingest.ps1`。dcp-lighthouse と agent-hub の実の試験で、名乗りが再起動の前後で一致することまで確認
- **次**: 台帳 `## 予定` は C37 (実装・レビュー修正済み、クローズ待ち)。未完は条件付きの保留・提案のみ (C7 量チャネル・C11 履歴窓数上限・C18 全 pass 帰無)。整備項目 C31〜C33 は 2026-11-25 に閉じた。詳細は `docs/roadmap.md`
- 数値・日付つきの経緯を知りたいときは `grep -n "^## " docs/devlog/ROADMAP_BRIEF.md` で見出しを引き、該当節だけ `Read` する (全文は 600 KB 超)

| | dcp-minecraft | dcp-lighthouse |
|---|---|---|
| 証明する性質 | 高頻度ストリーム処理 | 観測層と Brain 制御 |
| データ源 | Bukkit Plugin / 実 Minecraft | モック生成器 → 実データ (Wikimedia・OTel・Prow) |
| Brain の役割 | ルート変更・throttle・$V 更新 | 観測パラメータ操作・reroute・target schema 更新 |

---

## 起動・テスト

```
cd server && npm run dev          # tsc && node dist/index.js → http://localhost:3001
/demo/start?scenario=AR|CG|RC     # モックのシナリオ
npm test                          # tsc && node --test "dist/*.test.js" (scripts/lighthouse-test.mjs 経由)
```

- `npm test` は **`dist/*.test.js` を指定**する。ディレクトリ指定だと `dist/index.js` (実サーバ) が起動して `EADDRINUSE` になる
- `npm test` は送り手 `scripts/lighthouse-test.mjs` を通る (C37)。`LIGHTHOUSE_INGEST_URL` があるときだけ結果を灯台へ送る。node の試験の中から node の試験を起こすときは `NODE_TEST_CONTEXT` を消す (残すと子が親へ報告する形で走る)
- `BRAIN_MODE=claude` は **実課金の API 呼び出し**が走る (既定は `rule`)。配線確認は `ANTHROPIC_BASE_URL` のスタブで課金ゼロにできる
- 環境変数: `LIGHTHOUSE_PROFILE=mock|test-stream` / `LIGHTHOUSE_SOURCE=mock|prow|ingest` (`prow` は記録済み Prow を仮想時計再生、`ingest` は `POST /ingest/build` で JSON / JUnit XML 投入) / `LIGHTHOUSE_PERSIST_HISTORY=N` (持続の名乗りに flaky の履歴、C36・opt-in) / `LIGHTHOUSE_INGEST_LOG=<path>` (`ingest` の受理ビルドを再起動をまたいで保つ、C37・opt-in) / `PORT` (既定 3001)
- ブラウザでの実地確認は skill `run-lighthouse`、Wikimedia 収集器の運用は skill `wiki-collector-ops`

---

## Phase と検証基準

- **Phase 0** (Minecraft デモ + 手作り異常で真値を握り、コア機構を検証): $Q[observe] 抽出 → retention + replay (遡及的再観測) →
  並行オーバーレイ・チューニング割り込み → Brain 用スナップショット・パッケージ (Step 1〜3b)
- **Phase 1** (`test_result:v1` に皮を貼り替え、ドメイン表現の妥当性だけを問う): TestorAdapter・bitpos・RuleBrain・ダッシュボード (Step 4〜7)
- Phase 0 と Phase 1 は混ぜない (機構バグとドメインモデリングの混線を避ける)。詳細は MODEL.md §8 / PILOT_DATA.md §1.5
- **replay は分散縮小ではない**。保持した生データを別レンズ (`$Q[observe]`) で見直すこと (MODEL.md §5)

モックのシナリオ (`PILOT_DATA.md` §10 の基準): **AR** agent-C の pass 率 95%→70% (5 秒以内に reroute)・**CG** auth 領域の欠落
(10 秒以内にヒートマップに穴、持続で target-update)・**RC** 粗窓で見えない局所バースト (細窓の再観測で既知の位置・大きさで復元)。
背景は 50 events/sec の定常 (シナリオ間は静か)。late-arrival は ts 駆動集計が in-order と数値一致。

イベント: `["$S","test_result:v1",8,"ts","testId","agentId","areas","result","duration","weight","commitHash"]`。
エージェント 4 体 (A 基準 / B 広く浅い / C regression 候補 / D flaky)。area 空間は 256 bit 固定 (auth 0-31・payment 32-63・ui 64-127・utils 128-255)。

---

## ディレクトリ構成 (`*.ts` の隣に `*.test.ts`)

```
docs/            LIGHTHOUSE_MODEL.md / LIGHTHOUSE_PILOT_DATA.md / roadmap.md / devlog/ROADMAP_BRIEF.md
dashboard/       ブラウザ UI (index.html + app.js)
server/src/      Node.js / TypeScript
  ── 観測層コア ──
  q-registry.ts           $Q レジストリ (observe/pipeline/schema/compare/forecast の 5 層、書込時バリデート・書込ゲート)
  lens.ts                 applyLens = レンズチェーン (window/origin/align/group_by/downsample/decay/agg_func)
  lens-view.ts            1 ストリーム複数レンズ (LensView / ObservationOverlay)
  retention-buffer.ts     鮮度ゾーン ring + 参照ゾーン (疎化 = 加重)。IngestionBus.tap の上
  window-history.ts       窓要約の常設履歴 (疎化前に要約・1 時間)
  snapshot-curator.ts     $U。タイル選出と統計判定 (Šidák・連続性補正・isScorable・帰無 independent/overdispersed/variogram)
  comparison.ts           $Q[compare] を解決して採点する唯一の場所 (package が comparison を名乗る)
  forecast.ts / forecast-monitor.ts   $F の行 (kriging、virtual: true) と較正の常時監視
  calibration.ts          誤警報率/検出力の測定器 (レンズを引数に取る)
  q-collector-binding.ts / q-retention-binding.ts   $Q → StCollector / retention の動的 bind
  stream-profile.ts       定数の束を名前で選ぶ (mock = 従来 / test-stream)
  coarse-replay-trigger.ts   粗窓の発火 → group_by agentId の replay を自動発火 ($Q 行 `#regroup`)
  ── ドメイン (Phase 1) ──
  mock-stream-generator.ts / testor-adapter.ts / bitpos.ts
  brain-adapter.ts (interface) / rule-brain.ts (primary) / claude-brain.ts (LLM) / shadow-brain.ts (併走)
  dashboard.ts (SSE bridge・制御 API・POST /ingest/build) / index.ts (起動) / prow-live.ts (記録流の再生口) / ingest-build.ts (C30 リアルタイム投入) / ingest-log.ts (C37 受理ビルドの追記保存)
  ── 実データ (検証ハーネス・レポート。起動口は run-*.ts) ──
  wikimedia-collector.ts / otlp-receiver.ts / otel-flag-schedule.ts / real-data-harness.ts / range-coverage.ts
  prow-{import,events,replay,truth,persist,plant,shape,attribution}.ts   Prow の取り込み・再生・真値導出・植え込み・帰属
  treeherder-{import,stream}.ts   Treeherder autoland の取り込み (tier 1・個人情報を落とす) と、ジョブ単位の写し・人の分類による真値 (C29)
  ── §12 A/B 実験 ──  ab-fixture.ts / ab-harness.ts / ab-strategy-b.ts / anthropic-ask.ts
server/otel/     OTel Demo の extras (collector 設定・compose 上書き)
server/scripts/  run-wiki-collector.ps1 / run-h4-day.ps1 / lighthouse-test.mjs (C37 送り手) / run-lighthouse-ingest.ps1 (C37 常駐)
.claude/skills/  run-lighthouse / wiki-collector-ops
```

各 `run-*-report.ts` が何を測るかは README.md のコマンド一覧と、冒頭コメントを参照。

---

## 設計制約と不変条件 (破ると過去に踏んだ罠が戻る)

**dcp-core との境界** (2026-05-28、user 指示): コアには汎用の拡張点だけ (`StCollector.get/setWindowMs`・`IngestionBus.tap`・
`PipelineControl.onExtraDecision`)。**`$Q` ロジック本体は灯台側**。`FieldMapping` は path 解決専用なので `$Q` を相乗りさせない。
dcp-core を触るときは両プロジェクトで動作確認する。本番 AST 解析・mutation score・実テストランナー統合は将来 (パイロットは観測層の証明に集中)。

**統計層**
- 新しい機構は **既定の出力をバイト同一に保つ opt-in**。無加重レンズ・既存 fixture・A/B のシード集合を動かさない
- `count` は**実保持事象数**のまま。疎化・減衰は `weight` / `effectiveN` (Kish) で表し、`count` に代表数を入れない
- 採点可能性は述語 1 つ (`isScorable` / `isReferenceUsable`) を全箇所が呼ぶ。コピーを作らない (3 コピーがズレた前例)
- **沈黙と盲目を区別する**。採点できない・参照が無い・集計を拒否した、は申告する (`unscoredGroups`・`aggFuncUnscored`・`referenceUsable`)。収集の欠落も盲目
- ガード・フラグには**読み手**を付ける (読み手 0 件の `getSummary`/`aggFuncUnscored` が誤診断を生んだ)。動く経路だけでなく拒否される経路も試す
- 仮想 (予見・間引き・植え込み) は専用の軸 `virtual: true` で持ち、読み手は全てそれを見る
- 予見の読み手の物差しは**較正** (誤警報率が分かる形)。閾値で実データを黙らせない

**実データの規律**
- 規則 (判定線・真値の導出) は**測る前に固定**する。保留期間は 1 回だけ使い、**使用済みは探索データ**として扱う (`--holdout` は拒否)
- 実データで警報率を設計値に合わせて調整しない。対照 (シャッフル・植え込みなし) を同じ出力に並べる
- 「本物の回帰が無い流れ」の検出力は植え込みでしか測れない。植え込みは清潔で上限になる

**Brain**
- primary は **RuleBrain 固定**。ClaudeBrain は shadow 併走のみで、昇格は `GET /brain` のログを根拠に別途判断
- **発火 (いつ異常か) は curator**、LLM には**レンズ選択**だけを渡す。σ・タイル判定をプロンプトに入れない (転写の罠)
- 審議は tick から切り離す (`decide()` は同期)。提案の関所 (`validateObserveParams`・`lensGate`) は Brain 側、`registry.set` の catch は最後の砦
- shadow は per-tick 一致率を出さない (cadence の差を測ってしまう)

---

## 常設ルール

- 実データ派生 (非公開の姉妹プロジェクト) からの還元フィルタ: 「機構を行使/変更する or ドメイン非依存知見を生む」ものだけを灯台の実証に数える
- 作業の単位は台帳 `docs/roadmap.md` に `### C<n>. 題` で起票する。設計書の中に W1・Step n の独自番号を作らない
- 個人環境固有の手順 (絶対パス・ローカル CLI/DB の起動・進行中の測定) は**このファイルに書かない**。`CLAUDE.local.md` (untracked) に置く。
  本ファイルは公開リポジトリの一部なので、パスは常にリポジトリ相対で書く
- 長い経緯・数値の追記は `ROADMAP_BRIEF.md` へ。ここは**現在地・地図・不変条件**だけを短く保つ

@CLAUDE.local.md
