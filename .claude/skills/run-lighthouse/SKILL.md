---
name: run-lighthouse
description: Launch the dcp-lighthouse observation dashboard and drive a scenario (AR/CG/RC) to verify it end-to-end. Use when asked to run/start the lighthouse server, check the dashboard in a browser, verify replay or snapshot tiles render, or confirm Brain decisions fire on a live stream.
---

# dcp-lighthouse — 起動と実地検証

観測ダッシュボードを実際に立ち上げ、シナリオを流して**決定の連鎖とタイル描画を実配信で確認**するための手順。
ユニットテスト (`npm test`, 124件) は機構を保証するが、**配信経路は保証しない** —
静的配信の欠落や SSE の分岐ミスはテスト green のまま通り抜ける (2026-07 に実際に発生)。

## 1. 起動

```bash
cd server && npm run dev    # tsc → node dist/index.js。build 込みなので別途 npm run build は不要
```

- ポート **3001** 固定。`http://localhost:3001/`
- 起動と同時に **baseline 50 events/sec** が流れ始める (シナリオ未実行でもストリームは常時稼働)
- バックグラウンド実行推奨。フォアグラウンドだと以降の検証コマンドが打てない

疎通確認:

```bash
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" http://localhost:3001/
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" http://localhost:3001/app.js
curl -s http://localhost:3001/status     # {"eventsPerSec":50,"activeScenario":null}
```

`/` と `/app.js` は `dashboard/` から `readFileSync` で配信される
(`dashboard.ts` の `dashboardDir = resolve(import.meta.dirname, "../../dashboard")`)。
**404 が返ったら dist の位置関係が壊れている** — ビルド出力先を疑う。

## 2. ブラウザで見る

この環境には **chromium-cli も Playwright ブラウザも入っていない**。
`npx playwright` は未インストールパッケージのプロンプトで失敗するので試すな。
実ブラウザを開く:

```powershell
Start-Process "http://localhost:3001/"
```

人が見る用はこれで十分。**描画の可否を機械的に確かめたい場合は §3 の SSE キャプチャを使う**
(DOM は見えないが、描画に必要なペイロードが実際に流れているかは確定できる)。

## 3. シナリオを流して SSE を検証する (本命)

```
GET /demo/start?scenario=AR|CG|RC     # brain.reset() されてから開始
GET /demo/stop
```

RC のタイムライン (`mock-stream-generator.ts` `runRC`): **5s 静穏 → 2s バースト (agent-C を passRate 0.20 に) → 53s 残り**。
`replayRequest` は回復ティックで出るので、**開始から 15 秒あれば主要イベントは揃う**。45 秒取れば確実。

キャプチャは「両チャネルを背景で開く → シナリオ発火 → wait」を**1コマンドにまとめる**
(別コマンドに分けると sleep が挟めず取りこぼす):

```bash
SP=<scratchpad>
curl -sN --max-time 45 http://localhost:3001/events/decisions > "$SP/sse-decisions.log" & DPID=$!
curl -sN --max-time 45 http://localhost:3001/events/snapshot  > "$SP/sse-snapshot.log"  & SPID=$!
sleep 1
curl -s "http://localhost:3001/demo/start?scenario=RC"
wait $DPID $SPID
```

解析 (SSE は `data: {...}` の行区切り JSON):

```bash
node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(l=>l.startsWith("data: "));
for(const l of lines){
  const d=JSON.parse(l.slice(6));
  if(d.type==="replay_snapshot"){
    console.log("[replay]",(d.replayPackage.tiles||[]).map(t=>t.shapeTag+" "+t.magnitude+"s "+t.description).join("\n  "));
  } else for(const dec of (d.decisions||[])) console.log("[decision]",dec.type,JSON.stringify(dec.qProposal?.params??{}));
}
' "$SP/sse-decisions.log"
```

### RC が正常なときに出るもの

1. `rerouteSchema` — バースト中。`agent-C pass rate ~56% < threshold ~85%`
2. `replayRequest` — 回復時。`params` に **`window_ms:1000` と `fromTs`/`toTs` が載っていること** (区間指定 replay の配線確認点)
3. `replay_snapshot` — 細窓再観測の `dip` タイル (実測例: `mean 0.653 vs baseline 0.894, 2.48σ`)

`replay_snapshot` は **decisions チャネル**に流れ、`app.js` が `data.type` で
`renderReplayTiles` に分岐する。ここを `renderDecisions` に渡すと**黙って無視される**
(L2 で実際に踏んだバグ)。

## 4. 既知のノイズ — バグと間違えるな

- **粗窓の `dip` タイルが 24〜38 秒遅れて出る**。バースト終了・agent-C 回復後に
  `dip 2.0〜2.3σ` が粗窓側へ出続け、2.0σ 境界で明滅する。
  機序: 静穏窓が溜まると σ が縮み、過去のバースト窓が事後的に閾値を越え直す
  (粗窓の判定は "now" にアンカーされていない)。
  **実体は `0.895 vs 0.920` = 実差 0.025 にすぎない** (細窓 replay の実差 0.24 の約 1/10)。
  自分の変更が壊したのではない。2026-07-25 の finding として ROADMAP_BRIEF.md に記録済み
- ~~**細窓 replay の dip は 2.0σ 境界の縁にいる**~~ → **2026-07-25 の比較器修正で解消**。
  参照レンズ導入後は `dip 3.0〜3.3σ` が安定して出る。希釈自体は残る (バースト窓の実測 0.79〜0.80、
  agent-C 単独なら 0.20) が、閾値の縁ではなくなった。**dip が出ないなら今は本物の回帰を疑え**
- **replay タイルに `spike` が出たら疑え**。健全な全 pass 窓が spike として出るのは
  2026-07-25 に修正した比較器バグの症状 (観測窓自身の分散を分母に使うと、有界データでは
  平均が極端な窓ほど分母が縮んで定数の誤警報になる)。再発したら `comparisonSE` を見ろ
- **`referenceUsable: false` はタイル 0 件と別物**。前者は「物差しが無い」= 盲目、後者は静穏。
  参照区間が retention 外に落ちると前者になる。混同するな
- バースト**進行中**の粗窓タイルが `[baseline]` のみなのは**正常** (RC の前提そのもの)

## 5. 後片付け

```bash
curl -s http://localhost:3001/demo/stop
```

サーバはバックグラウンドのまま残る。止めるならプロセスを落とす。
`server/server.log` は untracked のまま放置されがちなので、コミット前に確認する。
