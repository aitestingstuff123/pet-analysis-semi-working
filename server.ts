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
  app.use(express.urlencoded({ extended: true }));

  // API Request Logging
  app.use("/api", (req, res, next) => {
    console.log(`[Server] API Request: ${req.method} ${req.url}`);
    next();
  });

  // Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Ensure uploads directory exists
  if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
  }

  // API Routes
  app.post("/api/process", (req, res, next) => {
    upload.single("media")(req, res, (err) => {
      if (err) {
        console.error("[Server] Multer Error:", err);
        return res.status(400).json({ 
          error: err instanceof multer.MulterError ? `File upload error: ${err.message}` : "Failed to upload file" 
        });
      }
      next();
    });
  }, async (req: MulterRequest, res) => {
    console.log(`[Server] Received upload request: ${req.file?.originalname} (${req.file?.mimetype})`);
    console.log(`[Server] Request Body Keys:`, Object.keys(req.body));
    console.log(`[Server] User ID:`, req.body.userId);
    console.log(`[Server] User Question Length:`, req.body.userQuestion?.length || 0);
    
    let tempPath = req.file?.path;
    let compressedPath = "";

    try {
      if (!req.file) {
        console.error("[Server] No file received in request");
        return res.status(400).json({ error: "No media file uploaded" });
      }

      // Strict type enforcement for security
      const isVideo = req.file.mimetype.startsWith("video/");
      const isAudio = req.file.mimetype.startsWith("audio/");
      
      if (!isVideo && !isAudio) {
        console.warn(`[Server] Rejected invalid file type: ${req.file.mimetype}`);
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        return res.status(400).json({ error: "Invalid file type. Only video and audio are allowed." });
      }

      // 1. Compression using FFmpeg (Optimized for Cost/Tokens)
      if (isVideo) {
        console.log("[Server] Starting video compression...");
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
            .on("error", (err) => {
              console.error("[Server] FFmpeg Error:", err);
              reject(err);
            });
        });
        console.log("[Server] Compression complete");
      }

      if (!fs.existsSync(compressedPath || tempPath)) {
        throw new Error("Media file disappeared after processing");
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
      console.error("[Server] Processing error:", error);
      res.status(500).json({ 
        error: "Media processing failed", 
        details: error.message 
      });
    } finally {
      // Cleanup temp files
      try {
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (compressedPath && fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
      } catch (cleanupError) {
        console.error("[Server] Cleanup error:", cleanupError);
      }
    }
  });

  // Catch-all for API routes to prevent falling through to SPA middleware
  app.all("/api/*", (req, res) => {
    console.warn(`[Server] API 404: ${req.method} ${req.url}`);
    res.status(404).json({ error: `API endpoint ${req.method} ${req.url} not found` });
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

  // Global Error Handler to ensure JSON responses
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[Server] Global Error:", err);
    res.status(500).json({ 
      error: "Internal Server Error", 
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
