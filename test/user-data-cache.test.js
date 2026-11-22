import { test } from 'node:test';
import assert from 'node:assert/strict';
import AnyList from '../anylist-js/lib/index.js';

function make() {
  const a = new AnyList({ email: 'x@example.com', password: 'p' });
  const posts = [];
  a.protobuf = { PBUserDataResponse: { decode: () => ({ mealPlanningCalendarResponse: { calendarId: 'c' } }) } };
  a.client = { post: async (path) => { posts.push(path); return { body: Buffer.alloc(0) }; } };
  return { a, posts };
}

test('reads within the window share one account download', async () => {
  const { a, posts } = make();
  await Promise.all([a._getUserData(true), a._getUserData(true), a._getUserData(true)]);
  await a._getUserData(true);
  assert.equal(posts.length, 1);
});

test('invalidation forces the next read to download again', async () => {
  const { a, posts } = make();
  await a._getUserData(true);
  a.invalidateUserData();
  await a._getUserData(true);
  assert.equal(posts.length, 2);
});

test('an expired cache downloads again', async () => {
  const { a, posts } = make();
  a.userDataMaxAgeMs = 0;
  await a._getUserData(true);
  await a._getUserData(true);
  assert.equal(posts.length, 2);
});
