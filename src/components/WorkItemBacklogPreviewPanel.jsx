import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

const NODE_BODY_ANIMATION_MS = 320;
const PROGRESS_LAYER_FADE_MS = 240;

function formatThreadTimestamp(value) {
  if (!value) {
    return "N/A";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "N/A";
  }

  return parsed.toLocaleString();
}

function getChildNodes(node) {
  return node.features || node.pbis || node.tasks || [];
}

function getNodeMetrics(node) {
  const childNodes = getChildNodes(node);
  const metrics = [];

  if (childNodes.length > 0) {
    metrics.push(childNodes.length === 1 ? "1 child item" : `${childNodes.length} child items`);
  }

  if (Array.isArray(node.acceptanceCriteria) && node.acceptanceCriteria.length > 0) {
    metrics.push(
      node.acceptanceCriteria.length === 1
        ? "1 acceptance criterion"
        : `${node.acceptanceCriteria.length} acceptance criteria`
    );
  }

  if (node?.type === "task") {
    const originalEstimate = Number(node?.originalEstimate);
    metrics.push(
      Number.isFinite(originalEstimate) && originalEstimate > 0
        ? `Original estimate: ${originalEstimate}h`
        : "Original estimate: not set"
    );
  }

  return metrics;
}

function createDraftFromNode(node) {
  return {
    title: node.title || "",
    description: node.description || "",
    acceptanceCriteria: Array.isArray(node.acceptanceCriteria)
      ? node.acceptanceCriteria.join("\n")
      : "",
    originalEstimate:
      node?.type === "task" && Number.isFinite(Number(node?.originalEstimate))
        ? String(Number(node.originalEstimate))
        : ""
  };
}

function renderCreatedItems(items, label, tone) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return (
    <div className="preview-created-group">
      <strong>{label}</strong>
      <div className="preview-created-links">
        {items.map((item) => (
          <a
            key={`${label}-${item.id}`}
            className={`preview-created-link ${tone}`}
            href={item.webUrl || item.url}
            target="_blank"
            rel="noreferrer"
          >
            #{item.id} {item.title}
          </a>
        ))}
      </div>
    </div>
  );
}

function renderEffortSummary(effortSummary) {
  const pbiItems = Array.isArray(effortSummary?.pbis) ? effortSummary.pbis : [];
  if (pbiItems.length === 0) {
    return null;
  }

  const totalEffortPoints = Number(effortSummary?.totalEffortPoints || 0);

  return (
    <div className="preview-effort-summary">
      <strong>Estimated Effort:</strong>
      <ol>
        {pbiItems.map((item) => (
          <li key={`effort-pbi-${item.id}`}>
            {item.title}: <strong>{Number(item.effortPoints || 0)} Story Points</strong>
          </li>
        ))}
      </ol>
      <p>Total Story Points: {totalEffortPoints}</p>
    </div>
  );
}

