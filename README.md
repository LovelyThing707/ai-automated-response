# AI電話自動応答デモ — マンション工事日程受付

工事会社が、マンション住人から工事日程の回答を電話で受け付ける AI 自動応答システムのデモです。

住人が電話をかけると AI が日本語で応対し、氏名・電話番号・マンション名・部屋番号を伺ったうえで、
仮予約日に対する「確定 / 変更希望 / 辞退」を受け付けます。変更希望の場合は第一〜第三希望日を伺います。
受け付けた内容は管理画面で確認できます。

**社内確認用のデモであり、本番運用システムではありません。**

---

## 1. 前提環境

| 項目 | 要件 |
|---|---|
| Node.js | **24.0 以上**（開発・確認は v24.16.0）。SQLite に Node 組み込みの `node:sqlite` を使うため |
| npm | 10 以上 |
| Twilio | 着信可能な電話番号と、その番号の Voice Webhook を変更できる権限 |
| OpenAI | Realtime API が利用可能な API キー |
| トンネル | ローカルで動かす場合のみ必要（Twilio は `wss://` でしか接続しないため） |

**ネイティブモジュールを使っていないため、ビルドツール（Visual Studio 等）は不要**です。
SQLite は Node 24 に組み込まれている `node:sqlite` を利用します。

---

## 2. セットアップ

```powershell
npm install
```

> **注意**: 環境変数 `NODE_ENV=production` が設定されていると、npm は devDependencies
> （TypeScript / tsx）を**黙ってスキップ**します。`npm run dev` が
> 「'tsc' is not recognized」で失敗する場合はこれが原因です。
>
> ```powershell
> npm install --include=dev
> ```

環境変数ファイルを用意します。

```powershell
Copy-Item .env.example .env
```

`.env` を開いて、最低限つぎの項目を設定してください。

| 変数 | 内容 |
|---|---|
| `OPENAI_API_KEY` | OpenAI の API キー |
| `TWILIO_ACCOUNT_SID` | Twilio Console ホームに表示される `AC…` |
| `TWILIO_AUTH_TOKEN` | 同ホームの「API keys and Auth tokens」から取得 |
| `TWILIO_PHONE_NUMBER` | 受付用の着信番号（E.164形式。例 `+815017225690`） |
| `TENTATIVE_DATE` | 全通話で案内する仮予約日（例 `2026-09-24`） |

各変数の詳細は `.env.example` のコメントと `docs/external-services.md` を参照してください。

> **`.env` は絶対にコミット・再配布しないでください（契約上の義務）。**
> リポジトリと納品ZIPに含めるのは `.env.example` のみです。

---

## 3. 起動

```powershell
# 開発（ファイル変更で自動再起動）
npm run dev

# 本番相当（ビルドしてから実行）
npm run build
npm start
```

起動確認:

```powershell
curl http://localhost:3000/health
# → {"status":"ok","handler":"realtime","signatureMode":"log"}
```

---

## 4. 公開URLの用意（ローカル開発時）

Twilio は TLS 付きの `wss://` でしか接続しないため、ローカルで動かす場合はトンネルが必要です。

```powershell
cloudflared tunnel --url http://localhost:3000
# → https://<ランダム>.trycloudflare.com が発行される
```

- アカウント登録は不要です（Quick Tunnel）。
- `--host-header=rewrite` は**付けないでください**（署名検証が通らなくなります）。
- URL は再起動のたびに変わります。変わったら Twilio 側の Webhook を貼り直してください。
  **コードの修正は不要**です（TwiML の `wss://` URL はリクエストの Host ヘッダから自動生成されます）。

固定ドメインを持つサーバーに配置する場合は、トンネルは不要です。`.env` の `PUBLIC_HOSTNAME` に
ホスト名を設定してください。

---

## 5. Twilio 電話番号の設定

Console の **Phone Numbers → Overview → 該当番号 → Configuration details → Voice and emergency address** で:

| 設定項目 | 値 |
|---|---|
| Primary method | Webhook |
| Webhook URL | `https://<公開ホスト名>/voice` |
| HTTP Format | **HTTP POST** |

`HTTP Format` の既定は GET です。**POST に変更してください。** GET のままだと Twilio が
`CallSid` などのパラメータを送らず、署名検証の計算方法も変わります。

保存後、ページを再読み込みして Webhook URL と POST が反映されていることを確認してください。

---

## 6. 使い方

### 6-1. 電話をかける

設定した番号に電話をかけると、AI が応対します。

