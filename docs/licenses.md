# 使用ライブラリ・OSSライセンス情報一覧

> 納品物4。`npm install` によって導入されるパッケージのライセンス情報。
> 調査日: 2026-09-11（node:sqlite 移行後に再取得）/ 対象: `package.json` および `node_modules` の実測値

---

## 1. 直接依存（実行時）

本番実行に必要なパッケージ。

| パッケージ | バージョン | ライセンス | 用途 | 配布元 |
|---|---|---|---|---|
| `fastify` | 5.12.3 | MIT | HTTPサーバー本体（Webhook・管理画面） | https://github.com/fastify/fastify |
| `@fastify/websocket` | 11.3.0 | MIT | Twilio Media Streams の WebSocket 受け口 | https://github.com/fastify/fastify-websocket |
| `@fastify/formbody` | 9.0.0 | MIT | Twilio Webhook の `application/x-www-form-urlencoded` 解析 | https://github.com/fastify/fastify-formbody |
| `ws` | 8.21.3 | MIT | OpenAI Realtime API への WebSocket クライアント | https://github.com/websockets/ws |
| `twilio` | 6.1.0 | MIT | `X-Twilio-Signature` の検証のみに使用 | https://github.com/twilio/twilio-node |
| `dotenv` | 17.4.2 | BSD-2-Clause | `.env` の読み込み | https://github.com/motdotla/dotenv |

## 2. 直接依存（開発時のみ）

`npm run build` / `npm run dev` に必要。本番実行には不要。

| パッケージ | バージョン | ライセンス | 用途 | 配布元 |
|---|---|---|---|---|
| `typescript` | 5.9.3 | Apache-2.0 | TypeScript コンパイラ | https://github.com/microsoft/TypeScript |
| `tsx` | 4.23.13 | MIT | 開発時の TypeScript 直接実行 | https://github.com/privatenumber/tsx |
| `@types/node` | 26.5.0 | MIT | Node.js の型定義 | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/ws` | 8.18.1 | MIT | `ws` の型定義 | https://github.com/DefinitelyTyped/DefinitelyTyped |

> SQLite は Node.js 24 に組み込まれている `node:sqlite` を使用しており、
> 外部パッケージへの依存はありません。ネイティブモジュールを持たないため、
> インストール時にコンパイラを必要としません。

## 3. 推移的依存を含めた全体

`node_modules` 配下の全パッケージ **124件** のライセンス内訳。

| ライセンス | 件数 |
|---|---|
| MIT | 105 |
| BSD-3-Clause | 7 |
| ISC | 7 |
| Apache-2.0 | 2 |
| BSD-2-Clause | 1 |

**すべて OSI 承認のパーミッシブライセンスであり、コピーレフト（GPL / AGPL / LGPL）は含まれていません。**
本デモの利用・改変・再配布にあたって、ソースコード公開義務は発生しません。

ライセンス表記が取得できなかった2件（`transport@0.0.1`、`benchmarks@1.0.0`）は、
`pino` のテストフィクスチャおよび `fast-uri` / `secure-json-parse` のベンチマーク用
ディレクトリに含まれるもので、**依存関係としてインストールされるパッケージではありません**
（`npm ls transport benchmarks` は空を返します）。実行時にも読み込まれません。

## 4. 外部サービス（OSSではない）

以下は本デモが通信する商用サービスであり、利用規約は各社のものが適用されます。
詳細は `docs/external-services.md` を参照してください。

| サービス | 用途 |
|---|---|
| Twilio | 電話着信、Media Streams による双方向音声 |
| OpenAI | Realtime API による音声対話 |
| Cloudflare Tunnel | 開発時にローカルサーバーを公開するためのトンネル（本番構成では不要） |

## 5. 再取得方法

本一覧は以下で再生成できます。

```powershell
# 直接依存のライセンス
npm ls --depth=0

# 全パッケージのライセンス内訳（別途 license-checker を使う場合）
npx license-checker --summary
```

`npm ls --depth=0` の出力と本一覧のバージョンが食い違う場合は、
`package.json` の更新後に本ファイルを更新してください。
