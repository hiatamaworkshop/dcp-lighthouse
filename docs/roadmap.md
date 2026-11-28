# 項目の台帳

作業の単位は `### C<n>. 題` の節。設計・経緯は `docs/devlog/ROADMAP_BRIEF.md` と各設計書に置く (L1〜L5 などの工程名は devlog 側の呼び名で、ここの C<n> とは別)。

## 予定

- [ ] C18

## 閉じた項目

- [x] C40 2 値の厳密な裾を `EXACT_MAX_COUNT` を越えても計算する (2026-11-28、opt-in `CurationOptions.exactBinaryTail` で実装。記録は ROADMAP_BRIEF の 2026-11-28 （11） の節)
  - `snapshot-curator.ts` の `betaBinomialTail`: 観測した個数から外向きに比の漸化式で足し、残りが和の $10^{-17}$ 未満と証明できるときだけ打ち切る。opt-in では $n \le 2{,}000$ も同じ和を通るので継ぎ目が無い。`selection.exactBinaryTail` で名乗る
  - 既定の継ぎ目 (参照の失敗が通算 1 件): gate の z が $n = 2{,}000 \to 2{,}001$ で $k=1$ は −1.96 → −2.51、$k=3$ は −3.96 → −13.29。(9) の `5.21σ` は生の z の値だった
  - $n = 10^5$ の窓 1 つの `curate` は 0.02〜0.07 ms (感度つきで 1.6 ms 以下)
  - 試験 820 件 (+5)、全 green。本番の配線には入れていない (C18 の opt-in が内側で有効にする)

- [x] C39 参照に対する同時多発 (C34) を本番の粗窓と自動 replay につなぐ (2026-11-28、opt-in `LIGHTHOUSE_RELATIVE_BURST=1` で実装・Prow 89 日を本番の配線に流して C34 の数えと窓・件数まで一致。記録は ROADMAP_BRIEF の 2026-11-28 （10） の節)
  - `coarse-replay-trigger.ts` (`parseRelativeBurst`・`describeRelativeBurst`・`relativeFailures.bursts` での発火、盲目からは発火しない)・`index.ts` (本番の `Comparator` に `relativeFailureBurst: true`)・`dashboard.ts` (SSE と `/status` の `relativeBurst`: 値・「この流れでは未測定」・直近の live package の盲目と発火)・`dashboard/app.js` (相対だけの窓を破線のタイル)
  - 全 pass の参照の上の 6 件は opt-in でだけ `#regroup` に届くが、その replay は 3 ジョブとも `unscoredGroups` で帰属しない (帰属は C18)
  - `run-prow-c39-report.ts` (`prow-c34-stream.ts` に C34 の数えを切り出し): 相対 13 窓・固定 10 件 10 窓・package 2,134・盲目 8 が一致。実サーバ (3011、`prow` 09-24〜26) で 09-26 01 時の 5 件が `#regroup` に届いた
  - 試験 815 件 (+8)、全 green。dashboard の描画は**ブラウザで見ていない** (構文検査と SSE・`/status` の中身まで)。常駐の受け手 (3001) では未有効 (有効にするかは user 判断)

- [x] C38 受けたビルドの保存 (`LIGHTHOUSE_INGEST_LOG`) を、名乗りを変えずに切り詰める (2026-11-28、user 決定で C37 の積み残しから起票。古いビルドを先頭行のチェックポイントへ畳む方式で実装し、試験と実の `builds.jsonl` の写しで再起動の前後の一致を確認。記録は ROADMAP_BRIEF の 2026-11-28 （8） の節)
  - 単に消すと、続いている連続失敗の途中で切れたとき同じ失敗を二度名乗る (試験で再現: 全部なら `h1` の 1 件、後ろだけなら `h6` の 1 件)。flaky の履歴・通った commit・通算・再送の記憶も欠ける
  - `ingest-log.ts`: opt-in `LIGHTHOUSE_INGEST_LOG_KEEP_HOURS=N` (保持 34 時間未満・ログ無しは起動時に拒否)。起動時に、先頭から続く N 時間より古いビルドを `LiveBuildIngestor.checkpoint()` の 1 行に畳む (tmp → fsync → rename、書けなければ警告して元のまま)。`restoreFromLog` を本番と試験が共に通る
  - `PersistenceDetector.exportState / importState` (commit は表引き)。設定 (flaky の履歴の N・`maxPassedCommits`) が違うチェックポイントは起動を拒否
  - 試験 807 件 (+10)、全 green。実の 3 ビルドの写しで切れ目 2 通り × 2 回の起動とも名乗り 5 件と `/status` が一致。チェックポイントは約 43 万バイト (試験約 1,700 件ぶん) で、ファイルは「チェックポイント + N 時間ぶん」で頭打ち
  - 常駐: `run-lighthouse-ingest.ps1 -KeepHours` (既定 168)。タスク `dcp-lighthouse-ingest` (ログオン時) に登録し、タスクから起こして復元を確認。ユーザ環境変数 `LIGHTHOUSE_INGEST_URL` を常設。実の常駐ではまだ畳む対象が無い (最古のビルドが 168 時間より新しい)

- [x] C37 自前のプロジェクトの試験結果を `ingest` で常時流す運用を始める (2026-11-28、送り手・再起動をまたぐ保持・窓を出さない常駐を実装し、dcp-lighthouse と agent-hub の実の試験で再起動の前後の一致まで確認。レビュー修正込み。記録は ROADMAP_BRIEF の 2026-11-28 （5）〜（7） の節)
  - `server/scripts/lighthouse-test.mjs` (`npm test` が通る・`LIGHTHOUSE_INGEST_URL` 未設定なら素通し・送れなくても終了コードは不変・中断した実行は送らない)。コミットは HEAD、未コミットの変更があれば `HEAD+dirty.<git diff HEAD のハッシュ>`、diff が読めなければ送らない (同じ HEAD での pass を flaky と読ませない)
  - `ingest-log.ts` (`LIGHTHOUSE_INGEST_LOG`、opt-in・`ingest` 専用): 受理したビルドだけを fsync で追記し、起動時に `LiveBuildIngestor.restore` が同じ経路に流し戻す。書く前に `PersistenceDetector.checkOrder` で順序違反を拒否。書きかけの末尾は切り落として警告、途中の壊れた行は起動を拒否
  - `server/scripts/run-lighthouse-ingest.ps1`: `conhost --headless` 経由で常駐、ログは `data/logs/`、PID は `data/lighthouse-ingest.pid`。既定の `-Node` は `process.execPath` (nvm の shim の PID を記録すると止めても本物が残る、2026-11-28 （7）)
  - `/status` に `liveReference` (`ingest` のときだけ。粗窓の参照が盲目か)。`LiveBuildIngestor.lastScheduledMs` を単調に
  - 実サーバ: dcp-lighthouse 793 件・失敗 0、agent-hub 888 件・失敗 5 (agent-hub に元からある C126 の試験)。2 回目で名乗り 5 件、PID 5216 → 13676 の再起動の前後で `/persistence`・`/status` の `ingest` が一致。試験 797 件、全 green
  - 残したもの: タスクスケジューラへの登録・常設の `LIGHTHOUSE_INGEST_URL` は user の判断で未設定。保存の切り詰めは無い (約 16 万バイト/ビルド)。自前の全 pass の流れでは粗窓の参照はほぼ盲目 (C18 の状況)

