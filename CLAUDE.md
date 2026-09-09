# AI電話自動応答デモ — マンション工事日程受付

## プロジェクト概要

工事会社が、マンション住人から工事日程の回答を電話で受け付けるAI自動応答システムのデモ。
住人には事前に「仮予約日」が割り当てられており、電話をかけて「確定 / 変更希望 / 辞退」を回答する。
変更希望の場合は第一〜第三希望日をヒアリングする。

受け付けた内容は簡易管理画面で確認できる。

**これは社内確認用のデモであり、本番運用システムではない。**

納期: 2026-09-13

---

## 技術スタック

- **Node.js** (LTS) — TypeScript推奨だがJavaScriptでも可
- **Twilio** — 着信、Media Streams (WebSocket双方向音声)
- **OpenAI Realtime API** — speech-to-speech音声対話
- **音声形式** — G.711 μ-law, 8kHz, mono, base64
  - 同じコーデックを Twilio は `audio/x-mulaw`、OpenAI は `audio/pcmu` と呼ぶ。貼り違えると接続はするが無音になる
- **DB** — SQLite (better-sqlite3) で十分。デモ用データのみ
- **管理画面** — Express + サーバーサイドHTML、またはシンプルなSPA。認証不要

### 重要な制約

- **`.env` で全ての認証情報を管理する。ソースコードに直接記載しない（契約上の義務）**
- リポジトリには `.env.example` のみをコミットする
- 実在する個人情報は一切使わない。架空データのみ

---

## 対象スコープ（これ以外は作らない）

### 含むもの
1. Twilioで着信し、AIが音声応答
2. 氏名・電話番号・マンション名・部屋番号のヒアリング
3. 仮予約日に対する「確定 / 変更希望 / 辞退」の受付
4. 変更希望の場合、第一〜第三希望日のヒアリング
5. 通話終了前に受付内容を復唱して確認
6. 受付結果をDBに保存
7. 管理画面: 一覧表示、詳細表示、簡易検索・絞り込み、デモデータ一括クリア

### 明示的に含まないもの（契約で対象外と定義済み）
- 管理者による工事日程の選択・確定機能
- 住人への自動発信（outbound calling）
- 発信後の会話フロー
- 後日かけ直しての予約状況照会
- 住人マスタとの照合、既存システム連携
- 受付内容の編集、個別削除
- 認証、権限管理、多要素認証
- 冗長化、監視、バックアップ、大量同時通話対応

**スコープ外の機能を提案・実装しないこと。** 必要と思われても、まず確認する。

---

## 会話フロー（状態機械）

```
START
  → GREETING（会社名を名乗り、用件を説明）
  → COLLECT_NAME（お名前）
  → COLLECT_PHONE（電話番号）
  → COLLECT_BUILDING（マンション名）
  → COLLECT_ROOM（部屋番号）
  → ANNOUNCE_TENTATIVE（仮予約日を案内）
  → BRANCH:
      ├─ CONFIRM   → CONFIRM_SUMMARY → END
      ├─ CHANGE    → COLLECT_DATE_1 → COLLECT_DATE_2 → COLLECT_DATE_3
      │              → CONFIRM_SUMMARY → END
      └─ DECLINE   → CONFIRM_SUMMARY → END
```

### 状態管理の方針

OpenAI Realtime の **function calling** で各項目を確定させる。
モデルに自由に会話させつつ、確定した値はツール呼び出しでサーバー側の状態に記録する。

推奨ツール:
- `record_resident_info(name_kana, phone, building, room)`
- `record_response(type: "confirm" | "change" | "decline")`
- `record_preferred_dates(date1, date2, date3)`
- `complete_reception()`

サーバー側で「今どの項目が未取得か」を保持する。ただし **instructions は通話中一切書き換えない**。
instructions と tools は会話の先頭に置かれるため、途中で変更するとプロンプトキャッシュが破棄され、
以降の全ターンでプレフィックス全体が定価で再課金される（3分通話で約2.8倍）。

状態はツール呼び出しの戻り値（`function_call_output` の `output` 文字列）でモデルに伝える。
これは会話の末尾に追記されるだけなのでキャッシュを壊さない。
例: `{"ok":true,"recorded":["name_kana"],"next_missing":"phone","hint":"次は電話番号を伺ってください"}`

instructions は通話開始時に1回だけ組み立てる（本日の日付・曜日・仮予約日を埋め込む）。以降 `session.update` は送らない。

**GREETING は自動では始まらない。** `turn_detection: server_vad` ではモデルは発信者の発話を待つため、
着信直後は完全な無音になる。`session.updated` 受信後かつ Twilio の `start` 受信後に、サーバーから明示的に
`conversation.item.create`（role:"user" の input_text で挨拶を指示）＋ `response.create` を送って口火を切る。
両条件を満たす前に送ると streamSid が未確定で音声が捨てられ、発信者には無音になる。

