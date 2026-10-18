import { useState } from 'react';
import { t } from '@shared/i18n';
import { UNKNOWN_RAW_BYTES, type UnknownSource } from '@shared/unknown-event';
import { CheckIcon, CopyIcon, DisclosureIcon, IconButton } from '../icons';
import { tx } from '../i18n';
import type { ChatItem, UnknownSample } from './chatState';

type UnknownItem = Extract<ChatItem, { kind: 'unknown' }>;

const SOURCE_LABEL = {
  stream: 'chat.unknown.sourceStream',
  transcript: 'chat.unknown.sourceTranscript',
  request: 'chat.unknown.sourceRequest',
} as const satisfies Record<UnknownSource, string>;

// 未知のイベント（tanacode が知らない、Claude Code からの行）。畳んだ灰色の 1 行で出し、開くと、どこから来たか・バージョン・生の行を出す。
// 生の行は大きいことがある（1 つ 64KB まで、まとめた行は 20 回分まで）ので、開いている間だけ描く
export function UnknownEventRow({ item }: { item: UnknownItem }) {
  const [open, setOpen] = useState(false);
  const code = <code className="chat-unknown-name">{item.name}</code>;
  const summary =
    item.problem === 'unparsable'
      ? t('chat.unknown.unparsableLine')
      : item.problem === 'malformed'
        ? item.name
          ? tx('chat.unknown.summaryMalformed', { name: code })
          : t('chat.unknown.malformedLine')
        : tx('chat.unknown.summary', { name: code });
  // 数えた回数のうち、生の行を残していないもの（同じ行が stream と会話ログの両方に出たものは、1 回と数える）
  const omitted = item.count - new Set(item.samples.map((s) => s.id)).size;
  return (
    <details className="chat-unknown" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {/* 開いたとき（[open]）に矢印を回すのは CSS */}
        <DisclosureIcon open={false} />
        <span className="chat-unknown-summary">{summary}</span>
        {item.count > 1 && <span className="chat-unknown-count">{t('chat.unknown.count', { count: item.count })}</span>}
      </summary>
      {open && (
        <div className="chat-unknown-body">
          <p className="chat-unknown-about">{t('chat.unknown.about')}</p>
          {omitted > 0 && <p className="chat-unknown-note">{t('chat.unknown.omitted', { count: omitted })}</p>}
          {item.samples.map((sample, i) => (
            <UnknownSampleView key={`${sample.id}:${sample.source}:${i}`} sample={sample} />
          ))}
        </div>
      )}
    </details>
  );
}

function UnknownSampleView({ sample }: { sample: UnknownSample }) {
  const [copied, setCopied] = useState(false);
  const kb = (bytes: number) => Math.ceil(bytes / 1024);
  return (
    <div className="chat-unknown-sample">
      <div className="chat-unknown-meta">
        <span>{t(SOURCE_LABEL[sample.source])}</span>
        <span>{sample.version ? t('chat.unknown.version', { version: sample.version }) : t('chat.unknown.versionUnknown')}</span>
        <IconButton
          size="sm"
          icon={copied ? CheckIcon : CopyIcon}
          label={copied ? t('chat.unknown.copied') : t('chat.unknown.copy')}
          className="chat-unknown-copy"
          onClick={() =>
            void navigator.clipboard.writeText(sample.raw).then(
              () => setCopied(true),
              (error: unknown) => console.warn('未知のイベントの生の行をコピーできませんでした', error),
            )
          }
        />
      </div>
      <pre className="chat-unknown-raw">{sample.raw}</pre>
      {sample.truncated !== undefined && (
        <p className="chat-unknown-note">{t('chat.unknown.truncated', { limit: kb(UNKNOWN_RAW_BYTES), total: kb(sample.truncated) })}</p>
      )}
    </div>
  );
}