- [x] C30 自前の試験実行・CI 結果をリアルタイム投入できる入口 (`POST /ingest/build`) を作る (2026-11-28、opt-in `LIGHTHOUSE_SOURCE=ingest` で JSON / JUnit XML 両対応を実装・実サーバで 2 ビルド連続失敗の持続名乗りまで確認。記録は ROADMAP_BRIEF の 2026-11-28 （3） の節)
  - `ingest-build.ts` (`parseIngestBuildJson`・`parseIngestBuildJunit`・`LiveBuildIngestor`): JSON ビルド形式と JUnit XML (`prow-import.ts` の `parseJunit` を再利用、`node --test --test-reporter=junit` 対応) を `ProwBuild` へ正規化し、`PersistenceDetector` (FIFO 有界 `passedOn`・FIFO 上限 1000 名乗り・任意 `flakyHistory`) と `RetentionBuffer` / `ObservationOverlay` へ供給
  - `dashboard.ts`・`index.ts`・`prow-live.ts`・`dashboard/app.js`: `POST /ingest/build` (上限 10 MiB・`400`/`405`/`409`/`413` ガード)、`LIGHTHOUSE_PERSIST_HISTORY` の `ingest` 対応、`PORT` 環境変数、`/status`・SSE・バッジの `ingest` 表示。`mock`・`prow` の既定出力は不変
  - 後追いの fix (2026-11-28): `ingest` も `test-stream` 以外では起動時に拒否 (`checkSourceProfile`、mock の窓で盲目のまま動いていた)・同じ `job` + `buildId` の再送を `409` で拒否 (`DuplicateBuildError`、連続失敗を偽装しうる。記憶は FIFO 1 万件)・経路を `/ingest/build` の完全一致に。試験 781 件
  - 試験 778 件 (+9、全 green)。実サーバ (`LIGHTHOUSE_PROFILE=test-stream LIGHTHOUSE_SOURCE=ingest LIGHTHOUSE_PERSIST_HISTORY=10`) で JUnit XML + JSON 2 ビルド投入 → `/persistence` 名乗り・`/status`・`/demo/start` 409 を確認 (ブラウザ描画は `app.js` 構文検査まで)
- [x] C34 同時多発の名乗りを、固定の件数ではなく参照に対する多さで出す (2026-11-28、opt-in `relativeFailureBurst` で実装・事前登録 3 基準が未使用の確認範囲で 3/3 成立。記録は ROADMAP_BRIEF の 2026-11-28 （2） の節)
  - `snapshot-curator.ts` (`CurationOptions.relativeFailureBurst` / `C34_RELATIVE_BURST` / `countRelativeFailureBursts`)・`prow-replay.ts`: 参照 30 窓の上位 10% トリム平均 + 3×scale (`max(1, sqrt(max(mean, var)))`)・最小 3 件・参照 8 窓未満は `blind: true`。既定 (`mock`・`test-stream`) のパッケージはバイト同一。単体試験 +7 件
  - `run-treeherder-c34-report.ts`: 規則と 3 基準を使用済み探索データ (Treeherder C29 + Prow 89 日) で決め、確認範囲を読む前にコミット (`9950fdb`)
  - 確認範囲 (Treeherder `2026-10-24〜11-06`・助走 `10-22`〜・回帰 161 件 + Prow 89 日): Treeherder 回帰なし失敗窓 4.6% (`fixed10` 61.1% から −56.5 pt、基準 i 成立)・回帰窓との差 +16.9 pt (基準 ii 成立)・Prow `>=10` 10/10 かつ単発 0/379 (基準 iii 成立)。出力は `data/logs/c34-treeherder-20261128.txt`
- [x] C36 本番の `/persistence` の名乗りに flaky の履歴を載せる (2026-11-27、user 決定: 環境変数で opt-in・未測定と名乗る。記録は ROADMAP_BRIEF の 2026-11-27 （4） の節)
  - `LIGHTHOUSE_PERSIST_HISTORY=N` (`parsePersistHistory`、`prow` 以外・正の整数以外は起動時に拒否) → `ProwPersistenceFeed` に `flakyHistory`。`/persistence` に `flakyHistory`、SSE に `persistenceHistory` (N・F=10%・「C35 は Treeherder で決めて確かめた値で、この流れでは未測定」)、dashboard の各名乗りに quiet / flaky / short の札
  - 未設定なら `/persistence`・SSE・起動ログは従来のまま (C22 の試験は無修正で通る)。試験 761 件 (+4)
  - 実サーバ (Prow 11-02〜11-04、7200 倍): 付けたとき e2e の 1 件に `history` 2/10 (flaky)、付けないとき従来の形。Prow の 89 日の名乗り 2 件は、C13 の回帰 = 2/10 (flaky)・C13 の flaky = 1/10 (quiet) で札と真値が逆 (2 件なので何も言えない)
  - dashboard の描画はブラウザでは見ていない (app.js の構文と SSE の中身まで)
- [x] C35 持続の名乗りに、ジョブ種 (試験) ごとの flaky の履歴を持たせる (2026-11-27、user 決定: 名乗りは落とさず度合いを添える。確認範囲で読む前の 2 判定はどちらも成り立った。記録は ROADMAP_BRIEF の 2026-11-27 （3） の節)
  - `prow-persist.ts`: `PersistenceDetector` の opt-in `flakyHistory: { runs: N }`。名乗りに、連続失敗が始まる前の直近 ≤ N 回の結果 (`history: { runs, fails }`) を添える。N 未満は `runs` < N のまま名乗る。オプション無しの出力は C29 のレポートの再実行でバイト一致。試験 757 件 (+3)
  - `run-treeherder-c35-report.ts`: quiet (直近 10 回の失敗 ≤ 10%)・flaky・short に分けた精度と回帰の捕捉。N・F と判定の線は使用済みの C29 範囲で決め、確認範囲を読む前にコミット (`e2fc395`)
  - 確認範囲 2026-10-24〜11-06 (助走 10-22〜、2,220 push・欠落 0・回帰 161 件): 札の差 31.4 ポイント (≥ 15)・quiet か short での捕捉 134/144 = 93.1% (≥ 90%)。出力は `data/logs/c35-treeherder-20261127.txt`、探索は `c35-explore-c29range-20261127.txt`
