import { describe, expect, it } from 'vitest';
import type { RateLimitEvent, StreamEventMessage } from '../src/main/stream/protocol';
import { appMode, elapsedText, modelName, Progress, rateLimitsOf, streamMode, tokensText, usageLimitsOf } from '../src/main/stream/state';

// stream-json の行から、アプリの表示に使う値を作る小さな関数（src/main/stream/state.ts）

const event = (value: Record<string, unknown>): StreamEventMessage => ({ type: 'stream_event', event: value, parent_tool_use_id: null, uuid: 'e' }) as unknown as StreamEventMessage;

describe('権限モードの名前', () => {
  it('Claude Code の名前（default）をアプリの名前（manual）にする。知らない名前は manual、無ければ null', () => {
    expect(appMode('default')).toBe('manual');
    expect(appMode('manual')).toBe('manual');
    for (const mode of ['acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const) expect(appMode(mode)).toBe(mode);
    expect(appMode('dontAsk')).toBe('manual');
    expect(appMode('')).toBeNull();
    expect(appMode(null)).toBeNull();
    expect(appMode(undefined)).toBeNull();
  });

  it('アプリの名前を、set_permission_mode で渡す名前にする', () => {
    expect(streamMode('manual')).toBe('default');
    expect(streamMode('plan')).toBe('plan');
    expect(streamMode('auto')).toBe('auto');
  });
});

describe('表記', () => {
  it('経過時間は、Claude Code の画面と同じ表記（5s・1m 5s・1h 2m）。負の値は 0s', () => {
    expect(elapsedText(0)).toBe('0s');
    expect(elapsedText(5_999)).toBe('5s');
    expect(elapsedText(65_000)).toBe('1m 5s');
    expect(elapsedText(3_720_000)).toBe('1h 2m');
    expect(elapsedText(-100)).toBe('0s');
  });

  it('トークン数は 1000 未満はそのまま、それ以上は k（小数 1 桁。.0 は付けない）', () => {
    expect(tokensText(225)).toBe('225');
    expect(tokensText(1000)).toBe('1k');
    expect(tokensText(1234)).toBe('1.2k');
    expect(tokensText(25_960)).toBe('26k');
  });

  it('モデルの ID を表示名にする（日付の付いた ID・小数点のある版も）。読めなければ null', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-opus-4-1-20250805')).toBe('Opus 4.1');
    expect(modelName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelName('claude-fable-5-1')).toBe('Fable 5.1');
    // 日付の先頭の数字（2）を、版の小数点以下と読まない
    expect(modelName('claude-sonnet-5-20260101')).toBe('Sonnet 5');
    expect(modelName('gpt-4')).toBeNull();
    expect(modelName(null)).toBeNull();
    expect(modelName(undefined)).toBeNull();
  });
});

describe('Progress（作業中の進み具合）', () => {
  it('はじめは応答待ち。考えている・書いている・ツールの実行中と、受け取ったトークン数。変わったときだけ true', () => {
    const progress = new Progress(1_000);
    expect(progress.current(1_000)).toEqual({ phase: 'waiting', elapsed: '0s', tokens: null });
    expect(progress.streamEvent(event({ type: 'content_block_start', content_block: { type: 'thinking' } }))).toBe(true);
    expect(progress.current(6_000)).toEqual({ phase: 'thinking', elapsed: '5s', tokens: null });
    expect(progress.streamEvent(event({ type: 'content_block_start', content_block: { type: 'redacted_thinking' } }))).toBe(false);
    expect(progress.streamEvent(event({ type: 'content_block_start', content_block: { type: 'text' } }))).toBe(true);
    expect(progress.streamEvent(event({ type: 'message_delta', usage: { output_tokens: 1234 } }))).toBe(true);
    expect(progress.current(2_000)).toEqual({ phase: 'writing', elapsed: '1s', tokens: '1.2k' });
    // 同じ累積値は、変わっていない
    expect(progress.streamEvent(event({ type: 'message_delta', usage: { output_tokens: 1234 } }))).toBe(false);
    expect(progress.streamEvent(event({ type: 'content_block_start', content_block: { type: 'tool_use' } }))).toBe(true);
    expect(progress.current(2_000).phase).toBe('working');
    // 次の応答の始まりで、応答待ちに戻し、トークン数を数え直す
    expect(progress.streamEvent(event({ type: 'message_start' }))).toBe(true);
    expect(progress.current(2_000)).toMatchObject({ phase: 'waiting', tokens: null });
    // 応答待ちのまま書き始めた（ブロックの始まりを取りこぼした）
    expect(progress.streamEvent(event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } }))).toBe(true);
    expect(progress.current(2_000).phase).toBe('writing');
  });

  it('ツールの経過（tool_progress）は、ツールの実行中にする。もう実行中なら変わらない', () => {
    const progress = new Progress(0);
    expect(progress.tool()).toBe(true);
    expect(progress.tool()).toBe(false);
    expect(progress.current(0).phase).toBe('working');
  });
});

