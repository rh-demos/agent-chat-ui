const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const stopButton = document.getElementById('stopButton');
const resetButton = document.getElementById('resetButton');
const modelSelect = document.getElementById('modelSelect');

// Active stream reader – set during streaming so Stop can cancel it
let activeReader = null;
let streamStopped = false;
let selectedModel = '';

const welcomeHTML =
    '<div class="message bot-message">' +
        '<div class="message-content">' +
            '<p>Hello! I\'m your AI assistant. I can help you with:</p>' +
            '<ul>' +
                '<li>Finding customer information</li>' +
                '<li>Looking up orders</li>' +
                '<li>Checking invoices</li>' +
                '<li>Answering general questions</li>' +
            '</ul>' +
            '<p>What would you like to know?</p>' +
        '</div>' +
    '</div>';

// ── Model loading ────────────────────────────────────────────────────

async function loadModels() {
    try {
        const response = await fetch('/api/models');
        if (!response.ok) throw new Error('Failed to fetch models');
        const data = await response.json();

        modelSelect.innerHTML = '';

        if (!data.models || data.models.length === 0) {
            modelSelect.innerHTML = '<option value="">No models available</option>';
            return;
        }

        // Sort: default model first, then alphabetically
        const models = data.models.sort((a, b) => {
            if (a.identifier === data.default_model) return -1;
            if (b.identifier === data.default_model) return 1;
            return a.identifier.localeCompare(b.identifier);
        });

        models.forEach(m => {
            const option = document.createElement('option');
            option.value = m.identifier;
            option.textContent = m.identifier;
            if (m.identifier === data.default_model) {
                option.textContent += ' (default)';
            }
            modelSelect.appendChild(option);
        });

        // Restore previously selected model from localStorage, or use first (default)
        const saved = localStorage.getItem('selectedModel');
        if (saved && models.some(m => m.identifier === saved)) {
            modelSelect.value = saved;
            selectedModel = saved;
        } else {
            selectedModel = models[0].identifier;
            modelSelect.value = selectedModel;
        }
    } catch (e) {
        console.error('Failed to load models:', e);
        modelSelect.innerHTML = '<option value="">Failed to load models</option>';
    }
}

modelSelect.addEventListener('change', () => {
    const newModel = modelSelect.value;
    if (newModel === selectedModel) return;

    selectedModel = newModel;
    localStorage.setItem('selectedModel', selectedModel);

    // Cancel any active stream
    if (activeReader) {
        activeReader.cancel();
        activeReader = null;
    }

    // Clear conversation and show model-switch notice
    chatMessages.innerHTML = welcomeHTML;
    const noticeDiv = document.createElement('div');
    noticeDiv.className = 'message bot-message';
    noticeDiv.innerHTML =
        `<div class="message-content"><em>Switched to model: <strong>${escapeHtml(selectedModel)}</strong>. Conversation has been reset.</em></div>`;
    chatMessages.appendChild(noticeDiv);
    scrollToBottom();

    // Reset input state
    messageInput.disabled = false;
    messageInput.value = '';
    stopButton.style.display = 'none';
    sendButton.style.display = '';
    messageInput.focus();
});

loadModels();

// ── Multi-round thinking parser ──────────────────────────────────────

function parseThinking(fullText) {
    const segments = [];
    let remaining = fullText;
    let isThinking = false;
    let thinkingRound = 0;

    while (remaining.length > 0) {
        const startIdx = remaining.indexOf('<think>');

        if (startIdx === -1) {
            // No more <think> tags – everything left is response
            if (remaining) segments.push({ type: 'response', content: remaining });
            break;
        }

        // Response text before <think>
        if (startIdx > 0) {
            segments.push({ type: 'response', content: remaining.substring(0, startIdx) });
        }

        remaining = remaining.substring(startIdx + 7); // skip '<think>'
        thinkingRound++;

        const endIdx = remaining.indexOf('</think>');

        if (endIdx === -1) {
            // No closing tag yet – still thinking
            segments.push({ type: 'thinking', content: remaining, round: thinkingRound });
            isThinking = true;
            remaining = '';
        } else {
            segments.push({ type: 'thinking', content: remaining.substring(0, endIdx), round: thinkingRound });
            remaining = remaining.substring(endIdx + 8); // skip '</think>'
        }
    }

    return { segments, isThinking, hasThinking: thinkingRound > 0, thinkingCount: thinkingRound };
}