- [x] C29 選んだ実流で本物の回帰に対する名乗りを測る (2026-11-27、Treeherder `autoland` 14 日・回帰 156 件。持続 90%・修正より先 105/140、下向きタイル 37%、同時多発は回帰の無い窓の 57% でも発火、帰属は exact 11/163。記録は ROADMAP_BRIEF の 2026-11-27 （2） の節)
  - `treeherder-import.ts`・`run-treeherder-import.ts`: tier 1 のみ・個人情報は保存前に落とす・分類の決着まで 3 日寝かせる・取れなかった push は欠落として記録。2026-11-07〜11-22 の 2,226 push・90.9 万ジョブを欠落 0 で取り込み
  - `treeherder-stream.ts`: 1 ジョブ = 1 事象 (testId = ジョブ種・agentId = OS の系統)、真値 = fixed by commit の注記が名乗る修正の revision ごとの回帰。規則は範囲を読む前に固定しコミット (`3a9839c`)
  - `run-treeherder-c29-report.ts`: 粗窓 (C19)・ジョブ種の持続 (C21/C22)・自動グループ別 replay (C24/C28) を同じ出力に。出力は `data/logs/c29-treeherder-20261127.txt`、再実行で一致。試験 754 件 (+12)
- [x] C25 本物の回帰があるデータ源を 1 本に決める (2026-11-27、Treeherder `autoland` に決定。記録は ROADMAP_BRIEF の 2026-11-27 の節)
  - 1-A Prow の非ゲート定期 3 ジョブ (slow・alpha-features・serial、7 日・315 ビルド): 失敗 6 件・regression 0。出力は `data/logs/c25-prow-nongating-truth-20261127.txt`
  - 1-B Treeherder `autoland` (2 日・495 push・178,404 ジョブ、個人情報は保存前に落とした): fixed by commit 804 ジョブ・2 日で 26 の固まり・backout 53 push。出力は `data/logs/c25-treeherder-autoland-20261127.txt`
  - 弱点: ジョブ単位 (試験名は失敗だけ、pass は取れない)・同じジョブ種は push の約 5% でしか走らない。C29 の完了条件に直しの提案 4 点 (C29 の節)
- [x] C33 運用ドキュメントの最新化 (2026-11-25、範囲を文書に絞った。`data/` は残す。記録は ROADMAP_BRIEF の 2026-11-25 （4） の節)
  - `README.md`: 次の行を C25 → C29 → C30 の決定に、「次は C16・C17」を現状に、コマンド一覧に `run-prow-attribution-report`、環境変数の表に `PROW_REPLAY_SPEED` の上限 (7200・C26)
  - `wiki-collector-ops`: description と冒頭を「2026-11-17 停止・参照専用、OS 再起動の後に再起動しない」に (誤って収集を再開させる発動を防ぐ)
  - `run-lighthouse`: `test-stream` + `prow` の起動と、`/persistence`・`failures`・自動 replay (`#regroup`) の確かめ方の節を追加
  - 残すと決めたもの: `data/wikimedia/`・`data/otel*` (第 1〜5 段階の判定の生データ、EventStreams は数日しか遡れず再取得できない。空き 211 GB で C6 の 100 GiB 規則にも当たらない)・`server/strategy-b-*` (対策B の課金実測の生出力、33 KB)
- [x] C32 `ROADMAP_BRIEF.md` のアーカイブ分割 — **見送り** (2026-11-25。常時読み込みの重さは C31 で解消し、devlog は見出しを grep して節だけ読む運用。分割すると `server/src` の 51 ファイルを含む 229 か所の「ROADMAP_BRIEF.md <日付>」参照が索引経由の遠回りになる。記録は ROADMAP_BRIEF の 2026-11-25 （4） の節)
- [x] C31 `CLAUDE.md` のスリム化 (2026-11-25、84 KB・715 行 → 11 KB・144 行。過去の時系列は削り `ROADMAP_BRIEF.md` を正本とするポインタに。記録は ROADMAP_BRIEF の 2026-11-25 （3） の節)
  - 残したもの: 現在地・起動/テスト手順・ディレクトリ地図・設計制約と不変条件 (dcp-core との境界・統計層・実データの規律・Brain)・常設ルール・`@CLAUDE.local.md`
  - 削った 250〜700 行目の詳細 (L1〜L5・較正期間・F2 など) は `git show 2cab5b2:CLAUDE.md` で全文を読める
- [x] C28 粗窓からの自動 replay の帰属を、他のジョブへの植え込みで測る (2026-11-22、誤帰属 0・5 試験の回帰で正しいジョブだけを名乗ったのは 1 ジョブで 50/60・2 ジョブ同時で 44/60。記録は ROADMAP_BRIEF の 2026-11-22 （6） の節)
  - `prow-attribution.ts`・`run-prow-attribution-report.ts`: 本番と同じ部品の並び + `CoarseReplayTrigger` + 自動 replay を植え込みで再生 (`replayThroughShippedWiring` に `onPackage` の口)。ジョブ別・大きさ別・2 ジョブ同時と、植えない対照 (発火 9・名乗り 2) を同じ出力に並べる
  - 範囲 2026-10-26〜11-15・種 20261122・3 ビルド・全境界評価を報告に書き、再実行で出力一致。C24 の「12/13」は配線確認と注記
- [x] C27 自動の遡及的再観測がライブの `$Q[observe]` 行を書き換えない (2026-11-22、専用の `#regroup` 行。記録は ROADMAP_BRIEF の 2026-11-22 （6） の節)
  - `CoarseReplayTrigger` の既定の scope を `observe:test_result:v1#regroup` に、30 窓参照を `compare:#regroup` に移した。`#fine` の行は起動時のまま (試験で固定)、RuleBrain の RC は不変
- [x] C26 記録流の再生で、飛ばした窓を黙って作らない (2026-11-22、`maxReplaySpeed` と起動時の拒否。記録は ROADMAP_BRIEF の 2026-11-22 （6） の節)
  - 1 時間窓で上限 7200。上限ちょうど・tick 遅れありで全窓が採点されることと、43200 で 7 割超が採点されないことを試験で固定。C23 の実サーバ確認に注記
