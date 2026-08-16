import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSaveEnvelope } from './game-state.mjs';

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
const writeQueues = new Map();

export function normalizePlayerName(value) {
  if (typeof value !== 'string') throw httpError(400, '玩家名称必须是字符串');
  const name = value.normalize('NFC').trim();
  const length = [...name].length;
  if (length < 1 || length > 16) throw httpError(400, '玩家名称长度必须为 1–16 个字符');
  return name;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function saveFileName(playerName) {
  return `${createHash('sha256').update(playerName).digest('hex')}.json`;
}

function queueWrite(filePath, operation) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  writeQueues.set(filePath, current);
  return current.finally(() => {
    if (writeQueues.get(filePath) === current) writeQueues.delete(filePath);
  });
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

async function readBody(request, limit = DEFAULT_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw httpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, '请求不是有效 JSON');
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function emptyLeaderboard() {
  return { version: 1, players: [] };
}

function normalizeLeaderboard(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.players)) {
    throw httpError(400, '排行榜格式无效');
  }
  return {
    version: 1,
    players: value.players
      .filter((player) => player && typeof player.name === 'string')
      .map((player) => ({
        name: normalizePlayerName(player.name),
        scores: Array.isArray(player.scores) ? player.scores.map((score) => Number(score) || 0) : [],
        matchScores: Array.isArray(player.matchScores) ? player.matchScores : [],
      })),
  };
}

export function mergeLeaderboards(targetValue, incomingValue) {
  const target = normalizeLeaderboard(targetValue);
  const incoming = normalizeLeaderboard(incomingValue);
  for (const sourcePlayer of incoming.players) {
    let player = target.players.find((item) => item.name === sourcePlayer.name);
    if (!player) {
      player = { name: sourcePlayer.name, scores: [], matchScores: [] };
      target.players.push(player);
    }
    sourcePlayer.scores.forEach((score, level) => {
      const current = Number(player.scores[level]) || 0;
      if (score > current) {
        player.scores[level] = score;
        player.matchScores[level] = sourcePlayer.matchScores[level] ?? null;
      } else if (score === current && !player.matchScores[level] && sourcePlayer.matchScores[level]) {
        player.matchScores[level] = sourcePlayer.matchScores[level];
      }
    });
  }
  return target;
}

