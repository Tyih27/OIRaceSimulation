import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSaveEnvelope,
  hydrateMaps,
  serializeMaps,
  validateSaveEnvelope,
} from '../game-state.mjs';

function sampleMap() {
  const root = { id: 'R', name: 'R', state: 'correct', children: [], parent: null, _b: { x: 1 }, _shake: true };
  const child = { id: 'N1', name: 'N1', state: 'unlocked', children: [], parent: root, score: 100, _cb: { x: 2 } };
  root.children.push(child);
  return {
    nodeMap: { R: root, N1: child },
    root,
    correctResult: child,
    totalUnlocked: 2,
    inferResults: new Map([['R', { containsCorrect: true }]]),
    inferReqs: new Map([['R', 7], ['N1', Infinity]]),
  };
}

test('地图往返时重建节点关系和 Map，并排除瞬时字段', () => {
  const encoded = serializeMaps([sampleMap()]);
  assert.equal(encoded[0].nodes[0]._b, undefined);
  assert.equal(encoded[0].nodes[0]._shake, undefined);

  const [map] = hydrateMaps(JSON.parse(JSON.stringify(encoded)));
  assert.equal(map.root.children[0], map.correctResult);
  assert.equal(map.correctResult.parent, map.root);
  assert.equal(map.nodeMap.N1, map.correctResult);
  assert.deepEqual(map.inferResults.get('R'), { containsCorrect: true });
  assert.equal(map.inferReqs.get('R'), 7);
  assert.equal(map.inferReqs.get('N1'), Infinity);
  assert.equal(map.root._b, null);
});

test('存档信封校验版本、阶段和玩家', () => {
  const save = createSaveEnvelope({
    playerName: '选手甲',
    phase: 'active',
    state: { maps: serializeMaps([sampleMap()]) },
  });
  assert.equal(validateSaveEnvelope(save, '选手甲'), save);
  assert.throws(() => validateSaveEnvelope({ ...save, schemaVersion: 999 }), /不支持/);
  assert.throws(() => validateSaveEnvelope(save, '选手乙'), /不一致/);
});

test('损坏的节点引用会被拒绝', () => {
  const encoded = serializeMaps([sampleMap()]);
  encoded[0].nodes[0].childIds = ['missing'];
  assert.throws(() => hydrateMaps(encoded), /不存在的节点/);
});