function NodeCard({
  node,
  depth,
  expandedNodes,
  editingNodeId,
  editDraft,
  onBeginEdit,
  onCancelEdit,
  onChangeDraft,
  onSaveEdit,
  onToggle,
  onRequestDelete,
  isRoot
}) {
  const isExpanded = Boolean(expandedNodes[node.id]);
  const isEditing = editingNodeId === node.id;
  const childNodes = getChildNodes(node);
  const hasChildren = childNodes.length > 0;
  const metrics = useMemo(() => getNodeMetrics(node), [node]);
  const bodyShellRef = useRef(null);
  const [isBodyRendered, setIsBodyRendered] = useState(isExpanded || isEditing);
  const [bodyState, setBodyState] = useState(isExpanded || isEditing ? "open" : "closed");

  useEffect(() => {
    if (isExpanded || isEditing) {
      setIsBodyRendered(true);
      setBodyState((current) => (current === "open" ? current : "opening"));
      return undefined;
    }

    if (isBodyRendered) {
      setBodyState("closing");
    }

    return undefined;
  }, [isExpanded, isEditing, isBodyRendered]);

  useEffect(() => {
    const shellElement = bodyShellRef.current;
    if (!shellElement || !isBodyRendered) {
      return undefined;
    }

    if (bodyState === "opening") {
      shellElement.style.height = "0px";
      shellElement.style.opacity = "0";
      shellElement.style.transform = "translateY(-6px) scaleY(0.97)";

      const animationFrameId = window.requestAnimationFrame(() => {
        shellElement.style.height = `${shellElement.scrollHeight}px`;
        shellElement.style.opacity = "1";
        shellElement.style.transform = "translateY(0) scaleY(1)";
      });

      return () => {
        window.cancelAnimationFrame(animationFrameId);
      };
    }

    if (bodyState === "closing") {
      shellElement.style.height = `${shellElement.scrollHeight}px`;
      shellElement.style.opacity = "1";
      shellElement.style.transform = "translateY(0) scaleY(1)";

      const animationFrameId = window.requestAnimationFrame(() => {
        shellElement.style.height = "0px";
        shellElement.style.opacity = "0";
        shellElement.style.transform = "translateY(-6px) scaleY(0.97)";
      });

      return () => {
        window.cancelAnimationFrame(animationFrameId);
      };
    }

    if (bodyState === "open") {
      shellElement.style.height = "auto";
      shellElement.style.opacity = "1";
      shellElement.style.transform = "translateY(0) scaleY(1)";
    }

    return undefined;
  }, [bodyState, isBodyRendered]);

  function handleBodyTransitionEnd(event) {
    if (event.target !== event.currentTarget || event.propertyName !== "height") {
      return;
    }

    if (bodyState === "opening") {
      const shellElement = bodyShellRef.current;
      if (shellElement) {
        shellElement.style.height = "auto";
      }
      setBodyState("open");
      return;
    }

    if (bodyState === "closing") {
      setIsBodyRendered(false);
      setBodyState("closed");
    }
  }

  return (
    <article className={`sketch-node-card ${node.type}`} style={{ "--node-depth": depth }}>
      <header className="sketch-node-header">
        <div className="sketch-node-heading">
          <span className="sketch-node-kind">{node.type}</span>
          <h3 className="sketch-node-title">{node.title || "Untitled item"}</h3>
        </div>

        <div className="sketch-node-actions">
          {!isRoot && (
            <button
              type="button"
              className={isEditing ? "sketch-node-action primary" : "sketch-node-action"}
              onClick={() => (isEditing ? onSaveEdit(node) : onBeginEdit(node))}
            >
              {isEditing ? "Save" : "Edit"}
            </button>
          )}
          <button
            type="button"
            className="sketch-node-action subtle"
            onClick={() => onToggle(node.id)}
          >
            {isExpanded ? "Collapse" : hasChildren ? "Expand" : "Details"}
          </button>
          {!isRoot && (
            <button
              type="button"
              className="sketch-node-action subtle danger"
              onClick={() => onRequestDelete(node.id)}
            >
              Delete
            </button>
          )}
        </div>
      </header>

      {!isEditing && metrics.length > 0 && (
        <div className="sketch-node-meta">
          {metrics.map((metric) => (
            <span key={`${node.id}-${metric}`} className="sketch-node-metric">
              {metric}
            </span>
          ))}
        </div>
      )}

      {isBodyRendered && (
        <div
          ref={bodyShellRef}
          className="sketch-node-body-shell"
          data-body-state={bodyState}
          aria-hidden={!isExpanded && !isEditing}
          onTransitionEnd={handleBodyTransitionEnd}
          style={{
            transitionDuration: `${NODE_BODY_ANIMATION_MS}ms`
          }}
        >
          <div className="sketch-node-body">
            {isEditing ? (
              <div className="sketch-edit-grid">
                <label className="sketch-field">
                  <span>Title</span>
                  <input
                    type="text"
                    value={editDraft.title}
                    onChange={(event) => onChangeDraft("title", event.target.value)}
                    autoFocus
                  />
                </label>

                <label className="sketch-field sketch-field-full">
                  <span>Description</span>
                  <textarea
                    rows={4}
                    value={editDraft.description}
                    onChange={(event) => onChangeDraft("description", event.target.value)}
                  />
                </label>

                {node.type !== "task" && "acceptanceCriteria" in node && (
                  <label className="sketch-field sketch-field-full">
                    <span>Acceptance Criteria</span>
                    <textarea
                      rows={4}
                      value={editDraft.acceptanceCriteria}
                      onChange={(event) => onChangeDraft("acceptanceCriteria", event.target.value)}
                      placeholder="One criterion per line"
                    />
                  </label>
                )}

                {node.type === "task" && (
                  <label className="sketch-field">
                    <span>Original Estimate (hours)</span>
                    <input
                      type="number"
                      min="0.25"
                      step="0.25"
                      value={editDraft.originalEstimate}
                      onChange={(event) => onChangeDraft("originalEstimate", event.target.value)}
                    />
                  </label>
                )}

                <div className="sketch-edit-actions">
                  <button type="button" className="sketch-node-action primary" onClick={() => onSaveEdit(node)}>
                    Save Changes
                  </button>
                  <button type="button" className="sketch-node-action subtle" onClick={onCancelEdit}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="sketch-node-content">
                  {node.description ? (
                    <div className="sketch-node-markdown sketch-node-description">
                      <ReactMarkdown>{node.description}</ReactMarkdown>
                    </div>
                  ) : (
                    <p className="sketch-node-description">No description provided yet.</p>
                  )}

                  {"acceptanceCriteria" in node && Array.isArray(node.acceptanceCriteria) && node.acceptanceCriteria.length > 0 && (
                    <div className="sketch-node-section">
                      <span className="sketch-node-section-title">Acceptance Criteria</span>
                      <ol className="sketch-criteria-list">
                        {node.acceptanceCriteria.map((criterion, index) => (
                          <li key={`${node.id}-criterion-${index}`}>
                            <div className="sketch-node-markdown">
                              <ReactMarkdown>{criterion}</ReactMarkdown>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>

                {childNodes.length > 0 && (
                  <div className="sketch-children">
                    {childNodes.map((child) => (
                      <NodeCard
                        key={child.id}
                        node={child}
                        depth={depth + 1}
                        expandedNodes={expandedNodes}
                        editingNodeId={editingNodeId}
                        editDraft={editDraft}
                        onBeginEdit={onBeginEdit}
                        onCancelEdit={onCancelEdit}
                        onChangeDraft={onChangeDraft}
                        onSaveEdit={onSaveEdit}
                        onToggle={onToggle}
                        onRequestDelete={onRequestDelete}
                        isRoot={false}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

export default function WorkItemBacklogPreviewPanel({
  activeTab,
  onChangeTab,
  threads,
  activeConversationId,
  isThreadsLoading,
  onSelectThread,
  sketch,
  sketchWarnings,
  isDraftLoading,
  isPreparingDraft,
  isSavingPreview,
  showSavePreviewSuccess,
  isCreatingBacklog,
  backlogItemsCreatedAt,
  canCreateBacklog,
  onCreateBacklog,
  canRefreshPreview,
  onRefreshPreview,
  canSavePreview,
  onSavePreview,
  createBacklogResult,
  expandedNodes,
  onToggleNode,
  onUpdateNodeField,
  onDeleteNode
}) {
  const [editingNodeId, setEditingNodeId] = useState(null);
  const [editDraft, setEditDraft] = useState(createDraftFromNode({}));
  const [isProgressLayerMounted, setIsProgressLayerMounted] = useState(isCreatingBacklog);
  const [isProgressLayerVisible, setIsProgressLayerVisible] = useState(isCreatingBacklog);
  const [isDraftLayerMounted, setIsDraftLayerMounted] = useState(isPreparingDraft);
  const [isDraftLayerVisible, setIsDraftLayerVisible] = useState(isPreparingDraft);
  const [isSaveLayerMounted, setIsSaveLayerMounted] = useState(
    isSavingPreview || showSavePreviewSuccess
  );
  const [isSaveLayerVisible, setIsSaveLayerVisible] = useState(
    isSavingPreview || showSavePreviewSuccess
  );
  const [pendingDeleteNodeId, setPendingDeleteNodeId] = useState(null);

  useEffect(() => {
    setEditingNodeId(null);
    setEditDraft(createDraftFromNode({}));
    setPendingDeleteNodeId(null);
  }, [sketch]);

  useEffect(() => {
    let hideTimerId = null;

    if (isCreatingBacklog) {
      setIsProgressLayerMounted(true);
      const animationFrameId = window.requestAnimationFrame(() => {
        setIsProgressLayerVisible(true);
      });
      return () => {
        window.cancelAnimationFrame(animationFrameId);
      };
    }

    if (isProgressLayerMounted) {
      setIsProgressLayerVisible(false);
      hideTimerId = window.setTimeout(() => {
        setIsProgressLayerMounted(false);
      }, PROGRESS_LAYER_FADE_MS);
    }

    return () => {
      if (hideTimerId) {
        window.clearTimeout(hideTimerId);
      }
    };
  }, [isCreatingBacklog, isProgressLayerMounted]);

  useEffect(() => {
    let hideTimerId = null;

    if (isPreparingDraft) {
      setIsDraftLayerMounted(true);
      const animationFrameId = window.requestAnimationFrame(() => {
        setIsDraftLayerVisible(true);
      });
      return () => {
        window.cancelAnimationFrame(animationFrameId);
      };
    }

    if (isDraftLayerMounted) {
      setIsDraftLayerVisible(false);
      hideTimerId = window.setTimeout(() => {
        setIsDraftLayerMounted(false);
      }, PROGRESS_LAYER_FADE_MS);
    }

    return () => {
      if (hideTimerId) {
        window.clearTimeout(hideTimerId);
      }
    };
  }, [isPreparingDraft, isDraftLayerMounted]);

  useEffect(() => {
    const shouldShowLayer = isSavingPreview || showSavePreviewSuccess;
    let hideTimerId = null;

    if (shouldShowLayer) {
      setIsSaveLayerMounted(true);
      const animationFrameId = window.requestAnimationFrame(() => {
        setIsSaveLayerVisible(true);
      });
      return () => {
        window.cancelAnimationFrame(animationFrameId);
      };
    }

    if (isSaveLayerMounted) {
      setIsSaveLayerVisible(false);
      hideTimerId = window.setTimeout(() => {
        setIsSaveLayerMounted(false);
      }, PROGRESS_LAYER_FADE_MS);
    }

    return () => {
      if (hideTimerId) {
        window.clearTimeout(hideTimerId);
      }
    };
  }, [isSavingPreview, showSavePreviewSuccess, isSaveLayerMounted]);

  function beginEdit(node) {
    setEditingNodeId(node.id);
    setEditDraft(createDraftFromNode(node));
  }

  function cancelEdit() {
    setEditingNodeId(null);
    setEditDraft(createDraftFromNode({}));
  }

  function saveEdit(node) {
    if (editingNodeId !== node.id) {
      return;
    }

    onUpdateNodeField(node.id, "title", editDraft.title);
    onUpdateNodeField(node.id, "description", editDraft.description);

    if (node.type !== "task" && "acceptanceCriteria" in node) {
      onUpdateNodeField(node.id, "acceptanceCriteria", editDraft.acceptanceCriteria);
    }
    if (node.type === "task") {
      onUpdateNodeField(node.id, "originalEstimate", editDraft.originalEstimate);
    }

    cancelEdit();
  }

  function requestDelete(nodeId) {
    setPendingDeleteNodeId(nodeId);
  }

  function confirmDelete() {
    if (!pendingDeleteNodeId) {
      return;
    }

    onDeleteNode(pendingDeleteNodeId);
    setPendingDeleteNodeId(null);
  }

  function cancelDeleteRequest() {
    setPendingDeleteNodeId(null);
  }

  const rootNode = sketch?.root || null;

  return (
    <>
      <div className="workspace-tabs" role="tablist" aria-label="Workspace view">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "discussion"}
          className={activeTab === "discussion" ? "workspace-tab active" : "workspace-tab"}
          onClick={() => onChangeTab("discussion")}
        >
          Discussion
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "preview"}
          className={activeTab === "preview" ? "workspace-tab active" : "workspace-tab"}
          onClick={() => onChangeTab("preview")}
        >
          Backlog Preview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "threads"}
          className={activeTab === "threads" ? "workspace-tab active" : "workspace-tab"}
          onClick={() => onChangeTab("threads")}
        >
          Threads
        </button>
      </div>

      {activeTab === "preview" && (
        <section
          className="backlog-preview-surface"
          aria-live="polite"
          aria-busy={isCreatingBacklog || isPreparingDraft || isSavingPreview}
        >
          {isDraftLoading && (
            <div className="backlog-preview-placeholder">
              <span className="summary-spinner" aria-hidden="true" />
              <p>Loading saved backlog draft...</p>
            </div>
          )}

          {!isDraftLoading && !rootNode && (
            <div className="backlog-preview-placeholder">
              <p>Backlog is not sketched yet.</p>
            </div>
          )}

          {!isDraftLoading && rootNode && (
            <div className="backlog-preview-content">
              <div className="backlog-preview-heading">
                <div>
                  <h2>Backlog Preview</h2>
                  <p>Review generated items, edit where needed, and delete irrelevant branches.</p>
                </div>
              </div>

              {sketchWarnings.length > 0 && (
                <div className="sketch-warning-panel" role="status">
                  <strong>Consistency warnings</strong>
                  <ul>
                    {sketchWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}

              <NodeCard
                node={rootNode}
                depth={0}
                expandedNodes={expandedNodes}
                editingNodeId={editingNodeId}
                editDraft={editDraft}
                onBeginEdit={beginEdit}
                onCancelEdit={cancelEdit}
                onChangeDraft={(field, value) =>
                  setEditDraft((current) => ({ ...current, [field]: value }))
                }
                onSaveEdit={saveEdit}
                onToggle={onToggleNode}
                onRequestDelete={requestDelete}
                isRoot={true}
              />

              <div className="backlog-preview-actions">
                <button
                  type="button"
                  className="preview-refresh-button"
                  onClick={onRefreshPreview}
                  disabled={!canRefreshPreview}
                >
                  Refresh Preview
                </button>
                <button
                  type="button"
                  className="preview-save-button"
                  onClick={onSavePreview}
                  disabled={!canSavePreview}
                >
                  Save Preview
                </button>
                <button
                  type="button"
                  className="preview-create-button"
                  onClick={onCreateBacklog}
                  disabled={!canCreateBacklog}
                >
                  {isCreatingBacklog
                    ? "Creating Backlog..."
                    : backlogItemsCreatedAt
                      ? "Items already created"
                      : "Create Backlog Items"}
                </button>
              </div>

              {createBacklogResult && (
                <section className="create-success preview-create-success">
                  <strong>Backlog items created successfully.</strong>
                  {createBacklogResult.counts && (
                    <p>
                      {createBacklogResult.counts.features} features,{" "}
                      {createBacklogResult.counts.pbis} PBIs, {createBacklogResult.counts.tasks} tasks
                    </p>
                  )}
                  {renderCreatedItems(createBacklogResult.features, "Features", "feature")}
                  {renderCreatedItems(createBacklogResult.pbis, "PBIs", "pbi")}
                  {renderCreatedItems(createBacklogResult.tasks, "Tasks", "task")}
                  {renderEffortSummary(createBacklogResult.effortSummary)}
                </section>
              )}
            </div>
          )}

          {!isDraftLoading && !isPreparingDraft && rootNode && isProgressLayerMounted && (
            <div
              className={
                isProgressLayerVisible
                  ? "backlog-progress-layer is-visible"
                  : "backlog-progress-layer"
              }
              role="status"
              aria-live="assertive"
            >
              <div className="backlog-progress-card">
                <strong>Creating Backlog Items</strong>
                <p>Saving generated hierarchy to Azure DevOps...</p>
              </div>
            </div>
          )}

          {!isDraftLoading && isDraftLayerMounted && (
            <div
              className={
                isDraftLayerVisible
                  ? "backlog-progress-layer is-visible"
                  : "backlog-progress-layer"
              }
              role="status"
              aria-live="assertive"
            >
              <div className="backlog-progress-card">
                <strong>Preparing Draft Items</strong>
                <p>Building backlog preview from conversation context...</p>
              </div>
            </div>
          )}

          {!isDraftLoading && !isPreparingDraft && !isCreatingBacklog && rootNode && isSaveLayerMounted && (
            <div
              className={
                isSaveLayerVisible
                  ? "backlog-progress-layer is-visible"
                  : "backlog-progress-layer"
              }
              role="status"
              aria-live="assertive"
            >
              <div className="backlog-progress-card">
                {isSavingPreview ? (
                  <>
                    <strong>Saving Draft Preview</strong>
                    <p>Persisting updated preview for this thread...</p>
                  </>
                ) : (
                  <strong>Draft was saved successfully</strong>
                )}
              </div>
            </div>
          )}

          {!isDraftLoading && !isPreparingDraft && !isSavingPreview && !isCreatingBacklog && rootNode && pendingDeleteNodeId && (
            <div className="backlog-progress-layer is-visible" role="dialog" aria-modal="true">
              <div className="backlog-progress-card backlog-confirm-card">
                <strong>Delete This Item?</strong>
                <p>This will remove the selected node from backlog preview.</p>
                <div className="backlog-confirm-actions">
                  <button
                    type="button"
                    className="backlog-confirm-button danger"
                    onClick={confirmDelete}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="backlog-confirm-button"
                    onClick={cancelDeleteRequest}
                  >
                    Back
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {activeTab === "threads" && (
        <section className="backlog-preview-surface" aria-live="polite">
          <div className="threads-panel">
            {isThreadsLoading && (
              <div className="backlog-preview-placeholder">
                <span className="summary-spinner" aria-hidden="true" />
                <p>Loading thread list...</p>
              </div>
            )}

            {!isThreadsLoading && (!Array.isArray(threads) || threads.length === 0) && (
              <div className="backlog-preview-placeholder">
                <p>No threads yet. Start by sending a prompt.</p>
              </div>
            )}

            {!isThreadsLoading && Array.isArray(threads) && threads.length > 0 && (
              <div className="threads-table-wrap">
                <table className="threads-table">
                  <thead>
                    <tr>
                      <th>Created By</th>
                      <th>Created At</th>
                      <th>Last Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {threads.map((thread) => (
                      <tr
                        key={thread.conversationId}
                        className={
                          activeConversationId === thread.conversationId
                            ? "threads-table-row active"
                            : "threads-table-row"
                        }
                        onClick={() => onSelectThread(thread.conversationId)}
                      >
                        <td>{thread.createdBy || "Unknown"}</td>
                        <td>{formatThreadTimestamp(thread.createdAt)}</td>
                        <td>{formatThreadTimestamp(thread.lastActiveAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
