import { useEffect, useRef, useState } from 'react';
import { t, type MessageKey } from '@shared/i18n';
import { mcpToolId, type McpServerDef, type McpTool, type McpToolGroup } from '@shared/mcp-tools';
import { defaultToolPermission, hiddenFromChild, PERMISSION_SERVERS, type McpEnabled, type ToolPermission } from '@shared/tool-permissions';
import { errorMessage } from '../errorMessage';
import { CloseIcon, IconButton } from '../icons';
import { Toggle } from '../layout/Toggle';
import { BrowserHostsEditor } from './BrowserHostsEditor';

const PERMISSIONS: ToolPermission[] = ['ask', 'allow'];

type Settings = { enabled: McpEnabled; permissions: Record<string, ToolPermission>; problem: string | null };

// MCP の設定（アプリ全体で 1 つ）。メニューの「MCP の設定…」から開く。tanacode が Claude Code に足す MCP サーバーごとに、
// 見出しに入り・切りのスイッチ、その下にツールの表（MCP名・説明・確認）。アプリ内ブラウザは、見出しの下に Claude に許す先も出す。
// 確認は「毎回確認／常に許可」で、既定のほうに「（既定）」を付ける。切っている MCP のツールの行は薄くして選べなくする（選んだ値は保つ）。
// 変えたらすぐ保存する（ツールの許可のフックは呼ばれるたびに印のファイルを見るので、動いているセッションにもすぐ効く）
export function McpSettingsDialog({ onClose }: { onClose: () => void }) {
  // 読めるまでは null（スイッチと選ぶ欄を出さない）
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void window.tanacode.mcpSettings.get().then(
      (saved) => {
        if (alive) setSettings(saved);
      },
      (e: unknown) => {
        if (alive) setError(errorMessage(e));
      },
    );
    // Escape で閉じるには、ダイアログの中にフォーカスが要る。閉じたら、開く前にいた場所に戻す
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      alive = false;
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  // 保存できなかったら、理由を出して、画面は保存した値のまま（選んだものを元に戻す）
  const save = async (change: () => Promise<Partial<Settings>>) => {
    try {
      const next = await change();
      setSettings((current) => (current ? { ...current, ...next } : current));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const setEnabled = (server: McpToolGroup, on: boolean) => save(async () => ({ enabled: await window.tanacode.mcpSettings.setEnabled(server, on) }));
  // 保存できたら、印のファイルを全部書き直せたので、起動したときの問題も直っている
  const setPermission = (toolId: string, permission: ToolPermission) =>
    save(async () => ({ permissions: await window.tanacode.mcpSettings.setPermission(toolId, permission), problem: null }));

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="quick-open settings-files-dialog mcp-settings-dialog"
        ref={dialog}
        role="dialog"
        aria-label={t('mcpSettings.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="settings-files-head">
          <h2>{t('mcpSettings.title')}</h2>
          <p>{t('mcpSettings.description')}</p>
          <p>{t('mcpSettings.scope')}</p>
        </div>
        {settings?.problem && <div className="mcp-settings-problem">{settings.problem}</div>}
        <div className="quick-open-list mcp-settings-list">
          {settings &&
            PERMISSION_SERVERS.map((server) => {
              const group = server.def.labels;
              const name = t(`tools.server.${group}`);
              const on = settings.enabled[group];
              return (
                <section key={server.def.name} className={`mcp-server${on ? '' : ' off'}`} aria-label={name}>
                  <div className="mcp-server-head">
                    <h3>
                      {name}
                      <code>{server.def.name}</code>
                    </h3>
                    <Toggle on={on} name={t('mcpSettings.switchLabel', { server: name })} onChange={(next) => void setEnabled(group, next)} />
                  </div>
                  {!on && <p className="mcp-server-off">{t('mcpSettings.off')}</p>}
                  {group === 'browser' && <BrowserHostsEditor />}
                  <table className="mcp-tools">
                    <thead>
                      <tr>
                        <th scope="col">{t('mcpSettings.columns.name')}</th>
                        <th scope="col">{t('mcpSettings.columns.description')}</th>
                        <th scope="col">{t('mcpSettings.columns.confirm')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {server.def.tools.map((tool) => (
                        <ToolRow
                          key={tool.name}
                          def={server.def}
                          tool={tool}
                          disabled={!on}
                          childHidden={hiddenFromChild(server, tool)}
                          permission={settings.permissions[mcpToolId(server.def.name, tool.name)]}
                          onChange={(permission) => void setPermission(mcpToolId(server.def.name, tool.name), permission)}
                        />
                      ))}
                    </tbody>
                  </table>
                </section>
              );
            })}
        </div>
        {error && <div className="browser-hosts-error">{error}</div>}
        <div className="settings-files-foot">
          <IconButton icon={CloseIcon} label={t('common.close')} tip={t('mcpSettings.closeTip')} onClick={onClose} />
        </div>
      </div>
    </div>
  );
}

// 1 つのツール。permission: 利用者が選んだ値（無ければ既定）/ disabled: その MCP を切っている
function ToolRow({
  def,
  tool,
  disabled,
  childHidden,
  permission,
  onChange,
}: {
  def: McpServerDef;
  tool: McpTool;
  disabled: boolean;
  childHidden: boolean;
  permission: ToolPermission | undefined;
  onChange: (permission: ToolPermission) => void;
}) {
  const fallback = defaultToolPermission(def, tool);
  const value = permission ?? fallback;
  return (
    <tr className={`mcp-tool${value !== fallback ? ' changed' : ''}`}>
      <td className="mcp-tool-name">
        <code>{tool.name}</code>
      </td>
      <td className="mcp-tool-desc">
        {t(`mcpSettings.desc.${def.labels}.${tool.name}` as MessageKey)}
        {childHidden && <span className="mcp-tool-note">{t('mcpSettings.childHidden')}</span>}
      </td>
      <td className="mcp-tool-confirm">
        <select
          className="tool-permission-select"
          value={value}
          disabled={disabled}
          aria-label={t('mcpSettings.choiceLabel', { tool: tool.name })}
          onChange={(e) => onChange(e.target.value as ToolPermission)}
        >
          {PERMISSIONS.map((p) => (
            <option key={p} value={p}>
              {p === fallback ? t('mcpSettings.withDefault', { label: t(`mcpSettings.${p}`) }) : t(`mcpSettings.${p}`)}
            </option>
          ))}
        </select>
      </td>
    </tr>
  );
}
