import assert from 'node:assert/strict';
import { dispatch } from './index.ts';

Deno.test('email dispatcher rejects public methods and unauthenticated triggers before querying bookings', async () => {
  const key = 'PICKLESTREET_EMAIL_DISPATCH_SECRET';
  const previous = Deno.env.get(key);
  Deno.env.set(key, 'tests-only-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  try {
    assert.equal((await dispatch(new Request('https://example.invalid'))).status, 405);
    for (const headers of [new Headers(), new Headers({ 'x-dispatch-secret': 'incorrect' })]) {
      assert.equal((await dispatch(new Request('https://example.invalid', { method: 'POST', headers }))).status, 401);
    }
  } finally {
    if (previous === undefined) Deno.env.delete(key);
    else Deno.env.set(key, previous);
  }
});
