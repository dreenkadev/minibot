const {
    default: makeWASocket,
    useMultiFileAuthState,
    downloadContentFromMessage,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

let qrCodeData = '';
let isConnected = false;

// Keep-Alive endpoint
app.get('/ping', (req, res) => {
    res.send('pong');
});

// QR Code HTML Dashboard
app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <html>
                <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f0f2f5;">
                    <div style="background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center;">
                        <h2 style="color: #25D366;">✅ WA Bot is Connected & Active!</h2>
                        <p>Anti View-Once feature is currently running.</p>
                    </div>
                </body>
            </html>
        `);
    }

    if (!qrCodeData) {
        return res.send(`
            <html>
                <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f0f2f5;">
                    <div style="background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center;">
                        <h2>🔄 Starting Bot...</h2>
                        <p>Please wait while generating the QR code. Refresh in a few seconds.</p>
                    </div>
                    <script>setTimeout(() => location.reload(), 3000);</script>
                </body>
            </html>
        `);
    }

    try {
        const qrImage = await qrcode.toDataURL(qrCodeData);
        res.send(`
            <html>
                <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f0f2f5;">
                    <div style="background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center;">
                        <h2>📱 Scan to Connect Bot</h2>
                        <img src="${qrImage}" alt="QR Code" style="width: 300px; height: 300px; margin: 20px 0;">
                        <p style="color: #666;">Scan this QR code with your WhatsApp app.</p>
                    </div>
                    <script>setTimeout(() => location.reload(), 5000);</script>
                </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR code.');
    }
});

app.listen(PORT, () => {
    console.log(`✅ Web Dashboard is running on port ${PORT}`);

    // Auto Keep-Alive for Railway (Ping every 10 minutes)
    setInterval(() => {
        const url = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
        fetch(`${url}/ping`)
            .then(() => console.log('Keep-alive ping optimal'))
            .catch(err => console.error('Keep-alive ping failed:', err.message));
    }, 10 * 60 * 1000); // 10 minutes
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp Web Version v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), // Suppress detailed logs
        browser: ['MiniBot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = qr; // Store for the web dashboard
            console.log('\nQR Code updated. Check the web dashboard to scan.');
        }

        if (connection === 'close') {
            isConnected = false;
            qrCodeData = ''; // Reset QR
            const lastError = lastDisconnect?.error;
            console.log('Connection closed. Error Details:', lastError);

            const shouldReconnect = lastError?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Reconnecting...', shouldReconnect);

            if (shouldReconnect) {
                // To avoid infinite loops on immediate reconnect
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log('You are logged out. Please delete auth_info_baileys directory and scan again.');
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeData = ''; // Clear the QR once connected
            console.log('Bot is strictly online and ready!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            // Extract the message content which might be viewOnce
            // View once messages can be encapsulated differently depending on WhatsApp client version
            let viewOnceMessage = msg.message?.viewOnceMessage?.message ||
                msg.message?.viewOnceMessageV2?.message ||
                msg.message?.viewOnceMessageV2Extension?.message;

            if (viewOnceMessage) {
                console.log('View Once Message Detected!');

                // Get the message type (e.g., imageMessage, videoMessage, audioMessage)
                const msgType = Object.keys(viewOnceMessage)[0];
                const mediaMsg = viewOnceMessage[msgType];

                if (msgType === 'imageMessage' || msgType === 'videoMessage' || msgType === 'audioMessage') {
                    // Download the media stream
                    const stream = await downloadContentFromMessage(
                        mediaMsg,
                        msgType.replace('Message', '')
                    );

                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    // Prepare caption
                    let captionText = `🚫 * ANTI VIEW ONCE * 🚫\n\n`;
                    if (mediaMsg.caption) {
                        captionText += `* Caption:* ${mediaMsg.caption}\n`;
                    }

                    const mentions = [];
                    const fromJid = msg.key.remoteJid;
                    const senderJid = msg.key.participant || msg.key.remoteJid;
                    mentions.push(senderJid);

                    captionText += `* From:* @${senderJid.split('@')[0]}\n`;

                    // Define options for resending
                    const options = {
                        quoted: msg
                    };

                    // To resend to the same chat where it was sent:
                    const chatId = msg.key.remoteJid;

                    // Send the downloaded media back to the chat as normal media
                    if (msgType === 'imageMessage') {
                        await sock.sendMessage(chatId, { image: buffer, caption: captionText, mentions: mentions }, options);
                    } else if (msgType === 'videoMessage') {
                        await sock.sendMessage(chatId, { video: buffer, caption: captionText, mentions: mentions }, options);
                    } else if (msgType === 'audioMessage') {
                        await sock.sendMessage(chatId, {
                            audio: buffer,
                            mimetype: mediaMsg.mimetype || 'audio/mp4',
                            ptt: mediaMsg.ptt || false,
                            mentions: mentions
                        }, options);
                    }

                    console.log('Successfully saved and resent View Once Media.');
                }
            }
        } catch (error) {
            console.error('Error in messages.upsert:', error);
        }
    });
}

connectToWhatsApp();
