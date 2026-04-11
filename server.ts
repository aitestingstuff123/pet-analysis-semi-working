import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "ffmpeg-static";

dotenv.config();

if (ffmpegInstaller) {
  ffmpeg.setFfmpegPath(ffmpegInstaller);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
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
  app.post("/api/analyze", upload.single("media"), async (req: MulterRequest, res) => {
    let tempPath = req.file?.path;
    let compressedPath = "";

    try {
      if (!req.file) {
        return res.status(400).json({ error: "No media file uploaded" });
      }

      // Compression using FFmpeg (fluent-ffmpeg wrapper)
      if (req.file.mimetype.startsWith("video")) {
        compressedPath = `uploads/compressed_${req.file.filename}.mp4`;
        await new Promise((resolve, reject) => {
          ffmpeg(tempPath)
            .outputOptions([
              "-vcodec libx264",
              "-crf 28",
              "-preset faster",
              "-vf scale='min(1280,iw)':-2",
              "-acodec aac",
              "-b:a 128k"
            ])
            .save(compressedPath)
            .on("end", resolve)
            .on("error", reject);
        });
      }

      const mediaBuffer = fs.readFileSync(compressedPath || tempPath);
      const mimeType = compressedPath ? "video/mp4" : req.file.mimetype;

      const prompt = `Analyze this pet behavior video/audio. 
      Provide a detailed report including:
      1. Observations (list of objects with 'event' and 'meaning' keys)
      2. Emotional state (string)
      3. Recommended action steps (list of strings)
      Format the response as a clean JSON object.`;

      const result = await genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: {
          parts: [
            {
              inlineData: {
                data: mediaBuffer.toString("base64"),
                mimeType: mimeType,
              },
            },
            { text: prompt }
          ]
        }
      });

      const text = result.text || "";
      
      // Attempt to parse JSON from response
      let analysisResult;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        analysisResult = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: text };
      } catch (e) {
        analysisResult = { raw: text };
      }

      res.json(analysisResult);
    } catch (error: any) {
      console.error("Analysis error:", error);
      res.status(500).json({ error: error.message });
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
