import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs'; // NEW: Built-in Node module for file handling

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- NEW CAPTURE LOGIC ---
function logInteraction(userInput, aiOutput) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        user_input: userInput,
        ai_output: aiOutput
    };
    
    // Save as JSON Lines (.jsonl) - perfect for later data analysis
    const logString = JSON.stringify(logEntry) + '\n';
    const logFilePath = path.join(__dirname, 'chat_history.jsonl');

    fs.appendFile(logFilePath, logString, (err) => {
        if (err) console.error("Failed to write to log file:", err);
    });

    // Also dump it to the console so it permanently appears in your Render Logs tab
    console.log(`[CAPTURED] Input: "${userInput}" | Output: "${aiOutput}"`);
}
// -------------------------

app.post('/api/tutor', async (req, res) => {
    try {
        const { message } = req.body;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `You are an expert, encouraging online tutor. Answer the student's query clearly and helpfully: ${message}`
        });

        const replyText = response.text;

        // NEW: Call the logging function before responding to the user
        logInteraction(message, replyText);

        res.json({ reply: replyText });
    } catch (error) {
        console.error('Error generating content:', error);
        res.status(500).json({ error: 'Failed to fetch response from the AI tutor.' });
    }
});

// --- NEW DATA EXPORT ENDPOINT ---
// Access this by going to yoursite.onrender.com/api/logs
app.get('/api/logs', (req, res) => {
    const logFilePath = path.join(__dirname, 'chat_history.jsonl');
    
    if (fs.existsSync(logFilePath)) {
        res.download(logFilePath); // Triggers a file download in the browser
    } else {
        res.status(404).send("No chat history logged yet.");
    }
});
// --------------------------------

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
