import { aesCmac } from './cmac';

// RFC 4493 section 4 test vectors
const K = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
const M = Buffer.from(
  '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710',
  'hex',
);

describe('AES-CMAC (RFC 4493 vectors)', () => {
  it.each([
    [0, 'bb1d6929e95937287fa37d129b756746'],
    [16, '070a16b46b4d4144f79bdd9dd04a287c'],
    [40, 'dfa66747de9ae63030ca32611497c827'],
    [64, '51f0bebf7e3b9d92fc49741779363cfe'],
  ])('message length %i', (len, expected) => {
    expect(aesCmac(K, M.subarray(0, len)).toString('hex')).toBe(expected);
  });

  it('rejects keys that are not 16 bytes', () => {
    expect(() => aesCmac(Buffer.alloc(15), Buffer.alloc(1))).toThrow();
  });

  it('is sensitive to a single flipped bit', () => {
    const a = aesCmac(K, M.subarray(0, 40));
    const flipped = Buffer.from(M.subarray(0, 40));
    flipped[39] = flipped[39]! ^ 1;
    expect(aesCmac(K, flipped).equals(a)).toBe(false);
  });
});
