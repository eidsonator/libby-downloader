import { PlayerUrlStore, hasSignedQuery, partKey } from '../../iframe/player-urls';

const ORIGIN = 'https://dewey-abc.listen.libbyapp.com';
const SPINE_PATH = '%7B1434EF84-D323-4178-B5A5-0E61DFFA6B43%7DFmt425-Part01.mp3';
const SIGNED = `${ORIGIN}/${SPINE_PATH}?cmpt=eyJzcGluZSI6MH0%3D--a94f2abeeac186ced8f3cf0ff1a7af2b3a6acbcd`;

describe('partKey', () => {
  it('decodes the file name of a spine path and a full URL to the same key', () => {
    expect(partKey(SPINE_PATH, ORIGIN)).toBe(
      '{1434EF84-D323-4178-B5A5-0E61DFFA6B43}Fmt425-Part01.mp3'
    );
    expect(partKey(SIGNED)).toBe(partKey(SPINE_PATH, ORIGIN));
  });

  it('returns null for a URL with no file name', () => {
    expect(partKey(`${ORIGIN}/`)).toBeNull();
  });
});

describe('hasSignedQuery', () => {
  it('accepts a cmpt query', () => {
    expect(hasSignedQuery(SIGNED)).toBe(true);
  });

  it('rejects the broken ?undefined query and a bare URL', () => {
    expect(hasSignedQuery(`${ORIGIN}/${SPINE_PATH}?undefined`)).toBe(false);
    expect(hasSignedQuery(`${ORIGIN}/${SPINE_PATH}`)).toBe(false);
  });
});

describe('PlayerUrlStore', () => {
  it('matches a captured player URL to its spine path', () => {
    const store = new PlayerUrlStore(ORIGIN);
    store.recordEntries([{ name: SIGNED }]);
    expect(store.urlFor(SPINE_PATH)).toBe(SIGNED);
  });

  it('ignores other origins, non-MP3 requests and unsigned URLs', () => {
    const store = new PlayerUrlStore(ORIGIN);
    store.recordEntries([
      { name: `https://evil.example/${SPINE_PATH}?cmpt=x` },
      { name: `${ORIGIN}/_d/activity?x=1` },
      { name: `${ORIGIN}/${SPINE_PATH}?undefined` },
    ]);
    expect(store.size).toBe(0);
    expect(store.urlFor(SPINE_PATH)).toBeUndefined();
  });

  it('keeps the first URL seen for a part', () => {
    const store = new PlayerUrlStore(ORIGIN);
    store.record(SIGNED);
    store.record(`${ORIGIN}/${SPINE_PATH}?cmpt=later--sig`);
    expect(store.urlFor(SPINE_PATH)).toBe(SIGNED);
  });
});
