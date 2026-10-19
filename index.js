
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

// ============================================================
// 1. ENVIRONMENT AND CONNECTIONS
// ============================================================

if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required.');
}

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
}

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (error) => {
    console.error('Unexpected PostgreSQL pool error:', error);
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 2. FREE-TIER-ONLY TEXT MODEL ALLOWLIST
// ============================================================

// Ordered from preferred candidates to lightweight fallbacks.
// Do not add paid-only models or unverified aliases here.
// These models have free-tier standard inference listed in Google's
// pricing documentation. Access and quotas still depend on your project.

const FREE_TIER_MODELS = [
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',

    // Gemma 4 text models
    'gemma-4-31b-it',
    'gemma-4-26b-a4b-it',

    // Lighter fallbacks
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite'
];

// This is the complete allowlist. There is no paid-model fallback.
const MODEL_CANDIDATES = [...new Set(FREE_TIER_MODELS)];

// ============================================================
// 3. TUTOR INSTRUCTIONS
// ============================================================

const TUTOR_SYSTEM_INSTRUCTION = `
You are an expert, patient, respectful online tutor for CSS-100
Computational Thinking and Technical Writing.

Your purpose is to help students learn, understand concepts, and
improve their skills.

Teaching and communication rules:

1. Always treat the student with respect and patience.
2. Never insult, shame, belittle, mock, or blame the student.
3. Never describe a student as stupid, bad, lazy, or incapable.
4. Treat mistakes as normal opportunities for learning.
5. When code is incorrect, identify the specific problem and explain
   how to fix it without criticizing the student.
6. Explain technical concepts using clear, accessible language.
7. Break difficult problems into manageable steps.
8. Provide examples when they will help the student understand.
9. For programming questions, explain the cause of an error and
   demonstrate an appropriate correction.
10. Encourage independent reasoning without withholding useful help.
11. Do not invent facts or claim to have executed code you did not run.
12. If the student's question is unclear, ask a focused question.
13. Maintain a supportive, professional, academically appropriate tone.
14. Format every reply in Markdown. Put each list item on its own line,
    leave a blank line between paragraphs and before and after lists,
    and put all code in fenced code blocks with a language tag such as
    \`\`\`python, with the code on separate lines.

Your job is to help students make progress, not to judge them.
`;

// ============================================================
// 4. DATABASE INITIALIZATION
// ============================================================

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_logs (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ DEFAULT NOW(),
            user_input TEXT,
            ai_output TEXT,
            student_id VARCHAR(255),
            session_id VARCHAR(255),
            model_name VARCHAR(255)
        );
    `);

    // Safely upgrade an existing table without deleting its data.
    await pool.query(`
        ALTER TABLE chat_logs
            ADD COLUMN IF NOT EXISTS student_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS session_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS model_name VARCHAR(255);
    `);

    console.log('Database table and columns verified.');
}

// ============================================================
// 5. SAVE EACH STUDENT / TUTOR EXCHANGE
// ============================================================

async function logInteraction(
    studentId,
    sessionId,
    userInput,
    aiOutput,
    modelName
) {
    try {
        await pool.query(
            `INSERT INTO chat_logs
                (student_id, session_id, user_input, ai_output, model_name)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                studentId || 'Unknown',
                sessionId || 'Unknown',
                userInput,
                aiOutput,
                modelName
            ]
        );
    } catch (error) {
        // A successful AI response should not be discarded merely
        // because the database logging operation failed.
        console.error('Failed to save chat log:', error);
    }
}

// ============================================================
// 6. PREPARE CONTENT FOR GEMINI OR GEMMA
// ============================================================

// Gemini models accept systemInstruction.
// For Gemma, put the tutoring instructions into the latest user
// message instead of relying on systemInstruction compatibility.

