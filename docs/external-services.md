# 外部サービス設定内容一覧

> 納品物3。本デモが利用する外部サービスと、その設定内容。
> **秘密値（Auth Token / API キー）は本書に一切記載しません。** それらは `.env` にのみ保持します。

---

## 1. Twilio

### 1-1. アカウント

| 項目 | 設定値 |
|---|---|
| アカウント種別 | 通常アカウント（Upgraded。トライアルではない） |
| Account SID | Console のホーム画面に表示される `AC` で始まる文字列。`.env` の `TWILIO_ACCOUNT_SID` に設定 |
| Auth Token | **秘密値。** Console ホームの「API keys and Auth tokens」から取得し `.env` の `TWILIO_AUTH_TOKEN` に設定 |
| リージョン | **United States (US1)** |

> トライアルアカウントでは通話の冒頭にトライアル用の音声が挿入され、通話時間にも上限があるため、
> デモには使用できません。

### 1-2. 電話番号

| 項目 | 設定値 |
|---|---|
| 電話番号 | `+81 50 1722 5690`（E.164: `+815017225690`） |
| 種別 | Japan / National（050番号・IP電話） |
| 対応機能 | Voice のみ（SMS 非対応） |
| Emergency calling | 非対応（050番号のため。本デモは着信専用なので影響なし） |

### 1-3. Voice Webhook 設定

Console の **Phone Numbers → Overview → 該当番号 → Configuration details → Voice and emergency address** で設定します。

| 設定項目 | 値 |
|---|---|
| Primary method | **Webhook** |
| Webhook URL | `https://<公開ホスト名>/voice` |
| HTTP Format | **HTTP POST** ← GET のままだと Twilio がフォームパラメータを送らない |
| Backup method URL | 空欄 |
| Call status change | `https://<公開ホスト名>/call-status`（任意。通話終了の記録用） |
| Caller name lookup | **Disabled**（有料の米国向け機能で、日本の発信者では解決しない） |

> 開発時にトンネル（Cloudflare Tunnel 等）を使う場合、公開ホスト名は再起動のたびに変わります。
> その都度この Webhook URL を貼り直してください。**コード側は修正不要**です
> （TwiML の `wss://` URL はリクエストの Host ヘッダから自動生成されます）。

### 1-4. Media Streams

TwiML で動的に設定するため、Console 側での設定は不要です。実際に送出される TwiML:

```xml
<Response>
  <Connect>
    <Stream url="wss://<公開ホスト名>/media-stream"
            name="reception"
            statusCallback="https://<公開ホスト名>/stream-status"
            statusCallbackMethod="POST" />
  </Connect>
  <Say language="ja-JP">ありがとうございました。失礼いたします。</Say>
</Response>
```

| 項目 | 内容 |
|---|---|
| 音声形式 | G.711 μ-law 8kHz mono（Twilio 表記 `audio/x-mulaw`）。**選択の余地はありません** |
| トラック | `inbound`（発信者の声）のみ。`<Connect>` 配下では他を指定するとエラー |
| 実測フレーム長 | 160バイト / 20ms / 約50fps（`docs/test-results.md` 参照） |

### 1-5. 課金対象

| 項目 | 備考 |
|---|---|
| 着信通話料 | 発信元（固定電話 / 携帯）により単価が異なります |
| Media Streams | 通話料とは**別建て**で分単位課金 |
| 電話番号 | 月額 |

---

## 2. OpenAI

### 2-1. 認証

| 項目 | 設定値 |
|---|---|
| APIキー | **秘密値。** `.env` の `OPENAI_API_KEY` に設定。サービスアカウントキー（`sk-svcacct-`）を使用 |
| 接続ヘッダ | `Authorization: Bearer <APIキー>` のみ |
| `OpenAI-Beta` ヘッダ | **付けない。** 付けると旧 beta スキーマが選択され、音声が無音になります |

> 本デモが利用する API は Realtime API のみです。プロジェクト単位の利用上限を設定している場合、
> 上限に達すると通話中に接続が切れます。

### 2-2. 接続先とモデル

| 項目 | 設定値 |
|---|---|
| 接続先 | `wss://api.openai.com/v1/realtime?model=<モデル名>` |
| モデル | `.env` の `OPENAI_REALTIME_MODEL`（既定 `gpt-realtime`） |
| 実機通話で確認したモデル | `gpt-realtime` |
| session 設定のみ確認したモデル | `gpt-realtime-2.1` / `gpt-realtime-mini`（`audio/pcmu` と `near_field` が `session.updated` に反映されることは確認済み。**実機通話では未検証**） |
| 使用不可 | `gpt-audio` / `gpt-audio-mini` は Chat Completions 用で Realtime では動作しません |

### 2-3. セッション設定（GAスキーマ）

`session.created` を受けた直後に1回だけ送信し、以降は通話中変更しません
（変更するとプロンプトキャッシュが破棄され課金が増えるため）。