1. AI が会社名を名乗って挨拶します
2. お名前の読み → 電話番号 → マンション名 → 部屋番号 の順に、1項目ずつ聞かれます
3. 各項目は復唱して確認されます
4. 仮予約日が曜日つきで案内されます
5. 「確定 / 変更希望 / 辞退」を答えます
6. 変更希望の場合は、第一〜第三希望日を1つずつ聞かれます
7. 受付内容が復唱され、確認が取れると AI 側から通話を終了します

**受話器か有線イヤホンを使ってください。** スピーカーフォンでは音が回り込んでハウリングします。

### 6-2. 管理画面

```text
http://localhost:3000/admin
```

- 一覧: 受付日時・お名前・マンション名・部屋番号・回答内容・受付状況（新しい順）
- 詳細: データモデルの全項目
- 絞り込み: マンション名、受付状況、キーワード（お名前・電話番号・部屋番号の部分一致）
- デモデータ一括クリア（確認ダイアログ付き）

> **認証はありません**（仕様どおり）。トンネル経由で公開している間は、URL を知っている人なら
> 誰でも閲覧および一括クリアが可能です。共有範囲にご注意ください。

---

## 7. 動作確認

### 7-1. 実機通話なしの検証

通話料も API 利用料もかからない検証です。コードを変更したらまずこれを実行してください。

```powershell
# 型チェック
npm run typecheck

# 日付ユーティリティと受付状態機械（47項目）
npm run test:flow

# DB層: 保存・上書き・絞り込み・詳細・一括クリア（22項目）
# 専用のテストDBを使うため、デモデータは影響を受けません
npm run test:db

# OpenAI のセッション設定とツール登録（10項目・音声は流さないためほぼ無課金）
npm run test:realtime

# Twilio Media Streams のプロトコル（サーバー起動中に別ターミナルで）
# realtime モードでは19項目、MEDIA_HANDLER=echo で起動していれば
# 音声のエコー検証も加わり22項目になります
node test/protocol-sim.mjs
```

管理画面を実データなしで確認したい場合は、架空データを投入できます。

```powershell
npm run seed
```

### 7-2. 実機通話でしか分からないこと

音質・体感遅延・割り込みの自然さは通話しないと分かりません。
`docs/test-results.md` に実測値と既知の制約をまとめています。

---

## 8. うまく動かないとき

| 症状 | 最有力の原因 | 確認場所 |
|---|---|---|
| 呼び出し音のあと**無音で切れる**（挨拶すら鳴らない） | Webhook URL 誤り／サーバー未起動／トンネル未起動／`HOST` が 127.0.0.1 | Twilio Console の Debugger（31901・31902・31904）。トンネルにリクエストが届いているか |
| 挨拶は鳴るが**完全な無音** | 音声フォーマットの不一致、または送信メッセージの不備 | サーバーログの `session.updated`。`audio/pcmu` と `near_field` が反映されているか |
| 挨拶の**直後に切断** | WebSocket ハンドラ内の例外 | 31920 / 31921、`/stream-status` の `StreamError` |
| **ブツ切り・金属音** | フレーム欠落、または Twilio 側の受信バッファ溢れ | 31930。サーバーログの `sequenceNumber が不連続` |
| AI が**話している途中で勝手に止まる** | VAD が過敏 | `.env` の `VAD_THRESHOLD` を上げる（0.65 → 0.7） |
| 考えている間に**話を遮られる** | 無音判定が短い | `.env` の `VAD_SILENCE_MS` を上げる（800 → 1000） |
| 通話が終わらない／締めの挨拶が途中で切れる | 再生バッファの滞留 | サーバーログの `再生の進行が止まりました` / `上限時間` |
| 管理画面に**記録が出ない** | 保存の失敗 | サーバーログの `受付内容の保存に失敗しました` |

> Twilio Console の Debugger に毎通話 **31921** が ERROR として記録されますが、これは
> サーバーが WebSocket を閉じた記録であり、仕様上正しい終了手順です。**異常ではありません。**
>
> 31920 / 31921 / 31924 / 31930 / 31931 / 31941 / 31950 / 31951 は
> **WebSocket 上には現れません**。Twilio Console か `/stream-status` にしか出ません。

### 疎通だけを切り分けたいとき

`.env` の `MEDIA_HANDLER` を `echo` にすると、OpenAI を経由せず受信音声をそのまま返します。
「音が出ない」ときに、Twilio 側の問題か OpenAI 側の問題かを切り分けられます。

---

## 9. エンドポイント

