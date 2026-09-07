import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  META_FILE_MAX_BYTES,
  NOTE_MAX_BYTES,
  NOTE_MAX_CHARS,
  normalizeFreeText,
  REASON_MAX_BYTES,
  REASON_MAX_CHARS,
} from '../shared/free-text.js';
import {
  NOTE_MAX_CHARS as PUBLISHED_NOTE_MAX_CHARS,
  normalizeFreeText as publishedNormalize,
  REASON_MAX_CHARS as PUBLISHED_REASON_MAX_CHARS,
} from '../publish-contract.js';

function norm(value, limits = { maxChars: REASON_MAX_CHARS, maxBytes: REASON_MAX_BYTES }) {
  return normalizeFreeText(value, limits);
}

test('normalizeFreeText: 비문자열은 null', () => {
  for (const value of [null, undefined, 1, 0, false, true, {}, [], 1n]) {
    assert.equal(norm(value), null, String(value));
  }
});

test('normalizeFreeText: NFC 정규화', () => {
  const combining = 'e\u0301';
  const composed = '\u00e9';
  assert.notEqual(combining, composed);
  assert.equal(norm(combining), composed);
  assert.equal(norm(composed), composed);
});

test('normalizeFreeText: C0/C1 제어문자와 연속 공백을 공백 하나로 접는다', () => {
  assert.equal(norm('a \t\n\r  b'), 'a b');
  assert.equal(norm('a\u0001\u001f\u0080\u009f b'), 'a b');
  assert.equal(norm('\n\nhello\t\t'), 'hello');
});

test('normalizeFreeText: trim 후 빈 문자열은 null', () => {
  assert.equal(norm(''), null);
  assert.equal(norm('   '), null);
  assert.equal(norm('\n\t\u0001'), null);
});

test('normalizeFreeText: 코드포인트 기준으로 maxChars 절단', () => {
  assert.equal(norm('x'.repeat(200)), 'x'.repeat(160));
  const hangul = '한'.repeat(200);
  const cut = norm(hangul);
  assert.equal([...cut].length, 160);
  assert.equal(cut, '한'.repeat(160));

  const hundredEmoji = '😀'.repeat(100);
  const kept = normalizeFreeText(hundredEmoji, { maxChars: 160, maxBytes: 10_000 });
  assert.equal([...kept].length, 100);
});

test('normalizeFreeText: 이모지 160개는 JSON.stringify 바이트가 512 이하가 되도록 재절단', () => {
  const raw = '😀'.repeat(160);
  const got = norm(raw);
  assert.ok(got);
  assert.ok([...got].length <= 160);
  assert.ok(Buffer.byteLength(JSON.stringify(got)) <= 512);
  assert.equal(norm(got), got);
});

test('normalizeFreeText: JSON 이스케이프가 바이트를 키우는 문자도 512 이하로 재절단', () => {
  const raw = '"\\'.repeat(160);
  const got = norm(raw);
  assert.ok(got);
  assert.ok([...got].length <= 160);
  assert.ok(Buffer.byteLength(JSON.stringify(got)) <= 512);
});

test('normalizeFreeText: 멱등', () => {
  const samples = [
    '  hello\n\nworld  ',
    'e\u0301 café',
    '😀'.repeat(160),
    '한'.repeat(200),
    '"\\'.repeat(80),
  ];
  for (const sample of samples) {
    const once = norm(sample);
    assert.equal(norm(once), once);
  }
});

test('free-text 상수와 publish-contract re-export', () => {
  assert.equal(REASON_MAX_CHARS, 160);
  assert.equal(NOTE_MAX_CHARS, 160);
  assert.equal(REASON_MAX_BYTES, 512);
  assert.equal(NOTE_MAX_BYTES, 512);
  assert.equal(META_FILE_MAX_BYTES, 8192);
  assert.equal(publishedNormalize, normalizeFreeText);
  assert.equal(PUBLISHED_REASON_MAX_CHARS, REASON_MAX_CHARS);
  assert.equal(PUBLISHED_NOTE_MAX_CHARS, NOTE_MAX_CHARS);
});