function prepareModelRequest(model, contents) {
    const clonedContents = contents.map((item) => ({
        role: item.role,
        parts: item.parts.map((part) => ({ ...part }))
    }));

    if (model.startsWith('gemma-')) {
        const latestMessage =
            clonedContents[clonedContents.length - 1];

        if (latestMessage?.role === 'user') {
            const textPart = latestMessage.parts.find(
                (part) => typeof part.text === 'string'
            );

            if (textPart) {
                textPart.text =
                    `${TUTOR_SYSTEM_INSTRUCTION}\n\n` +
                    `Student message:\n${textPart.text}`;
            }
        }

        return {
            contents: clonedContents,
            config: {}
        };
    }

    return {
        contents: clonedContents,
        config: {
            systemInstruction: TUTOR_SYSTEM_INSTRUCTION
        }
    };
}

// ============================================================
// 7. DECIDE WHEN TO FALL BACK TO ANOTHER FREE MODEL
// ============================================================

function shouldTryNextModel(error) {
    const status = Number(
        error?.status ??
        error?.response?.status ??
        0
    );

    const message = String(error?.message ?? error);

    // Temporary problems, throttling, and model-specific unavailability.
    if ([408, 429, 500, 502, 503, 504].includes(status)) {
        return true;
    }

    if (status === 404) {
        return true;
    }

    if (
        /RESOURCE_EXHAUSTED|QUOTA_EXCEEDED|RATE_LIMIT|UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL/i
            .test(message)
    ) {
        return true;
    }

    // Model endpoint is missing, disabled, unavailable, or incompatible.
    if (
        /model.{0,120}(not found|not available|unsupported|does not exist|not supported|not enabled|not accessible)|(?:not found|not available|unsupported|not enabled).{0,100}model/i
            .test(message)
    ) {
        return true;
    }

    // A model-specific access restriction may allow another candidate.
    if (
        status === 403 &&
        /model|permission|access|not enabled|region/i.test(message)
    ) {
        return true;
    }

    // Do not repeatedly retry unrelated client errors or invalid keys.
    return false;
}

// ============================================================
// 8. GENERATE A RESPONSE USING FREE MODELS ONLY
// ============================================================

async function generateTutorReply(contents) {
    const failures = [];

    for (const model of MODEL_CANDIDATES) {
        try {
            console.log(`Trying free-tier candidate: ${model}`);

            const request = prepareModelRequest(model, contents);

            const response = await ai.models.generateContent({
                model,
                contents: request.contents,
                config: request.config
            });

            const reply =
                typeof response.text === 'string'
                    ? response.text.trim()
                    : '';

            if (reply) {
                console.log(`Tutor answered using: ${model}`);

                return {
                    reply,
                    model
                };
            }

            // Empty responses do not reach the student as successful answers.
            failures.push({
                model,
                error: 'Empty response'
            });

            console.warn(
                `${model} returned an empty response. Trying the next candidate.`
            );
        } catch (error) {
            const message = String(error?.message ?? error);

            failures.push({
                model,
                error: message
            });

            if (!shouldTryNextModel(error)) {
                console.error(
                    `Non-retryable error from ${model}:`,
                    message
                );

                throw error;
            }

            console.warn(
                `${model} failed. Moving to the next free-tier candidate.`
            );
            console.warn(`Reason: ${message}`);
        }
    }

    const error = new Error(
        `All ${MODEL_CANDIDATES.length} configured free-tier model candidates failed.`
    );

    error.statusCode = 503;
    error.failures = failures;

    throw error;
}

// ============================================================
// 9. POST /api/tutor
// ============================================================

