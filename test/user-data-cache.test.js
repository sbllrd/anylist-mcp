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

test('a change during a download leaves that download stale, and a later read does not join it', async () => {
  const a = new AnyList({ email: 'x@example.com', password: 'p' });
  a.protobuf = { PBUserDataResponse: { decode: (body) => ({ n: body.n, mealPlanningCalendarResponse: { calendarId: 'c' } }) } };
  const posts = [];
  let release;
  a.client = { post: async () => {
    const n = posts.push(1);
    if (n === 1) await new Promise(r => { release = r; });
    return { body: { n } };
  } };
  const first = a._getUserData(true);
  await new Promise(r => setImmediate(r));
  a.invalidateUserData();                 // e.g. a websocket "lists changed" mid-download
  const second = a._getUserData(true);    // must not reuse the download that started before the change
  release();
  assert.equal((await first).n, 1);
  assert.equal((await second).n, 2);
  assert.equal(posts.length, 2);
  await a._getUserData(true);             // the second download is fresh, so this reuses it
  assert.equal(posts.length, 2);
});