function mimeType(filePath) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  })[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function createAppServer({
  rootDir = path.dirname(fileURLToPath(import.meta.url)),
  dataDir = path.join(rootDir, 'data'),
  bodyLimit = DEFAULT_BODY_LIMIT,
} = {}) {
  const savesDir = path.join(dataDir, 'saves');
  const leaderboardPath = path.join(dataDir, 'leaderboard.json');

  async function handleApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/leaderboard') {
      if (request.method !== 'GET') throw httpError(405, '不支持的请求方法');
      sendJson(response, 200, await readJson(leaderboardPath, emptyLeaderboard()));
      return true;
    }

    if (url.pathname === '/api/leaderboard/import') {
      if (request.method !== 'POST') throw httpError(405, '不支持的请求方法');
      const incoming = await readBody(request, bodyLimit);
      const merged = await queueWrite(leaderboardPath, async () => {
        const current = await readJson(leaderboardPath, emptyLeaderboard());
        const result = mergeLeaderboards(current, incoming);
        await atomicWriteJson(leaderboardPath, result);
        return result;
      });
      sendJson(response, 200, merged);
      return true;
    }

    if (url.pathname === '/api/leaderboard/records') {
      if (request.method !== 'POST') throw httpError(405, '不支持的请求方法');
      const record = await readBody(request, bodyLimit);
      const playerName = normalizePlayerName(record.playerName);
      const level = Number(record.level);
      const cumulativeScore = Number(record.cumulativeScore);
      if (!Number.isInteger(level) || level < 0 || level > 100 || !Number.isFinite(cumulativeScore) || cumulativeScore < 0) {
        throw httpError(400, '成绩字段无效');
      }
      const updated = await queueWrite(leaderboardPath, async () => {
        const leaderboard = normalizeLeaderboard(await readJson(leaderboardPath, emptyLeaderboard()));
        let player = leaderboard.players.find((item) => item.name === playerName);
        if (!player) {
          player = { name: playerName, scores: [], matchScores: [] };
          leaderboard.players.push(player);
        }
        const current = Number(player.scores[level]) || 0;
        if (cumulativeScore >= current) {
          player.scores[level] = cumulativeScore;
          player.matchScores[level] = record.matchScore ?? null;
        }
        await atomicWriteJson(leaderboardPath, leaderboard);
        return leaderboard;
      });
      sendJson(response, 200, updated);
      return true;
    }

    const saveMatch = url.pathname.match(/^\/api\/saves\/([^/]+)(\/meta)?$/);
    if (!saveMatch) return false;
    let rawName;
    try {
      rawName = decodeURIComponent(saveMatch[1]);
    } catch {
      throw httpError(400, '玩家名称编码无效');
    }
    const playerName = normalizePlayerName(rawName);
    const filePath = path.join(savesDir, saveFileName(playerName));

    if (saveMatch[2] === '/meta') {
      if (request.method !== 'GET') throw httpError(405, '不支持的请求方法');
      const save = await readJson(filePath, null);
      if (!save) {
        sendJson(response, 200, { exists: false });
      } else {
        sendJson(response, 200, {
          exists: true,
          playerName: save.playerName,
          savedAt: save.savedAt,
          phase: save.phase,
          level: save.state?.level ?? 0,
          levelName: save.state?.levelName ?? '',
        });
      }
      return true;
    }

    if (request.method === 'GET') {
      const save = await readJson(filePath, null);
      if (!save) throw httpError(404, '未找到存档');
      validateSaveEnvelope(save, playerName);
      sendJson(response, 200, save);
      return true;
    }
    if (request.method === 'PUT') {
      const save = await readBody(request, bodyLimit);
      try {
        validateSaveEnvelope(save, playerName);
      } catch (error) {
        throw httpError(error.message.includes('玩家名称') || error.message.includes('版本') ? 409 : 400, error.message);
      }
      save.playerName = playerName;
      save.savedAt = new Date().toISOString();
      await queueWrite(filePath, () => atomicWriteJson(filePath, save));
      sendJson(response, 200, {
        ok: true,
        savedAt: save.savedAt,
        phase: save.phase,
        level: save.state.level,
      });
      return true;
    }
    if (request.method === 'DELETE') {
      await queueWrite(filePath, async () => {
        try {
          await unlink(filePath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      });
      response.writeHead(204);
      response.end();
      return true;
    }
    throw httpError(405, '不支持的请求方法');
  }

  async function handleStatic(request, response, url) {
    if (!['GET', 'HEAD'].includes(request.method)) throw httpError(405, '不支持的请求方法');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw httpError(400, '路径编码无效');
    }
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/data' || pathname.startsWith('/data/')) throw httpError(404, '未找到');
    const publicFiles = new Set(['/index.html', '/tutorial.html', '/tutorial2.html', '/game-state.mjs']);
    if (!publicFiles.has(pathname)) throw httpError(404, '未找到');
    const filePath = path.resolve(rootDir, `.${pathname}`);
    if (filePath !== rootDir && !filePath.startsWith(`${rootDir}${path.sep}`)) throw httpError(404, '未找到');
    const info = await stat(filePath).catch((error) => {
      if (error.code === 'ENOENT') throw httpError(404, '未找到');
      throw error;
    });
    if (!info.isFile()) throw httpError(404, '未找到');
    response.writeHead(200, {
      'Content-Type': mimeType(filePath),
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (!(await handleApi(request, response, url))) throw httpError(404, '未找到 API');
      } else {
        await handleStatic(request, response, url);
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      sendJson(response, error.status || 500, {
        error: error.status ? 'request_error' : 'internal_error',
        message: error.status ? error.message : '服务器内部错误',
      });
      if (!error.status) console.error(error);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT) || 8080;
  const server = createAppServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`OI 比赛模拟器已启动：http://127.0.0.1:${port}`);
  });
}