| フィールドパス | 設定値 | 備考 |
|---|---|---|
| `session.type` | `realtime` | 必須。欠けると `session.update` ごと拒否される |
| `session.output_modalities` | `["audio"]` | 旧 `modalities` |
| `session.audio.input.format` | `{ type: "audio/pcmu" }` | **オブジェクト。** 文字列 `"g711_ulaw"` は beta の値 |
| `session.audio.output.format` | `{ type: "audio/pcmu" }` | 落とすと 24kHz PCM になり無音・雑音になる |
| `session.audio.input.noise_reduction` | `{ type: "near_field" }` | 既定は `null`（無効）。明示必須 |
| `session.audio.input.turn_detection.type` | `server_vad` | |
| `session.audio.input.turn_detection.threshold` | `.env` `VAD_THRESHOLD`（既定 0.65） | 低いと AI の発話を誤って中断する |
| `session.audio.input.turn_detection.silence_duration_ms` | `.env` `VAD_SILENCE_MS`（既定 800） | 既定値500は日本語の思考ポーズには短い |
| `session.audio.input.turn_detection.idle_timeout_ms` | `.env` `VAD_IDLE_TIMEOUT_MS`（既定 10000） | |
| `session.audio.output.voice` | `.env` `OPENAI_REALTIME_VOICE`（既定 `marin`） | 最初の音声出力後は変更不可 |
| `session.audio.output.speed` | `.env` `OUTPUT_SPEED`（既定 1.0） | 0.25〜1.5 |
| `session.max_output_tokens` | `.env` `MAX_OUTPUT_TOKENS`（既定 2000） | |
| `session.tools` | 5件（後述） | 通話中変更しない |
| `session.tool_choice` | `auto` | |

> `temperature` は GA のセッションから削除されています。送ってはいけません。

### 2-4. 登録している function（5件）

| 名前 | 役割 |
|---|---|
| `record_resident_info` | 氏名（かな）・電話番号・マンション名・部屋番号を1項目ずつ記録 |
| `record_response` | 仮予約日への回答（`confirm` / `change` / `decline`） |
| `record_preferred_dates` | 変更希望時の第一〜第三希望日。曜日つき復唱文をサーバー側で返す |
| `review_reception` | 受付内容の復唱用データを取得 |
| `complete_reception` | 受付確定と終話 |

---

## 3. 公開経路（開発時）

Twilio は `wss://`（TLS）でしか接続しないため、ローカル開発ではトンネルが必要です。

| 項目 | 内容 |
|---|---|
| 使用ツール | Cloudflare Tunnel（`cloudflared tunnel --url http://localhost:3000`） |
| アカウント | 不要（Quick Tunnel） |
| 発行される URL | `https://<ランダム>.trycloudflare.com`。**再起動のたびに変わります** |
| 注意 | `--host-header=rewrite` は付けないでください（署名検証が通らなくなります） |

> 本番相当の構成では、固定ドメイン + TLS 証明書を持つサーバーに直接配置してください。
> その場合トンネルは不要になり、`.env` の `PUBLIC_HOSTNAME` にホスト名を設定します。

**設置場所について**: Twilio Media Streams に日本リージョンはなく（US1 / IE1 / AU1）、
日本からの通話でも音声はまず US1（バージニア）へ渡ります。したがってサーバーを
**米国東部**に置くのが最も低遅延で、日本国内に置くと太平洋を余分に2回横断します
（詳細は `docs/test-results.md`）。

---

## 4. 環境変数の一覧

すべて `.env` で管理します。値の入っていないひな形は `.env.example` にあります。
**`.env` はリポジトリにも納品ZIPにも含めません（契約上の義務）。**

| 変数 | 秘密 | 用途 |
|---|---|---|
| `PORT` / `HOST` | | 待ち受け。`HOST` は `0.0.0.0` にする（既定の 127.0.0.1 だとトンネル経由で届かない） |
| `PUBLIC_HOSTNAME` | | 空ならリクエストの Host ヘッダから自動生成 |
| `TWILIO_ACCOUNT_SID` | | Twilio のアカウント識別子 |
| `TWILIO_AUTH_TOKEN` | **●** | 署名検証にのみ使用 |
| `TWILIO_PHONE_NUMBER` | | 受付用の着信番号 |
| `TWILIO_SIGNATURE_MODE` | | `off` / `log` / `enforce` |
| `MEDIA_HANDLER` | | `echo`（疎通確認用） / `realtime`（本番動作） |
| `OPENAI_API_KEY` | **●** | Realtime API の認証 |
| `OPENAI_REALTIME_MODEL` / `OPENAI_REALTIME_VOICE` | | モデルと音声 |
| `VAD_THRESHOLD` / `VAD_SILENCE_MS` / `VAD_IDLE_TIMEOUT_MS` | | 発話区切りの調整 |
| `OUTPUT_SPEED` / `MAX_OUTPUT_TOKENS` | | 発話速度と応答上限 |
| `REALTIME_CONNECT_TIMEOUT_MS` | | OpenAI 接続のタイムアウト |
| `ENABLE_INPUT_TRANSCRIPTION` / `TRANSCRIPTION_MODEL` | | 入力の文字起こし（デバッグ用・別課金） |
| `TENTATIVE_DATE` | | 全通話で案内する仮予約日（YYYY-MM-DD） |
| `DATABASE_PATH` | | SQLite ファイルの場所 |
| `LOG_LEVEL` / `LOG_MEDIA_FRAMES` / `ECHO_BATCH_FRAMES` / `ECHO_MARK_EVERY` | | ログと疎通確認用の調整 |
