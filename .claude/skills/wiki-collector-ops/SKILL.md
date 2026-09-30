---
name: wiki-collector-ops
description: Check, restart, or troubleshoot the real-data calibration period's Wikimedia EventStreams collector (server/src/wikimedia-collector.ts). Use after an OS restart or sleep, when asked whether collection is healthy, when gaps.jsonl grows, or before touching the collector's code or its scheduled task.
---

# Wikimedia 収集器 — 状態確認と運用

実データ較正期間 (ROADMAP_BRIEF.md 2026-09-27 (3)) の収集器を点検・再起動するときの手順。
**事前登録の規則 5「収集の欠落は盲目として扱う」** を守るのがこの収集器の唯一の追加責務。
欠落を黙って埋めたことにしてはいけないし、埋まった区間を盲目のまま残すのもデータの無駄になる。

開始日と保留期間 (5〜7 日目) の対応はリポジトリに書いていない (ローカルのメモが正本)。
**保留期間中のデータは最終集計まで開かない**。点検で見るのはプロセス・ログ・gaps の件数と
時刻の穴だけにし、値 (bot 比率など) の集計はしない。

## 1. 点検 (再起動・スリープの後は必ず)

```powershell
$pidf = Get-Content data\collector.pid
Get-Process -Id $pidf -ErrorAction SilentlyContinue          # 生きているか
Get-ScheduledTask -TaskName dcp-lighthouse-wiki-collector | Get-ScheduledTaskInfo   # LastRunTime / LastTaskResult
(Get-CimInstance Win32_OperatingSystem).LastBootUpTime
Get-ChildItem data\wikimedia, data\logs | Select-Object Name,Length,LastWriteTime
```

- ログは `data/logs/collector-<起動時刻>.{out,err}.log` (起動ごとに別ファイル、上書きしない)。
  2026-09-30 より前の手動起動分は `data/collector.*.log`
- `LastTaskResult = 3221225786` (`0xC000013A`) = コンソールを閉じられた / Ctrl+C。§3 参照
- out.log の統計行 `{"written","duplicates","malformed","gaps","reconnects"}` は 60 秒ごと。
  `malformed` は 1 日数十件が平常

**本当に取りこぼしたかは、gaps.jsonl ではなく時刻を並べ替えて判定する**
(到着順で見ると、遡り取得中は偽の穴だらけに見える):

```bash
node -e '
const fs=require("fs"),L=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
const ts=[];for(const l of L){try{ts.push(JSON.parse(l).ts)}catch{}}ts.sort((a,b)=>a-b);
for(let i=1;i<ts.length;i++)if(ts[i]-ts[i-1]>5000)console.log(new Date(ts[i-1]).toISOString(),"→",new Date(ts[i]).toISOString());
' data/wikimedia/<UTC日>.jsonl
```

## 2. 起動と停止

- 常用はタスクスケジューラ `dcp-lighthouse-wiki-collector` (ログオン時起動)。
  中身は `conhost.exe --headless powershell.exe ... -File server/scripts/run-wiki-collector.ps1 -Node <node.exe>`
- 手で起動するとき: `Start-ScheduledTask -TaskName dcp-lighthouse-wiki-collector`
  (直接 `node` を叩くとコンソール窓とログの行き先がタスク経由と食い違う)
- 止めるとき: `Stop-Process -Id (Get-Content data\collector.pid)`。タスクを止めるだけでは
  node が残ることがある
- **二重起動するな**。起動前に §1 で PID が死んでいることを確かめる。
  タスクの `MultipleInstances=IgnoreNew` はタスク同士にしか効かない
- 再起動は安全: 再開位置は `data/wikimedia/collector-state.json` から読まれ、重複は eid で落ちる。
  停止中の区間は再開時に遡って取得される (EventStreams の保持範囲内に限る)

## 3. 踏んだ罠と対策

### コンソール窓を閉じると収集器が死ぬ (2026-09-30)
タスクが `node.exe` を直接起動していたので、ログオン時にコンソール窓が出ていた。
邪魔なので閉じられ、`0xC000013A` で終了し、約 2 時間取りこぼした。ログの行き先も無く、原因が残らなかった。
**対策**: `conhost.exe --headless` を経由した起動に変更し、ログは `data/logs/` へ出す。
タスクの action を直接 `node.exe` / `powershell.exe` に戻さないこと。
「失敗時に 1 分間隔で 5 回再起動」は**起動に失敗したときだけ**効く。起動後に異常終了した場合は再起動されない。

### 遡り取得中に、静かな方のトピックが先に「今」へ着く (2026-09-30)
recentchange は Kafka の `eqiad` / `codfw` 2 トピックで、稼働していない側のデータセンターは
1 時間に数件しか流さない (当日は eqiad が本流、codfw は 5 分に 5 件)。
`since` で数時間分を遡ると、静かなトピックは数秒で現在時刻に追いつき、本流はまだ過去を読んでいる。
そこで起きた症状は 2 つある。
- **偽の欠落**: 最大時刻との差だけで判定していたので、本流がこれから埋める区間を 7 件の穴として記録した
- **本物の取りこぼし**: 遡り取得中に接続が切れると、再接続の `since` が「最大時刻 − 60 s」=
  静かなトピックの現在時刻から計算され、本流の未読区間 (11:21〜13:18Z) を丸ごと飛ばした

**対策 (実装済み)**:
- 再接続は SSE の `id:` 行 (トピックごとの位置) を `Last-Event-ID` に載せ、各トピックを
  それぞれの位置から再開する。`offset:-1` (まだ何も来ていないトピック) は「最新」ではなく、
  その接続の開始時刻に置き換える (`resumeAssignments`)
- 穴はすぐには確定しない。**最も古い開いた穴**が `gapSettleMs` (既定 10 分) の間
  埋まらなかったときに初めて gaps.jsonl に書く。遡り取得は古い順に埋まるので、
  上の穴は下が埋まり終わってから時計を動かし始める (`GapTracker`)
- 未確定の穴と再開位置は `collector-state.json` に保存し、再起動をまたいで引き継ぐ。
  **再生ハーネス (`loadWikiDir`) は未確定の穴も盲目として読む**。状態ファイルが読めなければ
  集計自体を拒否する (読めないのを飛ばすと、その穴を静穏と読んでしまうため)
- `Last-Event-ID` が使えないとき (旧形式のデータ・状態ファイル無し) の `since` は、
  最大時刻ではなく最も古い開いた穴から計算する

**コードを触るなら**: 到着順と時刻順が一致すると仮定しないこと。テストは
`wikimedia-collector.test.ts` の「2026-09-30」付きケースが上の 2 症状を再現している。

### 2026-09-30 の gaps.jsonl は取り直していない
11:12〜13:21Z の記録には偽の穴 (実際には埋まった区間) も含まれるが、判断の誤りにはならず
盲目側に倒れるだけなので、そのまま残している (取りこぼした区間を取り直さないと判断済み)。
gaps.jsonl を**後から書き換えないこと**。
