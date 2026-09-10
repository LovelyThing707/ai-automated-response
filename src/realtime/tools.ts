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
 *
 * Stage 3 の範囲は CLAUDE.md の COLLECT_NAME 〜 COLLECT_ROOM の4項目のみ。
 * 分岐（確定/変更希望/辞退）と希望日は Stage 4、DB保存は Stage 5 で追加する。
 */
export const TOOLS = [
  {
    type: 'function',
    name: 'record_resident_info',
    description:
      '住人から聞き取った項目を記録する。項目を1つ確定するたびに、その項目だけを指定して呼ぶこと。' +
      '必ず復唱して相手の確認が取れてから呼ぶこと。推測で埋めてはいけない。' +
      '戻り値の next_missing と hint に従って次の項目へ進むこと。',
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
        room: {
          type: 'string',
          description: '部屋番号。数字のみ。例: 101',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
] as const;
