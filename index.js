import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup for ES Modules directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Initialize the Google Gen AI SDK
// The cloud provider will inject the GEMINI_API_KEY environment variable
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());
// Serve the static frontend files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// API Route that your frontend will call
app.post('/api/tutor', async (req, res) => {
    try {
        const { message } = req.body;
        
        // Call the Gemini 2.5 Flash model
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `You are an expert, encouraging online tutor. Answer the student's query clearly and helpfully: ${message}`
        });

        res.json({ reply: response.text });
    } catch (error) {
        console.error('Error generating content:', error);
        res.status(500).json({ error: 'Failed to fetch response from the AI tutor.' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});