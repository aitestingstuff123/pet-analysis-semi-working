import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import multer from "multer";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import cors from "cors";
import { initializeApp } from 'firebase/app';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import admin from 'firebase-admin';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

dotenv.config();

// Initialize Firebase Admin
let dbAdmin: any = null;
let bucket: any = null;
let firebaseConfig: any = null;

async function runFirestore<T>(op: (db: any) => Promise<T>): Promise<T> {
  if (!dbAdmin) throw new Error("Firestore not initialized");
  try {
    return await op(dbAdmin);
  } catch (err: any) {
    const errMsg = err.message || String(err);
    if (errMsg.includes("5 NOT_FOUND") || errMsg.includes("NOT_FOUND") || errMsg.includes("database") && errMsg.includes("not found")) {
      console.warn("[Server] Firestore operation failed with NOT_FOUND. Retrying with (default) database...");
      dbAdmin = admin.firestore(); // Fallback to default
      return await op(dbAdmin);
    }
    throw err;
  }
}

try {
  const configPath = path.resolve(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    
    if (!admin.apps.length) {
      admin.initializeApp({
        projectId: firebaseConfig.projectId,
        storageBucket: firebaseConfig.storageBucket
      });
      console.log("[Server] Firebase Admin initialized for project:", firebaseConfig.projectId);
    }

    // Default to named database if available, otherwise default
    if (firebaseConfig.firestoreDatabaseId) {
      dbAdmin = getFirestore(admin.app(), firebaseConfig.firestoreDatabaseId);
      console.log(`[Server] Firestore Admin initialized with named database: ${firebaseConfig.firestoreDatabaseId}`);
    } else {
      dbAdmin = admin.firestore();
      console.log("[Server] Firestore Admin initialized with (default) database");
    }
    
    // Initialize Storage Bucket
    bucket = admin.storage().bucket(firebaseConfig.storageBucket);
    console.log(`[Server] Storage Bucket (${firebaseConfig.storageBucket}) initialized`);
  }
} catch (err) {
  console.error("[Server] Firebase Admin initialization error:", err);
}

// Initialize Firebase Client SDK (for frontend config if needed, but mostly for storage fallback if any)
let storage: any;
try {
  if (firebaseConfig) {
    const firebaseApp = initializeApp(firebaseConfig);
    storage = getStorage(firebaseApp);
    console.log("[Server] Firebase Client Storage initialized");
  }
} catch (err) {
  console.error("[Server] Firebase Client initialization error:", err);
}

