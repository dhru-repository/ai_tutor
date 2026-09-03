import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg'; 
const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Auto-create table and safely add student & session tracking
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_logs (
                id SERIAL PRIMARY KEY,
                timestamp TIMESTAMPTZ DEFAULT NOW(),
                user_input TEXT,
                ai_output TEXT
            );
        `);
        
        await pool.query(`
            ALTER TABLE chat_logs 
            ADD COLUMN IF NOT EXISTS student_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS session_id VARCHAR(255);
        `);
        console.log("Database table and columns verified.");
    } catch (error) {
        console.error("DB Initialization error:", error);
    }
}
initDB();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Saves to DB using BOTH student ID and session ID
async function logInteraction(studentId, sessionId, userInput, aiOutput) {
    try {
        await pool.query(
            'INSERT INTO chat_logs (student_id, session_id, user_input, ai_output) VALUES ($1, $2, $3, $4)',
            [studentId || 'Unknown', sessionId || 'Unknown', userInput, aiOutput]
        );
    } catch (err) {
        console.error("Failed to write to DB:", err);
    }
}

// 1. ENDPOINT: Handle new messages and AI responses
app.post('/api/tutor', async (req, res) => {
    try {
        const { message, studentId, sessionId } = req.body;
        const safeStudentId = studentId || 'Unknown';
        const safeSessionId = sessionId || 'Unknown';

        // Fetch context for the AI (last 2 rows = 4 messages) for this specific session
        const historyResult = await pool.query(
            'SELECT user_input, ai_output FROM chat_logs WHERE student_id = $1 AND session_id = $2 ORDER BY timestamp DESC LIMIT 2',
            [safeStudentId, safeSessionId]
        );
        const chronologicalHistory = historyResult.rows.reverse();

        const chatContext = [];
        for (const row of chronologicalHistory) {
            chatContext.push({ role: 'user', parts: [{ text: row.user_input }] });
            chatContext.push({ role: 'model', parts: [{ text: row.ai_output }] });
        }
        chatContext.push({ role: 'user', parts: [{ text: message }] });

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: chatContext,
            config: {
                systemInstruction: "You are an expert, encouraging online tutor for a CSS-100 Computational Thinking and Technical Writing course. Answer the student's query clearly and helpfully."
            }
        });

        const replyText = response.text;

        await logInteraction(safeStudentId, safeSessionId, message, replyText);
        res.json({ reply: replyText });
    } catch (error) {
        console.error('Error generating content:', error);
        res.status(500).json({ error: 'Failed to fetch response from the AI tutor.' });
    }
});

// 2. ENDPOINT: Fetch full UI chat history when a student returns to the page
app.get('/api/history', async (req, res) => {
    try {
        const { studentId, sessionId } = req.query;
        if (!studentId || !sessionId) {
            return res.json([]);
        }

        // Fetch ALL rows for this specific session to redraw the screen (Ascending order)
        const result = await pool.query(
            'SELECT user_input, ai_output FROM chat_logs WHERE student_id = $1 AND session_id = $2 ORDER BY timestamp ASC',
            [studentId, sessionId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error("Error retrieving UI history:", error);
        res.status(500).json([]);
    }
});

// 3. ENDPOINT: Your admin raw logs viewer
app.get('/api/logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM chat_logs ORDER BY timestamp DESC');
        res.json(result.rows);
    } catch (error) {
        res.status(500).send("Error retrieving logs.");
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
