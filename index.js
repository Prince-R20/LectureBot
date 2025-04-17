const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const supabase = require("./supabase"); // import your Supabase client
const crypto = require("crypto");

const tempUploads = new Map(); // Keeps track of recent uploads by user

function getFileHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

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

    // If awaiting course code from sender
    if (tempUploads.has(sender) && text.trim()) {
      const pending = tempUploads.get(sender);
      tempUploads.delete(sender);

      const fileName = `${Date.now()}_${
        pending.originalFileName || "lecture"
      }.pdf`;

      // Upload to Supabase Storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from("lecturebot")
        .upload(fileName, pending.buffer, {
          contentType: "application/pdf",
        });

      if (uploadError) {
        console.error("❌ Upload error:", uploadError);
        await sock.sendMessage(sender, {
          text: "❌ Failed to upload the PDF. Please try again.",
        });
        return;
      }

      // Save metadata in the table
      const { error: insertError } = await supabase
        .from("lecture_files")
        .insert([
          {
            sender_id: sender,
            original_file_name: pending.originalFileName,
            file_hash: pending.fileHash,
            storage_path: uploadData.path,
            timestamp: new Date().toISOString(),
            course_code: text.trim(),
          },
        ]);

      if (insertError) {
        console.error("❌ Failed to insert metadata:", insertError);
        await sock.sendMessage(sender, {
          text: "❌ Failed to save file info. Please try again.",
        });
        return;
      }

      await sock.sendMessage(sender, {
        text: "✅ PDF uploaded and saved successfully with course code!",
      });

      return;
    }

    if (text.toLowerCase() === "hello") {
      await sock.sendMessage(sender, {
        text: "Hey! 👋 Welcome to *LectureBot* 📚\n\nSend something like *MAT101 Week1* to receive a note.",
      });
    }

    // 📄 Check and handle incoming PDF
    const documentMsg = message.message.documentMessage;
    if (documentMsg && documentMsg.mimetype === "application/pdf") {
      try {
        const buffer = await downloadMediaMessage(message, "buffer");

        if (buffer) {
          const fileHash = getFileHash(buffer);

          // 🧠 Check if file already exists by hash
          const { data: existingFiles, error: queryError } = await supabase
            .from("lecture_files")
            .select("*")
            .eq("file_hash", fileHash);

          if (queryError) {
            console.error("❌ Error checking existing file:", queryError);
            await sock.sendMessage(sender, {
              text: "❌ Error checking for duplicates. Please try again.",
            });
            return;
          }

          if (existingFiles.length > 0) {
            await sock.sendMessage(sender, {
              text: "⚠️ This file has already been uploaded.",
            });
            return;
          }

          // 🧠 Temporarily store buffer and wait for course code
          tempUploads.set(sender, {
            buffer,
            fileHash,
            originalFileName: documentMsg.fileName,
          });

          await sock.sendMessage(sender, {
            text: "📥 PDF received. Now please send the *course code or title* for this note.",
          });
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
