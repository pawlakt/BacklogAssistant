import React, { useEffect, useMemo, useState } from "react";
import {
  backendConfigHint,
  getWorkItemAssistantDraft,
  getWorkItemAssistantMessages,
  getWorkItemAssistantThreads,
  isBackendConfigured,
  postWorkItemAssistantActivateThread,
  postWorkItemAssistantCreateBacklog,
  postWorkItemAssistantMessage,
  postWorkItemAssistantNewThread,
  postWorkItemAssistantPrepareDraft,
  postWorkItemAssistantSaveDraft,
  resolveAgentContext
} from "../apiClient";
import ConversationTranscript from "./ConversationTranscript";
import WorkItemBacklogPreviewPanel from "./WorkItemBacklogPreviewPanel";
import { normalizeAgentMessages } from "../lib/agentModels";
import { normalizeRequestError, resolveWorkItemContext } from "../lib/appHelpers";
import { subscribeWorkItemHostContext } from "../lib/workItemHostBridge";
import {
  deleteWorkItemSketchNode,
  normalizeWorkItemSketch,
  updateWorkItemSketchNode,
  validateWorkItemSketch
} from "../lib/workItemDraftModels";

const MAX_PROMPT_LENGTH = 10000;
const THREAD_NOTICE_TIMEOUT_MS = 8000;
const SAVE_PREVIEW_NOTICE_TIMEOUT_MS = 2000;
const NEW_THREAD_NOTICE_TEXT =
  "The existing thread was saved. To switch threads, open the Threads tab and select one from the existing threads.";