- [x] C24 粗窓の発火を契機にグループ別の遡及的再観測を自動で回す (2026-11-22、`CoarseReplayTrigger` と `test-stream` の自動 grouped replay 配線。記録は ROADMAP_BRIEF の 2026-11-22 （4） の節)
  - 注 (C28): 下の「帰属 12/13」は既知の 1 ジョブの固まりを指した配線確認。見分ける力は C28 で測った
  - `coarse-replay-trigger.ts`・`index.ts`: `LIGHTHOUSE_PROFILE=test-stream` で合算 1 時間粗窓の `SnapshotPackage` から下向きタイル (`dip`・`step_down`) または同時多発 (`failures.bursts`) を拾い、窓区間ごとに重複抑止つきで `group_by: ["agentId"]` の `replayRequest` を自動発火 (`compare:#fine` も 30 窓参照、`broadcastReplay` へ配信、`mock` は不変)
  - 実データ 11 日 (2026-08-30〜09-09、873 ビルド) で発火 13 窓 (同時多発 9/9)・帰属 12/13 (同時多発 9/9) がすべて `ci-kubernetes-e2e-gci-gce` に特定。試験 733 件 (+4)
- [x] C22 試験ごとの持続の名乗りを灯台の出力にする (2026-11-22、ドメイン層 `ProwPersistenceFeed` と `GET /persistence`・SSE 別欄・dashboard パネル。記録は ROADMAP_BRIEF の 2026-11-22 （3） の節)
  - `prow-live.ts` (`ProwPersistenceFeed`): `PersistenceDetector` (`prow-persist.ts`) を `SnapshotCurator` / `lens.ts` に入れず試験の流れ向けのドメイン層として配線、`atMs` (`finishedMs`) で表に出す (`mock` の package・出力は不変)
  - `dashboard.ts`・`dashboard/index.html`・`dashboard/app.js`: `GET /persistence`・SSE (`/events/snapshot`) の別欄 `persistence`・`#panel-persistence` を追加
  - 試験 729 件 (+2): `ProwPersistenceFeed`・`GET /persistence`・SSE の名乗りが `detectPersistence` と一致し、`mock` では非稼働であることを固定
- [x] C23 記録済みの試験結果の流れを本番サーバと dashboard に流す入口と C19 の画面表示 (2026-11-22、`LIGHTHOUSE_SOURCE=prow` の仮想時計再生口と `SnapshotPackage.failures` の UI 描画。記録は ROADMAP_BRIEF の 2026-11-22 （2） の節)
  - `prow-live.ts`・`index.ts`・`dashboard.ts`: `LIGHTHOUSE_PROFILE=test-stream LIGHTHOUSE_SOURCE=prow` で取り込み済みの `data/prow/` を仮想時計で本番配線 (`RetentionBuffer` → `WindowHistory` → `Comparator` → `DashboardServer`) に流す。既定 (`mock`) の動作・出力は不変
  - `dashboard/index.html`・`dashboard/app.js`: `SnapshotPackage.failures` (窓ごとの失敗数と同時多発 `bursts`) と再生位置のバッジを描画 (`failures` 無しでは非表示)
  - 試験 727 件 (+9): 本番の `livePackage(t)` が `prow-replay` (`1h-fresh`) と境界ごとに盲目・下向きタイル・`bursts` で一致することを固定。実サーバで 3 週分 (1,745 ビルド・1,774,055 事象) の SSE 配信を確認

- [x] C19 試験の流れ向けの本番の定数 (2026-11-19、opt-in のプロファイル `LIGHTHOUSE_PROFILE=test-stream` と、package が名乗る失敗数・同時多発。記録は ROADMAP_BRIEF の 2026-11-19 の節)
  - `stream-profile.ts`: 1 時間窓・`reference_windows` 30・鮮度ゾーン 34 時間 (疎化つき参照ゾーンなし)・3 ジョブを 1 本。index.ts と再生の `1h-fresh` の腕が同じ数字から作られ、ずれない。既定 (`mock`) は従来の定数そのまま
  - `CurationOptions.failureCount` (opt-in): package に窓ごとの失敗した試験の数と、10 件以上の窓 (`bursts`) を載せる。原因は名乗らない・採点は動かない。試験 718 件 (+15)
  - 89 日の再生は C12・C13 と同じ数字 (盲目 0.6%・失敗の無い区間 0/1,082・10 件以上の窓 10/10)。package が名乗った 10 窓は事象から数えた 10 窓と窓・件数とも一致。出力は `data/logs/prow-replay-89d-c19-20261119.txt`・`prow-truth-89d-c19-20261119.txt`
- [x] C21 1 つの試験が続けて落ちることを拾う経路 (2026-11-17、流れに沿った検出器を作って測った。植えた回帰は 180/180 を 2 ビルド目で名乗り、89 日の記録での名乗りは 2 件。記録は ROADMAP_BRIEF の 2026-11-17 の 8 番目の節)
  - `prow-persist.ts`: 規則 (2 ビルド目の時点で、同じ試験が連続するビルドで落ち、その時点までにどちらの commit でも pass が無く、同じビルド内にも pass の件が無い) を計測の前に頭書きに固定。試験 703 件
  - 89 日の記録: 名乗り 2 件 (regression 1 = C13 の唯一の回帰を拾った・flaky 1 = 誤名乗り)。長さ 2 以上の flaky 17 件のうち誤って名乗ったのは 1 件。名乗りの無い日が 87/89
  - C20 と同じ切り出しの植え込み 180 件: 180/180 (3 大きさ・3 ジョブ)、名乗りまでは最初の植えた失敗から中央値 1.2〜1.6 時間 (2 ビルド分)。検出は定義と同じ規則なので自明に近く、言えるのは遅れと記録での誤名乗りの少なさだけ。続きは C22 (置き場所、提案)。出力は `data/logs/prow-persist-20261117.txt`
- [x] C20 回帰のある流れで検出を測る (2026-11-17、案 b: 記録済みの流れに回帰を植えた。5 試験以上はほぼ必ず 1 時間以内に拾い、1 試験だけの回帰は 1 時間ごとのジョブで 2〜3 割。記録は ROADMAP_BRIEF の 2026-11-17 の 7 番目の節)
  - user「先にやる価値のある物から」で案 b を選んだ。`prow-plant.ts`・`run-prow-plant-report.ts`: 規則を再生の前に固定 (開始ビルドで pass した試験から 1・5・1 area 全部を選び、commit の最初のビルドから n ビルド、n ビルド目の commit の終わりまで落とす。植えない再生が覆っていない窓だけ数える)。試験 694 件
  - 3 週・3 ジョブ × 20 開始 × 3 大きさ × 2 長さ: 1 時間窓 × 参照 30 窓 (3 ジョブを 1 本) で 5 試験は 60/60・中央値 0.4〜0.6 時間、1 試験は unit 4〜6/20・integration 6〜9/20・e2e 16/20。ジョブ別・area 別に分けても良くならない。C13 の規則は植えた回帰を 360/360 regression と呼ぶ
  - 前提として `RetentionBuffer.evict` の先頭 `splice` を先頭位置の前進に替えた (出力はビット一致、204 時間の保持が 3 週 18 秒)。出力は `data/logs/prow-plant-3wk-20261117.txt`
