const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// --- Serve Static Frontend Files (index.html, style.css, app.js) ---
app.use(express.static(path.join(__dirname)));

const BB_BASE = "https://www.bigbasket.com";

// --- AES-GCM Decryption & Encryption (Matching frontend app.js) ---
function decryptPayload(b64Data) {
    try {
        const buffer = Buffer.from(b64Data, 'base64');
        const iv = buffer.slice(0, 12);
        const key = buffer.slice(12, 28);
        const ciphertextWithTag = buffer.slice(28);

        const authTag = ciphertextWithTag.slice(ciphertextWithTag.length - 16);
        const actualCiphertext = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);

        const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv);
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(actualCiphertext, undefined, 'utf8');
        decrypted += decipher.final('utf8');
        return JSON.parse(decrypted);
    } catch (e) {
        console.error("Decryption error:", e);
        return null;
    }
}

function encryptPayload(obj) {
    const iv = crypto.randomBytes(12);
    const key = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);

    let encrypted = cipher.update(JSON.stringify(obj), 'utf8', undefined);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    const combined = Buffer.concat([iv, key, encrypted, authTag]);
    return combined.toString('base64');
}

// --- ADVANCED DEVICE SPOOFING & GPS JITTER LOGIC ---
function getMockLocation() {
    const lat = (23.385085 + (Math.random() - 0.5) * 0.004).toFixed(6);
    const lng = (85.286066 + (Math.random() - 0.5) * 0.004).toFixed(6);
    return { lat, lng };
}

function randomDeviceId() {
    return crypto.randomBytes(8).toString('hex');
}

function buildAppHeaders(sessionData = {}) {
    const { lat, lng } = getMockLocation();
    const token = sessionData.token || sessionData.bbAuthToken || "";
    const tid = sessionData.tid || sessionData.mId || "";

    const headers = {
        "Host": "www.bigbasket.com",
        "user-agent": "Bigbasket-Android/8.35.0 (Android/14; Vivo I2017)",
        "content-type": "application/json; charset=utf-8",
        "accept": "application/json, text/plain, */*",
        "accept-encoding": "gzip, deflate",
        "x-requested-with": "in.bigbasket.android",
        "client-id": "android",
        "platform": "Bigbasket-Android",
        "version-code": "1590",
        "app-version": "8.35.0",
        "os-version": "14",
        "manufacturer": "VIVO",
        "model-name": "I2017",
        "swuid": randomDeviceId(),
        "deviceid": randomDeviceId(),
        "latitude": lat,
        "longitude": lng,
        "connection": "keep-alive",
        "referer": "https://www.bigbasket.com/"
    };

    if (tid) headers["tid"] = String(tid);
    if (token) headers["token"] = String(token);
    
    return headers;
}

// --- Universal Dynamic Handler matching app.js apiCall ---
app.post('/tata_bb_api_v2/', async (req, res) => {
    try {
        const { op, session_key, data } = req.body;
        let decodedData = data ? decryptPayload(data) : {};

        console.log(`[API Request] Operation: ${op}`);

        let targetUrl = `${BB_BASE}`;
        let method = 'POST';
        let payloadBody = decodedData;

        if (op === 'validate_access_code') {
            const mockResponse = { ok: true, access_data: { code: decodedData.code, balance: 1000, per_order_limit: 50 }, features: {} };
            return res.json({ op, data: encryptPayload(mockResponse) });
        } 
        else if (op.includes('otp') || op.includes('login')) {
            targetUrl = `${BB_BASE}/member-tdl/v3/member/otp/`;
        } 
        else if (op.includes('cart')) {
            targetUrl = `${BB_BASE}/mapi/v4.2.0/cart/summary/`;
            method = 'GET';
        } 
        else if (op.includes('address')) {
            targetUrl = `${BB_BASE}/ui-svc/v1/address/list`;
            method = 'GET';
        }
        else {
            targetUrl = `${BB_BASE}/ui-svc/v1/member/details`;
            method = 'GET';
        }

        const spoofedHeaders = buildAppHeaders(decodedData);

        const bbResponse = await fetch(targetUrl, {
            method: method,
            headers: {
                ...spoofedHeaders,
                'Cookie': req.headers.cookie || ''
            },
            body: method === 'POST' ? JSON.stringify(payloadBody) : undefined
        });

        const resultData = await bbResponse.json().catch(() => ({ ok: true }));

        res.json({
            op: op,
            data: encryptPayload(resultData)
        });

    } catch (err) {
        console.error("Backend Proxy Error:", err);
        res.status(500).json({ op: "error", data: encryptPayload({ ok: false, message: err.message }) });
    }
});

// --- Proxy for listing/search requests matching frontend proxyGet ---
app.get('/bigbasket/proxy.php', async (req, res) => {
    try {
        const queryString = new URLSearchParams(req.query).toString();
        const targetUrl = `${BB_BASE}/listing-svc/v4/products?${queryString}`;
        
        const spoofedHeaders = buildAppHeaders();

        const response = await fetch(targetUrl, {
            headers: {
                ...spoofedHeaders,
                'Cookie': req.headers.cookie || ''
            }
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Final Production-Ready Server running on port ${PORT}`);
});
