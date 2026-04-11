import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import multer from "multer";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "ffmpeg-static";
import { initializeApp } from 'firebase/app';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';

dotenv.config();

// Initialize Firebase Client SDK (Works on server and uses API Key instead of Service Account)
const firebaseConfig = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));
const firebaseApp = initializeApp(firebaseConfig);
const storage = getStorage(firebaseApp);

if (ffmpegInstaller) {
  ffmpeg.setFfmpegPath(ffmpegInstaller);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({ dest: "uploads/" });

interface MulterRequest extends express.Request {
  file?: any;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Ensure uploads directory exists
  if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
  }

  // API Routes
  app.post("/api/process", upload.single("media"), async (req: MulterRequest, res) => {
    let tempPath = req.file?.path;
    let compressedPath = "";

    try {
      if (!req.file) {
        return res.status(400).json({ error: "No media file uploaded" });
      }

      // Strict type enforcement for security
      const isVideo = req.file.mimetype.startsWith("video/");
      const isAudio = req.file.mimetype.startsWith("audio/");
      
      if (!isVideo && !isAudio) {
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        return res.status(400).json({ error: "Invalid file type. Only video and audio are allowed." });
      }

      // 1. Compression using FFmpeg (Optimized for Cost/Tokens)
      if (isVideo) {
        compressedPath = `uploads/compressed_${req.file.filename}.mp4`;
        await new Promise((resolve, reject) => {
          ffmpeg(tempPath)
            .outputOptions([
              "-vcodec libx264",
              "-crf 32", // Higher compression (smaller file)
              "-preset faster",
              "-vf scale='min(854,iw)':-2,fps=15", // Scale to 480p and cap at 15fps (huge token saver)
              "-acodec aac",
              "-ac 1", // Mono audio
              "-b:a 64k", // Lower audio bitrate
              "-t 60" // Limit to 60 seconds for cost control
            ])
            .save(compressedPath)
            .on("end", resolve)
            .on("error", reject);
        });
      }

      const mediaBuffer = fs.readFileSync(compressedPath || tempPath);
      const mimeType = compressedPath ? "video/mp4" : req.file.mimetype;
      const userId = req.body.userId || "anonymous";
      const fileName = `analyses/${userId}/${Date.now()}_${req.file.originalname}`;

      // 2. Upload to Firebase Storage (Server-side bypasses CORS)
      console.log(`[Server] Uploading to storage: ${fileName}`);
      const storageRef = ref(storage, fileName);
      const uploadResult = await uploadBytes(storageRef, mediaBuffer, {
        contentType: mimeType
      });
      
      const mediaUrl = await getDownloadURL(uploadResult.ref);
      console.log(`[Server] Upload successful. URL: ${mediaUrl}`);

      // Return processed media and URL to frontend
      res.json({
        base64: mediaBuffer.toString("base64"),
        mimeType: mimeType,
        mediaUrl: mediaUrl
      });
    } catch (error: any) {
      console.error("Processing error:", error);
      res.status(500).json({ error: "An error occurred during media processing." });
    } finally {
      // Cleanup temp files
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      if (compressedPath && fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