- [x] C13 真値つきの検出: 既知の回帰で検出を測る (2026-11-17、真値は導出できたが、この流れに回帰はほぼ無い。記録は ROADMAP_BRIEF の 2026-11-17 の 6 番目の節)
  - `prow-truth.ts`: 規則を突き合わせの前に固定 (flaky = 同じコードが通してもいる・regression = 割れが無く 2 ビルド以上・isolated = 割れが無く 1 ビルド)。試験 684 件
  - 89 日・3 ジョブ: エピソード 689 のうち flaky 599・isolated 89・regression 1。回帰の検出力は測れない。失敗の 31% は 10 件以上が同時に落ちた 10 ビルドに集まる
  - 1 時間窓 × 参照 30 窓は固まり (窓に 10 件以上) を 10/10・2 件の窓を 29/39 拾い、単発は 2/379、失敗の無い区間の警報は 0/1,082。続きは C20 (回帰のある流れ、提案)。出力は `data/logs/prow-truth-89d-20261117.txt`
- [x] C12 試験結果の実流を本番の配線に流す再生口 (2026-11-17、出荷時の構成は 99.8% 盲目で、1 時間窓と参照 30 窓なら静かに動く。記録は ROADMAP_BRIEF の 2026-11-17 の 5 番目の節)
  - `prow-replay.ts`・`run-prow-replay-report.ts`: 記録済みの事象を `RetentionBuffer` → `WindowHistory` → `Comparator` → curator に index.ts と同じクラス・オプションで流す (差し替えるのは時計だけ)。試験 675 件
  - 21 日・3 ジョブ: 出荷時の 10 s 窓は問うた package の 99.8% が盲目・失敗のある窓 135 のうち 134 は盲目の中だけ。1 時間窓 × 参照 30 窓は盲目 1.2%・失敗の無い区間の警報 0/213・下向きのタイルは失敗 1 件の窓 0/110・2 件 7/11・3 件以上 2/2
  - 警報の付いた窓が回帰か flaky かは真値が無く言えない。続きは C13 (真値)・C19 (本番の定数、提案)。出力は `data/logs/prow-replay-3wk-20261117.txt`
- [x] C17 選んだ CI の試験結果を取り込み、`test_result:v1` に変換して形を調べる (2026-11-17、本番の 10 s 窓と 1 s 窓は失敗のある窓をほぼ採点できない。記録は ROADMAP_BRIEF の 2026-11-17 の 4 番目の節)
  - `prow-import.ts`・`prow-events.ts`・`prow-shape.ts` と起動口 2 つ。取れなかったビルドは `days.jsonl` に missing として残り、取り込んでいない日を含む範囲は拒否。試験 671 件
  - 21 日・3 ジョブ: 83 ビルド/日・8.4 万事象/日、失敗は 1 万 3 千件に 1 件、日周なし。失敗のある窓で参照が使えるのは 1 s 窓 0/77・10 s 窓 0〜2/113・1 時間窓 × 参照 30 窓で 122/123。使えない理由の 92〜99% は参照が全 pass
  - 出力は `data/logs/prow-shape-3wk-20261117.txt`。90 日分の取り込みは継続中
- [x] C16 公開 CI の試験結果を実地で確かめ、データ源を 1 つに決める (2026-11-17、Kubernetes の Prow に決定。記録は ROADMAP_BRIEF の 2026-11-17 の 3 番目の節)
  - Prow: 認証なしで取れ、過去 90 日・試験単位の junit。unit は 24 ビルド/日 × 約 1544 件、失敗は testcase の 1 万件に 1 件程度。真値の印は無く、commit と試験名から導出する形 (成り立つかは未確認)
  - Treeherder: 認証なしで取れ、人の付けた失敗の分類があるが粒度はジョブ単位でメールアドレスを含む。C13 の代わりの候補として残す。標本は `data/ci-samples/`
- [x] C15 C8 の後の検証の場を決める (2026-11-17、user 決定: 次の実データは公開 CI の試験結果。記録は ROADMAP_BRIEF の 2026-11-17 の 2 番目の節)
  - Wikimedia の保留週の繰り返しは第 5 段階で終わり。収集器は 2026-11-17T01:44Z に停止しタスクを無効化 (データは保持、未確定の穴 0、`gaps.jsonl` は 80 行のまま)
  - 続きは C16 (データ源の実地確認)・C17 (取り込みと形の調査)。C12・C13 は試験結果の実流を対象に書き直した
- [x] C8 第 5 段階の封印週を 1 回だけ集計する (2026-11-17、判定は SUPPORTED。記録は ROADMAP_BRIEF の 2026-11-17 の節)
  - 封印週 2026-11-09〜11-15 を 1 回だけ読んだ (入口検査は通過、盲目の試行 0)。V-a は除く後の var z 1.044・10 s 腕は 1.005 で帯に入り、|z|≥3 は 0.71%・0.45%。除いたから入ったと言えるのは 10 s 腕だけ (V-a は履歴そのままも帯の内)
  - `HOLDOUTS` の stage 5 に `spentOn` を入れ、`--holdout` は拒否。試験 647 件。出力は `data/logs/stage5-holdout-20261117.txt`
- [x] C10 C4 を本番の履歴の長さ（1 時間）で測る (2026-11-12、10 s 腕は 1 時間で成り立ち、V-a は成り立たない。記録は ROADMAP_BRIEF の 2026-11-12 の 3 番目の節)
  - `run-history-mix-report` に `--history-total-ms`（参照を含めた全体の長さ）と declined の割合の出力を追加。既定の出力は第 4 段階の週で 11-02 の出力とバイト一致。`--holdout` と `--rehearse` は拒否。試験 647 件
  - 10 s 腕は全体 1 時間で除いた後の var z が 1.045（第 4 段階の週）と 0.999（3 週）で、24 区間と同じ。V-a は 1 時間では参照が履歴を使い切って走らせられず、2 時間・6 時間でも 0.44・0.40 で検出 0/453（24 時間は 1.012）。出力は `data/logs/c10-*-20261112b.txt`
