import { diffLines } from 'diff';
import { token } from '../theme';
import { monaco } from './monaco';

// 編集前との差分をエディタ上にインラインで出す。追加行は緑の背景とガターの線、
// 削除行は該当位置に取り消し線付きで差し込む（Monaco の view zone。行番号は振られない）
export class DiffDecorations {
  private readonly lines: monaco.editor.IEditorDecorationsCollection;
  private zoneIds: string[] = [];

  constructor(private readonly editor: monaco.editor.IStandaloneCodeEditor) {
    this.lines = editor.createDecorationsCollection();
  }

  show(baseline: string, current: string): void {
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const removed: { afterLine: number; lines: string[] }[] = [];
    let line = 1;
    for (const part of diffLines(baseline, current)) {
      if (part.added) {
        decorations.push({
          range: new monaco.Range(line, 1, line + part.count - 1, 1),
          options: {
            isWholeLine: true,
            className: 'diff-added-line',
            linesDecorationsClassName: 'diff-added-gutter',
            overviewRuler: { color: token('ok'), position: monaco.editor.OverviewRulerLane.Left },
          },
        });
        line += part.count;
      } else if (part.removed) {
        removed.push({ afterLine: line - 1, lines: splitLines(part.value) });
      } else {
        line += part.count;
      }
    }
    this.lines.set(decorations);
    this.setZones(removed);
  }

  clear(): void {
    this.lines.clear();
    this.setZones([]);
  }

  private setZones(removed: { afterLine: number; lines: string[] }[]): void {
    this.editor.changeViewZones((accessor) => {
      this.zoneIds.forEach((zoneId) => accessor.removeZone(zoneId));
      this.zoneIds = removed.map(({ afterLine, lines }) => {
        const domNode = document.createElement('div');
        domNode.className = 'diff-removed-zone';
        for (const text of lines) {
          const row = document.createElement('div');
          row.className = 'diff-removed-text';
          row.textContent = text;
          domNode.appendChild(row);
        }
        const marginDomNode = document.createElement('div');
        marginDomNode.className = 'diff-removed-margin';
        return accessor.addZone({ afterLineNumber: afterLine, heightInLines: lines.length, domNode, marginDomNode });
      });
    });
  }
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