// ── Streaming context ────────────────────────────────────────────────

function createStreamingContext() {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message bot-message';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content streaming';
    messageDiv.appendChild(contentDiv);
    chatMessages.appendChild(messageDiv);
    scrollToBottom();

    return { messageDiv, contentDiv, segments: [] };
}

// ── Thinking block DOM factory ───────────────────────────────────────

function createThinkingBlockElement() {
    const block = document.createElement('div');
    block.className = 'thinking-block active';

    const header = document.createElement('div');
    header.className = 'thinking-header';
    header.addEventListener('click', () => block.classList.toggle('collapsed'));

    const icon = document.createElement('span');
    icon.className = 'thinking-icon';

    const label = document.createElement('span');
    label.className = 'thinking-label';
    label.textContent = 'Thinking...';

    const toggle = document.createElement('span');
    toggle.className = 'thinking-toggle';

    header.append(icon, label, toggle);

    const collapse = document.createElement('div');
    collapse.className = 'thinking-collapse';

    const body = document.createElement('div');
    body.className = 'thinking-body';
    collapse.appendChild(body);

    block.append(header, collapse);

    const startTime = Date.now();
    const timer = setInterval(() => {
        const sec = Math.round((Date.now() - startTime) / 1000);
        label.textContent = `Thinking... ${sec}s`;
    }, 1000);

    return { type: 'thinking', el: block, bodyEl: body, labelEl: label, startTime, timer, done: false };
}

// ── Segment reconciliation ───────────────────────────────────────────
// Makes sure the rendered DOM segments match the parsed segment structure.
// Segments only grow; the only mutation is the *last* segment may change
// type when a partial `<think` tag completes.

function reconcileSegments(ctx, parsed) {
    // Handle last-segment type change (partial tag completed)
    if (ctx.segments.length > 0 && parsed.segments.length >= ctx.segments.length) {
        const checkIdx = ctx.segments.length - 1;
        const rendered = ctx.segments[checkIdx];
        const target = parsed.segments[checkIdx];

        if (rendered.type !== target.type) {
            // Remove the old element (and anything after it, though normally nothing)
            for (let j = checkIdx; j < ctx.segments.length; j++) {
                const s = ctx.segments[j];
                if (s.timer) clearInterval(s.timer);
                s.el.remove();
            }
            ctx.segments.length = checkIdx;
        }
    }

    // Append new segment DOM elements as needed
    while (ctx.segments.length < parsed.segments.length) {
        const idx = ctx.segments.length;
        const seg = parsed.segments[idx];
        let rendered;

        if (seg.type === 'thinking') {
            rendered = createThinkingBlockElement();
        } else {
            const el = document.createElement('div');
            el.className = 'response-text';
            rendered = { type: 'response', el };
        }

        ctx.contentDiv.appendChild(rendered.el);
        ctx.segments.push(rendered);
    }
}

// ── Update streaming content (called on every token) ─────────────────