- [x] C14 第 5 段階の各判定で何を変えるかを、読む前に書く (2026-11-12、封印週も C10 の結果も見る前。記録は ROADMAP_BRIEF の 2026-11-12 の節)
  - 4 つの判定のどれでも本番の振る舞いは変わらない (`history_clean` は opt-in のまま・ライブ行は independent)。第 5 段階は回帰の確認で、外向きの主張にしない。支持でも本番 (履歴 1 時間) については何も言わない。規則・判定・許容は変更なし
- [x] C9 封印週の集計の前検査 (2026-11-12、`--holdout` と `--rehearse` が範囲の端まで事象があるかを時刻だけで確かめる。記録は ROADMAP_BRIEF の 2026-11-12 の 2 番目の節)
  - `range-coverage.ts`: 範囲の最初・最後の事象が端から 60 秒以内、`collector-state.json` の `openGaps` が空、でなければ拒否。記録にない 5 秒超の穴は出力の先頭に列挙 (判定は変えない)。試験 646 件 (+9)
  - 第 4 段階の週の `--rehearse` は、先頭の coverage 4 行を除いて 11-02 の出力と一致 (`data/logs/stage5-rehearsal-stage4week-20261112.txt`)。日別ファイルの選び方は `listDayFiles` 1 か所に共有
- [x] C6 日別 gz の保持期限 (2026-11-06、user 承認の案どおり: 空きが 100 GB を切ったら古い日から消す。結果は ROADMAP_BRIEF の 2026-11-06)
  - `wiki-retention.ts` / `run-wiki-retention.ts` (既定は dry run、`--apply` で削除)。空き 100 GiB 未満で、120 GiB になるまで古い日の `.jsonl.gz` を消す。直近 14 日と全ての保留の週 (使用済みも、前 2 日・後 2 日つき) は消さない
  - 消した日は `pruned.jsonl` に記録し、`loadWikiDir` はその日に触れる範囲を拒否する (欠けた日は静穏として読まれるため)。試験 637 件。実機の dry run は空き 218 GiB で削除なし
- [x] C2 1 手目の実データ読み: MDE の検算と H-mix の診断 (2026-11-02、手元で 3 本を回して記録)
  - 出力は `data/logs/history-mix-stage4week-20261102.txt` / `history-mix-3wk-20261102.txt` / `sensitivity-stage4week-20261102.txt`。結果と解釈は ROADMAP_BRIEF 2026-11-02 (3)
  - H-mix: 第 4 段階の週は V-a・H1-10s とも支持 (var z +0.568 / +0.377、V-a は除外版が行き過ぎ)。3 週は V-a 不明 (+0.132)・H1-10s 支持 (+0.179)
  - MDE: V-a・H1-10s は検出 89〜94% で名乗りの 80% より上 (帰無の保守性の 2 つ目の読み)。V-b の spike は範囲内
- [x] C3 量を独立した採点チャネルにする (2026-11-02、機構は入った・較正は 1 s 窓だけ合う。結果は ROADMAP_BRIEF の 2026-11-02 の 4 番目の節)
  - `CurationOptions.volumeChannel` (opt-in) → `SnapshotPackage.volume`。率の gate は読まず、curator の package は HEAD と 360 件・`run-volume-report` の 1 日分でバイト一致。テスト 604 件
  - 実データの較正 (`run-volume-channel-report`): 1 s 窓は var z 0.97 で合うが、10 s・60 s 窓は 1.4〜1.8 (第 4 段階の週は 1.6〜4.2)・package の 14〜44% が発火。量の物差しが時間依存を持たない
  - 構成の変化の捕捉: V-a 73〜91%・10 s 48〜87%・1 s 8%。10-19 は V-a で 3/7。ライブの粗窓は参照 3 窓で盲目 (dashboard は盲目と表示)
  - dashboard: 破線の量タイル + 注記。SSE のペイロードで live (盲目)・replay (細窓、誤警報なし) を確認、ブラウザ描画は未確認
- [x] C4 率の帰無の履歴から量の外れた窓を除く (2026-11-02、opt-in で実装・封印週の主張を固定。結果は ROADMAP_BRIEF の 2026-11-02 の 10 番目と 11 番目の節)
  - `$Q[compare]` の `history_clean: "median"` — `Comparator` が variogram の履歴から、系列自身の中央値に対する量の帯 [0.8, 1.25] の外を除く (curator は不変、除く割合が 0.5 超の系列は除かず `comparison.history.cleaned` に名乗る)。既定の出力は HEAD と 360 package でバイト一致。テスト 624 件
  - 平常の量の var z: 第 4 段階の週 0.533 → 1.012 (V-a)・0.655 → 1.043 (10 s)、3 週 0.833 → 0.975・0.807 → 0.993。−0.1 の検出は 3.5〜6.1% → 5.9〜12.5% で、得るのは主に較正
  - 封印週の主張は分散の帯 [0.8, 1.25] で判定し、|z|≥3 は併記 (偶然で落ちる確率が V-a で 10.8%)。集計は C8
- [x] C5 `$F` の較正の常時監視 (2026-11-02、`$F` の最初の読み手。結果は ROADMAP_BRIEF の 2026-11-02 の 5 番目の節)
  - `ForecastMonitor` が view ごとに 1 分に 1 起点を採点して蓄積 (窓要約は 1 時間しか残らず 24 時間は再計算できない)。1 時間・24 時間 × 地平ごとに z の分散・|z|≥2/3・被覆率を `GET /forecast` の `calibration` で名乗る
  - 状態は通常の量の窓だけで読む: blind (30 窓未満)・overconfident (var z − 2SE > 1)・conservative (var z + 2SE < 0.7)・healthy。dashboard の Forecast パネルに表示。テスト 616 件
  - 実サーバで確認したのは blind まで (30 窓が溜まる前)。blind → healthy / overconfident の遷移は合成の試験のみ
- [x] C1 収集器の翌朝点検 (2026-11-02、点検で停止を見つけ、user の了承で再開して穴が埋まったことまで確認)
  - 10-27 の未圧縮ファイルを gzip (sha256・8,523,778 行が一致、元を削除)。`2026-10-28.jsonl.gz` は 10-29 09:00 に作成済み。10-28 のファイルの穴: 03:36:55→03:37:01Z の 5.9 秒が残り、15:03:02→15:03:08Z の 5.9 秒と 15:03:12→15:05:24Z の 132 秒 (後者は `gaps.jsonl` の +1 件) が新たに見つかった
  - 点検時、収集器は 11-02 18:39 JST から止まりタスクは Disabled だった (誰がいつ止めたかは不明)。user の了承で 20:52 JST にタスクを Enable して起動 (PID 21888)。遡り取得で追いつき (最新の事象が実時間から 2〜3 秒遅れ)、`2026-11-02.jsonl` の ts は 11-01T23:59:59Z から連続 (5 秒超の穴なし、3,239,995 件)。`gaps.jsonl` は 80 件のまま
  - `2026-11-02.jsonl` は収集器が書いている最中で未圧縮 (翌日 09:00 JST の圧縮に任せる)

