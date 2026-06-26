// --- tab switching (generic; later steps add the buttons/panels) ---
const tabs = document.querySelectorAll("#tabs button");
const panels = document.querySelectorAll(".panel");
tabs.forEach((btn) =>
  btn.addEventListener("click", () => {
    tabs.forEach((b) => b.classList.toggle("active", b === btn));
    panels.forEach((p) => p.classList.toggle("active", p.id === btn.dataset.tab));
  }),
);

// --- header status line: ingested counts ---
async function loadStats() {
  const stats = await (await fetch("/api/stats")).json();
  document.getElementById("stats").textContent = Object.entries(stats)
    .map(([name, count]) => `${count} ${name}`)
    .join("  ·  ");
}
loadStats();

// --- QUERY tab: NL -> pipeline + raw results ---
const queryForm = document.getElementById("query-form");
const queryPlan = document.getElementById("query-plan");
const queryRows = document.getElementById("query-rows");
const queryMeta = document.getElementById("query-meta");

queryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = document.getElementById("query-input").value.trim();
  if (!question) return;
  queryPlan.textContent = "…";
  queryRows.textContent = "";
  queryMeta.textContent = "";
  const outcome = await (await fetch("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  })).json();

  queryPlan.textContent = outcome.plan
    ? `${outcome.plan.collection}\n${JSON.stringify(outcome.plan.pipeline, null, 2)}`
    : "(no plan)";
  const typeLabel = outcome.type.replace(/([a-z])([A-Z])/g, "$1 $2"); // "NotImplemented" -> "Not Implemented"
  queryMeta.textContent = `${typeLabel}${outcome.attempts ? ` · ${outcome.attempts} attempt(s)` : ""}`;
  if (outcome.type === "Success") queryRows.textContent = JSON.stringify(outcome.rows, null, 2);
  else if (outcome.type === "NoResults") queryRows.textContent = "No matching documents.";
  else if (outcome.type === "MaxAttemptsExceeded") queryRows.textContent = outcome.errors.join("\n");
  else if (outcome.type === "NotImplemented") queryRows.textContent = outcome.message;
  else queryRows.textContent = outcome.reason ?? "";
});

// --- QUERY tab: discovered schema disclosure (lazy-loaded on first open) ---
const schemaDisclosure = document.getElementById("schema-disclosure");
const schemaBody = document.getElementById("schema-body");
let schemaLoaded = false;
schemaDisclosure?.addEventListener("toggle", async () => {
  if (!schemaDisclosure.open || schemaLoaded) return;
  schemaLoaded = true;
  try {
    schemaBody.textContent = await (await fetch("/api/schema")).text();
  } catch {
    schemaLoaded = false; // allow a retry on next open
    schemaBody.textContent = "Failed to load schema.";
  }
});

// --- CHAT tab: streamed agent loop ---
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatLog = document.getElementById("chat-log");
const history = []; // Anthropic message params

// Start fresh: wipe the transcript and the conversation context sent to the model.
document.getElementById("chat-clear").addEventListener("click", () => {
  history.length = 0;
  chatLog.innerHTML = "";
  chatInput.focus();
});

function addMsg(who, cls) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${cls}`;
  wrap.innerHTML = `<div class="who">${who}</div><div class="bubble"></div>`;
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
  return wrap.querySelector(".bubble");
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  const sendBtn = chatForm.querySelector("button");
  sendBtn.disabled = true;
  addMsg("you", "user").textContent = text;
  history.push({ role: "user", content: text });

  const assistantBubble = addMsg("assistant", "assistant");
  const msgEl = assistantBubble.parentElement;
  let answer = "";
  let lastWasThinking = false; // detect the start of a new thinking block
  let currentThink = null; // the persistent thinking block currently streaming
  let lastToolPre = null; // the <pre> of the most recent tool line, filled on its result

  // Status indicator (dots + label) for the non-thinking phases. Thinking gets its
  // own persistent block, so we hide the ticker while it streams.
  const status = document.createElement("div");
  status.className = "status";
  status.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span class="slabel"></span>`;
  const slabel = status.querySelector(".slabel");
  const setStatus = (label) => {
    if (label === null) {
      status.remove();
      return;
    }
    slabel.textContent = label;
    msgEl.appendChild(status); // keep it at the bottom of the message
    chatLog.scrollTop = chatLog.scrollHeight;
  };
  setStatus("Thinking…");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const chunk of events) {
        const line = chunk.replace(/^data: /, "").trim();
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "thinking") {
          if (!lastWasThinking) {
            // new thinking block — freeze the previous one, start a fresh persistent block
            if (currentThink) currentThink.classList.remove("active");
            currentThink = document.createElement("div");
            currentThink.className = "thinking active";
            msgEl.insertBefore(currentThink, assistantBubble);
            setStatus(null); // the live thinking block is the indicator now
          }
          currentThink.textContent += ev.text;
        } else if (ev.type === "tool_call") {
          const d = document.createElement("details");
          d.className = "tool";
          const sm = document.createElement("summary");
          sm.innerHTML = `🔧 querying: <span class="q"></span>`;
          sm.querySelector(".q").textContent = ev.question;
          const pre = document.createElement("pre");
          pre.className = "toolq";
          pre.textContent = "(synthesizing…)";
          d.append(sm, pre);
          msgEl.insertBefore(d, assistantBubble);
          lastToolPre = pre;
          setStatus("Running query…");
        } else if (ev.type === "tool_result") {
          if (lastToolPre) {
            lastToolPre.textContent = ev.plan
              ? `${ev.plan.collection}\n${JSON.stringify(ev.plan.pipeline, null, 2)}`
              : "(no query synthesized)";
          }
          setStatus("Reading results…");
        } else if (ev.type === "note") {
          // interim narration ("Let me search…") — a distinct block, not the answer
          const n = document.createElement("div");
          n.className = "note";
          n.textContent = ev.text;
          msgEl.insertBefore(n, assistantBubble);
        } else if (ev.type === "answer") {
          answer += ev.text;
          assistantBubble.innerHTML = marked.parse(answer); // render rich markdown
          setStatus("Writing…");
        } else if (ev.type === "error") {
          assistantBubble.textContent = `Error: ${ev.message}`;
        }
        if (ev.type !== "thinking" && currentThink) currentThink.classList.remove("active"); // freeze shimmer
        lastWasThinking = ev.type === "thinking";
        chatLog.scrollTop = chatLog.scrollHeight;
      }
    }
  } finally {
    if (currentThink) currentThink.classList.remove("active");
    status.remove();
    sendBtn.disabled = false;
  }
  if (answer) history.push({ role: "assistant", content: answer });
});