function updateStreamingContent(ctx, fullText) {
    const parsed = parseThinking(fullText);

    // Fallback: no segments at all (empty text so far)
    if (parsed.segments.length === 0) {
        ctx.contentDiv.innerHTML = '<span class="streaming-cursor"></span>';
        scrollToBottom();
        return;
    }

    reconcileSegments(ctx, parsed);

    parsed.segments.forEach((seg, i) => {
        const rendered = ctx.segments[i];
        if (!rendered) return;
        const isLast = i === parsed.segments.length - 1;

        if (seg.type === 'thinking') {
            // Body content + cursor while still thinking
            const cursor = (isLast && parsed.isThinking) ? '<span class="streaming-cursor"></span>' : '';
            rendered.bodyEl.innerHTML = (seg.content ? formatMessage(seg.content) : '') + cursor;

            if (isLast && parsed.isThinking) {
                // Still active
                rendered.el.classList.add('active');
                rendered.el.classList.remove('collapsed');
            } else if (!rendered.done) {
                // Just completed
                rendered.done = true;
                clearInterval(rendered.timer);
                const duration = Math.round((Date.now() - rendered.startTime) / 1000);
                rendered.labelEl.textContent = `Thought for ${duration} seconds`;
                rendered.el.classList.remove('active');
                rendered.el.classList.add('collapsed');
            }
        } else {
            // Response segment
            const cursor = isLast ? '<span class="streaming-cursor"></span>' : '';
            rendered.el.innerHTML = seg.content
                ? formatMessage(seg.content) + cursor
                : cursor;
        }
    });

    scrollToBottom();
}

// ── Finalize streaming message ───────────────────────────────────────

function finalizeStreamingContent(ctx, fullText) {
    // Clear all timers
    ctx.segments.forEach(s => { if (s.timer) clearInterval(s.timer); });

    const parsed = parseThinking(fullText);

    if (parsed.segments.length === 0) {
        ctx.contentDiv.innerHTML = formatMessage(fullText || 'No response received');
        ctx.contentDiv.classList.remove('streaming');
        scrollToBottom();
        return;
    }

    // Make sure DOM is up to date
    reconcileSegments(ctx, parsed);

    parsed.segments.forEach((seg, i) => {
        const rendered = ctx.segments[i];
        if (!rendered) return;

        if (seg.type === 'thinking') {
            if (!rendered.done) {
                rendered.done = true;
                const duration = rendered.startTime
                    ? Math.round((Date.now() - rendered.startTime) / 1000)
                    : 0;
                rendered.labelEl.textContent = `Thought for ${duration} seconds`;
                rendered.el.classList.remove('active');
                rendered.el.classList.add('collapsed');
            }
            rendered.bodyEl.innerHTML = formatMessage(seg.content || '');
        } else {
            rendered.el.innerHTML = formatMessage(seg.content || '');
        }
    });

    ctx.contentDiv.classList.remove('streaming');
    scrollToBottom();
}

// ── Basic helpers ────────────────────────────────────────────────────

function addUserMessage(message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message user-message';
    messageDiv.innerHTML = `<div class="message-content">${escapeHtml(message)}</div>`;
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
}

function addBotMessage(message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message bot-message';
    messageDiv.innerHTML = `<div class="message-content">${formatMessage(message)}</div>`;
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
}

function addErrorMessage(error) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = `Error: ${error}`;
    chatMessages.appendChild(errorDiv);
    scrollToBottom();
}

function addBlockedMessage(reason) {
    const blockedDiv = document.createElement('div');
    blockedDiv.className = 'blocked-message';
    blockedDiv.innerHTML =
        `<span class="blocked-icon">&#x26D4;</span> ` +
        `<strong>Request blocked by safety policy</strong>` +
        (reason ? `<br><span class="blocked-reason">${escapeHtml(reason)}</span>` : '');
    chatMessages.appendChild(blockedDiv);
    scrollToBottom();
}

function formatMessage(text) {
    let formatted = escapeHtml(text);
    formatted = formatted.replace(/\n/g, '<br>');
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/\*(.+?)\*/g, '<em>$1</em>');
    return formatted;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── SSE stream consumer ──────────────────────────────────────────────

