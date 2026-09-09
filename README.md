# AI電話自動応答デモ — マンション工事日程受付

工事会社が、マンション住人から工事日程の回答を電話で受け付ける AI 自動応答システムのデモ。

**現在の実装段階: Stage 1（音声パイプラインの疎通確認）**
Twilio に着信 → WebSocket 接続 → 受信音声をそのままエコーバックするところまで。
OpenAI Realtime API との接続は Stage 2 で実装します。

---

## 1. 前提環境

| 項目 | 要件 |
|---|---|
| Node.js | 20.11 以上（開発・確認は v24.16.0） |
| npm | 10 以上 |
| トンネル | ngrok など。Twilio は `wss://`（TLS）でしか接続しないため、ローカル開発では必須 |
| Twilio | 着信可能な電話番号と、その番号の Voice Webhook を変更できる権限 |

---

## 2. セットアップ

```powershell
npm install
```

> **注意**: 環境変数 `NODE_ENV=production` が設定されていると、npm は devDependencies
> （TypeScript / tsx）を**黙ってスキップ**します。`npm run dev` が
> 「'tsc' is not recognized」で失敗する場合はこれが原因です。その場合は:
>
> ```powershell
> npm install --include=dev
> ```

環境変数ファイルを用意します。

```powershell
Copy-Item .env.example .env
```

`.env` を開いて以下を設定してください（Stage 1 で必要なのは Twilio の3項目のみ。
値が空でもエコーテストは動きますが、署名検証は無効になります）。

| 変数 | 内容 |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio Console の Account Info に表示される `AC…` |
| `TWILIO_AUTH_TOKEN` | 同上。**本プロジェクトでの用途は署名検証のみ**（REST API は呼びません） |
| `TWILIO_PHONE_NUMBER` | 受付用の着信番号（E.164形式。例 `+815017225690`） |
| `TWILIO_SIGNATURE_MODE` | `off` / `log` / `enforce`。**最初は `log` のまま**にし、署名が通ることをログで確認してから `enforce` にしてください |

**`.env` は絶対にコミットしないでください（契約上の義務）。** リポジトリと納品ZIPに含めるのは `.env.example` のみです。

---

## 3. 起動

```powershell
# 開発（ファイル変更で自動再起動）
npm run dev

# 本番相当（TypeScript をビルドしてから実行）
npm run build
npm start
```

起動できていることの確認:

```powershell
curl http://localhost:3000/health
# → {"status":"ok","stage":1,"handler":"echo","signatureMode":"log"}

# TwiML はブラウザで開いても確認できます（GET/POST 両対応にしてあります）
start http://localhost:3000/voice
```

---

## 4. トンネル（ローカル開発時）

別のターミナルで:

```powershell
ngrok http 3000
# → Forwarding  https://xxxx-xx-xx-xx-xx.ngrok-free.app -> http://localhost:3000
```

- `--host-header=rewrite` は**付けないでください**（署名検証が通らなくなります）。
- ngrok 無料プランは再起動のたびにホスト名が変わりますが、`PUBLIC_HOSTNAME` を
  空のままにしておけば、TwiML の `wss://` URL はリクエストの Host ヘッダから
  自動生成されるため修正不要です。
- `http://127.0.0.1:4040` で Twilio からのリクエストを実際に覗けます。切り分けに有用です。

---

## 5. Twilio 電話番号の設定

Console またはIncomingPhoneNumber REST API で、番号の「A CALL COMES IN」を
`https://<ngrokのホスト名>/voice`（HTTP **POST**）に設定します。

Twilio CLI を使う場合:

```powershell
twilio phone-numbers:update PNd0b30ac64194898182fe1d27b5e2b366 `
  --voice-url https://xxxx-xx-xx-xx-xx.ngrok-free.app/voice `
  --voice-method POST
