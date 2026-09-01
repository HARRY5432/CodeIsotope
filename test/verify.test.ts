import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderVerifyResults } from '../src/lib/render.ts';
import { verifyPackage, verifyPackages, type VerifyResult } from '../src/vet/verify.ts';

/**
 * These tests are offline by construction: they exercise the shape of the contract and the
 * rendering, not the network. Live existence checks belong in CI, where a real request can fail
 * loudly -- see the `self-audit` job, which verifies emitted permalinks resolve.
 */

const result = (over: Partial<VerifyResult> = {}): VerifyResult => ({
  name: 'example',
  ecosystem: 'npm',
  status: 'exists',
  detail: 'example exists on npm',
  ...over,
});

test('an unsupported ecosystem is reported, not silently treated as missing', async () => {
  // rubygems is parsed by the manifest reader but has no registry client. Saying "does not exist"
  // would be a lie: we never looked.
  const out = await verifyPackage('rails', 'rubygems');
  assert.equal(out.status, 'unsupported');
  assert.match(out.detail, /cannot be verified/);
});

test('a missing name is called invented, not merely absent', () => {
  // Wording is deliberate. "not found" invites the reader to assume a typo; the actual situation,
  // when a model supplied the name, is that it came from somewhere other than reality.
  const text = renderVerifyResults([result({ status: 'not-found', detail: 'x does not exist on npm. If a model suggested it, it was invented.' })], {
    ecosystem: 'npm',
    source: 'explicit',
    reason: '',
  });
  assert.match(text, /INVENTED/);
  assert.match(text, /invented/);
});

test('a name that exists in a different registry is distinguished from one that exists nowhere', () => {
  const wrongEco = renderVerifyResults(
    [result({ status: 'wrong-ecosystem', foundIn: ['npm', 'pypi'], detail: 'tenacity does not exist on crates.io, but npm and pypi has a package by that name.' })],
    { ecosystem: 'cargo', source: 'explicit', reason: '' },
  );
  assert.match(wrongEco, /WRONG REGISTRY/);
  // The distinction matters: this is the failure that produced the worst bug the tool has had.
  assert.doesNotMatch(wrongEco, /INVENTED/);
});

test('the summary line states how many names could not be confirmed', () => {
  const text = renderVerifyResults(
    [result(), result({ name: 'ghost', status: 'not-found', detail: 'no' })],
    { ecosystem: 'npm', source: 'explicit', reason: '' },
  );
  assert.match(text, /1 of 2 name\(s\) could not be confirmed/);
  assert.match(text, /Do not recommend those/);
});

test('an all-clear says so plainly', () => {
  const text = renderVerifyResults([result(), result({ name: 'other' })], {
    ecosystem: 'npm',
    source: 'explicit',
    reason: '',
  });
  assert.match(text, /All 2 name\(s\) exist on npm/);
});

test('an inferred ecosystem is disclosed in the header', () => {
  // A reader must be able to tell a chosen registry from a guessed one.
  const text = renderVerifyResults([result()], {
    ecosystem: 'pypi',
    source: 'inferred',
    reason: 'inferred pypi from requirements.txt',
  });
  assert.match(text, /inferred pypi from requirements\.txt/);
});

test('verifyPackages preserves input order', async () => {
  // Order matters because the caller pairs results back against its own list.
  const names = ['rails', 'sinatra', 'puma'];
  const out = await verifyPackages(names, 'rubygems');
  assert.deepEqual(out.map((r) => r.name), names);
  assert.ok(out.every((r) => r.status === 'unsupported'));
});