describe('利用枠', () => {
  it('rate_limit_event: utilization（0〜1）を割合に、resetsAt（秒）をミリ秒にする。窓が無ければ null', () => {
    const limits = (info: Record<string, unknown>) => rateLimitsOf({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'l' } as unknown as RateLimitEvent);
    expect(limits({ unifiedWindows: { five_hour: { utilization: 0.421, resetsAt: 1_800_000_000 }, seven_day: { utilization: 0.05 } } })).toEqual({
      fiveHour: { percent: 42.1, resetsAt: 1_800_000_000_000 },
      sevenDay: { percent: 5, resetsAt: null },
    });
    expect(limits({ unifiedWindows: { five_hour: { utilization: 'x' } } })).toEqual({ fiveHour: null, sevenDay: null });
    expect(limits({ status: 'allowed' })).toBeNull();
  });

  it('get_usage: utilization（0〜100）と resets_at（ISO）。モデル別の週の枠も読む。使えなければ null', () => {
    const at = '2026-10-17T10:00:00.000Z';
    expect(
      usageLimitsOf({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: at },
          seven_day: { utilization: 3, resets_at: 'x' },
          seven_day_opus: null,
          seven_day_sonnet: { utilization: 7, resets_at: null },
          // サーバーの一覧から来るモデル別の枠。同じモデルの古い欄（seven_day_sonnet）より、こちらを使う
          model_scoped: [
            { display_name: 'Fable', utilization: 55, resets_at: at },
            { display_name: 'Sonnet', utilization: 12, resets_at: null },
            { display_name: 'Haiku', utilization: null, resets_at: null },
          ],
        },
      }),
    ).toEqual({
      limits: [
        { label: '5時間', percent: 42, resetsAt: Date.parse(at) },
        { label: '週', percent: 3, resetsAt: null },
        { label: '週', model: 'Fable', percent: 55, resetsAt: Date.parse(at) },
        { label: '週', model: 'Sonnet', percent: 12, resetsAt: null },
      ],
      modelsKnown: true,
    });
    expect(usageLimitsOf({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toBeNull();
    expect(usageLimitsOf({ subscription_type: null, rate_limits_available: true, rate_limits: { five_hour: null } })).toEqual({ limits: [], modelsKnown: false });
  });

  it('get_usage: Claude Code の /usage と同じ枠だけ出す（seven_day_opus は読まない。seven_day_sonnet は max・team・プランの分からないときだけ）', () => {
    const old = { seven_day_opus: { utilization: 20, resets_at: null }, seven_day_sonnet: { utilization: 7, resets_at: null } };
    const sonnet = { label: '週', model: 'Sonnet', percent: 7, resetsAt: null };
    for (const plan of ['max', 'team', null]) {
      expect(usageLimitsOf({ subscription_type: plan, rate_limits_available: true, rate_limits: old })?.limits).toEqual([sonnet]);
    }
    for (const plan of ['pro', 'enterprise']) {
      expect(usageLimitsOf({ subscription_type: plan, rate_limits_available: true, rate_limits: old })?.limits).toEqual([]);
    }
    // model_scoped があっても seven_day_sonnet は出す（同じ名前のモデルが一覧にあれば、一覧の方）
    expect(
      usageLimitsOf({ subscription_type: 'max', rate_limits_available: true, rate_limits: { ...old, model_scoped: [{ display_name: 'Fable', utilization: 55, resets_at: null }] } })?.limits,
    ).toEqual([{ label: '週', model: 'Fable', percent: 55, resetsAt: null }, sonnet]);
  });

  it('get_usage: model_scoped が無い返事は、モデル別の枠が分からない（空の配列は、この人には無い）', () => {
    const base = { subscription_type: 'pro', rate_limits_available: true } as const;
    expect(usageLimitsOf({ ...base, rate_limits: { seven_day: { utilization: 3, resets_at: null } } })?.modelsKnown).toBe(false);
    expect(usageLimitsOf({ ...base, rate_limits: { seven_day: { utilization: 3, resets_at: null }, model_scoped: [] } })?.modelsKnown).toBe(true);
    expect(usageLimitsOf({ ...base, rate_limits: { model_scoped: 'x' as unknown as [] } })?.modelsKnown).toBe(false);
  });
});
