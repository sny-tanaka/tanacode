import { useState } from 'react';
import { t } from '@shared/i18n';
import type { ChooseResult, Menu, MenuOption } from '@shared/screen';
import { CheckIcon, CloseIcon, IconButton } from '../icons';

// メニューの種類の名前（見出しに出す）
const kindLabel = (kind: Menu['kind']) => t(`screen.kind.${kind}`);
// 自由記述の欄がまだ空のときの表示（「Type something.」。複数選択では末尾の . が無い）
const TEXT_PLACEHOLDER = /^Type something\.?$/;

// 選べなかったとき、カードに出す知らせ（押したことを黙って捨てない）
const notChosen = (result: Exclude<ChooseResult, 'chosen'>) => t(`screen.notChosen.${result}`);

// 自由記述に入力済みの文字（空なら ''）
function typedText(option: MenuOption): string {
  return TEXT_PLACEHOLDER.test(option.label) ? '' : option.label;
}

function optionLabel(option: MenuOption): string {
  if (option.id === 'submit') return option.label === 'Next' ? t('screen.card.nextQuestion') : t('screen.card.reviewAnswers');
  if (option.textInput) return typedText(option) ? t('screen.card.otherTyped', { text: typedText(option) }) : t('screen.card.other');
  return option.label;
}

// 質問の選択肢そのもの（自由記述・確定・Chat about this 以外）。プレビューはこれにだけある
function isChoice(option: MenuOption): boolean {
  return !option.textInput && option.id !== 'submit' && option.label !== 'Chat about this';
}

type Props = {
  sessionId: string;
  menu: Menu;
};

// pty の画面に出ている選択メニュー（AskUserQuestion・許可確認など）をボタンで操作する
export function MenuCard({ sessionId, menu }: Props) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  // 押した選択肢。ターミナルのカーソル（↑/↓ で目的の選択肢まで送る途中）は出さず、押したものだけを示す。
  // 送り終えるまでは、ほかの選択肢を押せない（続けて押したものを、黙って捨てないように）
  const [chosen, setChosen] = useState<string | null>(null);
  // 選べなかったときの知らせ
  const [failure, setFailure] = useState<string | null>(null);
  // プレビューを出す選択肢（ホバー・フォーカスしたもの。はじめはプレビューのある最初の選択肢）
  const [previewed, setPreviewed] = useState<string | null>(null);
  const hasPreview = menu.options.some((o) => o.preview);
  const shown = hasPreview ? (menu.options.find((o) => o.id === previewed) ?? menu.options.find((o) => o.preview)) : undefined;

  const choose = (option: MenuOption, key: 'enter' | 'space' | 'none' = 'enter', input?: string) => {
    setChosen(option.id);
    setFailure(null);
    window.tanacode.screen
      .choose(sessionId, { optionId: option.id, key, text: input })
      .then(
        (result) => setFailure(result && result !== 'chosen' ? notChosen(result) : null),
        () => setFailure(t('screen.card.sendFailed')),
      )
      .finally(() => setChosen(null));
  };

  const onClick = (option: MenuOption) => {
    if (option.textInput) {
      setText(typedText(option));
      setEditing(true);
    } else choose(option, menu.multiSelect && option.checked !== null ? 'space' : 'enter');
  };

  return (
    <div className={`menu-card ${menu.kind}`}>
      {/* 見出しの行。キャンセルは右上に置く */}
      <div className="menu-card-head">
        <div className="menu-card-kind">{kindLabel(menu.kind)}</div>
        <IconButton icon={CloseIcon} size="md" label={t('common.cancel')} tip={t('screen.card.cancelTip')} onClick={() => window.tanacode.pty.write(sessionId, '\x1b')} />
      </div>
      {menu.tabs.length > 1 && (
        <div className="menu-tabs">
          {menu.tabs.map((tab) => (
            <span key={tab.label} className={`menu-tab${tab.answered ? ' answered' : ''}`}>
              {tab.answered && <CheckIcon size={12} />}
              {tab.label}
            </span>
          ))}
        </div>
      )}
      {menu.context.length > 0 && <pre className="menu-context">{menu.context.join('\n')}</pre>}
      <div className="menu-title">{menu.title}</div>
      <div className="menu-options">
        {menu.options.map((option) =>
          option.textInput && editing ? (
            <form
              key={option.id}
              className="menu-text-input"
              onSubmit={(e) => {
                e.preventDefault();
                if (!text.trim()) return;
                // 単一選択は Enter で答える。複数選択は打つだけでチェックが付く（Enter だと外れる）
                choose(option, menu.multiSelect ? 'none' : 'enter', text);
                setText('');
                setEditing(false);
              }}
            >
              <input autoFocus value={text} placeholder={t('screen.card.answerPlaceholder')} onChange={(e) => setText(e.target.value)} />
              <button className="send-button" type="submit" disabled={!text.trim()}>
                {menu.multiSelect ? t('screen.card.confirm') : t('screen.card.send')}
              </button>
              <IconButton icon={CloseIcon} size="md" label={t('screen.card.stopEditing')} onClick={() => setEditing(false)} />
            </form>
          ) : (
            <button
              key={option.id}
              className={`menu-option${option.id === chosen ? ' chosen' : ''}${option.id === 'submit' ? ' submit' : ''}${hasPreview && option.id === shown?.id ? ' previewed' : ''}`}
              disabled={chosen !== null}
              onClick={() => onClick(option)}
              onMouseEnter={() => isChoice(option) && setPreviewed(option.id)}
              onFocus={() => isChoice(option) && setPreviewed(option.id)}
            >
              {option.checked !== null && <span className={`menu-check${option.checked ? ' on' : ''}`}>{option.checked && <CheckIcon size={12} />}</span>}
              <span className="menu-option-text">
                <span className="menu-option-label">{optionLabel(option)}</span>
                {option.description && <span className="menu-option-desc">{option.description}</span>}
              </span>
            </button>
          ),
        )}
      </div>
      {failure && (
        <div className="menu-card-error" role="alert">
          {failure}
        </div>
      )}
      {/* 選択肢のプレビュー（比べるための図や文章）。ホバーした選択肢のものを出す */}
      {shown && (
        <div className="menu-preview">
          <div className="menu-preview-label">{t('screen.card.preview', { label: shown.label })}</div>
          {shown.preview ? <pre className="menu-preview-body">{shown.preview}</pre> : <div className="menu-preview-none">{t('screen.card.noPreview')}</div>}
        </div>
      )}
    </div>
  );
}
