import type {
  ConversationMessageReactions,
  UserType,
  WorkspaceType,
} from "@dust-tt/types";
import React from "react";

import { AgentMessage } from "@app/components/assistant/conversation/AgentMessage";
import type { MessageWithContentFragmentsType } from "@app/components/assistant/conversation/ConversationViewer";
import { UserMessage } from "@app/components/assistant/conversation/UserMessage";

interface MessageItemProps {
  conversationId: string;
  hideReactions: boolean;
  isInModal: boolean;
  isLastMessage: boolean;
  latestMentions: string[];
  message: MessageWithContentFragmentsType;
  owner: WorkspaceType;
  reactions: ConversationMessageReactions;
  user: UserType;
}

const MessageItem = React.forwardRef<HTMLDivElement, MessageItemProps>(
  function MessageItem(
    {
      conversationId,
      hideReactions,
      isInModal,
      isLastMessage,
      latestMentions,
      message,
      owner,
      reactions,
      user,
    }: MessageItemProps,
    ref
  ) {
    const { sId, type } = message;

    const convoReactions = reactions.find((r) => r.messageId === sId);
    const messageReactions = convoReactions?.reactions || [];

    if (message.visibility === "deleted") {
      return null;
    }

    switch (type) {
      case "user_message":
        return (
          <div key={`message-id-${sId}`} ref={ref}>
            <UserMessage
              conversationId={conversationId}
              hideReactions={hideReactions}
              isLastMessage={isLastMessage}
              latestMentions={latestMentions}
              message={message}
              owner={owner}
              reactions={messageReactions}
              user={user}
              contentFragments={message.contenFragments}
              size={isInModal ? "compact" : "normal"}
            />
          </div>
        );

      case "agent_message":
        return (
          <div key={`message-id-${sId}`} ref={ref}>
            <AgentMessage
              message={message}
              owner={owner}
              user={user}
              conversationId={conversationId}
              reactions={messageReactions}
              isInModal={isInModal}
              hideReactions={hideReactions}
              size={isInModal ? "compact" : "normal"}
            />
          </div>
        );

      default:
        console.error("Unknown message type", message);
    }
  }
);

export default MessageItem;
