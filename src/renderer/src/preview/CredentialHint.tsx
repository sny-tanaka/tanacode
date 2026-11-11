import { useState } from 'react';
import { t } from '@shared/i18n';
import { LockIcon } from '../icons';
import { openMcpSettings } from '../mcp/openMcpSettings';
import { readSharedPref, useSharedPrefChange, writeSharedPref } from '../sharedPrefs';

// 「1Password のアイテムのリンクを渡せば、Claude がパスワードを見ずに入力できる」ことの案内。人にログインを頼む帯に添える
// （ask_user_to_act の AskBar。Basic 認証の入力の帯にも、合わせるときに同じものを置く）。
// リンクの取り方と、サイトごとにリンクを控える画面（MCP の設定）への入り口を出す。「もう出さない」は、プロファイルをまたいで覚える

const HIDDEN_KEY = 'tanacode.credentialHint.hidden';

// 案内を出すか（「もう出さない」を押していなければ出す）と、出さないようにする関数
export function useCredentialHint(): { shown: boolean; hide: () => void } {
  const [hidden, setHidden] = useState(() => readSharedPref(HIDDEN_KEY) === '1');
  useSharedPrefChange(HIDDEN_KEY, () => setHidden(readSharedPref(HIDDEN_KEY) === '1'));
  return {
    shown: !hidden,
    hide: () => {
      writeSharedPref(HIDDEN_KEY, '1');
      setHidden(true);
    },
  };
}

// 案内の本体。onHide: 「もう出さない」を押した（無ければボタンを出さない）
export function CredentialHint({ onHide }: { onHide?: () => void }) {
  return (
    <div className="credential-hint" role="note" aria-label={t('preview.credentialHint.label')}>
      <LockIcon size={14} />
      <p className="credential-hint-text">
        {t('preview.credentialHint.text')}
        <span className="credential-hint-how">{t('preview.credentialHint.how')}</span>
      </p>
      <div className="credential-hint-actions">
        <button type="button" className="ghost-button" onClick={openMcpSettings}>
          {t('preview.credentialHint.settings')}
        </button>
        {onHide && (
          <button type="button" className="ghost-button credential-hint-hide" onClick={onHide}>
            {t('preview.credentialHint.hide')}
          </button>
        )}
      </div>
    </div>
  );
}
