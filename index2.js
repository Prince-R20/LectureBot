const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const supabase = require("./supabase");
const crypto = require("crypto");
const axios = require("axios");

// Trackers for pending responses
const tempUploads = new Map(); // To store file buffers awaiting course code
const awaitingFileSelection = new Map(); // To track users picking from multiple search results
console.log(awaitingFileSelection)
// Utility to hash files
function getFileHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const sock = makeWASocket({ auth: state, printQRInTerminal: true });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update;
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
    }
  });

  // MAIN MESSAGE HANDLER
  sock.ev.on("messages.upsert", async (msg) => {
    const message = msg.messages[0];
    if (!message.message || message.key.fromMe) return;

    const sender = message.key.remoteJid;
    const text =
      message.message.conversation ||
      message.message.extendedTextMessage?.text ||
      "";
    console.log(`📨 ${sender}: ${text}`);

    // 1️⃣ -- HANDLE FILE DESCRIPTION AFTER UPLOAD
    if (tempUploads.has(sender)) {
      const uploadData = tempUploads.get(sender);
      const courseCode = text.trim();

      // Insert metadata + upload buffer to Supabase
      const fileHash = getFileHash(uploadData.buffer);

      const { data: uploadResponse, error: uploadError } =
        await supabase.storage
          .from("lecturebot")
          .upload(uploadData.fileName, uploadData.buffer, {
            contentType: "application/pdf",
          });

      if (uploadError) {
        await sock.sendMessage(sender, { text: "❌ Failed to upload PDF." });
        tempUploads.delete(sender);
        return;
      }

      const { error: insertError } = await supabase
        .from("lecture_files")
        .insert([
          {
            sender_id: sender,
            original_file_name: uploadData.originalName,
            file_hash: fileHash,
            storage_path: uploadResponse.path,
            timestamp: new Date().toISOString(),
            course_description: courseCode,
          },
        ]);

      if (insertError) {
        console.error("❌ Failed to insert metadata:", insertError);
        await sock.sendMessage(sender, { text: "❌ Could not save metadata." });
      } else {
        await sock.sendMessage(sender, {
          text: `✅ File saved under *${courseCode}*.`,
        });
      }

      tempUploads.delete(sender);
      return;
    }

    // 2️⃣ -- HANDLE FILE SELECTION AFTER MULTIPLE MATCHES
    if (awaitingFileSelection.has(sender)) {
      const { files } = awaitingFileSelection.get(sender);
      const choice = parseInt(text.trim());

      if (!Number.isInteger(choice) || choice < 1 || choice > files.length) {
        await sock.sendMessage(sender, {
          text: "⚠️ Invalid number. Please choose a valid option from the list.",
        });
        return;
      }

      const selected = files[choice - 1];
      const { data: fileStream } = await axios.get(
        `https://xyz.supabase.co/storage/v1/object/public/lecturebot/${selected.storage_path}`,
        { responseType: "arraybuffer" }
      );

      await sock.sendMessage(sender, {
        document: Buffer.from(fileStream),
        mimetype: "application/pdf",
        fileName: selected.original_file_name,
      });

      awaitingFileSelection.delete(sender);
      return;
    }

    // 3️⃣ -- GREETING
    if (text.toLowerCase() === "hello") {
      await sock.sendMessage(sender, {
        text: "Hey! 👋 Welcome to *LectureBot* 📚\n\nSend something like *MAT101 Week1* to receive a note.",
      });
    }

    // 4️⃣ -- HANDLE FILE UPLOAD
    const documentMsg = message.message.documentMessage;
    if (documentMsg && documentMsg.mimetype === "application/pdf") {
      try {
        const buffer = await downloadMediaMessage(message, "buffer");
        const fileHash = getFileHash(buffer);

        const { data: existing, error } = await supabase
          .from("lecture_files")
          .select("*")
          .eq("file_hash", fileHash);

        if (error) throw error;
        if (existing.length > 0) {
          await sock.sendMessage(sender, {
            text: "⚠️ This file already exists.",
          });
          return;
        }

        const fileName = `${Date.now()}_${
          documentMsg.fileName || "lecture"
        }.pdf`;
        tempUploads.set(sender, {
          buffer,
          fileName,
          originalName: documentMsg.fileName,
        });

        await sock.sendMessage(sender, {
          text: "📌 Now send a course code/description for this PDF.",
        });
        return;
      } catch (err) {
        console.error("Download error:", err);
        await sock.sendMessage(sender, { text: "❌ Error downloading PDF." });
        return;
      }
    }

    // 5️⃣ -- HANDLE SEND <KEYWORD> SEARCH
    if (text.toLowerCase().startsWith("send ")) {
      const searchInput = text.slice(5).toLowerCase();
      const keywords = searchInput.split(/[^a-zA-Z0-9]+/).filter(Boolean);

      const { data: allFiles, error } = await supabase
        .from("lecture_files")
        .select("*");
      if (error || !allFiles || allFiles.length === 0) {
        await sock.sendMessage(sender, { text: "⚠️ No files available yet." });
        return;
      }

      const matched = allFiles
        .map((file) => {
          const nameWords =
            file.original_file_name
              ?.toLowerCase()
              .split(/[^a-zA-Z0-9]+/)
              .filter(Boolean) || [];
          const descWords =
            file.course_description
              ?.toLowerCase()
              .split(/[^a-zA-Z0-9]+/)
              .filter(Boolean) || [];
          const allWords = [...nameWords, ...descWords];

          const matchCount = keywords.reduce(
            (acc, word) => (allWords.includes(word) ? acc + 1 : acc),
            0
          );
          return { ...file, matchCount };
        })
        .filter((file) => file.matchCount > 0);

      if (matched.length === 0) {
        await sock.sendMessage(sender, { text: "❌ No match found." });
        return;
      }

      matched.sort((a, b) => b.matchCount - a.matchCount);

      if (
        matched.length === 1 ||
        matched[0].matchCount > matched[1]?.matchCount
      ) {
        // One strong match, send immediately
        const topFile = matched[0];
        const { data: fileStream } = await axios.get(
          `https://xyz.supabase.co/storage/v1/object/public/lecturebot/${topFile.storage_path}`,
          { responseType: "arraybuffer" }
        );

        await sock.sendMessage(sender, {
          document: Buffer.from(fileStream),
          mimetype: "application/pdf",
          fileName: topFile.original_file_name,
        });
      } else {
        // Multiple similar matches, prompt selection
        const list = matched
          .map(
            (f, i) =>
              `${i + 1}. ${f.original_file_name} (${
                f.course_description || "No code"
              })`
          )
          .join("\n");
        awaitingFileSelection.set(sender, { files: matched });

        await sock.sendMessage(sender, {
          text: `📚 Multiple matches found:\n\n${list}\n\nPlease reply with the number of the file you want to receive.`,
        });
      }
    }
  });
}

startBot();
