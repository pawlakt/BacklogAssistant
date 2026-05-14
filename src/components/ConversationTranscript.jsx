import React from "react";
import ReactMarkdown from "react-markdown";
import ProgressBlock from "./ProgressBlock";

export default function ConversationTranscript({
  isAgentMode,
  isHistoryLoading,
  isMessagesLoading,
  isLoading,
  requestMode,
  activeConversationId,
  agentMessages,
  showEmptyConversationHint = true,
  showSummarizeButton,
  canSummarize,
  isSummarizing,
  onSummarize,
  footerAction = null,
  secondaryFooterAction = null
}) {
  const resolvedFooterAction = footerAction || {
    visible: showSummarizeButton,
    disabled: !canSummarize,
    isLoading: isSummarizing,
    label: "Summarize",
    loadingLabel: "Summarizing...",
    onClick: onSummarize
  };

  return (
    <section className="transcript" aria-live="polite">
      {isAgentMode && (
        <>
          {showEmptyConversationHint &&
            !isMessagesLoading &&
            !isLoading &&
            !activeConversationId &&
            !isHistoryLoading && (
            <p className="empty-transcript">Create a conversation from the left panel to get started.</p>
          )}

          {isMessagesLoading && (
            <ProgressBlock
              title="Loading conversation..."
              subtitle="Fetching persisted thread messages."
            />
          )}

          {activeConversationId && !isMessagesLoading && agentMessages.length === 0 && !isLoading && (
            <p className="empty-transcript">
              No messages yet. Send the first prompt to start this discussion.
            </p>
          )}

          {!isMessagesLoading &&
            agentMessages.map((message) => (
              <article
                key={message.id}
                className={
                  message.role === "assistant" ? "agent-message assistant" : "agent-message user"
                }
              >
                <h2>
                  {message.role === "assistant"
                    ? "Assistant"
                    : message.authorDisplayName || "You"}
                </h2>
                <div className="agent-message-markdown">
                  <ReactMarkdown>{message.content}</ReactMarkdown>
                </div>
              </article>
            ))}

          {isLoading && requestMode === "agent" && (
            <ProgressBlock
              title="Agent is responding..."
              subtitle="Using conversation context from the active thread."
            />
          )}

          {resolvedFooterAction?.visible && (
            <div className="transcript-footer">
              {secondaryFooterAction?.visible && (
                <button
                  type="button"
                  className={secondaryFooterAction.className || "summarize-button"}
                  onClick={secondaryFooterAction.onClick}
                  disabled={secondaryFooterAction.disabled}
                >
                  {secondaryFooterAction.isLoading
                    ? secondaryFooterAction.loadingLabel || "Working..."
                    : secondaryFooterAction.label || "Action"}
                </button>
              )}
              <button
                type="button"
                className={resolvedFooterAction.className || "summarize-button"}
                onClick={resolvedFooterAction.onClick}
                disabled={resolvedFooterAction.disabled}
              >
                {resolvedFooterAction.isLoading
                  ? resolvedFooterAction.loadingLabel || "Working..."
                  : resolvedFooterAction.label || "Action"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
