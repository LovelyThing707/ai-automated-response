import { config } from '../config.js';

export interface TwiMLOptions {
  /** wss:// を組み立てるためのホスト名（例: xxxx.ngrok-free.app） */
  hostname: string;
  /** <Parameter> として Media Stream に渡す値。Stage 3 以降で仮予約日などを載せる。 */
  parameters?: Record<string, string>;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 着信時に返す TwiML。
 *
 * 設計上の確定事項:
 *  - <Connect><Stream> を使う。<Start><Stream> は単方向で音声を返せず、
 *    返そうとすると Error 31924 になる（かつ発信者には無音に聞こえる）。
 *  - track 属性は書かない。<Connect> 配下では inbound_track 以外を指定すると
 *    Error 31941 になる。既定が inbound_track なので省略が最も安全。
 *  - url は絶対 wss:// URL。クエリ文字列を付けると Error 31920（ハンドシェイク失敗）。
 *    通話ごとの値は <Parameter> で渡す。
 *  - <Say> は <Connect> より前に置く。<Connect> は後続 TwiML をブロックするため、
 *    後ろに置くと発信者は接続直後から完全な無音を聞くことになる。
 *  - </Connect> の後の <Say> は「サーバーがソケットを閉じたとき」だけ再生される。
 *    Stage 1 ではサーバー側クローズを耳で検知する装置になり、
 *    Stage 5 では終話の挨拶の置き場所になる。
 */
export function buildVoiceTwiML(options: TwiMLOptions): string {
  const wsUrl = `wss://${options.hostname}/media-stream`;
  const statusUrl = `https://${options.hostname}/stream-status`;

  const params = Object.entries(options.parameters ?? {})
    .map(([name, value]) => `      <Parameter name="${escapeXml(name)}" value="${escapeXml(value)}" />`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP">エコーテストを開始します。何か話しかけてください。</Say>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" name="stage1-echo" statusCallback="${escapeXml(statusUrl)}" statusCallbackMethod="POST">
${params}
    </Stream>
  </Connect>
  <Say language="ja-JP">接続が終了しました。ありがとうございました。</Say>
</Response>`;
}

/**
 * TwiML に埋め込むホスト名を決める。
 * PUBLIC_HOSTNAME が空なら受信リクエストの Host ヘッダを使うため、
 * ngrok の URL が変わっても TwiML 側の修正が不要になる。
 */
export function resolveHostname(requestHost: string | undefined): string {
  if (config.publicHostname) return config.publicHostname;
  if (requestHost) return requestHost;
  throw new Error('ホスト名を決定できません。PUBLIC_HOSTNAME を設定してください。');
}
