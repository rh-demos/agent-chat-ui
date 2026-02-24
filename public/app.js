const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');

// Add user message to chat
function addUserMessage(message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message user-message';
    messageDiv.innerHTML = `
        <div class="message-content">
            ${escapeHtml(message)}
        </div>
    `;
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
}

// Add bot message to chat
function addBotMessage(message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message bot-message';
    messageDiv.innerHTML = `
        <div class="message-content">
            ${formatMessage(message)}
        </div>
    `;
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
}

// Add typing indicator
function addTypingIndicator() {
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message bot-message';
    typingDiv.id = 'typing-indicator';
    typingDiv.innerHTML = `
        <div class="message-content typing-indicator">
            <span></span>
            <span></span>
            <span></span>
        </div>
    `;
    chatMessages.appendChild(typingDiv);
    scrollToBottom();
}

// Remove typing indicator
function removeTypingIndicator() {
    const typingIndicator = document.getElementById('typing-indicator');
    if (typingIndicator) {
        typingIndicator.remove();
    }
}

// Add error message
function addErrorMessage(error) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = `Error: ${error}`;
    chatMessages.appendChild(errorDiv);
    scrollToBottom();
}

// Format message with basic markdown-like formatting
function formatMessage(text) {
    // Escape HTML first
    let formatted = escapeHtml(text);

    // Convert newlines to <br>
    formatted = formatted.replace(/\n/g, '<br>');

    // Convert **bold** to <strong>
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Convert *italic* to <em>
    formatted = formatted.replace(/\*(.+?)\*/g, '<em>$1</em>');

    return formatted;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Scroll to bottom of chat
function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Send message to backend
async function sendMessage(message) {
    try {
        const response = await fetch(`/api/question?q=${encodeURIComponent(message)}`);

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Failed to get response');
        }

        const data = await response.json();
        return data.answer || 'No response received';
    } catch (error) {
        console.error('Error sending message:', error);
        throw error;
    }
}

// Handle form submission
chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const message = messageInput.value.trim();
    if (!message) return;

    // Add user message
    addUserMessage(message);

    // Clear input
    messageInput.value = '';

    // Disable input while processing
    messageInput.disabled = true;
    sendButton.disabled = true;

    // Show typing indicator
    addTypingIndicator();

    try {
        // Send message and get response
        const response = await sendMessage(message);

        // Remove typing indicator
        removeTypingIndicator();

        // Add bot response
        addBotMessage(response);
    } catch (error) {
        // Remove typing indicator
        removeTypingIndicator();

        // Show error
        addErrorMessage(error.message);
    } finally {
        // Re-enable input
        messageInput.disabled = false;
        sendButton.disabled = false;
        messageInput.focus();
    }
});

// Focus input on load
messageInput.focus();
