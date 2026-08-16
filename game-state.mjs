export const SAVE_SCHEMA_VERSION = 1;

const NODE_TRANSIENT_KEYS = new Set(['children', 'parent', '_b', '_cb', '_shake']);
const MAP_RELATION_KEYS = new Set(['nodeMap', 'root', 'correctResult', 'inferResults', 'inferReqs']);

function copySerializable(source, excludedKeys) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (excludedKeys.has(key) || typeof value === 'function' || value === undefined) continue;
    result[key] = value;
  }
  return result;
}

export function serializeMaps(maps) {
  return (maps || []).map((map) => ({
    ...copySerializable(map, MAP_RELATION_KEYS),
    rootId: map.root?.id ?? null,
    correctResultId: map.correctResult?.id ?? null,
    nodes: Object.values(map.nodeMap || {}).map((node) => ({
      ...copySerializable(node, NODE_TRANSIENT_KEYS),
      childIds: (node.children || []).map((child) => child.id),
    })),
    inferResults: [...(map.inferResults || new Map()).entries()],
    inferReqs: [...(map.inferReqs || new Map()).entries()].map(([key, value]) => [
      key,
      value === Infinity ? { $number: 'Infinity' } : value,
    ]),
  }));
}

export function hydrateMaps(serializedMaps) {
  return (serializedMaps || []).map((savedMap) => {
    const nodeMap = {};
    for (const savedNode of savedMap.nodes || []) {
      const { childIds: _childIds, ...nodeData } = savedNode;
      nodeMap[savedNode.id] = {
        ...nodeData,
        children: [],
        parent: null,
        _b: null,
        _cb: null,
      };
    }

    for (const savedNode of savedMap.nodes || []) {
      const node = nodeMap[savedNode.id];
      for (const childId of savedNode.childIds || []) {
        const child = nodeMap[childId];
        if (!child) throw new Error(`存档引用了不存在的节点: ${childId}`);
        node.children.push(child);
        child.parent = node;
      }
    }

    const {
      nodes: _nodes,
      rootId,
      correctResultId,
      inferResults = [],
      inferReqs = [],
      ...mapData
    } = savedMap;
    if (!nodeMap[rootId]) throw new Error(`存档根节点不存在: ${rootId}`);
    if (!nodeMap[correctResultId]) throw new Error(`存档正确节点不存在: ${correctResultId}`);

    return {
      ...mapData,
      nodeMap,
      root: nodeMap[rootId],
      correctResult: nodeMap[correctResultId],
      inferResults: new Map(inferResults),
      inferReqs: new Map(inferReqs.map(([key, value]) => [
        key,
        value && value.$number === 'Infinity' ? Infinity : value,
      ])),
    };
  });
}

export function createSaveEnvelope({ playerName, phase, state, finalScreen = null }) {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    playerName,
    savedAt: new Date().toISOString(),
    phase,
    state,
    finalScreen,
  };
}

export function validateSaveEnvelope(value, expectedPlayerName = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('存档必须是 JSON 对象');
  }
  if (value.schemaVersion !== SAVE_SCHEMA_VERSION) {
    throw new Error(`不支持的存档版本: ${value.schemaVersion}`);
  }
  if (typeof value.playerName !== 'string' || !value.playerName.trim()) {
    throw new Error('存档缺少玩家名称');
  }
  if (expectedPlayerName !== null && value.playerName.normalize('NFC').trim() !== expectedPlayerName.normalize('NFC').trim()) {
    throw new Error('存档玩家名称与请求不一致');
  }
  if (!['active', 'shop', 'finished'].includes(value.phase)) {
    throw new Error(`无效的存档阶段: ${value.phase}`);
  }
  if (!value.state || typeof value.state !== 'object' || !Array.isArray(value.state.maps)) {
    throw new Error('存档状态不完整');
  }
  if (value.phase === 'finished' && (!value.finalScreen || typeof value.finalScreen.title !== 'string')) {
    throw new Error('终局存档缺少结果信息');
  }
  return value;
}