## 項目

### C7. 量チャネルの尺度を距離の関数で補正する (本体の較正)
状態: 保留(user が「何を出来事と呼ばないか」を決めたとき。2026-11-02 の見直しで根拠が崩れ、新しい物差しは作らない)

設計: `docs/devlog/ROADMAP_BRIEF.md` 2026-11-02 (7) の下調べと、(8) の見直し。
(7) は中央値 |z| が参照から遠いほど大きい (60 s で 1.14 → 1.38 倍) ことを「本体の尺度の過小、距離とともに増える」と読み、距離の関数で SE を拡大する案を出した。
(8) の見直し: **物差しが正しく、構成の変化 (一括作業の開始・停止) だけがある合成の流れでほぼ同じ数字が出る** (60 s で 1.12 → 1.36 倍・|z|≥1.5 19.2% → 28.7%)。
物差しの誤りの証拠にならず、その拡大を入れると構成の変化の捕捉が半分以下になる (60 s で 48.5% → 15.7%、10 s で 30.9% → 15.5%)。
判断待ちだった 2 点 (本体の較正に絞る / 探索で定数を置き封印週で確認) は、どちらも採らないことを勧めた (中央値 |z| も出来事の数で動き、封印週の合否が一括作業の回数で決まる)。

- 量チャネルは今の物差しのまま「構成の変化の検出器」として運用し、評価は捕捉率 (C3 のレポートが出す) で読む
- 再開の条件: user が「何を出来事と呼ばないか」(例: 日周のなめらかな変化だけを平常とする) を決めたとき。その場合はまず量の日周の形を前の日々から作る参照
  (F1 の量版) をハーネスで試し、効くと分かってから本番の実装 (1 日分の日周の形の保持) を検討する

### C11. 窓要約の履歴の上限を、時間ではなく窓数で持つ
状態: 提案

設計: `docs/devlog/ROADMAP_BRIEF.md` 2026-11-12 (3)。`HISTORY_WINDOW_MS` の 1 時間は丸めた数字で、調整した値ではない (index.ts の注記)。
C10 の結果: 10 s 腕は全体 1 時間で成り立つが、V-a (60 s 窓・参照 60 分) は 1 時間では参照が履歴を使い切って走らせられず、2 時間・6 時間でも較正されない (24 時間で 1.012)。
本番のビューは 10 s と 1 s で、60 s 窓のビューは無いので急がない。

- 起こす条件: user が 60 s 窓の比較行を本番に持つと決めたとき
- 案: 上限を窓の幅ごとに窓数で持つ (60 s 窓で 24 時間は 1440 件の要約)。6〜24 時間のどこから成り立つかは未測定で、決めるときに先に測る

### C39. 参照に対する同時多発 (C34) を本番の粗窓と自動 replay につなぐ
状態: 完了 (2026-11-28)

設計: `docs/devlog/ROADMAP_BRIEF.md` 2026-11-28 (2) (C34 の規則と確認)・2026-11-28 (9) (補助案)。2026-11-28 に user 決定。
C34 の `relativeFailureBurst` は全 pass の参照でも動く (参照の平均 0 なら閾値 3、4 件から発火) が、使っているのはレポートと `prow-replay.ts` だけで、`index.ts`・`coarse-replay-trigger.ts` には無い。
本番の粗窓が固定 10 件の `failures.bursts` でしか自動 replay を起こさないため、4〜9 件の同時失敗は下向きタイルが立たない限り `#regroup` に届かない。
閾値は Treeherder と Prow で決めて確かめたもので、自前の `ingest` の流れでは未測定。常駐の受け手で有効にするかは、入ってから user が決める。

#### 完了条件
- [x] `LIGHTHOUSE_RELATIVE_BURST=1` (opt-in。`test-stream` 以外・`1` 以外の値は起動時に拒否) で、本番の粗窓の curator に `relativeFailureBurst: true` (`C34_RELATIVE_BURST` の既定値) が渡り、package に `relativeFailures` が載る
- [x] 未設定なら package・SSE・`/status`・起動ログがバイト同一 (既存の試験が無修正で通る)
- [x] `CoarseReplayTrigger` が `relativeFailures.bursts` の窓でも `#regroup` の replay を発火する (重複抑止は従来と同じ窓区間ごと)。`relativeFailures.blind: true` の窓では発火せず、盲目であることを SSE と `/status` が名乗る
- [x] SSE と `/status` が「閾値は Treeherder・Prow で決めて確かめた値で、この流れでは未測定」と名乗る (C36 と同じ形)
- [x] dashboard の失敗数のパネルに、相対の同時多発を固定 10 件の `bursts` と区別して描く (ブラウザで見たか、見ていないかを記録に書く) — ブラウザでは見ていない (構文検査と SSE の中身まで)
- [x] 試験: 発火する経路・盲目で発火しない経路・未設定でのバイト同一・不正な値での起動拒否
- [x] 記録済みの Prow 89 日を本番の配線 (`replayThroughShippedWiring`) に流し、package の `relativeFailures.bursts` の窓と件数が `run-treeherder-c34-report` の Prow 側の数えと一致する

### C40. 2 値の厳密な裾を `EXACT_MAX_COUNT` を越えても計算する
状態: 完了 (2026-11-28)

設計: `docs/devlog/ROADMAP_BRIEF.md` 2026-11-28 (9) の 2 番。2026-11-28 に user 決定 (C18 の前提)。`exactZ` は `n > EXACT_MAX_COUNT` (2,000、`snapshot-curator.ts`) で一律 `null` を返し正規近似へ落ちる。
Prow の 1 時間合算 (約 3,500 件)・`e2e` 単体の全 pass 参照窓の 51%・自前 `ingest` の 1 時間窓 (2,569 件) が 2,000 を越える。
参照に失敗 1 件 ($c_0 = 1$) あるとき、2,000 を越えると $k = 1$ が正規近似で `5.21σ` に跳ねる不連続もある (実装後の実測: `5.21σ` は生の z。gate の z は −1.96 → −2.51、$k = 3$ で −3.96 → −13.29。2026-11-28 (11))。
$O(n^2)$ になるのは 3 値以上だけで、2 値 (`levels === 2`) の Beta-Binomial の裾は失敗数 $k$ の側から対数比の漸化式で足せば $O(k)$ で厳密に出る。
既定の出力を変えるので opt-in にする。C18 の opt-in はこれを内側で有効にする。

