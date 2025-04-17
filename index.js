const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");

const supabase = require("./supabase"); // import your Supabase client

// const fs = require("fs");
// const path = require("path");

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log(
        "Connection closed due to",
        lastDisconnect?.error,
        "Reconnecting...",
        shouldReconnect
      );
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
    }
  });

  sock.ev.on("messages.upsert", async (msg) => {
    const message = msg.messages[0];
    if (!message.message || message.key.fromMe) return;

    const sender = message.key.remoteJid;
    const text =
      message.message.conversation ||
      message.message.extendedTextMessage?.text ||
      "";

    console.log(`📨 ${sender}: ${text}`);

    if (text.toLowerCase() === "hello") {
      await sock.sendMessage(sender, {
        text: "Hey! 👋 Welcome to *LectureBot* 📚\n\nSend something like *MAT101 Week1* to receive a note.",
      });
    }

    // 📄 Check and handle incoming PDF
    const documentMsg = message.message.documentMessage;
    if (documentMsg && documentMsg.mimetype === "application/pdf") {
      try {
        const buffer = await downloadMediaMessage(message, "buffer"); // ✅ message, not msg

        if (buffer) {
          const originalName = documentMsg.fileName || "lecture.pdf";
          const fileName = originalName.endsWith(".pdf")
            ? originalName
            : `${originalName}.pdf`;

          // Check if the file already exists
          const { data: existingFiles, error: listError } =
            await supabase.storage.from("lecturebot").list("", {
              search: fileName,
            });

          if (listError) {
            console.error("❌ Error checking existing files:", listError);
            await sock.sendMessage(sender, {
              text: "⚠️ Failed to verify file existence. Please try again.",
            });
            return;
          }

          if (
            existingFiles &&
            existingFiles.find((file) => file.name === fileName)
          ) {
            console.log("⚠️ File already exists. Skipping upload.");
            await sock.sendMessage(sender, {
              text: "📄 This PDF already exists in the system. No need to resend it.",
            });
            return;
          }

          // Upload since it doesn't exist
          const { data, error } = await supabase.storage
            .from("lecturebot") // 🧠 Replace with your actual bucket name
            .upload(fileName, buffer, {
              contentType: "application/pdf",
            });

          if (error) {
            console.error("❌ Error uploading PDF:", error);
            await sock.sendMessage(sender, {
              text: "❌ Failed to save the PDF. Please try again later.",
            });
          } else {
            console.log("✅ PDF uploaded to Supabase:", data);
            await sock.sendMessage(sender, {
              text: "📄 PDF received and saved successfully!",
            });
          }
        }
      } catch (error) {
        console.error("Error downloading the PDF:", error);
        await sock.sendMessage(sender, {
          text: "❌ There was an error downloading the PDF. Please try again.",
        });
      }
    }
  });
}

startBot();
