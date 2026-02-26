const express = require('express');
const axios = require('axios');
require('dotenv').config({ path: '../.env' });

const app = express();
const CHAT_UI_PORT = process.env.CHAT_UI_PORT || 3001;
const FASTAPI_URL = process.env.FASTAPI_URL || 'http://localhost:8000';

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API endpoint to proxy SSE stream from FastAPI
app.get('/api/question', async (req, res) => {
    const { q } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'Question parameter "q" is required' });
    }

    try {
        console.log(`Forwarding question to FastAPI (stream): ${q}`);

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const response = await axios({
            method: 'get',
            url: `${FASTAPI_URL}/question`,
            params: { q },
            responseType: 'stream',
            timeout: 120000
        });

        // Pipe the SSE stream from FastAPI directly to the client
        response.data.pipe(res);

        response.data.on('end', () => {
            console.log('Stream ended');
            res.end();
        });

        response.data.on('error', (err) => {
            console.error('Stream error:', err.message);
            res.write(`data: ${JSON.stringify({ type: 'error', content: 'Stream interrupted' })}\n\n`);
            res.end();
        });

    } catch (error) {
        console.error('Error calling FastAPI:', error.message);

        if (!res.headersSent) {
            if (error.response) {
                res.status(error.response.status).json({
                    error: error.response.data?.detail || 'Error from FastAPI backend'
                });
            } else if (error.code === 'ECONNREFUSED') {
                res.status(503).json({
                    error: 'Cannot connect to FastAPI backend. Is it running?'
                });
            } else {
                res.status(500).json({
                    error: 'Internal server error'
                });
            }
        } else {
            // Headers already sent (SSE mode), send error as SSE event
            res.write(`data: ${JSON.stringify({ type: 'error', content: error.message })}\n\n`);
            res.end();
        }
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', fastapi_url: FASTAPI_URL });
});

app.listen(CHAT_UI_PORT, () => {
    console.log(`Chat UI server running on http://localhost:${CHAT_UI_PORT}`);
    console.log(`FastAPI backend: ${FASTAPI_URL}`);
});