if (ffmpegPath) {
  console.log("[Server] Setting FFmpeg path to:", ffmpegPath);
  ffmpeg.setFfmpegPath(ffmpegPath);
} else {
  console.warn("[Server] ffmpeg-static path not found");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({ 
  dest: "uploads/",
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});

interface MulterRequest extends express.Request {
  file?: any;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Root Health Check
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // API Router
  const apiRouter = express.Router();

  // API Request Logging
  apiRouter.use((req, res, next) => {
    console.log(`[Server] API Request: ${req.method} ${req.url}`);
    next();
  });

  // RevenueCat Webhook
  apiRouter.post("/revenuecat-webhook", async (req, res) => {
    const authHeader = req.headers.authorization;
    const webhookSecret = process.env.REVENUECAT_WEBHOOK_AUTH_HEADER;

    // Optional: Verify RevenueCat Authorization header if configured
    if (webhookSecret && authHeader !== webhookSecret) {
      console.warn("[RevenueCat Webhook] Unauthorized request");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { event } = req.body;
    if (!event) {
      return res.status(400).json({ error: "Missing event data" });
    }

    const { type, app_user_id, entitlement_ids, expiration_at_ms } = event;
    console.log(`[RevenueCat Webhook] Received ${type} for user: ${app_user_id}`);

    if (!dbAdmin) {
      console.error("[RevenueCat Webhook] Firestore not initialized");
      return res.status(500).json({ error: "Internal Server Error" });
    }

    try {
      await runFirestore(async (db) => {
        const userRef = db.collection("users").doc(app_user_id);
        
        // Handle different event types
        // INITIAL_PURCHASE, RENEWAL, CANCELLATION, etc.
        // We primarily care if they have the 'pro' entitlement
        const hasProEntitlement = entitlement_ids && entitlement_ids.includes("pro");
        
        if (type === "INITIAL_PURCHASE" || type === "RENEWAL" || type === "RESTORE") {
          await userRef.set({
            status: "pro",
            subscriptionTier: "pro",
            is_subscriber: true,
            premiumUntil: expiration_at_ms ? Timestamp.fromMillis(expiration_at_ms) : null,
            lastBillingEvent: type,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          console.log(`[RevenueCat Webhook] Upgraded user ${app_user_id} to Pro`);
        } else if (type === "EXPIRATION" || type === "CANCELLATION") {
          // Only downgrade if they don't have other active entitlements (simplified here)
          if (!hasProEntitlement) {
            await userRef.set({
              status: "free",
              subscriptionTier: "free",
              is_subscriber: false,
              lastBillingEvent: type,
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            console.log(`[RevenueCat Webhook] Downgraded user ${app_user_id} to Free`);
          }
        }
      });

      res.json({ received: true });
    } catch (error: any) {
      if (error.message && error.message.includes("PERMISSION_DENIED")) {
        console.warn("[RevenueCat Webhook] Backend lacks permissions to update Firestore. Returning 200 OK to acknowledge receipt.");
        return res.json({ received: true, note: "Handled by frontend" });
      }
      console.error("[RevenueCat Webhook] Error processing event:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // Subscription Sync (Immediate update after purchase)
  apiRouter.post("/sync-subscription", async (req, res) => {
    const { app_user_id } = req.body;
    console.log(`[Subscription Sync] Received request for user: ${app_user_id}`);
    
    if (!app_user_id) {
      console.error("[Subscription Sync] Missing app_user_id in request body");
      return res.status(400).json({ error: "Missing app_user_id" });
    }

    if (!dbAdmin) {
      console.error("[Subscription Sync] Firestore not initialized");
      return res.status(500).json({ error: "Firestore not initialized" });
    }

    try {
      await runFirestore(async (db) => {
        const userRef = db.collection("users").doc(app_user_id);
        
        console.log(`[Subscription Sync] Attempting to upgrade user ${app_user_id} to Pro...`);
        
        await userRef.set({
          status: "pro",
          subscriptionTier: "pro",
          is_subscriber: true,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });

      console.log(`[Subscription Sync] Successfully upgraded user ${app_user_id} to Pro`);
      res.json({ success: true, status: "pro" });
    } catch (error: any) {
      if (error.message && error.message.includes("PERMISSION_DENIED")) {
        console.warn("[Subscription Sync] Backend lacks permissions to update Firestore. Relying on frontend update.");
        return res.json({ success: true, status: "pro", note: "Handled by frontend" });
      }
      console.error("[Subscription Sync] Error upgrading user:", error.message);
      res.status(500).json({ 
        error: "Failed to sync subscription", 
        details: error.message,
        code: error.code 
      });
    }
  });

  // Ensure uploads directory exists
  if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
  }

  // API Routes
  apiRouter.post("/process", (req, res, next) => {
    console.log("[Server] Entering /api/process route");
    upload.single("media")(req, res, (err) => {
      if (err) {
        console.error("[Server] Multer Error:", err);
        return res.status(400).json({ 
          error: err instanceof multer.MulterError ? `File upload error: ${err.message}` : "Failed to upload file" 
        });
      }
      console.log("[Server] Multer upload successful, proceeding to handler");
      next();
    });
  }, async (req: MulterRequest, res) => {
    console.log(`[Server] Processing upload: ${req.file?.originalname}`);
    
    let tempPath = req.file?.path;
    let compressedPath = "";

    try {
      if (!storage) {
        throw new Error("Firebase Storage not initialized. Check server logs.");
      }

      if (!req.file) {
        console.error("[Server] No file received in request");
        return res.status(400).json({ error: "No media file uploaded" });
      }

      const userId = req.body.userId;
      if (!userId) {
        return res.status(400).json({ error: "User ID is required for processing" });
      }

      // Fetch user usage from Firestore
      let monthlyAnalysesCount = 0;
      let isPro = false;
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      if (dbAdmin) {
        try {
          console.log(`[Server] Fetching user doc for ${userId}`);
          const userDoc = await runFirestore(db => db.collection("users").doc(userId).get()) as any;
          if (userDoc.exists) {
            const userData = userDoc.data();
            isPro = userData?.subscriptionTier === 'pro';
            const monthlyUsage = userData?.monthlyUsage || {};
            monthlyAnalysesCount = monthlyUsage[monthKey] || 0;
            console.log(`[Server] User ${userId} isPro: ${isPro}, usage: ${monthlyAnalysesCount}`);
          } else {
            console.log(`[Server] User doc for ${userId} not found`);
          }
        } catch (dbErr: any) {
          console.error("[Server] Firestore usage fetch failed:", dbErr);
          // If this fails with PERMISSION_DENIED, it's a database access issue
          if (dbErr.message.includes("PERMISSION_DENIED")) {
            console.warn("[Server] Firestore Permission Denied. Falling back to default usage (0).");
            // We continue with 0 to allow the analysis to proceed if it's just a tracking issue
          } else {
            throw dbErr;
          }
        }
      }

      // 3. Subscription Hard-Cap (300 analyses/month)
      if (monthlyAnalysesCount >= 300) {
        return res.status(429).json({ 
          error: "Monthly limit reached", 
          code: "SOFT_PAUSE",
          message: "You have exceeded 300 analyses this month. Please verify you are not a bot to continue." 
        });
      }

      // 1. Smart Routing Logic
      // Use Gemini 3 Flash for speed and reliability
      const modelToUse = "gemini-3-flash-preview";
      const isHeavyUser = monthlyAnalysesCount >= 30;

      // Strict type enforcement for security
      const isVideo = req.file.mimetype.startsWith("video/");
      const isAudio = req.file.mimetype.startsWith("audio/");
      
      if (!isVideo && !isAudio) {
        console.warn(`[Server] Rejected invalid file type: ${req.file.mimetype}`);
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        return res.status(400).json({ error: "Invalid file type. Only video and audio are allowed." });
      }

      // 2. Token Shaving (FFmpeg)
      // Aggressively downsample for 'Heavy Users'
      if (isVideo) {
        console.log(`[Server] Starting video compression (Heavy User: ${isHeavyUser})...`);
        compressedPath = `uploads/compressed_${req.file.filename}.mp4`;
        
        const ffmpegOptions = [
          "-vcodec libx264",
          "-crf 32",
          "-preset faster",
          "-acodec aac",
          "-ac 1",
          "-b:a 64k",
          "-t 60"
        ];

        if (isHeavyUser) {
          // Aggressive downsampling: 480p, 10 FPS
          ffmpegOptions.push("-vf scale='min(640,iw)':-2,fps=10");
        } else {
          // Standard: 480p, 15 FPS
          ffmpegOptions.push("-vf scale='min(854,iw)':-2,fps=15");
        }

        await new Promise((resolve, reject) => {
          ffmpeg(tempPath)
            .outputOptions(ffmpegOptions)
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

      // 4. Upload to Firebase Storage using Admin SDK (bypasses rules)
      let mediaUrl = "";
      const fileName = `analyses/${userId}/${Date.now()}_${req.file.originalname}`;
      const mimeType = compressedPath ? "video/mp4" : req.file.mimetype;
      
      try {
        if (bucket) {
          console.log(`[Server] Saving to bucket: ${fileName}...`);
          const file = bucket.file(fileName);
          await file.save(fs.readFileSync(compressedPath || tempPath), {
            metadata: { contentType: mimeType }
          });
          // Construct public URL - if public:true fails, we can use a signed URL or a standard Firebase Storage URL
          mediaUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media`;
          console.log("[Server] Uploaded to Storage via Admin SDK:", mediaUrl);
        } else {
          throw new Error("Storage bucket not initialized");
        }
      } catch (uploadErr: any) {
        if (uploadErr.message && uploadErr.message.includes("PERMISSION_DENIED")) {
          console.warn("[Server] Storage Permission Denied. Proceeding without remote URL (Frontend will upload).");
          mediaUrl = ""; // Frontend will handle missing URL
        } else if (uploadErr.message && uploadErr.message.includes("Authorization")) {
          console.warn("[Server] Storage Authorization Error. Proceeding without remote URL (Frontend will upload).");
          mediaUrl = "";
        } else {
          console.error("[Server] Admin Storage upload failed:", uploadErr.message || uploadErr);
          if (storage) {
            console.log("[Server] Trying Client SDK fallback...");
            try {
              const storageRef = ref(storage, fileName);
              const snapshot = await uploadBytes(storageRef, fs.readFileSync(compressedPath || tempPath), {
                contentType: mimeType
              });
              mediaUrl = await getDownloadURL(snapshot.ref);
            } catch (clientErr) {
              console.error("[Server] Client SDK fallback also failed:", clientErr);
              mediaUrl = "";
            }
          } else {
            mediaUrl = "";
          }
        }
      }

      // 5. Increment usage in Firestore
      if (dbAdmin) {
        try {
          await runFirestore(async (db) => {
            const userRef = db.collection("users").doc(userId);
            await userRef.set({
              monthlyUsage: {
                [monthKey]: FieldValue.increment(1)
              },
              analysesCount: FieldValue.increment(1),
              updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
          });
          console.log(`[Server] Usage incremented for ${userId}`);
        } catch (usageErr: any) {
          if (usageErr.message && usageErr.message.includes("PERMISSION_DENIED")) {
            console.warn("[Server] Backend lacks permissions to increment usage. Relying on frontend update.");
          } else {
            console.error("[Server] Failed to increment usage:", usageErr);
          }
        }
      }

      // Return processed media, URL, and routing info to frontend
      const finalBuffer = fs.readFileSync(compressedPath || tempPath);
      res.json({
        base64: finalBuffer.toString("base64"),
        mimeType: mimeType,
        mediaUrl: mediaUrl,
        modelToUse: modelToUse,
        isHeavyUser: isHeavyUser,
        usageStats: {
          monthlyCount: monthlyAnalysesCount,
          monthKey: monthKey
        }
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

  // Mount API Router
  app.use("/api", apiRouter);

  // Catch-all for API routes to prevent falling through to SPA middleware
  apiRouter.all("*", (req, res) => {
    console.warn(`[Server] API 404: ${req.method} ${req.url}`);
    res.status(404).json({ error: `API endpoint ${req.method} ${req.url} not found` });
  });

  // Ensure uploads directory exists
  if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
  }

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