export default function WorkItemAssistantApp({ adoContext }) {
  const backendConfigured = isBackendConfigured();
  const agentContext = useMemo(() => resolveAgentContext(adoContext), [adoContext]);
  const agentContextReady = Boolean(agentContext.adoUserId && agentContext.projectId);

  const [workItemContext, setWorkItemContext] = useState({
    workItemId: null,
    workItemType: null
  });
  const [workspaceTab, setWorkspaceTab] = useState("discussion");
  const [messages, setMessages] = useState([]);
  const [threads, setThreads] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [draft, setDraft] = useState("");
  const [sketch, setSketch] = useState(null);
  const [sketchWarnings, setSketchWarnings] = useState([]);
  const [expandedSketchNodes, setExpandedSketchNodes] = useState({});
  const [createResult, setCreateResult] = useState(null);
  const [backlogItemsCreatedAt, setBacklogItemsCreatedAt] = useState(null);
  const [error, setError] = useState(null);
  const [isContextLoading, setIsContextLoading] = useState(true);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isThreadsLoading, setIsThreadsLoading] = useState(false);
  const [isDraftLoading, setIsDraftLoading] = useState(false);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [isSwitchingThread, setIsSwitchingThread] = useState(false);
  const [isPreparingDraft, setIsPreparingDraft] = useState(false);
  const [isSavingPreview, setIsSavingPreview] = useState(false);
  const [showSavePreviewSuccess, setShowSavePreviewSuccess] = useState(false);
  const [isCreatingBacklog, setIsCreatingBacklog] = useState(false);
  const [threadNotice, setThreadNotice] = useState("");

  const hasAssistantResponse = messages.some((message) => message.role === "assistant");
  const trimmedDraft = draft.trim();
  const isPromptTooLong = draft.length > MAX_PROMPT_LENGTH;
  const canSend =
    backendConfigured &&
    agentContextReady &&
    Number.isInteger(workItemContext.workItemId) &&
    workItemContext.workItemId > 0 &&
    trimmedDraft.length > 0 &&
    !isPromptTooLong &&
    !isLoading &&
    !isMessagesLoading &&
    !isSwitchingThread &&
    !isCreatingThread;
  const canPrepareDraft =
    backendConfigured &&
    agentContextReady &&
    Number.isInteger(workItemContext.workItemId) &&
    workItemContext.workItemId > 0 &&
    hasAssistantResponse &&
    !isPreparingDraft &&
    !isSavingPreview &&
    !isLoading &&
    !isDraftLoading &&
    !isSwitchingThread &&
    !isCreatingThread;
  const canCreateBacklog =
    backendConfigured &&
    agentContextReady &&
    Number.isInteger(workItemContext.workItemId) &&
    workItemContext.workItemId > 0 &&
    Boolean(sketch?.root) &&
    !backlogItemsCreatedAt &&
    !isCreatingBacklog &&
    !isPreparingDraft &&
    !isSavingPreview &&
    !isDraftLoading &&
    !isSwitchingThread &&
    !isCreatingThread;
  const canRefreshPreview =
    Boolean(sketch?.root) &&
    !isSavingPreview &&
    !isCreatingBacklog &&
    !isPreparingDraft &&
    !isDraftLoading &&
    !isSwitchingThread &&
    !isCreatingThread;
  const canSavePreview =
    backendConfigured &&
    agentContextReady &&
    Number.isInteger(workItemContext.workItemId) &&
    workItemContext.workItemId > 0 &&
    Boolean(sketch?.root) &&
    !isSavingPreview &&
    !isCreatingBacklog &&
    !isPreparingDraft &&
    !isDraftLoading &&
    !isSwitchingThread &&
    !isCreatingThread;
  const canCreateNewThread =
    backendConfigured &&
    agentContextReady &&
    Number.isInteger(workItemContext.workItemId) &&
    workItemContext.workItemId > 0 &&
    !isLoading &&
    !isMessagesLoading &&
    !isDraftLoading &&
    !isPreparingDraft &&
    !isCreatingBacklog &&
    !isSwitchingThread &&
    !isCreatingThread;

  function normalizeContextCandidate(candidate) {
    const normalizedId = Number(candidate?.workItemId);
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
      return null;
    }

    return {
      workItemId: normalizedId,
      workItemType: String(candidate?.workItemType || "").trim() || null
    };
  }

  function mergeContext(currentContext, nextContext) {
    if (!nextContext) {
      return currentContext;
    }

    const mergedType =
      nextContext.workItemType ||
      (currentContext.workItemId === nextContext.workItemId ? currentContext.workItemType : null);

    if (
      currentContext.workItemId === nextContext.workItemId &&
      currentContext.workItemType === mergedType
    ) {
      return currentContext;
    }

    return {
      workItemId: nextContext.workItemId,
      workItemType: mergedType
    };
  }

  function setRequestError(requestError, fallbackMessage) {
    setError(normalizeRequestError(requestError, fallbackMessage));
  }

  useEffect(() => {
    if (!threadNotice) {
      return undefined;
    }

    const timerId = window.setTimeout(() => {
      setThreadNotice("");
    }, THREAD_NOTICE_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [threadNotice]);

  useEffect(() => {
    if (!showSavePreviewSuccess) {
      return undefined;
    }

    const timerId = window.setTimeout(() => {
      setShowSavePreviewSuccess(false);
    }, SAVE_PREVIEW_NOTICE_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [showSavePreviewSuccess]);

  useEffect(() => {
    let isCancelled = false;
    const unsubscribe = subscribeWorkItemHostContext((nextContext) => {
      const normalized = normalizeContextCandidate(nextContext);
      setWorkItemContext((currentContext) => mergeContext(currentContext, normalized));
    });

    async function loadContext() {
      setIsContextLoading(true);
      try {
        const resolved = await resolveWorkItemContext();
        if (isCancelled) {
          return;
        }

        const normalized = normalizeContextCandidate(resolved);
        setWorkItemContext((currentContext) => mergeContext(currentContext, normalized));
      } finally {
        if (!isCancelled) {
          setIsContextLoading(false);
        }
      }
    }

    loadContext();

    return () => {
      isCancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (
      isContextLoading ||
      (Number.isInteger(workItemContext.workItemId) && workItemContext.workItemId > 0)
    ) {
      return undefined;
    }

    let isCancelled = false;
    let attempts = 0;
    const retryTimer = window.setInterval(async () => {
      attempts += 1;
      if (attempts > 10) {
        window.clearInterval(retryTimer);
        return;
      }

      try {
        const resolved = await resolveWorkItemContext();
        if (isCancelled) {
          return;
        }

        const normalized = normalizeContextCandidate(resolved);
        if (normalized) {
          setWorkItemContext((currentContext) => mergeContext(currentContext, normalized));
          window.clearInterval(retryTimer);
        }
      } catch {
        // Keep retrying while context is unavailable.
      }
    }, 500);

    return () => {
      isCancelled = true;
      window.clearInterval(retryTimer);
    };
  }, [isContextLoading, workItemContext.workItemId]);

  async function loadThreads({ preferMostRecent = false } = {}) {
    if (
      !backendConfigured ||
      !agentContextReady ||
      !Number.isInteger(workItemContext.workItemId) ||
      workItemContext.workItemId <= 0
    ) {
      return {
        threads: [],
        activeConversationId: null
      };
    }

    const payload = await getWorkItemAssistantThreads({
      workItemId: workItemContext.workItemId,
      agentContext,
      workItemContext
    });
    const resolvedThreads = Array.isArray(payload?.threads) ? payload.threads : [];
    let selectedConversationId =
      payload?.activeConversationId || resolvedThreads[0]?.conversationId || null;

    const preferredConversationId =
      preferMostRecent && resolvedThreads.length > 0
        ? resolvedThreads[0].conversationId
        : selectedConversationId;

    if (preferredConversationId && preferredConversationId !== payload?.activeConversationId) {
      const activatePayload = await postWorkItemAssistantActivateThread({
        workItemId: workItemContext.workItemId,
        conversationId: preferredConversationId,
        agentContext,
        workItemContext
      });
      selectedConversationId = activatePayload?.activeConversationId || preferredConversationId;
    }

    setThreads(resolvedThreads);
    setActiveConversationId(selectedConversationId);

    return {
      threads: resolvedThreads,
      activeConversationId: selectedConversationId
    };
  }

  async function loadWorkspace({ preferMostRecentThread = false } = {}) {
    if (
      !backendConfigured ||
      !agentContextReady ||
      !Number.isInteger(workItemContext.workItemId) ||
      workItemContext.workItemId <= 0
    ) {
      return;
    }

    setIsThreadsLoading(true);
    setIsMessagesLoading(true);
    setIsDraftLoading(true);
    try {
      const threadState = await loadThreads({ preferMostRecent: preferMostRecentThread });
      if (!threadState.activeConversationId) {
        setMessages([]);
        setSketch(null);
        setBacklogItemsCreatedAt(null);
        setSketchWarnings([]);
        setExpandedSketchNodes({});
        return;
      }

      const [messagesPayload, draftPayload] = await Promise.all([
        getWorkItemAssistantMessages({
          workItemId: workItemContext.workItemId,
          agentContext,
          workItemContext
        }),
        getWorkItemAssistantDraft({
          workItemId: workItemContext.workItemId,
          agentContext,
          workItemContext
        })
      ]);

      setMessages(normalizeAgentMessages(messagesPayload?.messages));
      const normalizedSketch = normalizeWorkItemSketch(draftPayload?.sketch);
      setSketch(normalizedSketch);
      setBacklogItemsCreatedAt(draftPayload?.backlogItemsCreatedAt || null);
      setSketchWarnings(normalizedSketch ? validateWorkItemSketch(normalizedSketch) : []);
      if (normalizedSketch?.root?.id) {
        setExpandedSketchNodes({ [normalizedSketch.root.id]: true });
      } else {
        setExpandedSketchNodes({});
      }
    } catch (requestError) {
      setRequestError(requestError, "Failed to load work item assistant context.");
    } finally {
      setIsThreadsLoading(false);
      setIsMessagesLoading(false);
      setIsDraftLoading(false);
    }
  }

  useEffect(() => {
    if (
      !backendConfigured ||
      !agentContextReady ||
      !Number.isInteger(workItemContext.workItemId) ||
      workItemContext.workItemId <= 0
    ) {
      return;
    }

    setThreadNotice("");
    setWorkspaceTab("discussion");
    setThreads([]);
    setActiveConversationId(null);
    setBacklogItemsCreatedAt(null);
    loadWorkspace({ preferMostRecentThread: true });
  }, [backendConfigured, agentContextReady, workItemContext.workItemId]);

  async function refreshThreadList() {
    try {
      await loadThreads();
    } catch {
      // Do not fail main flow if thread list refresh fails.
    }
  }

  async function createNewThread() {
    if (!canCreateNewThread) {
      return;
    }

    setError(null);
    setIsCreatingThread(true);
    try {
      const payload = await postWorkItemAssistantNewThread({
        workItemId: workItemContext.workItemId,
        agentContext,
        workItemContext
      });

      setThreads(Array.isArray(payload?.threads) ? payload.threads : []);
      setActiveConversationId(payload?.activeConversationId || null);
      setMessages([]);
      setSketch(null);
      setBacklogItemsCreatedAt(null);
      setSketchWarnings([]);
      setExpandedSketchNodes({});
      setCreateResult(null);
      setDraft("");
      setWorkspaceTab("discussion");
      setThreadNotice(NEW_THREAD_NOTICE_TEXT);
    } catch (requestError) {
      setRequestError(requestError, "Failed to create a new thread.");
    } finally {
      setIsCreatingThread(false);
    }
  }

  async function selectThread(conversationId) {
    if (
      !conversationId ||
      !backendConfigured ||
      !agentContextReady ||
      !Number.isInteger(workItemContext.workItemId) ||
      workItemContext.workItemId <= 0 ||
      isSwitchingThread ||
      conversationId === activeConversationId
    ) {
      return;
    }

    setError(null);
    setIsSwitchingThread(true);
    setIsMessagesLoading(true);
    setIsDraftLoading(true);
    try {
      await postWorkItemAssistantActivateThread({
        workItemId: workItemContext.workItemId,
        conversationId,
        agentContext,
        workItemContext
      });

      setActiveConversationId(conversationId);
      const [messagesPayload, draftPayload, threadsPayload] = await Promise.all([
        getWorkItemAssistantMessages({
          workItemId: workItemContext.workItemId,
          agentContext,
          workItemContext
        }),
        getWorkItemAssistantDraft({
          workItemId: workItemContext.workItemId,
          agentContext,
          workItemContext
        }),
        getWorkItemAssistantThreads({
          workItemId: workItemContext.workItemId,
          agentContext,
          workItemContext
        })
      ]);

      setMessages(normalizeAgentMessages(messagesPayload?.messages));
      const normalizedSketch = normalizeWorkItemSketch(draftPayload?.sketch);
      setSketch(normalizedSketch);
      setBacklogItemsCreatedAt(draftPayload?.backlogItemsCreatedAt || null);
      setSketchWarnings(normalizedSketch ? validateWorkItemSketch(normalizedSketch) : []);
      if (normalizedSketch?.root?.id) {
        setExpandedSketchNodes({ [normalizedSketch.root.id]: true });
      } else {
        setExpandedSketchNodes({});
      }

      const resolvedThreads = Array.isArray(threadsPayload?.threads) ? threadsPayload.threads : [];
      setThreads(resolvedThreads);
      setActiveConversationId(threadsPayload?.activeConversationId || conversationId);
      setWorkspaceTab("discussion");
      setCreateResult(null);
    } catch (requestError) {
      setRequestError(requestError, "Failed to switch thread.");
    } finally {
      setIsSwitchingThread(false);
      setIsMessagesLoading(false);
      setIsDraftLoading(false);
    }
  }

  async function sendMessage() {
    if (!canSend) {
      return;
    }

    setError(null);
    setIsLoading(true);
    setDraft("");
    try {
      const payload = await postWorkItemAssistantMessage({
        workItemId: workItemContext.workItemId,
        message: trimmedDraft,
        agentContext,
        workItemContext
      });
      setMessages(normalizeAgentMessages(payload?.messages));
      setActiveConversationId(payload?.session?.conversationId || activeConversationId);
      setCreateResult(null);
      await refreshThreadList();
    } catch (requestError) {
      setRequestError(requestError, "Request failed.");
    } finally {
      setIsLoading(false);
    }
  }

  async function prepareDraftItems() {
    if (!canPrepareDraft) {
      return;
    }

    setError(null);
    setIsPreparingDraft(true);
    setWorkspaceTab("preview");
    setCreateResult(null);
    try {
      const payload = await postWorkItemAssistantPrepareDraft({
        workItemId: workItemContext.workItemId,
        agentContext,
        workItemContext
      });

      const normalizedSketch = normalizeWorkItemSketch(payload?.sketch);
      setSketch(normalizedSketch);
      setBacklogItemsCreatedAt(payload?.backlogItemsCreatedAt || null);
      setSketchWarnings(normalizedSketch ? validateWorkItemSketch(normalizedSketch) : []);
      if (normalizedSketch?.root?.id) {
        setExpandedSketchNodes({ [normalizedSketch.root.id]: true });
      }
      await refreshThreadList();
    } catch (requestError) {
      setRequestError(requestError, "Prepare Draft Items failed.");
    } finally {
      setIsPreparingDraft(false);
    }
  }

  async function createBacklogItems() {
    if (!canCreateBacklog || !sketch) {
      return;
    }

    setError(null);
    setIsCreatingBacklog(true);
    try {
      const payload = await postWorkItemAssistantCreateBacklog({
        workItemId: workItemContext.workItemId,
        sketch,
        agentContext,
        workItemContext
      });
      setCreateResult(payload?.result || null);
      setBacklogItemsCreatedAt(payload?.backlogItemsCreatedAt || new Date().toISOString());
      await refreshThreadList();
    } catch (requestError) {
      setRequestError(requestError, "Backlog creation failed.");
    } finally {
      setIsCreatingBacklog(false);
    }
  }

  async function savePreview() {
    if (!canSavePreview || !sketch) {
      return;
    }

    setError(null);
    setCreateResult(null);
    setShowSavePreviewSuccess(false);
    setIsSavingPreview(true);
    try {
      const payload = await postWorkItemAssistantSaveDraft({
        workItemId: workItemContext.workItemId,
        sketch,
        agentContext,
        workItemContext
      });
      const normalizedSketch = normalizeWorkItemSketch(payload?.sketch);
      setSketch(normalizedSketch);
      setBacklogItemsCreatedAt(payload?.backlogItemsCreatedAt || null);
      setSketchWarnings(normalizedSketch ? validateWorkItemSketch(normalizedSketch) : []);
      setShowSavePreviewSuccess(true);
      await refreshThreadList();
    } catch (requestError) {
      setRequestError(requestError, "Save Preview failed.");
    } finally {
      setIsSavingPreview(false);
    }
  }

  function refreshPreview() {
    setCreateResult(null);
    setSketch(null);
    setBacklogItemsCreatedAt(null);
    setSketchWarnings([]);
    setExpandedSketchNodes({});
    setWorkspaceTab("discussion");
  }

  function toggleSketchNode(nodeId) {
    setExpandedSketchNodes((current) => ({
      ...current,
      [nodeId]: !current[nodeId]
    }));
  }

  function updateSketchNodeField(nodeId, fieldName, nextValue) {
    setCreateResult(null);
    setSketch((current) => {
      if (!current) {
        return current;
      }

      const updated = updateWorkItemSketchNode(current, nodeId, (node) => ({
        ...node,
        [fieldName]:
          fieldName === "acceptanceCriteria"
            ? String(nextValue)
                .split(/\r?\n/)
                .map((item) => item.trim())
                .filter(Boolean)
            : fieldName === "originalEstimate"
              ? (() => {
                  const numericValue = Number(nextValue);
                  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
                })()
              : nextValue
      }));
      setSketchWarnings(validateWorkItemSketch(updated));
      return updated;
    });
  }

  function deleteSketchNode(nodeId) {
    setCreateResult(null);
    setSketch((current) => {
      if (!current) {
        return current;
      }

      const updated = deleteWorkItemSketchNode(current, nodeId);
      setSketchWarnings(validateWorkItemSketch(updated));
      return updated;
    });
    setExpandedSketchNodes((current) => {
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
  }

  function onInputKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="layout-shell workitem-layout-shell">
      <main className="chat-page workitem-chat-page">
        {!backendConfigured && (
          <div className="warning-banner">
            Configure <code>{backendConfigHint()}</code> to enable requests.
          </div>
        )}

        {backendConfigured && !agentContextReady && (
          <div className="warning-banner">
            Assistant mode requires user/project context. Set <code>VITE_AGENT_LOCAL_USER_ID</code> and{" "}
            <code>VITE_AGENT_LOCAL_PROJECT_ID</code> for local testing.
          </div>
        )}

        <WorkItemBacklogPreviewPanel
          activeTab={workspaceTab}
          onChangeTab={setWorkspaceTab}
          threads={threads}
          activeConversationId={activeConversationId}
          isThreadsLoading={isThreadsLoading}
          onSelectThread={selectThread}
          sketch={sketch}
          sketchWarnings={sketchWarnings}
          isDraftLoading={isDraftLoading}
          isPreparingDraft={isPreparingDraft}
          isSavingPreview={isSavingPreview}
          showSavePreviewSuccess={showSavePreviewSuccess}
          isCreatingBacklog={isCreatingBacklog}
          backlogItemsCreatedAt={backlogItemsCreatedAt}
          canCreateBacklog={canCreateBacklog}
          onCreateBacklog={createBacklogItems}
          canRefreshPreview={canRefreshPreview}
          onRefreshPreview={refreshPreview}
          canSavePreview={canSavePreview}
          onSavePreview={savePreview}
          createBacklogResult={createResult}
          expandedNodes={expandedSketchNodes}
          onToggleNode={toggleSketchNode}
          onUpdateNodeField={updateSketchNodeField}
          onDeleteNode={deleteSketchNode}
        />

        {threadNotice && <div className="thread-notice">{threadNotice}</div>}

        {workspaceTab === "discussion" && (
          <>
            <ConversationTranscript
              isAgentMode={true}
              isHistoryLoading={false}
              isMessagesLoading={isMessagesLoading}
              isLoading={isLoading}
              requestMode="agent"
              activeConversationId={activeConversationId}
              agentMessages={messages}
              showEmptyConversationHint={false}
              showSummarizeButton={false}
              canSummarize={false}
              isSummarizing={false}
              onSummarize={() => {}}
              footerAction={{
                visible: hasAssistantResponse,
                disabled: !canPrepareDraft,
                isLoading: isPreparingDraft,
                label: "Prepare Draft Items",
                loadingLabel: "Preparing Draft...",
                onClick: prepareDraftItems,
                className: "summarize-button"
              }}
              secondaryFooterAction={{
                visible: true,
                disabled: !canCreateNewThread,
                isLoading: isCreatingThread,
                label: "New Thread",
                loadingLabel: "Creating Thread...",
                onClick: createNewThread,
                className: "summarize-button thread-button"
              }}
            />

            <section className="composer">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Type your message to the assistant..."
                rows={4}
                disabled={isLoading || isPreparingDraft || !backendConfigured}
                maxLength={MAX_PROMPT_LENGTH + 1}
              />
              <div className="composer-actions">
                <span className={isPromptTooLong ? "char-count over-limit" : "char-count"}>
                  {draft.length}/{MAX_PROMPT_LENGTH}
                </span>
                <div className="composer-buttons">
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={sendMessage}
                    disabled={!canSend}
                  >
                    Send to Agent
                  </button>
                </div>
              </div>
            </section>
          </>
        )}

        {error && (
          <aside className="error-panel" role="alert">
            <strong>Request failed.</strong> {error.message}
            {error.requestId && <div>requestId: {error.requestId}</div>}
          </aside>
        )}
      </main>
    </div>
  );
}