```

> CLI は `localhost` の URL を明示的に拒否します。必ずトンネルの https URL を指定してください。

---

## 6. 動作確認（実機通話）

**必ず受話器または有線ヘッドセットで**かけてください。スピーカーフォンでは
音響フィードバックでハウリングし、正しい動作かどうか判断できません。

### 成功しているときの聞こえ方

1. 日本語の案内（「エコーテストを開始します」）が鳴る
2. 「あ、い、う、え、お」と話すと、**0.5〜1秒ほど遅れて自分の声がそのまま返る**
3. 音は連続していて、途切れ・クリック音・金属的な歪みが無い
4. 話し続けても**遅延が一定のまま**（だんだん伸びていかない）
5. 電話を切ると、サーバーのログに `stop` → `WebSocket クローズ` → `エコー終了サマリ` が出る
6. Twilio Console の Debugger に **31921 が赤く記録される（これは正常です）**

> 31921 は「サーバーが WebSocket を閉じた」という記録です。ソケットを自分で閉じるのは
> 仕様上正しいストリーム終了手順ですが、Twilio は Log Level = ERROR で記録します。
> 毎通話後に必ず出るため、追いかける必要はありません。

### 失敗パターンと切り分け

| 聞こえ方 | 最有力の原因 | 確認場所 |
|---|---|---|
| 案内は鳴るが**完全な無音**（切断はされない） | 送信メッセージの不備。`streamSid` 欠落／余計なフィールド混入／バイナリ送信 | Twilio Console の 31950・31951（**各ストリーム1回しか出ません**） |
| 案内の**直後に切断** | WebSocket ハンドラ内の例外、`<Stream url>` にクエリ文字列 | 31920 / 31921、`/stream-status` の `StreamError` |
| **呼び出し音のあと無音で切れる**（案内すら鳴らない） | Webhook URL 誤り／サーバー未起動／ngrok 未起動／`HOST` が 127.0.0.1 | 31901・31902・31904。ngrok の 4040 に着信が出るか |
| **ブツ切り・金属音** | フレーム欠落。Twilio 側の受信バッファ溢れの可能性もあり自コードとは限らない | 31930（Buffer Overflow）。サーバーログの「sequenceNumber が不連続」 |
| **遅延がだんだん伸びる** | 送信バッファの累積 | サーバーログの `mark 往復` の値が増え続けていないか |
| **猛烈なハウリング** | スピーカーフォンで試している | 受話器に持ち替える |
| **話し始めの音が欠ける** | メッセージ取りこぼし | サーバーログの `start` と最初の `媒体フレーム実測` の時刻差 |
| **無言が続くと切れる** | トンネル／プロキシのアイドルタイムアウト | 31903 |

> **重要**: 31920 / 31921 / 31924 / 31930 / 31931 / 31941 / 31950 / 31951 は
> **すべて WebSocket 上には現れません**。Twilio Console Debugger か、
> `/stream-status` に届く `StreamError` にしか出ません。
> ストリームが張れないときはまずそこを見てください。

---

## 7. 実機通話なしでのローカル検証

Twilio のメッセージ列を再現してプロトコル処理を検証できます。通話料も
Media Streams 料金もかかりません。

```powershell
# 別ターミナルでサーバーを起動しておく
npm run dev

# 検証を実行
node test/protocol-sim.mjs
```

TwiML の構造、`media` の往復、送信メッセージのフィールド構成、
トラックの取り違え、`start` 前の送信抑止などを確認します。
**ただしこれは音質・遅延・実際の音声品質を検証するものではありません。**
それらは実機通話でしか分かりません。

---

## 8. エンドポイント

| メソッド | パス | 役割 |
|---|---|---|
| `GET` / `POST` | `/voice` | 着信 webhook。TwiML を返す |
| `GET`(upgrade) | `/media-stream` | Twilio Media Streams の接続先 |
| `POST` | `/stream-status` | `<Stream statusCallback>` の受け口。**ストリームが張れないときの原因はここに出ます** |
| `POST` | `/call-status` | 通話ステータス（任意） |
| `GET` | `/health` | 起動確認 |

---

## 9. Stage 1 で実測する項目

Twilio が公式に文書化していない値が複数あるため、初回通話のログで実測します。
結果は納品物5（テスト結果および既知の制約事項）に記載します。

- 1フレームのバイト長（160バイトか）と base64 長（216文字か）
- `timestamp` の増分（20ms か）と実測フレームレート（50fps か）
- 無音時にフレームが抑制されるか
- `sequenceNumber` の欠落の有無
- `mark` の往復時間（再生バッファ深度の目安）
- Twilio が WebSocket の ping を送るか、アイドルで切断されるか
- WebSocket のクローズコードと理由
- `<Parameter>` が `customParameters` として届くか（Stage 3 以降で必須）

これらは `LOG_MEDIA_FRAMES` と `ECHO_MARK_EVERY` で制御でき、通話終了時に
「エコー終了サマリ」としてまとめて出力されます。

---

## 10. 既知の制約（Stage 1 時点）

- **音声フォーマットは G.711 μ-law 8kHz mono 固定。** Twilio Media Streams に選択肢はありません。
- **Media Streams に日本リージョンはありません**（US1 / IE1 / AU1 のみ）。
  Console の `tokyo` は SIP/REST の Edge Location であって Media Engine の位置ではないため、
  サーバーを日本に置いても音声の経路は短くなりません。日本からの通話は音声が太平洋を往復します。
  Stage 2 のレイテンシはこの前提で評価してください。
- `MEDIA_HANDLER=realtime` は Stage 2 で実装します。現在は `echo` のみです。
- 署名検証は既定で `log`（検証するが通す）です。Auth Token 設定後、
  ログで検証成功を確認してから `enforce` にしてください。