#### 完了条件
- [x] `CurationOptions` の opt-in で、2 値 (`levels === 2`) の `exactZ` と `exactWindowMde` が `n > EXACT_MAX_COUNT` でも厳密な裾を返す。3 値以上と opt-in 無しは従来どおり
- [x] $n \le 2{,}000$ で既存の厳密計算と一致する (許容の誤差を試験で固定)
- [x] $c_0 = 1$ の参照で、$n = 2{,}000$ と $n = 2{,}001$ の前後の $z$ に正規近似の跳ねが無いことを試験で固定する
- [x] $n = 10^5$ の窓 1 つの計算時間を測って記録に書く
- [x] 未設定なら package がバイト同一 (`mock`・`test-stream`・A/B のシード集合)

### C18. 全 pass の参照でも採点できる帰無 (稀な失敗の流れ)

設計: `docs/devlog/ROADMAP_BRIEF.md` 2026-11-17 (4)・2026-11-28 (9)。Prow の試験結果では、本番の 10 s 窓・1 s 窓で失敗のある窓の 0/77・0〜2/113 しか参照が使えない。
使えない参照の 92〜99% は「全部 pass で分散が 0」(`isReferenceUsable` が偽)。curator は参照が使えないと採点しないので、失敗が 1 件も無かった直後の失敗で盲目になる。

- 2026-11-28 user 決定: 帰無を opt-in で変える (既定の「分散 0 の参照は使わない」は不変)。起こす理由は短い窓ではなく、1 時間窓の `#regroup` のジョブ別の盲目 (下の実測) と自前 `ingest` の定常状態
- 下調べ (2026-11-28 (9)) は Prow 3 週・89 日 = 使用済みの探索データで、`BB(0.5)` 厳密・`minFailures: 2` もそれを見て選んだ。確認は未取り込みの Prow 2026-11-16 以降で 1 回だけ行う
- 本番 (`#regroup`・`ingest`) への配線は、確認が成立してから別項目にする (C34 → C39 と同じ順)
- 案 (2026-11-28 (9) 下調べで具体化): opt-in `allPassBinaryNull` — unweighted かつ `{0, 1}` の 2 値ストリームに限り、全 pass 参照 (`effectiveN >= MIN_VALID_COUNT`・`variance === 0`・`mean === 1`) を 2 値厳密 Beta-Binomial 帰無 ($O(k)$ 計算で `EXACT_MAX_COUNT = 2_000` 制限を 2 値のみ解除) と `minFailures: 2` (単発 flaky 抑止、1 試験の継続は C21/C22 `PersistenceDetector` に委ねる) で採点する。`isReferenceUsable` / `curate` ループ / `buildScoringUnits` / `collectUnreachableTails` / `windowMde` / `detectSteps` の 6 箇所と `categoricalModel` の全 pass 非対称を整合させる
- 下調べの実測 (2026-11-28 (9)):
  - 単発 flaky ($k=1$) の暴発: 全 pass 参照の単発失敗は $N_{\text{ref}}/n$ が大きい窓で `BB(0.5)`・`BB(1.0)`・`CP95`/`CP99` いずれでも誤発火する (Prow 3 週 `10min` で 1〜3/35、`60s` で 4〜52/114)。`BB(0.5)` exact + $k \ge 2$ なら 0/35・0/114 に抑えられ、自前 `ingest` 30 ビルドで $k=2$ (`3.36σ`)・3 ビルドで $k=3$ (`2.55σ`) から検出。なお `60s` の $k \ge 2$ (3 窓) は参照長不足 ($N_{\text{ref}}/n < 1$) でどの帰無でも 0/3
  - `EXACT_MAX_COUNT = 2_000` の壁: Prow 1 時間合算 (~3,500 件)・`e2e` 単体の全 pass 参照窓の 51% (22/43)・自前 `ingest` の初回 1 時間窓 (2,569 件) が 2,000 超。2 値の $O(k)$ 厳密化は $c_0=1$ の正規近似フォールバック爆発 (`5.21σ`) と $c_0=0 \to 1$ の単調性段差も同時に防ぐ
  - 影響範囲の拡大: C12 (2026-11-17 (5)) の合算 1 時間窓では盲目 0.0〜1.2% だが、89 日間 Prow の 1 時間窓ジョブ別 (`#regroup`) では `unit` 16.5%・`integration` 19.2%・`e2e` 2.6% (うち $k \ge 2$ が 10 窓) が全 pass 参照で `unscoredGroups` に落ちている。自前 `ingest` (C37/C38) の定常状態でも同様
  - 補助策: 全 pass 参照で動く C34 (`relativeFailureBurst`) の本番配線は C39 に起票した

#### 完了条件
- [ ] `CurationOptions.allPassBinaryNull` (opt-in、C40 の厳密な裾を内側で有効にする): unweighted・値が `{0, 1}` だけ・`effectiveN >= MIN_VALID_COUNT`・`variance === 0`・`mean === 1` の参照を、2 値の Beta-Binomial 帰無で採点する。条件を外れる参照は従来どおり盲目と名乗る
- [ ] 採点可能性の判定は述語 1 つにし、`curate` のループ・`buildScoringUnits`・`collectUnreachableTails`・`windowMde`・`detectSteps`・package の `referenceUsable` と `categoricalModel` がそれを呼ぶ (コピーを作らない)。各箇所に全 pass 参照の試験がある
- [ ] 全 pass の参照の窓で、失敗が `minFailures` (既定 2) 未満なら下向きのタイルを立てない。`windowScores` に $z$ は残し、抑止したことを package が名乗る
- [ ] 全 pass の参照では `detectSteps` が step を検定せず、そのことを名乗る (窓の `dip` に委ねる)
- [ ] 未設定なら package がバイト同一 (`mock`・`test-stream`・A/B のシード集合)
- [ ] 判定の基準 (単発の失敗での誤発火・`#regroup` のジョブ別の盲目の割合・C20 と同じ規則の植え込みでのジョブ別の捕捉) と線を、確認範囲 (Prow 2026-11-16 以降、3 ジョブ) を取り込む前にコミットする
- [ ] 確認範囲を取り込み、1 回だけ読んで成立・不成立をそのまま記録する (不成立でも線は動かさない)。植え込みなしの対照を同じ出力に並べる
