import { BUILDINGS } from './instructions.js';

/**
 * Realtime API (GA) の function calling 定義。
 *
 * 形式に注意: Realtime のツールは **フラット** なオブジェクト
 * （`{ type, name, description, parameters }`）であって、Chat Completions のように
 * `function` キーの下にネストしない。`strict` キーも Realtime には存在しない。
 *
 * **tools は instructions と同じく通話中不変。** 途中で session.update すると
 * プロンプトキャッシュが破棄され、以降の全ターンが定価で再課金される。
 */
export const TOOLS = [
  {
    type: 'function',
    name: 'record_resident_info',
    description:
      '住人から聞き取った項目を記録する。項目を1つ確定するたびに、その項目だけを指定して呼ぶこと。' +
      '必ず復唱して相手の確認が取れてから呼ぶこと。推測で埋めてはいけない。' +
      '戻り値の next と hint に従って次の項目へ進むこと。',
    parameters: {
      type: 'object',
      properties: {
        name_kana: {
          type: 'string',
          description: 'お名前の読み（ひらがなまたはカタカナのみ）。漢字は使わない。例: やまだ たろう',
        },
        phone: {
          type: 'string',
          description: '電話番号。数字のみ10〜11桁。ハイフンは付けても付けなくてもよい。',
        },
        building: {
          type: 'string',
          description: 'マンション名。次のいずれか正確に1つ。',
          enum: [...BUILDINGS],
        },
        room: { type: 'string', description: '部屋番号。数字のみ。例: 101' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'record_response',
    description:
      '仮予約日に対する住人の回答を記録する。4項目をすべて確定し、仮予約日をご案内してから呼ぶこと。' +
      'confirm=仮予約日でよい / change=別の日に変更したい / decline=工事を辞退する。' +
      'どれに当たるか曖昧なときは推測せず、確認してから呼ぶこと。',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '住人の回答区分',
          enum: ['confirm', 'change', 'decline'],
        },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'record_preferred_dates',
    description:
      '変更希望の場合の希望日を記録する。record_response を change で呼んだ後にのみ使える。' +
      '**必ず1つずつ記録すること。** 第一希望を確定してから第二希望を尋ね、それから第三希望を尋ねる。' +
      '3つまとめて聞いてはいけない（混同のもとになる）。' +
      '「来週の火曜日」などの相対表現は、instructions に書かれた本日の日付を基準に ' +
      'YYYY-MM-DD 形式へ変換して渡すこと。' +
      '戻り値の readback には曜日つきの正しい読み上げ文が入っているので、' +
      '**曜日を自分で計算せず、その文字列をそのまま読み上げて確認すること。**',
    parameters: {
      type: 'object',
      properties: {
        date1: { type: 'string', description: '第一希望日。YYYY-MM-DD 形式。例: 2026-10-01' },
        date2: { type: 'string', description: '第二希望日。YYYY-MM-DD 形式。' },
        date3: { type: 'string', description: '第三希望日。YYYY-MM-DD 形式。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'complete_reception',
    description:
      '受付を完了して通話を終える。受付内容をすべて復唱し、住人の確認が取れてから呼ぶこと。' +
      'これを呼ぶと通話が終了するため、まだ伺うことが残っている場合は呼んではいけない。' +
      '変更希望で第二・第三希望が不要と言われた場合も、これを呼んで完了してよい。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
] as const;