---

## 認識精度の設計（重要 — ここが品質を決める）

電話音声は G.711 μ-law 8kHz の狭帯域で、音を聞き分けるための高域が物理的に失われている。
プロンプトや後処理だけでは信号由来の誤りは解消できない。以下の設計で精度を担保する。

### ノイズ抑制設定

`session.audio.input.noise_reduction` に **`{ type: "near_field" }`** を明示指定する。

**パスに注意。** beta 時代の `session.input_audio_noise_reduction`（トップレベル平坦）は GA では存在しない。
GA は `session.audio.input.noise_reduction` にネストしている。古いパスで送ってもエラーは出ず
`session.updated` も正常に返るが、値は既定の `null`（ノイズ抑制オフ）のままになる。
`turn_detection` と違い、書かなければ何も効かない。
「設定したつもりで実は無効」のまま精度チューニングを続けるのが最悪の失敗モードなので、
毎通話 `session.updated` をログに出して `audio.input.noise_reduction.type === "near_field"` を検証すること。

理由: `far_field` はノートPCや会議室マイクなど遠距離マイク向けの設定。電話の発信者は受話器を口元に当てるかイヤホンで通話しており、音響的には近距離に該当する。`far_field` では必要な音声成分まで削ってしまう可能性がある。

ただし near_field モデルが 8kHz μ-law の電話音声で学習されているかは公式に記載が無い。
Stage 7 で「near_field あり / noise_reduction 未指定」の A/B を実機通話で行うこと。

### マンション名

認識対象は以下の3つのみ。**これらを認識候補としてinstructionsに明示的に登録する。**

- ライオンズマンション
- ネスペマンション
- テストマンション

固有名詞は8kHzで最も認識が難しいため、選択肢を絞ることが最も効果的。
候補に一致しない場合は聞き返す。

### 部屋番号

数字のみ（101, 201 など）。英字混じりは想定しない。
必ず復唱確認する。

### お名前

漢字の確定は行わない。**読み（かな）で取得する。**
同音異字・読みの揺れがあり、電話音質での漢字確定は非現実的。

### 電話番号

- 桁数検証（10〜11桁）
- 必ず復唱確認
- 日本語の数字は「1（いち）/ 7（しち）」「4（し）/ 7（しち）」が紛れやすい

### 日付

- 「来週の火曜日」などの相対表現を実際の日付に変換する
- **復唱時は必ず曜日を添える**: 「9月15日、月曜日でお間違いないでしょうか」
  - 曜日が冗長な検証になる。住人が「15日」と言ったのに AI が「5日」と聞き取った場合、
    曜日の不一致で即座に誤りが表面化する
- 日本語の日付で紛れやすい組み合わせ: 「よっか（4日）」「ようか（8日）」
- 第一〜第三希望は、**都度復唱して確定させてから次に進む**（まとめて聞くと混同する）

### 復唱確認の原則

数字の復唱では曖昧さを排した読みを使う:
- 7 → 「なな」（「しち」は使わない）
- 4 → 「よん」（「し」は使わない）
- 0 → 「ゼロ」

---

## データモデル

```
receptions
  id
  received_at        受付日時
  name_kana          お名前（かな）
  phone              電話番号
  building           マンション名
  room               部屋番号
  tentative_date     仮予約日
  response_type      確定 / 変更希望 / 辞退
  preferred_date_1   第一希望日
  preferred_date_2   第二希望日
  preferred_date_3   第三希望日
  status             受付状況
  call_sid           Twilio Call SID（デバッグ用）
```

管理画面の詳細表示は上記全項目を表示する（確定済みの仕様）。

---

## 管理画面

- 一覧表示: 受付日時、お名前、マンション名、部屋番号、回答内容、受付状況
- 詳細表示: 上記データモデルの全項目
- 検索・絞り込み: マンション名、受付状況
- デモデータ一括クリア: 確認ダイアログ付き

認証は不要。シンプルで見やすければよい。デザインに凝る必要はない。

---

## 開発の進め方

**段階的に構築し、各段階で必ず実際に電話をかけて確認する。**
音声のバグはコードを読んでも分からない。通話して初めて分かる。

### Stage 1: 音声パイプラインの疎通
Twilio着信 → WebSocket接続 → 受信音声をそのままエコーバック。
これで音声が正しく往復することを確認する。**ここが最も詰まりやすい。**

確認: 電話をかけて、自分の声が返ってくるか。途切れ・エコー・遅延がないか。

### Stage 2: OpenAI Realtime との接続
エコーの代わりに Realtime API へ中継。単純な雑談ができる状態にする。

確認: AIと自然に会話できるか。レイテンシは許容範囲か。音質はどうか。