| メソッド | パス | 役割 |
|---|---|---|
| `GET` / `POST` | `/voice` | 着信 webhook。TwiML を返す |
| `GET`(upgrade) | `/media-stream` | Twilio Media Streams の接続先 |
| `POST` | `/stream-status` | `<Stream statusCallback>` の受け口 |
| `POST` | `/call-status` | 通話ステータス（任意） |
| `GET` | `/health` | 起動確認 |
| `GET` | `/admin` | 受付一覧 |
| `GET` | `/admin/receptions/:id` | 受付詳細 |
| `POST` | `/admin/clear` | デモデータ一括クリア |

---

## 10. ディレクトリ構成

```text
src/
├── server.ts                    Fastify 生成・ルート登録・起動
├── config.ts                    .env 読み込みと起動時バリデーション
├── logger.ts                    通話単位の構造化ログ
├── routes/
│   ├── voice.ts                 着信 webhook（TwiML）
│   ├── media-stream.ts          WebSocket 受け口。Twilio プロトコルを吸収
│   ├── stream-status.ts         Stream / Call のステータスコールバック
│   └── admin.ts                 管理画面
├── twilio/
│   ├── protocol.ts              メッセージ型とパーサ
│   ├── sender.ts                media / mark / clear の送信
│   ├── twiml.ts                 TwiML 生成
│   └── signature.ts             X-Twilio-Signature 検証
├── media/
│   ├── handler.ts               MediaHandler インターフェース
│   ├── echo-handler.ts          疎通確認用（MEDIA_HANDLER=echo）
│   └── realtime-handler.ts      OpenAI 中継・barge-in・終話
├── realtime/
│   ├── openai-session.ts        OpenAI Realtime の WebSocket クライアント
│   ├── reception-state.ts       受付状態機械と入力検証
│   ├── dates.ts                 日付と曜日（サーバー側で計算）
│   ├── instructions.ts          モデルへの指示文
│   └── tools.ts                 function calling 定義
└── db/index.ts                  SQLite 保存と検索

docs/
├── external-services.md         納品物3: 外部サービス設定内容一覧
├── licenses.md                  納品物4: OSSライセンス情報一覧
└── test-results.md              納品物5: テスト結果と既知の制約

test/                            実機通話なしの検証スクリプト
```

`media/handler.ts` の `MediaHandler` インターフェースがトランスポート層と応答ロジックの境界です。
`MEDIA_HANDLER` を切り替えるだけで、エコー応答と AI 応答を差し替えられます。

---

## 11. 対象範囲

本デモに**含まれない**もの（契約で対象外と定義済み）:

- 管理者による工事日程の選択・確定機能
- 住人への自動発信（outbound calling）
- 後日かけ直しての予約状況照会
- 住人マスタとの照合、既存システム連携
- 受付内容の編集、個別削除
- 認証、権限管理
- 冗長化、監視、バックアップ、大量同時通話対応

仮予約日は住人ごとではなく、`.env` の `TENTATIVE_DATE` で指定した**1つの日付を全通話で案内**します
（住人マスタとの照合が対象外のため）。

既知の制約は `docs/test-results.md` にまとめています。

---

## 12. 納品物とファイルの対応

| 納品物 | 該当ファイル |
|---|---|
| 1. ソースコード一式 | `src/` `test/` `package.json` `tsconfig.json` `.env.example` |
| 2. 環境設定・起動方法の手順書 | 本 README |
| 3. 外部サービス設定内容一覧 | `docs/external-services.md` |
| 4. 使用ライブラリ・OSSライセンス情報一覧 | `docs/licenses.md` |
| 5. テスト結果および既知の制約事項 | `docs/test-results.md` |

### 納品ZIP の作り方

```powershell
# 1. ビルド成果物と実データを消してから固める
Remove-Item -Recurse -Force dist, node_modules -ErrorAction SilentlyContinue
Remove-Item data/*.sqlite* -ErrorAction SilentlyContinue

# 2. 除外リストを守って圧縮（git 管理下のファイルだけを固めるのが確実）
git archive --format=zip --output=../ai-automated-response.zip HEAD
```

**ZIP に含めてはいけないもの**:

| 対象 | 理由 |
|---|---|
| `.env` | 認証情報。**契約上の義務として絶対に含めない** |
| `node_modules/` | `better-sqlite3` にプラットフォーム別のバイナリが含まれ、別環境で動かない |
| `dist/` | ビルド成果物。`npm run build` で再生成できる |
| `data/*.sqlite*` | 実通話の受付内容と Call SID が入る |

`git archive` を使えば `.gitignore` の除外がそのまま効くため、上記は自動的に除かれます。
受領側は ZIP を展開して `npm install` → `.env.example` を `.env` にコピーして値を埋める、で動きます。
