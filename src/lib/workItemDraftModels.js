function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(items) {
  return Array.isArray(items)
    ? items.map((item) => normalizeString(item)).filter(Boolean)
    : [];
}

function normalizePositiveNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
}

function normalizeNode(node, fallbackId, fallbackType) {
  const type = normalizeString(node?.type).toLowerCase() || fallbackType;
  const normalized = {
    id: normalizeString(node?.id) || fallbackId,
    type,
    title: normalizeString(node?.title),
    description: normalizeString(node?.description),
    acceptanceCriteria: normalizeStringArray(node?.acceptanceCriteria)
  };

  if (type === "task") {
    normalized.originalEstimate = normalizePositiveNumber(node?.originalEstimate);
  }

  if (Array.isArray(node?.features)) {
    normalized.features = node.features.map((feature, index) =>
      normalizeNode(feature, `feature-${index + 1}`, "feature")
    );
  }
  if (Array.isArray(node?.pbis)) {
    normalized.pbis = node.pbis.map((pbi, index) =>
      normalizeNode(pbi, `pbi-${index + 1}`, "pbi")
    );
  }
  if (Array.isArray(node?.tasks)) {
    normalized.tasks = node.tasks.map((task, index) =>
      normalizeNode(task, `task-${index + 1}`, "task")
    );
  }

  return normalized;
}

export function normalizeWorkItemSketch(sketch) {
  const root = sketch?.root;
  if (!root || typeof root !== "object") {
    return null;
  }

  return {
    root: normalizeNode(root, "root-1", "epic"),
    context: {
      sourceWorkItemId: Number(sketch?.context?.sourceWorkItemId) || null,
      sourceWorkItemType: normalizeString(sketch?.context?.sourceWorkItemType),
      parentContainerId: Number(sketch?.context?.parentContainerId) || null,
      parentContainerType: normalizeString(sketch?.context?.parentContainerType),
      generationMode: normalizeString(sketch?.context?.generationMode)
    },
    warnings: normalizeStringArray(sketch?.warnings)
  };
}

function updateNodeList(nodes, nodeId, updater) {
  let changed = false;

  const nextNodes = nodes.map((node) => {
    if (node.id === nodeId) {
      changed = true;
      return updater(node);
    }

    if (Array.isArray(node.features) && node.features.length > 0) {
      const nextFeatures = updateNodeList(node.features, nodeId, updater);
      if (nextFeatures !== node.features) {
        changed = true;
        return {
          ...node,
          features: nextFeatures
        };
      }
    }

    if (Array.isArray(node.pbis) && node.pbis.length > 0) {
      const nextPbis = updateNodeList(node.pbis, nodeId, updater);
      if (nextPbis !== node.pbis) {
        changed = true;
        return {
          ...node,
          pbis: nextPbis
        };
      }
    }

    if (Array.isArray(node.tasks) && node.tasks.length > 0) {
      const nextTasks = updateNodeList(node.tasks, nodeId, updater);
      if (nextTasks !== node.tasks) {
        changed = true;
        return {
          ...node,
          tasks: nextTasks
        };
      }
    }

    return node;
  });

  return changed ? nextNodes : nodes;
}

function removeNodeList(nodes, nodeId) {
  let changed = false;
  const filtered = [];

  for (const node of nodes) {
    if (node.id === nodeId) {
      changed = true;
      continue;
    }

    let nextNode = node;
    if (Array.isArray(node.features) && node.features.length > 0) {
      const nextFeatures = removeNodeList(node.features, nodeId);
      if (nextFeatures !== node.features) {
        changed = true;
        nextNode = {
          ...nextNode,
          features: nextFeatures
        };
      }
    }
    if (Array.isArray(node.pbis) && node.pbis.length > 0) {
      const nextPbis = removeNodeList(node.pbis, nodeId);
      if (nextPbis !== node.pbis) {
        changed = true;
        nextNode = {
          ...nextNode,
          pbis: nextPbis
        };
      }
    }
    if (Array.isArray(node.tasks) && node.tasks.length > 0) {
      const nextTasks = removeNodeList(node.tasks, nodeId);
      if (nextTasks !== node.tasks) {
        changed = true;
        nextNode = {
          ...nextNode,
          tasks: nextTasks
        };
      }
    }

    filtered.push(nextNode);
  }

  return changed ? filtered : nodes;
}

export function updateWorkItemSketchNode(sketch, nodeId, updater) {
  if (!sketch?.root || !nodeId) {
    return sketch;
  }

  if (sketch.root.id === nodeId) {
    return {
      ...sketch,
      root: updater(sketch.root)
    };
  }

  const root = sketch.root;
  const nextRoot = {
    ...root,
    features: root.features ? updateNodeList(root.features, nodeId, updater) : root.features,
    pbis: root.pbis ? updateNodeList(root.pbis, nodeId, updater) : root.pbis,
    tasks: root.tasks ? updateNodeList(root.tasks, nodeId, updater) : root.tasks
  };

  if (
    nextRoot.features === root.features &&
    nextRoot.pbis === root.pbis &&
    nextRoot.tasks === root.tasks
  ) {
    return sketch;
  }

  return {
    ...sketch,
    root: nextRoot
  };
}

export function deleteWorkItemSketchNode(sketch, nodeId) {
  if (!sketch?.root || !nodeId || sketch.root.id === nodeId) {
    return sketch;
  }

  const root = sketch.root;
  const nextRoot = {
    ...root,
    features: root.features ? removeNodeList(root.features, nodeId) : root.features,
    pbis: root.pbis ? removeNodeList(root.pbis, nodeId) : root.pbis,
    tasks: root.tasks ? removeNodeList(root.tasks, nodeId) : root.tasks
  };

  if (
    nextRoot.features === root.features &&
    nextRoot.pbis === root.pbis &&
    nextRoot.tasks === root.tasks
  ) {
    return sketch;
  }

  return {
    ...sketch,
    root: nextRoot
  };
}

function collectWarnings(node, warnings) {
  if (!normalizeString(node.title)) {
    warnings.push(`${node.type} requires a title.`);
  }

  for (const child of node.features || []) {
    collectWarnings(child, warnings);
  }
  for (const child of node.pbis || []) {
    collectWarnings(child, warnings);
  }
  for (const child of node.tasks || []) {
    collectWarnings(child, warnings);
  }
}

export function validateWorkItemSketch(sketch) {
  if (!sketch?.root) {
    return [];
  }

  const warnings = [];
  collectWarnings(sketch.root, warnings);
  return Array.from(new Set(warnings));
}
