const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

// const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const supabase = require("./supabase"); // import your Supabase client
const crypto = require("crypto");
const { Readable } = require("stream");

// Trackers for pending responses
const tempUploads = new Map(); // To store file buffers awaiting course code
const awaitingFileSelection = new Map(); // To track users picking from multiple search results

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
        tempUploads.delete(sender);
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
      tempUploads.delete(sender);

      return;
    }

    if (text.toLowerCase() === "hello") {
      await sock.sendMessage(sender, {
        text: "Hey! 👋 Welcome to *LectureBot* 📚\n\nSend something like *Send MAT101* to receive a note. \n\nPowered by Dev Prince",
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

    // ✅ Handle file retrieval request
    // 📨 Check for message starting with "send"
    if (text.toLowerCase().startsWith("send ")) {
      const query = text.substring(5).toLowerCase().trim(); // extract query
      const queryWords = query
        .split(/\s+/) // split by spaces
        .flatMap((word) => word.split(/[-_.,]/)) // break symbols like "-", "_", ".", ","
        .filter((word) => word); // remove empty strings

      // Fetch all files from Supabase
      const { data: files, error: fetchError } = await supabase
        .from("lecture_files")
        .select("*");

      if (fetchError) {
        console.error("❌ Error fetching files:", fetchError);
        await sock.sendMessage(sender, {
          text: "❌ Error fetching files. Please try again.",
        });
        return;
      }

      // Each file gets a score based on how many keywords match
      const scoredFiles = files.map((file) => {
        const nameWords =
          file.original_file_name?.toLowerCase().split(/[\s\-_.]+/) || [];
        const descWords =
          file.course_code?.toLowerCase().split(/[\s\-_.]+/) || [];

        // Merge name and description words into a Set for faster lookup
        const allWords = new Set([...nameWords, ...descWords]);

        // Count how many query words are found in allWords
        const matchCount = queryWords.reduce(
          (count, word) => (allWords.has(word) ? count + 1 : count),
          0
        );

        return { ...file, matchCount };
      });

      // Get max score to filter best matches
      const maxScore = Math.max(...scoredFiles.map((f) => f.matchCount));
      const topMatches = scoredFiles.filter(
        (f) => f.matchCount === maxScore && maxScore > 0
      );

      // No matches at all
      if (topMatches.length === 0) {
        await sock.sendMessage(sender, {
          text: "😔 No matching materials found for your request.",
        });
        return;
      }

      // Only one best match found – send the file immediately
      if (topMatches.length === 1) {
        const match = topMatches[0];
        try {
          const { data: fileBuffer, error: downloadError } =
            await supabase.storage
              .from("lecturebot")
              .download(match.storage_path);

          if (downloadError) {
            console.error("❌ Error downloading file:", downloadError);
            await sock.sendMessage(sender, {
              text: "❌ Error retrieving the file. Please try again.",
            });
            return;
          }

          await sock.sendMessage(sender, {
            document: fileBuffer,
            fileName: match.original_file_name || "file.pdf",
            mimetype: "application/pdf",
          });
        } catch (err) {
          console.error("Error sending PDF:", err);
          await sock.sendMessage(sender, {
            text: "❌ There was an error sending the file.",
          });
        }
      } else {
        // Multiple top matches – ask user to choose
        let listText = "*📚 Multiple matches found!*\n\n";
        topMatches.forEach((file, idx) => {
          const desc = file.course_description || "No description";
          listText += `${idx + 1}. ${file.original_file_name} (${desc})\n`;
        });

        listText += `\nReply with the *number* of the material you want to receive.`;

        // Save user’s options in memory temporarily
        awaitingFileSelection.set(sender, { files: scoredFiles });

        await sock.sendMessage(sender, { text: listText });
      }
    }

    // 🟡 Handle response to selection (if user previously asked to choose a file)
    if (awaitingFileSelection.has(sender)) {
      const { files } = awaitingFileSelection.get(sender);
      const selectedIndex = parseInt(text.trim());

      if (
        !isNaN(selectedIndex) &&
        selectedIndex > 0 &&
        selectedIndex <= files.length
      ) {
        const chosenFile = files[selectedIndex - 1];

        try {
          const { data: fileBuffer, error: downloadError } =
            await supabase.storage
              .from("lecturebot")
              .download(chosenFile.storage_path);

          if (downloadError) {
            console.error("❌ Error downloading file:", downloadError);
            await sock.sendMessage(sender, {
              text: "❌ Error retrieving the file. Please try again.",
            });
            return;
          }

          // Convert buffer to readable stream
          const bufferStream = Readable.from(fileBuffer);

          // ✅ Just send the file. Don't save metadata again — it's already stored.
          await sock.sendMessage(sender, {
            document: bufferStream,
            fileName: chosenFile.original_file_name || "file.pdf",
            mimetype: "application/pdf",
          });

          awaitingFileSelection.delete(sender); // clear state after response
          return;
        } catch (err) {
          console.error("❌ Error sending PDF:", err);
          await sock.sendMessage(sender, {
            text: "❌ There was an error sending the file.",
          });
        }
      } else {
        await sock.sendMessage(sender, {
          text: "❌ Invalid number. Please reply with a valid number from the list.",
        });
      }
    }
  });
}

startBot();
