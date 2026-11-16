import { describe, expect, it } from 'vitest';
import { isAllowedDependency } from '../scripts/third-party-notices';

// アプリに入れて配る依存のライセンスの判定（electron.vite.config.ts・vite.demo.config.ts の rollup-plugin-license が使う）
describe('isAllowedDependency', () => {
  it('MIT などの GPL 系でないライセンスは許す', () => {
    expect(isAllowedDependency({ name: 'react', license: 'MIT', licenseText: null })).toBe(true);
  });

  it('GPL 系とライセンスの分からない依存は止める', () => {
    expect(isAllowedDependency({ name: 'some-gpl', license: 'GPL-3.0-or-later', licenseText: null })).toBe(false);
    expect(isAllowedDependency({ name: 'unknown', license: null, licenseText: null })).toBe(false);
  });

  it('例外は elkjs の決まった表記だけで、ほかの名前や表記には広げない', () => {
    expect(isAllowedDependency({ name: 'elkjs', license: 'EPL-2.0 OR GPL-3.0-or-later', licenseText: null })).toBe(true);
    expect(isAllowedDependency({ name: 'elkjs', license: 'GPL-3.0-or-later', licenseText: null })).toBe(false);
    expect(isAllowedDependency({ name: 'other', license: 'EPL-2.0 OR GPL-3.0-or-later', licenseText: null })).toBe(false);
  });
});
