import express from 'express';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import pdf from 'pdf-parse';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USER_MAPPINGS_FILE = path.join(__dirname, 'user_mappings.json');
let USER_MAPPINGS = {};
try {
    if (fs.existsSync(USER_MAPPINGS_FILE)) {
        USER_MAPPINGS = JSON.parse(fs.readFileSync(USER_MAPPINGS_FILE, 'utf8'));
    }
} catch (e) {
    console.error("Error loading user_mappings.json:", e);
}

const app = express();
const port = process.env.PORT || 3018;

app.use(express.json());

const DATA_FILE = path.join(__dirname, 'chats.json');

function readData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            const initialData = { chats: [], userCount: 0 };
            fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) { return { chats: [], userCount: 0 }; }
}

function saveData(data) {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

function getMappedUserName(userId) {
    return USER_MAPPINGS[userId] || userId;
}

// --- GESTIÓN DE MÚLTIPLES CLAVES ---
const API_KEYS = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
].filter(k => k && k.trim().length > 0);

let currentKeyIndex = 0;

function getAIInstance() {
    const apiKey = API_KEYS[currentKeyIndex];
    delete process.env.GOOGLE_API_KEY; // Evitar conflictos
    return new GoogleGenAI({ apiKey });
}

const systemInstruction = `Eres MontañIA, experto en campamentos. Ayuda a monitores basándote en sus cuadernillos. Responde con Markdown. Puedes buscar en internet.
Responde en base con la información recopilada en los cuadernillos y elabora lo que te pidan con la misma estructura.`;

let campContext = "";
async function loadContext() {
    const cuadernillosDir = path.join(__dirname, 'cuadernillos');
    if (!fs.existsSync(cuadernillosDir)) fs.mkdirSync(cuadernillosDir);
    const files = fs.readdirSync(cuadernillosDir).filter(file => file.endsWith('.pdf'));
    let combinedText = "";
    for (const file of files) {
        const dataBuffer = fs.readFileSync(path.join(cuadernillosDir, file));
        try {
            const data = await pdf(dataBuffer);
            combinedText += `\n--- CUADERNILLO: ${file} ---\n${data.text}`;
        } catch (err) {}
    }
    campContext = combinedText;
}
loadContext();

app.get('/api/register', (req, res) => {
    const data = readData();
    data.userCount = (data.userCount || 0) + 1;
    const newUserId = `user${data.userCount}`;
    saveData(data);
    res.json({ userId: newUserId });
});

app.get('/api/chats', (req, res) => {
    const { userId, isAdmin } = req.query;
    const data = readData();
    let filteredChats = (isAdmin === 'true') ? data.chats : data.chats.filter(c => c.userId === userId);
    res.json(filteredChats.map(c => {
        const displayUserId = (isAdmin === 'true') ? getMappedUserName(c.userId) : c.userId;
        return { id: c.id, title: c.title, userId: displayUserId, isOthers: c.userId !== userId };
    }));
});

app.get('/api/chats/:id', (req, res) => {
    const data = readData();
    const chat = data.chats.find(c => c.id === req.params.id);
    res.json(chat || { history: [] });
});

app.post('/api/chat', async (req, res) => {
    const { message, history, chatId, userId } = req.body;
    let attempts = 0;

    while (attempts < API_KEYS.length) {
        try {
            const ai = getAIInstance();
            console.log(`[Chat] Usando API Key #${currentKeyIndex + 1} para ${userId}`);

            const chat = ai.chats.create({
                model: "gemini-2.5-flash",
                history: (history || []).map(h => ({ role: h.role, parts: h.parts })),
                config: { systemInstruction: systemInstruction, tools: [{ googleSearch: {} }] }
            });

            let fullMessage = message;
            if (campContext && (!history || history.length === 0)) {
                fullMessage = `Contexto previo:\n${campContext}\n\n---\n\nUsuario: ${message}`;
            }

            const result = await chat.sendMessage({ message: [{ text: fullMessage }] });
            const responseText = result.text;

            const data = readData();
            let currentChat = data.chats.find(c => c.id === chatId);
            if (!currentChat) {
                let title = message.substring(0, 25);
                try {
                    const titleResult = await ai.models.generateContent({
                        model: "gemini-2.5-flash",
                        contents: [{ role: "user", parts: [{ text: `Resume en 2-6 palabras de forma breve: "${message}"` }] }]
                    });
                    title = titleResult.text.trim().replace(/[*"']/g, "");
                } catch (e) {}
                currentChat = { id: chatId, title: title, history: [], userId: userId };
                data.chats.push(currentChat);
            }
            currentChat.history.push({ role: 'user', parts: [{ text: message }] });
            currentChat.history.push({ role: 'model', parts: [{ text: responseText }] });
            saveData(data);
            return res.json({ response: responseText });

        } catch (error) {
            console.error(`❌ Error con API Key #${currentKeyIndex + 1}:`, error.message);
            
            if (error.status === 429 || error.message.includes("429")) {
                attempts++;
                currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
                console.warn(`🔄 Cuota agotada. Rotando a API Key #${currentKeyIndex + 1}...`);
            } else {
                return res.status(500).json({ error: "Error interno al procesar el mensaje." });
            }
        }
    }

    // Si salimos del bucle es que todas las llaves han fallado con 429
    res.status(429).json({ response: "Servidor saturado... espere unos minutos" });
});

app.use(express.static('public'));
app.listen(port, () => console.log(`🚀 MontañIA funcionando con ${API_KEYS.length} llaves en puerto ${port}`));