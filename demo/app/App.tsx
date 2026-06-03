import { useEffect, useRef, useState } from "react";

const initialMessages = [
  {
    id: "message-001",
    author: "Assistant",
    text: "Welcome to the barebones chat demo.",
  },
  {
    id: "message-002",
    author: "User",
    text: "What can this demo show?",
  },
  {
    id: "message-003",
    author: "Assistant",
    text: "It can show clicking, typing, hovering, and scrolling.",
  },
  {
    id: "message-004",
    author: "User",
    text: "Keep the UI plain and reliable.",
  },
  {
    id: "message-005",
    author: "Assistant",
    text: "The layout uses simple borders, native controls, and deterministic copy.",
  },
  {
    id: "message-006",
    author: "Assistant",
    text: "Final checklist: validate, script, capture, compose.",
  },
];

type Message = (typeof initialMessages)[number];

export function App() {
  const [status, setStatus] = useState("Saved chat loaded");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [hoverHintVisible, setHoverHintVisible] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      return;
    }

    transcript.scrollTop = transcript.scrollHeight;
  });

  function startNewChat() {
    setStatus("New chat ready");
    setMessage("");
    setMessages([]);
  }

  function loadLaunchPlanChat() {
    setStatus("Saved chat loaded");
    setMessage("");
    setMessages(initialMessages);
  }

  function sendMessage() {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      return;
    }

    setMessages((currentMessages) => [
      ...currentMessages,
      {
        id: `message-${currentMessages.length + 1}-user`,
        author: "User",
        text: trimmedMessage,
      },
      {
        id: `message-${currentMessages.length + 1}-assistant`,
        author: "Assistant",
        text: "Demo reply: here is a simple launch plan.",
      },
    ]);
    setMessage("");
    setStatus("Message sent");
  }

  return (
    <main className="app-shell">
      <section className="panel">
        <h1>Barebones Chat</h1>
        <p>Status: {status}</p>
        <button type="button" onClick={startNewChat}>
          New chat
        </button>
      </section>

      <section className="layout" aria-label="Chat workspace">
        <aside className="panel sidebar" aria-label="Saved chats">
          <h2>Saved chats</h2>
          <button
            type="button"
            onMouseEnter={() => setHoverHintVisible(true)}
            onMouseLeave={() => setHoverHintVisible(false)}
            onClick={loadLaunchPlanChat}
          >
            Launch Plan Chat
          </button>
          {hoverHintVisible ? <p>Open saved launch plan</p> : null}
        </aside>

        <section className="panel chat-panel" aria-label="Current chat">
          <h2>Conversation</h2>
          <div
            aria-label="Conversation transcript"
            className="transcript"
            ref={transcriptRef}
            role="log"
          >
            {messages.length === 0 ? <p>No messages yet</p> : null}
            {messages.map((chatMessage) => {
              return (
                <article className="message" key={chatMessage.id}>
                  <strong>{chatMessage.author}</strong>
                  <p>{chatMessage.text}</p>
                </article>
              );
            })}
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              sendMessage();
            }}
          >
            <label>
              Message
              <input
                aria-label="Message"
                value={message}
                onChange={(event) => setMessage(event.currentTarget.value)}
              />
            </label>
            <button type="submit">Send</button>
          </form>
        </section>
      </section>
    </main>
  );
}
