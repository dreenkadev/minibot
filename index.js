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
            if (!msg.message) return;

            // Get message text
            const getMessageText = (msg) => {
                if (!msg.message) return '';
                if (msg.message.conversation) return msg.message.conversation;
                if (msg.message.extendedTextMessage) return msg.message.extendedTextMessage.text;
                if (msg.message.imageMessage?.caption) return msg.message.imageMessage.caption;
                if (msg.message.videoMessage?.caption) return msg.message.videoMessage.caption;
                return '';
            };

            const text = getMessageText(msg).trim().toLowerCase();

            // Check if the message is the .reveal command
            if (text === '.reveal') {
                // Check if the user is replying to a viewOnce message
                const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                if (!contextInfo || !contextInfo.quotedMessage) return;

                const quotedMsg = contextInfo.quotedMessage;

                // Extract the viewOnce content from the quoted message
                let viewOnceMessage = quotedMsg.viewOnceMessage?.message ||
                    quotedMsg.viewOnceMessageV2?.message ||
                    quotedMsg.viewOnceMessageV2Extension?.message;

                if (viewOnceMessage) {
                    console.log('Reveal Command Detected on View Once Message!');

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
                        let captionText = `🚫 *REVEALED VIEW ONCE* 🚫\n\n`;
                        if (mediaMsg.caption) {
                            captionText += `*Caption:* ${mediaMsg.caption}\n`;
                        }

                        const mentions = [];
                        const chatId = msg.key.remoteJid;
                        const originalSenderJid = contextInfo.participant;
                        const requesterJid = msg.key.participant || msg.key.remoteJid;

                        mentions.push(originalSenderJid);
                        mentions.push(requesterJid);

                        captionText += `*Sender:* @${originalSenderJid.split('@')[0]}\n`;
                        captionText += `*Revealed by:* @${requesterJid.split('@')[0]}\n`;

                        // Define options for resending, quote the original view once message if possible
                        // Or quote the .reveal command
                        const options = {
                            quoted: msg
                        };

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

                        console.log('Successfully revealed View Once Media via command.');
                        return; // Stop further processing for this message
                    }
                }
            }

        } catch (error) {
            console.error('Error in messages.upsert:', error);
        }
    });
}

connectToWhatsApp();
