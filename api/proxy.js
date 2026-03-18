import mongoose from "mongoose";

// ── MongoDB Connection ──
let isConnected = false;
async function connectDB() {
    if (isConnected) return;
    await mongoose.connect(process.env.MONGODB_URI);
    isConnected = true;
}

// ── Schema ──
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

// ── Get next valid key ──
async function getNextKey() {
    const keys = await Key.find({ depleted: false });
    if (!keys.length) return null;

    let meta = await Meta.findOne();
    if (!meta) { meta = await Meta.create({ currentIdx: 0 }); }

    const idx = meta.currentIdx % keys.length;
    return keys[idx];
}

// ── Mark key depleted ──
async function markDepleted(keyId) {
    await Key.findByIdAndUpdate(keyId, { depleted: true });
    // Move to next
    let meta = await Meta.findOne();
    if (meta) { meta.currentIdx += 1; await meta.save(); }
}

// ── Main Handler ──
export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") return res.status(200).end();

    await connectDB();

    // ── GET /api/proxy — Status check ──
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

    // ── POST — Forward to Anthropic ──
    const keyObj = await getNextKey();

    if (!keyObj) {
        return res.status(429).json({
            error: {
                type: "all_keys_depleted",
                message: "Badhi API keys khatam! Site pe ja ne navi keys nakho.",
            },
        });
    }

    try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": keyObj.value,
                "anthropic-version": "2023-06-01",
                ...(req.headers["anthropic-beta"] && {
                    "anthropic-beta": req.headers["anthropic-beta"],
                }),
            },
            body: JSON.stringify(req.body),
        });

        const data = await response.json();

        // Key depleted or invalid?
        if (
            data?.error?.message?.toLowerCase().includes("credit") ||
            data?.error?.message?.toLowerCase().includes("balance") ||
            response.status === 401
        ) {
            console.log(`⛔ Key depleted: ${keyObj.name}`);
            await markDepleted(keyObj._id);

            // Retry with next key
            const nextKey = await getNextKey();
            if (!nextKey) {
                return res.status(429).json({
                    error: { message: "Badhi keys khatam! Navi nakho." },
                });
            }

            const retry = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": nextKey.value,
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify(req.body),
            });

            const retryData = await retry.json();
            return res.status(retry.status).json(retryData);
        }

        return res.status(response.status).json(data);
    } catch (e) {
        return res.status(500).json({ error: { message: "Server error: " + e.message } });
    }
}