### Stage 3: function calling で項目取得
4項目（氏名・電話番号・マンション名・部屋番号）のヒアリングを実装。

確認: 各項目が正しく取得できるか。特にマンション名と数字。

### Stage 4: 分岐と希望日
確定 / 変更希望 / 辞退の3分岐、変更時の第一〜第三希望日。

確認: 3パターンすべて。日付の相対表現。

### Stage 5: 復唱確認と保存
受付内容の復唱、DB保存。

確認: 復唱内容が正しいか。曜日が正しく計算されているか。

### Stage 6: 管理画面
一覧・詳細・検索・クリア。

### Stage 7: 調整
プロンプト調整、聞き返しの自然さ、エッジケース。

---

## 実装上の注意点

### Twilio Media Streams

- Twilioは base64エンコードされた μ-law フレームを WebSocket で送ってくる
- メッセージ種別: `connected`, `start`, `media`, `mark`, `stop`
- 音声を送り返す際は同じ形式で `media` イベントとして送る
- **barge-in（割り込み）対応は2アクション必須**:
  1. Twilio へ `{event:"clear", streamSid}` — バッファ済みの未再生音声を破棄する
  2. OpenAI へ `conversation.item.truncate {item_id, content_index:0, audio_end_ms}`
     — モデルの会話履歴を「実際に発信者に聞こえたところ」で切る

  片方だけでは駄目。1 を欠くとAIが話し続けて会話が破綻する。2 を欠くとモデルが
  「聞こえていない発話」を発話済みと信じ、本デモの中核である復唱確認が破綻する
  （読み上げていない日付を「先ほど申し上げた通り」と扱う）。
  この truncate が自動化されるのは WebRTC / SIP のみで、WebSocket ブリッジでは自前で送る。
  `output_audio_buffer.clear` は "WebRTC/SIP Only" なので使わない
- `mark` イベントで再生完了を追跡できる。**barge-in の必須部品でもある**:
  未返却の mark が残っているかどうかが「まだ再生中の音声があるか」の唯一の判定材料で、
  これを見ずに truncate すると audio_end_ms が実音声長を超えてサーバーエラーになる

### OpenAI Realtime API

- WebSocket接続。session設定で音声形式を μ-law 8kHz に合わせる
  - `session.audio.input.format = { type: "audio/pcmu" }`
  - `session.audio.output.format = { type: "audio/pcmu" }`
  - **オブジェクトであって文字列ではない。** `"g711_ulaw"` は beta の値。
    `audio/pcmu` に `rate` キーは無い（G.711 は定義上 8kHz）ため `rate: 8000` はスキーマ違反
  - 未指定時の既定は PCM 16bit 24kHz mono。指定を落とすと μ-law バイト列が 24kHz PCM として
    解釈され、**エラー無しで**完全な無音または高速ノイズになる
- `session.audio.input.noise_reduction = { type: "near_field" }`（詳細は「認識精度の設計 > ノイズ抑制設定」を参照）
- `session.output_modalities = ["audio"]`（beta の `modalities`。text と audio の同時指定は不可）
- `session.audio.output.voice`（beta の `session.voice`）。最初の音声出力後は変更不可
- `session.type = "realtime"` は必須。欠けると `session.update` ごと拒否され、
  tools が未登録のままモデルが即興で会話してしまう
- 接続ヘッダは `Authorization: Bearer` のみ。**`OpenAI-Beta: realtime=v1` は付けない**
  （付けると beta スキーマが選択される）
- `temperature` は GA の session から削除された
- turn detection の設定は要調整。無音待ち時間が長すぎると応答が遅く、
  短すぎると住人の発話を途中で切ってしまう
- **APIは変化が速い。実装前に最新の公式ドキュメントを確認すること。**
  記憶に頼らず、session設定のスキーマを必ず検証する

### エラー処理

デモなので過剰な作り込みは不要。ただし以下は必要:
- 認識できない場合の聞き返し（同じ項目で3回失敗したら次に進むか、丁寧に終話）
- WebSocket切断時のクリーンアップ
- 通話中の例外でプロセスが落ちないこと

---

## 納品物（契約で定義済み）

1. ソースコード一式
2. 環境設定・起動方法を記載した手順書またはREADME
   - **クライアント環境で動かせるレベルの手順を書くこと**
3. 外部サービス設定内容一覧（秘密値は除く）
4. 使用ライブラリ・OSSのライセンス情報一覧
5. テスト結果および既知の制約事項

すべてZIPにまとめて納品する。`.env` は**含めない**（`.env.example` のみ）。

---

## コミュニケーション方針

- 不明点があれば実装を進める前に確認する
- スコープ外と思われる要望が出てきたら、実装せずに指摘する
- 「動くはず」ではなく、実際に通話して確認した結果で判断する
