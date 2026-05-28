# dcp-lighthouse

灯台モデル (Lighthouse Model) のパイロット実装。
DCP Pipeline を観測層として、マルチエージェント開発時代のテスト/コード品質ストリームを扱う。

## 位置づけ

- 親プロジェクト: `../dcp-wrap` (DCP Pipeline コア)
- 姉妹プロジェクト: `../dcp-minecraft` (高頻度ストリーム処理の実証)

dcp-minecraft が「DCP Stream を止めずに観測層を被せられる」ことを示したのを受け、
本プロジェクトでは同じ仕組みをコード生成検証ドメインに応用する。

## ドキュメント

- [docs/LIGHTHOUSE_MODEL.md](docs/LIGHTHOUSE_MODEL.md) — 灯台モデルの概念・$Q shadow・stream replay
- [docs/LIGHTHOUSE_PILOT_DATA.md](docs/LIGHTHOUSE_PILOT_DATA.md) — モックデータ要件・シナリオ・検証基準
- [CLAUDE.md](CLAUDE.md) — 引継ぎコンテキスト

## 構成

```
dcp-lighthouse/
  docs/        設計仕様
  server/      Node.js / TypeScript (MockStreamGenerator, TestorAdapter, RuleBrain, dashboard SSE)
  dashboard/   ブラウザ UI (shape-oriented panels)
```

## 開発

```sh
cd server
npm install
npm run dev    # tsc && node dist/index.js
npm test       # tsc && node --test dist/*.test.js
```

## ステータス

Phase 0 着手。実装順序は [CLAUDE.md](CLAUDE.md) を参照。

- [x] scaffold (server / dashboard / docs)
- [x] $Q レジストリ — `server/src/q-registry.ts` (scope パース・レイヤー別 read・swap history・onChange)
- [x] Step 1: $Q[observe] → StCollector window 動的 bind — `server/src/q-collector-binding.ts` (実 collector を実行中に reshape)
- [x] Step 2: retention + 遡及的再観測 — `server/src/retention-buffer.ts` (鮮度ゾーン ring on IngestionBus.tap) + `server/src/lens.ts` (`applyLens` チェーン型)。粗窓で消えるバーストを細窓 replay で注入真値通り復元
- [x] Step 3: 並行 $ST オーバーレイ・チューニング割り込み・動的データ追加 — `server/src/lens-view.ts` (LensView / ObservationOverlay)。1ストリームを複数レンズで同時観測、$Q 変更で live 再構成、後付け view を backfill (テスト計 47 件)
- [ ] Step 3b: Brain 向け観測 UI (スナップショット・パッケージ)

灯台モデルのコアはドメイン非依存。Phase 0 は真値が既知のストリーム
(Minecraft イベント + 自作異常) で機構を検証し、Phase 1 でコードテスト
ドメイン (`test_result:v1`) に皮を貼る。詳細は
[docs/LIGHTHOUSE_PILOT_DATA.md](docs/LIGHTHOUSE_PILOT_DATA.md) §1.5。
