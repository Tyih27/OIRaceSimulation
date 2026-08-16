import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';

function requestJson(base, pathname, { method = 'GET', body = null } = {}) {
  const url = new URL(pathname, base);
  const payload = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method,
      agent: false,
      headers: payload === null ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        if (text) {
          try { data = JSON.parse(text); } catch { data = text; }
        }
        resolve({ status: response.statusCode, data });
      });
    });
    request.on('error', reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

async function withServer(run, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'oi-save-test-'));
  const server = createAppServer({ rootDir: process.cwd(), dataDir, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, dataDir);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function sampleSave(playerName = '测试选手') {
  return {
    schemaVersion: 1,
    playerName,
    savedAt: new Date(0).toISOString(),
    phase: 'active',
    state: { level: 2, levelName: 'NOIP模拟赛1', maps: [] },
    finalScreen: null,
  };
}

test('存档 API 支持写入、元信息、读取和幂等删除', async () => {
  await withServer(async (base) => {
    const player = encodeURIComponent('测试选手');
    let response = await requestJson(base, `/api/saves/${player}`, { method: 'PUT', body: sampleSave() });
    assert.equal(response.status, 200);

    const loaded = await requestJson(base, `/api/saves/${player}`);
    response = await requestJson(base, `/api/saves/${player}/meta`);
    assert.deepEqual(response.data, {
      exists: true,
      playerName: '测试选手',
      savedAt: loaded.data.savedAt,
      phase: 'active',
      level: 2,
      levelName: 'NOIP模拟赛1',
    });

    response = await requestJson(base, `/api/saves/${player}`, { method: 'DELETE' });
    assert.equal(response.status, 204);
    response = await requestJson(base, `/api/saves/${player}`, { method: 'DELETE' });
    assert.equal(response.status, 204);
    assert.equal((await requestJson(base, `/api/saves/${player}/meta`)).data.exists, false);
  });
});

test('存档 API 列出所有有效存档并忽略损坏文件', async () => {
  await withServer(async (base, dataDir) => {
    let response = await requestJson(base, '/api/saves');
    assert.deepEqual(response, { status: 200, data: { saves: [] } });

    for (const playerName of ['甲', '乙']) {
      response = await requestJson(base, `/api/saves/${encodeURIComponent(playerName)}`, {
        method: 'PUT',
        body: sampleSave(playerName),
      });
      assert.equal(response.status, 200);
    }
    await writeFile(path.join(dataDir, 'saves', 'broken.json'), '{not json', 'utf8');

    response = await requestJson(base, '/api/saves');
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.saves.map((save) => save.playerName).sort(), ['乙', '甲']);
    for (const save of response.data.saves) {
      assert.equal(typeof save.savedAt, 'string');
      assert.equal(save.phase, 'active');
      assert.equal(save.level, 2);
      assert.equal(save.levelName, 'NOIP模拟赛1');
    }

    response = await requestJson(base, '/api/saves', { method: 'POST', body: {} });
    assert.equal(response.status, 405);
  });
});

test('拒绝玩家不一致、超大正文，并且不公开 data 目录', async () => {
  await withServer(async (base) => {
    let response = await requestJson(base, `/api/saves/${encodeURIComponent('甲')}`, { method: 'PUT', body: sampleSave('乙') });
    assert.equal(response.status, 409);
    response = await requestJson(base, `/api/saves/${encodeURIComponent('甲')}`, { method: 'PUT', body: JSON.stringify(sampleSave('甲')) + 'x'.repeat(400) });
    assert.equal(response.status, 413);
    response = await requestJson(base, '/data/leaderboard.json');
    assert.equal(response.status, 404);
    response = await requestJson(base, '/server.mjs');
    assert.equal(response.status, 404);
    response = await requestJson(base, '/game-state.mjs');
    assert.equal(response.status, 200);
  }, { bodyLimit: 300 });
});

test('排行榜迁移合并最高分，后续低分不会覆盖', async () => {
  await withServer(async (base, dataDir) => {
    let response = await requestJson(base, '/api/leaderboard/import', { method: 'POST', body: { players: [{ name: '甲', scores: [100, 500], matchScores: [null, { matchScore: 300 }] }] } });
    assert.equal(response.status, 200);
    response = await requestJson(base, '/api/leaderboard/records', { method: 'POST', body: { playerName: '甲', level: 1, cumulativeScore: 300, matchScore: { matchScore: 0 } } });
    assert.equal(response.status, 200);
    const leaderboard = (await requestJson(base, '/api/leaderboard')).data;
    assert.equal(leaderboard.players[0].scores[1], 500);
    assert.equal(JSON.parse(await readFile(path.join(dataDir, 'leaderboard.json'), 'utf8')).version, 1);
  });
});
