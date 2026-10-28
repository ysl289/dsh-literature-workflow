import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAgentFailure } from '../lib/agent-failure.mjs';

test('keeps provider and nested local transport diagnostics without server bodies', () => {
  const cause = Object.assign(new Error('private remote response body'), {code:'ECONNREFUSED'});
  const error = Object.assign(new Error('DeepSeek Messages transport failed', {cause:new TypeError('fetch failed', {cause})}), {code:'TRANSPORT'});
  assert.equal(describeAgentFailure(error), '[TRANSPORT] DeepSeek Messages transport failed → fetch failed → [ECONNREFUSED]');
  assert.ok(!describeAgentFailure(error).includes('private'));
});

test('redacts credential-like text, destinations and cause cycles', () => {
  const error = new TypeError('fetch failed https://example.test/?token=private token=hidden Bearer private sk-private');
  error.cause = error;
  const result = describeAgentFailure(error);
  assert.ok(!/private|example\.test|hidden/.test(result));
  assert.ok(result.length < 1200);
});
