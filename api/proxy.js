import mongoose from "mongoose";

let isConnected = false;
async function connectDB() {
    if (isConnected) return;
    await mongoose.connect(process.env.MONGODB_URI);
    isConnected = true;
}

const KeySchema = new mongoose.Schema({
    name: String,
    value: String,
    depleted: { type: Boolean, default: false },
    addedAt: { type: Date, default: Date.now },
});
const MetaSchema = new mongoose.Schema({
    currentIdx: { type: Number, default: 0 },
});

const Key = mongoose.models.Key || mongoose.model("Key", KeySchema);
const Meta = mongoose.models.Meta || mongoose.model("Meta", MetaSchema);

async function getNextKey() {
    const keys = await Key.find({ depleted: false });
    if (!keys.length) return null;
    let meta = await Meta.findOne();
    if (!meta) meta = await Meta.create({ currentIdx: 0 });
    const idx = meta.currentIdx % keys.length;
    return keys[idx];
}

async function markDepleted(keyId) {
    await Key.findByIdAndUpdate(keyId, { depleted: true });
    let meta = await Meta.findOne();
    if (meta) { meta.currentIdx += 1; await meta.save(); }
}

// ── OpenAI → Anthropic convert ──
function toAnthropic(body) {
    const messages = body.messages || [];
    let system = "";
    const filtered = messages.filter(m => {
        if (m.role === "system") { system = m.content; return false; }
        return true;
    });
    const result = {
        model: "claude-sonnet-4-5-20251001",
        max_tokens: body.max_tokens || body.max_completion_tokens || 8096,
        messages: filtered.map(m => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: typeof m.content === "string" ? m.content :
                Array.isArray(m.content) ? m.content.map(c =>
                    c.type === "text" ? { type: "text", text: c.text } : c
                ) : String(m.content)
        })),
    };
    if (system) result.system = system;
    if (body.temperature) result.temperature = body.temperature;
    if (body.stream) result.stream = body.stream;
    return result;
}

// ── Anthropic → OpenAI convert ──
function toOpenAI(data) {
    return {
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: data.model || "claude-sonnet-4-5-20251001",
        choices: [{
            index: 0,
            message: { role: "assistant", content: data.content?.[0]?.text || "" },
            finish_reason: data.stop_reason === "end_turn" ? "stop" : (data.stop_reason || "stop")
        }],
        usage: {
            prompt_tokens: data.usage?.input_tokens || 0,
            completion_tokens: data.usage?.output_tokens || 0,
            total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
        }
    };
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") return res.status(200).end();

    await connectDB();

    // ── Status ──
    if (req.method === "GET") {
        const keys = await Key.find();
        const active = await getNextKey();
        return res.json({
            status: "✅ Running",
            totalKeys: keys.length,
            activeKeys: keys.filter(k => !k.depleted).length,
            depletedKeys: keys.filter(k => k.depleted).length,
            activeKey: active?.name || "none",
        });
    }

    if (req.method !== "POST") return res.status(405).end();

    // ── Format detect — OpenAI (Cursor) ya Anthropic (Cline)? ──
    const isOpenAI = !req.headers["anthropic-version"] && req.body?.messages;
    const anthropicBody = isOpenAI ? toAnthropic(req.body) : req.body;

    // ── Get key ──
    const keyObj = await getNextKey();
    if (!keyObj) {
        return res.status(429).json({ error: { message: "Badhi keys khatam! Site pe ja ne navi nakho.", code: "insufficient_quota" } });
    }

    try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": keyObj.value,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(anthropicBody),
        });

        const data = await response.json();

        // Key depleted?
        if (
            data?.error?.message?.toLowerCase().includes("credit") ||
            data?.error?.message?.toLowerCase().includes("balance") ||
            response.status === 401
        ) {
            await markDepleted(keyObj._id);
            const nextKey = await getNextKey();
            if (!nextKey) return res.status(429).json({ error: { message: "Badhi keys khatam!" } });

            const retry = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-api-key": nextKey.value, "anthropic-version": "2023-06-01" },
                body: JSON.stringify(anthropicBody),
            });
            const retryData = await retry.json();
            return res.status(retry.status).json(isOpenAI ? toOpenAI(retryData) : retryData);
        }

        return res.status(response.status).json(isOpenAI ? toOpenAI(data) : data);

    } catch (e) {
        return res.status(500).json({ error: { message: "Server error: " + e.message } });
    }
}