app.post('/api/tutor', async (req, res) => {
    try {
        const { studentId, sessionId } = req.body || {};

        const message =
            typeof req.body?.message === 'string'
                ? req.body.message.trim()
                : '';

        if (!message) {
            return res.status(400).json({
                error: 'Please enter a message.'
            });
        }

        if (message.length > 20000) {
            return res.status(413).json({
                error: 'The message is too long. Please shorten it.'
            });
        }

        const safeStudentId =
            typeof studentId === 'string' && studentId.trim()
                ? studentId.trim().slice(0, 255)
                : 'Unknown';

        const safeSessionId =
            typeof sessionId === 'string' && sessionId.trim()
                ? sessionId.trim().slice(0, 255)
                : 'Unknown';

        // Load the last two exchanges for this exact student/session.
        const historyResult = await pool.query(
            `SELECT user_input, ai_output
             FROM chat_logs
             WHERE student_id = $1 AND session_id = $2
             ORDER BY timestamp DESC, id DESC
             LIMIT 2`,
            [safeStudentId, safeSessionId]
        );

        const chronologicalHistory = historyResult.rows.reverse();
        const chatContext = [];

        for (const row of chronologicalHistory) {
            if (row.user_input) {
                chatContext.push({
                    role: 'user',
                    parts: [{ text: row.user_input }]
                });
            }

            if (row.ai_output) {
                chatContext.push({
                    role: 'model',
                    parts: [{ text: row.ai_output }]
                });
            }
        }

        chatContext.push({
            role: 'user',
            parts: [{ text: message }]
        });

        // There is no code path outside the free-tier allowlist.
        const result = await generateTutorReply(chatContext);

        await logInteraction(
            safeStudentId,
            safeSessionId,
            message,
            result.reply,
            result.model
        );

        return res.json({
            reply: result.reply,
            model: result.model
        });
    } catch (error) {
        console.error('Tutor request failed:', error);

        if (
            error.statusCode === 503 ||
            Number(error.status) === 503
        ) {
            return res.status(503).json({
                error:
                    'All available free-tier tutor models are temporarily ' +
                    'unavailable or have reached their limits. Please try again later.'
            });
        }

        return res.status(500).json({
            error: 'Failed to fetch a response from the AI tutor.'
        });
    }
});

// ============================================================
// 10. GET /api/history
// Restore the full interface history for a student/session.
// ============================================================

app.get('/api/history', async (req, res) => {
    try {
        const { studentId, sessionId } = req.query;

        if (!studentId || !sessionId) {
            return res.json([]);
        }

        const result = await pool.query(
            `SELECT user_input, ai_output
             FROM chat_logs
             WHERE student_id = $1 AND session_id = $2
             ORDER BY timestamp ASC, id ASC`,
            [studentId, sessionId]
        );

        return res.json(result.rows);
    } catch (error) {
        console.error('Error retrieving chat history:', error);

        return res.status(500).json([]);
    }
});

// ============================================================
// 11. GET /api/logs
// Protect student transcripts from unauthenticated access.
// ============================================================

app.get('/api/logs', async (req, res) => {
    try {
        const adminToken = process.env.ADMIN_LOGS_TOKEN;
        const suppliedToken = req.get('x-admin-token');

        if (!adminToken || suppliedToken !== adminToken) {
            return res.status(403).json({
                error: 'Forbidden.'
            });
        }

        const result = await pool.query(
            'SELECT * FROM chat_logs ORDER BY timestamp DESC, id DESC'
        );

        return res.json(result.rows);
    } catch (error) {
        console.error('Error retrieving logs:', error);

        return res.status(500).send('Error retrieving logs.');
    }
});

// ============================================================
// 12. START ONLY AFTER DATABASE INITIALIZATION
// ============================================================

async function startServer() {
    try {
        await initDB();

        app.listen(port, () => {
            console.log(`Server is running on port ${port}`);
            console.log('Free-tier-only model fallback: ENABLED');
            console.log(
                `Configured free-tier candidates: ${MODEL_CANDIDATES.length}`
            );
            console.log(
                `Model priority: ${MODEL_CANDIDATES.join(' -> ')}`
            );
        });
    } catch (error) {
        console.error('Server startup failed:', error);
        process.exit(1);
    }
}

startServer();