async function sendMessageStream(message, callbacks) {
    let url = `/api/question?q=${encodeURIComponent(message)}`;
    if (selectedModel) url += `&model=${encodeURIComponent(selectedModel)}`;
    const response = await fetch(url);

    if (!response.ok) {
        let errorMsg = 'Failed to get response';
        try {
            const errorData = await response.json();
            errorMsg = errorData.error || errorMsg;
        } catch (e) { /* response might not be JSON */ }
        throw new Error(errorMsg);
    }

    const reader = response.body.getReader();
    activeReader = reader;
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
            for (const line of part.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    switch (data.type) {
                        case 'token':    callbacks.onToken?.(data.content); break;
                        case 'status':   callbacks.onStatus?.(data.content); break;
                        case 'tool_call':callbacks.onToolCall?.(data.tool); break;
                        case 'blocked':  callbacks.onBlocked?.(data.content); break;
                        case 'error':    callbacks.onError?.(data.content); break;
                        case 'end':      callbacks.onEnd?.(); break;
                    }
                } catch (e) {
                    console.warn('Failed to parse SSE data:', line);
                }
            }
        }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'token')   callbacks.onToken?.(data.content);
                if (data.type === 'blocked') callbacks.onBlocked?.(data.content);
                if (data.type === 'end')     callbacks.onEnd?.();
                if (data.type === 'error')   callbacks.onError?.(data.content);
            } catch (e) { /* ignore */ }
        }
    }
}

// ── Form submission handler ──────────────────────────────────────────

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const message = messageInput.value.trim();
    if (!message) return;

    addUserMessage(message);
    messageInput.value = '';
    messageInput.disabled = true;
    sendButton.style.display = 'none';
    stopButton.style.display = '';
    streamStopped = false;

    const ctx = createStreamingContext();
    let fullText = '';
    let hasContent = false;
    let hasEnded = false;

    try {
        await sendMessageStream(message, {
            onToken(token) {
                if (!hasContent) {
                    // Clear any status/tool messages before real content
                    ctx.contentDiv.innerHTML = '';
                }
                hasContent = true;
                fullText += token;
                updateStreamingContent(ctx, fullText);
            },
            onStatus(status) {
                if (!hasContent) {
                    ctx.contentDiv.innerHTML =
                        `<em>${escapeHtml(status)}</em><span class="streaming-cursor"></span>`;
                    scrollToBottom();
                }
            },
            onToolCall(tool) {
                if (!hasContent) {
                    ctx.contentDiv.innerHTML =
                        `<em>Calling tool: ${escapeHtml(tool)}...</em><span class="streaming-cursor"></span>`;
                    scrollToBottom();
                }
            },
            onBlocked(reason) {
                hasEnded = true;
                ctx.segments.forEach(s => { if (s.timer) clearInterval(s.timer); });
                ctx.messageDiv.remove();
                addBlockedMessage(reason);
            },
            onEnd() {
                hasEnded = true;
                finalizeStreamingContent(ctx, fullText || 'No response received');
            },
            onError(error) {
                hasEnded = true;
                // Clean up timers
                ctx.segments.forEach(s => { if (s.timer) clearInterval(s.timer); });
                ctx.messageDiv.remove();
                addErrorMessage(error);
            },
        });

        if (!hasEnded) {
            finalizeStreamingContent(ctx, fullText || 'No response received');
        }
    } catch (error) {
        if (streamStopped) {
            // User clicked Stop – finalize whatever content we have
            finalizeStreamingContent(ctx, fullText || 'Generation stopped');
        } else {
            ctx.segments.forEach(s => { if (s.timer) clearInterval(s.timer); });
            ctx.messageDiv.remove();
            addErrorMessage(error.message);
        }
    } finally {
        activeReader = null;
        messageInput.disabled = false;
        stopButton.style.display = 'none';
        sendButton.style.display = '';
        messageInput.focus();
    }
});

// ── Stop button handler ─────────────────────────────────────────────

stopButton.addEventListener('click', () => {
    streamStopped = true;
    if (activeReader) {
        activeReader.cancel();
        activeReader = null;
    }
});

// ── Reset button handler ────────────────────────────────────────────

resetButton.addEventListener('click', () => {
    // Cancel any active stream
    if (activeReader) {
        activeReader.cancel();
        activeReader = null;
    }
    // Clear messages and restore welcome
    chatMessages.innerHTML = welcomeHTML;
    // Reset input state
    messageInput.disabled = false;
    messageInput.value = '';
    stopButton.style.display = 'none';
    sendButton.style.display = '';
    messageInput.focus();
});

messageInput.focus();
