const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../youtubeToDiscord.js'), 'utf8');

function setup(rows = []) {
  const state = { rows, posts: [], calls: [], properties: {}, videos: [], uploads: [], success: true };
  const sheet = {
    getLastRow: () => state.rows.length,
    getRange(a, b, count = 1) {
      if (typeof a === 'string') {
        return { getValues: () => state.rows.map(row => [row[3]]) };
      }
      return {
        getValues: () => state.rows.slice(a - 1, a - 1 + count).map(row => row.slice(b - 1)),
        getValue: () => state.rows[a - 1][b - 1],
        setValue: value => { state.rows[a - 1][b - 1] = value; },
        setValues: values => values.forEach((row, i) => { state.rows[a - 1 + i] = [...row]; })
      };
    }
  };
  const context = vm.createContext({
    console: { log() {}, error() {} }, Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => state.properties[key],
      setProperty: (key, value) => { state.properties[key] = value; }
    }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    Utilities: { sleep() {} },
    dayjs: { dayjs: value => ({ isValid: () => true, format: () => String(value) }) },
    YouTube: {
      Channels: { list: () => ({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUtest' } } }] }) },
      PlaylistItems: { list: () => {
        if (state.failUploads) throw Error('500');
        return { items: state.uploads.map(id => ({ contentDetails: { videoId: id } })) };
      } },
      Videos: { list: (parts, options) => {
        assert.ok(parts.split(',').map(part => part.trim()).includes('status'));
        if (options.fields) assert.ok(options.fields.includes('status(privacyStatus)'));
        state.calls.push(options.id);
        if (state.failVideos) throw Error('500');
        return { items: state.videos.filter(video => options.id.split(',').includes(video.id)) };
      } }
    }
  });
  vm.runInContext(source, context);
  context.initialRows = rows.map(row => [...row]);
  vm.runInContext('globalSheetData = initialRows;', context);
  context.postToDiscord = data => { state.posts.push(data); return { success: state.success, rateLimited: false }; };
  state.run = () => context.processChannelFeed('Channel', 'UCtest', [['Channel', 'UCtest']], '', '');
  state.fetchVideo = id => context.fetchVideoInfo(id);
  return state;
}
const video = (id, details) => ({ id, status: { privacyStatus: 'public' }, snippet: { title: id, publishedAt: '2026-09-01' }, contentDetails: { duration: 'PT1M' }, ...(details ? { liveStreamingDetails: details } : {}) });

test('only public videos are notified and stored', () => {
  const state = setup();
  state.uploads = ['public', 'private', 'unlisted', 'unknown'];
  state.videos = state.uploads.map(id => ({ ...video(id), status: id === 'unknown' ? undefined : { privacyStatus: id } }));
  state.run();
  assert.deepEqual(state.posts.map(post => post.videoId), ['public']);
  assert.deepEqual(state.rows.map(row => row[3]), ['public']);
  assert.equal(state.fetchVideo('private'), null);
  assert.equal(state.fetchVideo('unlisted'), null);
  assert.equal(state.fetchVideo('unknown'), null);
});

for (const privacyStatus of ['private', 'unlisted']) {
test(`a tracked stream made ${privacyStatus} preserves its row without notification`, () => {
  const original = ['old', 'published', 'checked', 'old', 'Channel', 'upcoming', 'scheduled', '', '00:00:00'];
  const state = setup([[...original]]);
  state.videos = [{ ...video('old', { actualStartTime: 'started' }), status: { privacyStatus } }];
  state.run();
  assert.deepEqual(state.rows, [original]);
  assert.equal(state.posts.length, 0);
});
}

test('API-only discovery batches details, caches playlist, and avoids duplicate notification', () => {
  const state = setup();
  state.uploads = ['a', 'a', 'b'];
  state.videos = [video('a'), video('b')];
  state.run();
  assert.equal(state.posts.length, 2);
  assert.deepEqual(state.calls, ['a,b']);
  assert.equal(state.properties['uploadsPlaylistId:UCtest'], 'UUtest');
  state.run();
  assert.equal(state.posts.length, 2);
  assert.equal(state.rows.length, 2);
});

test('tracks an older upcoming stream even when uploads fail', () => {
  const state = setup([['old', 'published', 'checked', 'old', 'Channel', 'upcoming', 'scheduled', '', '00:00:00']]);
  state.failUploads = true;
  state.videos = [video('old', { actualStartTime: 'started' })];
  state.run();
  assert.equal(state.rows[0][5], 'live');
  assert.equal(state.posts.length, 1);
});

test('missing videos and API errors preserve existing rows without notifications', () => {
  const original = ['old', 'published', 'checked', 'old', 'Channel', 'live', '', 'started', '00:00:00'];
  const state = setup([[...original]]);
  state.run();
  state.failVideos = true;
  state.run();
  assert.deepEqual(state.rows, [original]);
  assert.equal(state.posts.length, 0);
});

test('failed new notifications are retried without saving a row', () => {
  const state = setup();
  state.uploads = ['new'];
  state.videos = [video('new')];
  state.success = false;
  state.run();
  assert.equal(state.rows.length, 0);
  state.success = true;
  state.run();
  assert.equal(state.rows.length, 1);
});

test('failed state notifications restore the previous row', () => {
  const original = ['old', 'published', 'checked', 'old', 'Channel', 'live', '', 'started', '00:00:00'];
  const state = setup([[...original]]);
  state.videos = [video('old', { actualStartTime: 'started', actualEndTime: 'ended' })];
  state.success = false;
  state.run();
  assert.deepEqual(state.rows, [original]);
  assert.equal(state.posts.length, 1);
});
