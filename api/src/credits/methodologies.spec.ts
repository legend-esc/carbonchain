import { isValidMethodology } from './methodologies';

describe('isValidMethodology', () => {
  it('accepts registered and prefixed custom methodologies', () => {
    expect(isValidMethodology('VCS')).toBe(true);
    expect(isValidMethodology('Custom-forest-restoration')).toBe(true);
  });

  it('rejects unregistered values without the Custom- prefix', () => {
    expect(isValidMethodology('forest-restoration')).toBe(false);
  });
});