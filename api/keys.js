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

const Key = mongoose.models.Key || mongoose.model("Key", KeySchema);

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") return res.status(200).end();

    await connectDB();

    // GET — Badhi keys lavo
    if (req.method === "GET") {
        const keys = await Key.find().select("-value"); // Value hide karo
        return res.json({ keys });
    }

    // POST — Navi key add karo
    if (req.method === "POST") {
        const { name, value } = req.body;
        if (!name || !value) return res.status(400).json({ error: "Name and value required" });
        const key = await Key.create({ name, value });
        return res.json({ success: true, key: { _id: key._id, name: key.name } });
    }

    // DELETE — Key delete karo
    if (req.method === "DELETE") {
        const { id } = req.body;
        await Key.findByIdAndDelete(id);
        return res.json({ success: true });
    }
}