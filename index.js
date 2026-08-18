import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg'; // NEW: PostgreSQL driver
const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// --- DATABASE SETUP ---
// Connect to Render's PostgreSQL using the URL in the environment variables
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Render's cloud databases
});

// Auto-create the table if it doesn't exist
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_logs (
                id SERIAL PRIMARY KEY,
                timestamp TIMESTAMPTZ DEFAULT NOW(),
                user_input TEXT,
                ai_output TEXT
            )
        `);
        console.log("Database table verified/created.");
    } catch (error) {
        console.error("DB Initialization error:", error);
    }
}
initDB();
// ----------------------

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- NEW DB LOGGING LOGIC ---
async function logInteraction(userInput, aiOutput) {
    try {
        await pool.query(
            'INSERT INTO chat_logs (user_input, ai_output) VALUES ($1, $2)',
            [userInput, aiOutput]
        );
        console.log(`[DB LOGGED] Input saved to permanent storage.`);
    } catch (err) {
        console.error("Failed to write to DB:", err);
    }
}
// ----------------------------

app.post('/api/tutor', async (req, res) => {
    try {
        const { message } = req.body;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `You are an expert, encouraging online tutor. Answer the student's query clearly and helpfully: ${message}`
        });

        const replyText = response.text;

        // Save to PostgreSQL before sending response
        await logInteraction(message, replyText);

        res.json({ reply: replyText });
    } catch (error) {
        console.error('Error generating content:', error);
        res.status(500).json({ error: 'Failed to fetch response from the AI tutor.' });
    }
});

// --- UPDATED EXPORT ENDPOINT ---
// Access this by going to yoursite.onrender.com/api/logs to view the DB rows
app.get('/api/logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM chat_logs ORDER BY timestamp DESC');
        res.json(result.rows);
    } catch (error) {
        console.error("Error retrieving logs:", error);
        res.status(500).send("Error retrieving logs from database.");
    }
});
// -------------------------------

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
