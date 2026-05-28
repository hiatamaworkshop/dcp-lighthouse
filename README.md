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
npm run dev
```

## ステータス

未実装。実装順序は [CLAUDE.md](CLAUDE.md) を参照。
